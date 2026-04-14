import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import bcrypt from 'bcrypt';
import * as OTPAuth from 'otpauth';
import * as QRCode from 'qrcode';
import { prisma } from '../lib/prisma.js';
import { ValidationError } from '../lib/errors.js';
import { jwtAuth } from '../middleware/jwt-auth.js';

function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () =>
    crypto.randomBytes(4).toString('hex') // 8 char hex codes
  );
}

export async function auth2faRoutes(app: FastifyInstance) {
  // POST /auth/2fa/setup — generate TOTP secret and QR code
  app.post('/2fa/setup', { preHandler: [jwtAuth] }, async (request, reply) => {
    const { sub } = request.user as { sub: string };
    const user = await prisma.user.findUnique({ where: { id: sub } });
    if (!user) return reply.status(404).send({ error: true, message: 'User not found.', code: 'NOT_FOUND', statusCode: 404 });

    if (user.totpEnabled) {
      return reply.status(400).send({ error: true, message: '2FA is already enabled.', code: '2FA_ALREADY_ENABLED', statusCode: 400 });
    }

    const secret = new OTPAuth.Secret();
    const totp = new OTPAuth.TOTP({
      issuer: 'sheets.banco',
      label: user.email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret,
    });

    const uri = totp.toString();
    const qrCode = await QRCode.toDataURL(uri);

    // Save secret temporarily (not yet enabled)
    await prisma.user.update({
      where: { id: sub },
      data: { totpSecret: secret.base32 },
    });

    return {
      secret: secret.base32,
      uri,
      qrCode, // data:image/png;base64,...
    };
  });

  // POST /auth/2fa/verify — verify code and enable 2FA
  app.post('/2fa/verify', { preHandler: [jwtAuth] }, async (request, reply) => {
    const { sub } = request.user as { sub: string };
    const body = request.body as { code?: string };

    if (!body?.code) throw new ValidationError('Provide a "code" from your authenticator app.');

    const user = await prisma.user.findUnique({ where: { id: sub } });
    if (!user?.totpSecret) {
      return reply.status(400).send({ error: true, message: 'Run /2fa/setup first.', code: '2FA_NOT_SETUP', statusCode: 400 });
    }

    const totp = new OTPAuth.TOTP({
      issuer: 'sheets.banco',
      label: user.email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(user.totpSecret),
    });

    const delta = totp.validate({ token: body.code, window: 1 });
    if (delta === null) {
      return reply.status(401).send({ error: true, message: 'Invalid code.', code: 'INVALID_2FA_CODE', statusCode: 401 });
    }

    // Generate recovery codes
    const plainCodes = generateRecoveryCodes();
    const hashedCodes = await Promise.all(
      plainCodes.map((code) => bcrypt.hash(code, 4))
    );

    await prisma.user.update({
      where: { id: sub },
      data: {
        totpEnabled: true,
        recoveryCodes: hashedCodes,
      },
    });

    return {
      enabled: true,
      recoveryCodes: plainCodes, // show only once!
    };
  });

  // POST /auth/2fa/disable — disable 2FA (requires password)
  app.post('/2fa/disable', { preHandler: [jwtAuth] }, async (request, reply) => {
    const { sub } = request.user as { sub: string };
    const body = request.body as { password?: string };

    if (!body?.password) throw new ValidationError('Provide your password.');

    const user = await prisma.user.findUnique({ where: { id: sub } });
    if (!user) return reply.status(404).send({ error: true, message: 'User not found.', code: 'NOT_FOUND', statusCode: 404 });

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      return reply.status(401).send({ error: true, message: 'Invalid password.', code: 'INVALID_PASSWORD', statusCode: 401 });
    }

    await prisma.user.update({
      where: { id: sub },
      data: {
        totpEnabled: false,
        totpSecret: null,
        recoveryCodes: [],
      },
    });

    return { disabled: true };
  });

  // POST /auth/2fa/validate — validate 2FA code during login (called after login returns requires2FA)
  app.post('/2fa/validate', async (request, reply) => {
    const body = request.body as { tempToken?: string; code?: string };

    if (!body?.tempToken || !body?.code) {
      throw new ValidationError('Provide "tempToken" and "code".');
    }

    let payload: { sub: string; email: string; pending2fa: boolean };
    try {
      payload = app.jwt.verify<typeof payload>(body.tempToken);
    } catch {
      return reply.status(401).send({ error: true, message: 'Invalid or expired token.', code: 'INVALID_TOKEN', statusCode: 401 });
    }

    if (!payload.pending2fa) {
      return reply.status(400).send({ error: true, message: 'Token is not a 2FA pending token.', code: 'INVALID_TOKEN', statusCode: 400 });
    }

    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user?.totpSecret) {
      return reply.status(400).send({ error: true, message: '2FA not configured.', code: '2FA_NOT_SETUP', statusCode: 400 });
    }

    const totp = new OTPAuth.TOTP({
      issuer: 'sheets.banco',
      label: user.email,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: OTPAuth.Secret.fromBase32(user.totpSecret),
    });

    const delta = totp.validate({ token: body.code, window: 1 });

    if (delta === null) {
      // Try recovery codes
      let recoveryUsed = false;
      for (let i = 0; i < user.recoveryCodes.length; i++) {
        const match = await bcrypt.compare(body.code, user.recoveryCodes[i]);
        if (match) {
          // Mark as used
          const updated = [...user.recoveryCodes];
          updated.splice(i, 1);
          await prisma.user.update({ where: { id: user.id }, data: { recoveryCodes: updated } });
          recoveryUsed = true;
          break;
        }
      }

      if (!recoveryUsed) {
        return reply.status(401).send({ error: true, message: 'Invalid 2FA code.', code: 'INVALID_2FA_CODE', statusCode: 401 });
      }
    }

    // Issue full JWT
    const token = app.jwt.sign({ sub: user.id, email: user.email });

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        googleConnected: !!user.googleRefreshToken,
      },
      token,
    };
  });
}
