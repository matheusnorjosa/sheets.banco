/**
 * Tests for apiAuth dual-read (#99 bcrypt transition).
 *
 * Coverage targets:
 *   - Bearer with only plaintext (legacy)
 *   - Bearer with only hash (new)
 *   - Bearer with both (transition — hash wins, legacy never consulted)
 *   - Bearer grace period (previous token) by hash and by plaintext
 *   - Basic with only plaintext
 *   - Basic with only hash
 *   - No credential configured → endpoint public
 *   - Wrong password → 401
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcrypt';
import { apiAuth } from './api-auth.js';

const PASS = 'super-secret-token-xyz';
let HASH: string;
let WRONG_HASH: string;

beforeAll(async () => {
  HASH = await bcrypt.hash(PASS, 4); // low rounds for test speed
  WRONG_HASH = await bcrypt.hash('something-else', 4);
});

function mockReply() {
  const reply: any = {
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply;
}

function mockRequest(opts: {
  authorization?: string;
  sheetApi?: any;
}): any {
  return {
    headers: { authorization: opts.authorization ?? '' },
    sheetApi: opts.sheetApi,
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('apiAuth — passthrough', () => {
  it('returns early when sheetApi missing', async () => {
    const reply = mockReply();
    await apiAuth(mockRequest({ sheetApi: undefined }), reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('returns early when no credential configured (public endpoint)', async () => {
    const reply = mockReply();
    await apiAuth(
      mockRequest({
        sheetApi: {
          bearerToken: null,
          bearerTokenHash: null,
          basicUser: null,
          basicPass: null,
          basicPassHash: null,
        },
      }),
      reply,
    );
    expect(reply.status).not.toHaveBeenCalled();
  });
});

describe('apiAuth — bearer dual-read', () => {
  it('accepts a token verified against the legacy plaintext column', async () => {
    const reply = mockReply();
    await apiAuth(
      mockRequest({
        authorization: `Bearer ${PASS}`,
        sheetApi: { bearerToken: PASS, bearerTokenHash: null },
      }),
      reply,
    );
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('accepts a token verified against the bcrypt hash', async () => {
    const reply = mockReply();
    await apiAuth(
      mockRequest({
        authorization: `Bearer ${PASS}`,
        sheetApi: { bearerToken: null, bearerTokenHash: HASH },
      }),
      reply,
    );
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('prefers hash when both are present — accepts if hash matches', async () => {
    const reply = mockReply();
    await apiAuth(
      mockRequest({
        authorization: `Bearer ${PASS}`,
        // plaintext deliberately wrong to prove hash path is consulted first
        sheetApi: { bearerToken: 'wrong-plaintext-here', bearerTokenHash: HASH },
      }),
      reply,
    );
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('rejects when hash mismatches even if plaintext matches', async () => {
    const reply = mockReply();
    await apiAuth(
      mockRequest({
        authorization: `Bearer ${PASS}`,
        // hash takes precedence: PASS will be compared against WRONG_HASH → false
        sheetApi: { bearerToken: PASS, bearerTokenHash: WRONG_HASH },
      }),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(401);
  });

  it('rejects wrong bearer token', async () => {
    const reply = mockReply();
    await apiAuth(
      mockRequest({
        authorization: 'Bearer wrong-token',
        sheetApi: { bearerToken: PASS, bearerTokenHash: null },
      }),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(401);
  });
});

describe('apiAuth — bearer rotation grace', () => {
  it('accepts the previous token via hash during grace window', async () => {
    const reply = mockReply();
    await apiAuth(
      mockRequest({
        authorization: `Bearer ${PASS}`,
        sheetApi: {
          bearerToken: 'new-token',
          bearerTokenHash: WRONG_HASH,
          bearerTokenPrevious: null,
          bearerTokenPreviousHash: HASH,
          bearerTokenRotatedAt: new Date(),
        },
      }),
      reply,
    );
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('accepts the previous token via legacy plaintext during grace window', async () => {
    const reply = mockReply();
    await apiAuth(
      mockRequest({
        authorization: `Bearer ${PASS}`,
        sheetApi: {
          bearerToken: 'new-token',
          bearerTokenHash: WRONG_HASH,
          bearerTokenPrevious: PASS,
          bearerTokenPreviousHash: null,
          bearerTokenRotatedAt: new Date(),
        },
      }),
      reply,
    );
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('rejects the previous token after the grace window', async () => {
    const reply = mockReply();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await apiAuth(
      mockRequest({
        authorization: `Bearer ${PASS}`,
        sheetApi: {
          bearerToken: 'new-token',
          bearerTokenHash: WRONG_HASH,
          bearerTokenPrevious: PASS,
          bearerTokenPreviousHash: HASH,
          bearerTokenRotatedAt: twoHoursAgo,
        },
      }),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(401);
  });
});

describe('apiAuth — basic dual-read', () => {
  const basicHeader = (user: string, pass: string) =>
    `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

  it('accepts basic auth via legacy plaintext', async () => {
    const reply = mockReply();
    await apiAuth(
      mockRequest({
        authorization: basicHeader('alice', PASS),
        sheetApi: { basicUser: 'alice', basicPass: PASS, basicPassHash: null },
      }),
      reply,
    );
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('accepts basic auth via bcrypt hash', async () => {
    const reply = mockReply();
    await apiAuth(
      mockRequest({
        authorization: basicHeader('alice', PASS),
        sheetApi: { basicUser: 'alice', basicPass: null, basicPassHash: HASH },
      }),
      reply,
    );
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('rejects basic with wrong password', async () => {
    const reply = mockReply();
    await apiAuth(
      mockRequest({
        authorization: basicHeader('alice', 'wrong'),
        sheetApi: { basicUser: 'alice', basicPass: PASS, basicPassHash: null },
      }),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(401);
  });

  it('rejects basic with wrong username', async () => {
    const reply = mockReply();
    await apiAuth(
      mockRequest({
        authorization: basicHeader('mallory', PASS),
        sheetApi: { basicUser: 'alice', basicPass: PASS, basicPassHash: null },
      }),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(401);
  });
});
