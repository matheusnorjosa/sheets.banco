/**
 * Tests for hmacVerify middleware (v1 legacy + v2 raw-body).
 *
 * v1 hashes JSON.stringify(request.body) — fragile across JSON serializers,
 *    kept for back-compat. New clients must use v2.
 * v2 hashes the raw bytes (request.rawBody captured by fastify-raw-body) —
 *    cross-language-stable.
 *
 * Both versions use canonical: METHOD\nPATH\nTIMESTAMP\nHEX(SHA256(body)).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { hmacVerify } from './hmac-verify.js';

const SECRET = 'test-secret-do-not-use-in-prod';

function sign(method: string, url: string, timestamp: string, body: string): string {
  const bodyHash = crypto.createHash('sha256').update(body).digest('hex');
  const canonical = `${method}\n${url}\n${timestamp}\n${bodyHash}`;
  return crypto.createHmac('sha256', SECRET).update(canonical).digest('hex');
}

function mockReply() {
  const reply: any = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply;
}

function mockRequest(opts: {
  headers: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  method?: string;
  url?: string;
  requireSigning?: boolean;
  hmacSecret?: string | null;
}): any {
  return {
    method: opts.method ?? 'POST',
    url: opts.url ?? '/api/v1/abc',
    headers: opts.headers,
    body: opts.body,
    rawBody: opts.rawBody,
    sheetApi: {
      requireSigning: opts.requireSigning ?? true,
      hmacSecret: opts.hmacSecret === undefined ? SECRET : opts.hmacSecret,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-17T12:00:00Z'));
});

describe('hmacVerify — passthrough cases', () => {
  it('skips when sheetApi missing', async () => {
    const req: any = { headers: {}, sheetApi: undefined };
    const reply = mockReply();
    await hmacVerify(req, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('skips when requireSigning is false', async () => {
    const req = mockRequest({ headers: {}, requireSigning: false });
    const reply = mockReply();
    await hmacVerify(req, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('skips when hmacSecret is null', async () => {
    const req = mockRequest({ headers: {}, hmacSecret: null });
    const reply = mockReply();
    await hmacVerify(req, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });
});

describe('hmacVerify — missing/invalid headers', () => {
  it('rejects when X-Signature missing', async () => {
    const req = mockRequest({ headers: { 'x-timestamp': '1750166400' } });
    const reply = mockReply();
    await hmacVerify(req, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ code: 'SIGNATURE_MISSING' }));
  });

  it('rejects when X-Timestamp missing', async () => {
    const req = mockRequest({ headers: { 'x-signature': 'deadbeef' } });
    const reply = mockReply();
    await hmacVerify(req, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ code: 'SIGNATURE_MISSING' }));
  });

  it('rejects when timestamp drift > 5min', async () => {
    const ts = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const req = mockRequest({
      headers: { 'x-signature': 'deadbeef', 'x-timestamp': ts },
    });
    const reply = mockReply();
    await hmacVerify(req, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ code: 'SIGNATURE_EXPIRED' }));
  });

  it('rejects non-numeric timestamp', async () => {
    const req = mockRequest({
      headers: { 'x-signature': 'deadbeef', 'x-timestamp': 'not-a-number' },
    });
    const reply = mockReply();
    await hmacVerify(req, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ code: 'SIGNATURE_EXPIRED' }));
  });
});

describe('hmacVerify v1 (legacy JSON.stringify path)', () => {
  it('accepts a valid v1 signature', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = { hello: 'world' };
    const signature = sign('POST', '/api/v1/abc', ts, JSON.stringify(body));
    const req = mockRequest({
      headers: { 'x-signature': signature, 'x-timestamp': ts },
      body,
    });
    const reply = mockReply();
    await hmacVerify(req, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('treats missing body as empty string', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = sign('GET', '/api/v1/abc', ts, '');
    const req = mockRequest({
      headers: { 'x-signature': signature, 'x-timestamp': ts },
      method: 'GET',
      body: undefined,
    });
    const reply = mockReply();
    await hmacVerify(req, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('rejects a wrong signature', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const req = mockRequest({
      headers: { 'x-signature': 'a'.repeat(64), 'x-timestamp': ts },
      body: { hello: 'world' },
    });
    const reply = mockReply();
    await hmacVerify(req, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ code: 'SIGNATURE_INVALID' }));
  });
});

describe('hmacVerify v2 (raw body)', () => {
  it('accepts a valid v2 signature using rawBody', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    // Simulate a client sending bytes with different whitespace than V8 would emit.
    const rawBody = '{ "hello" : "world" }';
    const signature = sign('POST', '/api/v1/abc', ts, rawBody);
    const req = mockRequest({
      headers: {
        'x-signature': signature,
        'x-timestamp': ts,
        'x-signature-version': '2',
      },
      // body is what Fastify parsed (semantically equivalent but different bytes).
      body: { hello: 'world' },
      rawBody,
    });
    const reply = mockReply();
    await hmacVerify(req, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('v1 signature over the same logical payload is rejected when sent as v2', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const rawBody = '{ "hello" : "world" }';
    // Signed against V8 JSON.stringify (no spaces) — won't match the raw bytes.
    const wrongSig = sign('POST', '/api/v1/abc', ts, JSON.stringify({ hello: 'world' }));
    const req = mockRequest({
      headers: {
        'x-signature': wrongSig,
        'x-timestamp': ts,
        'x-signature-version': '2',
      },
      body: { hello: 'world' },
      rawBody,
    });
    const reply = mockReply();
    await hmacVerify(req, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(expect.objectContaining({ code: 'SIGNATURE_INVALID' }));
  });

  it('v2 with missing rawBody treats body as empty', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = sign('GET', '/api/v1/abc', ts, '');
    const req = mockRequest({
      headers: {
        'x-signature': signature,
        'x-timestamp': ts,
        'x-signature-version': '2',
      },
      method: 'GET',
      rawBody: undefined,
    });
    const reply = mockReply();
    await hmacVerify(req, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });
});

describe('hmacVerify — version routing', () => {
  it('defaults to v1 when X-Signature-Version absent', async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const body = { x: 1 };
    const signature = sign('POST', '/api/v1/abc', ts, JSON.stringify(body));
    const req = mockRequest({
      headers: { 'x-signature': signature, 'x-timestamp': ts },
      body,
    });
    const reply = mockReply();
    await hmacVerify(req, reply);
    expect(reply.status).not.toHaveBeenCalled();
  });
});
