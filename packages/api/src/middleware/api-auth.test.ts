/**
 * Tests for apiAuth dual-read (#99 bcrypt transition) and API-key auth.
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
 *   - API key via X-API-Key and via Authorization: Bearer
 *   - API key scoped to the wrong SheetApi → 401 (does not leak that it exists)
 *   - Inactive / expired / insufficient-scope keys
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import bcrypt from 'bcrypt';
import { apiAuth } from './api-auth.js';
import { findApiKeyByPlaintext } from '../lib/api-key-lookup.js';

vi.mock('../lib/prisma.js', () => ({
  prisma: { apiKey: { update: vi.fn().mockResolvedValue({}) } },
}));

vi.mock('../lib/api-key-lookup.js', () => ({
  findApiKeyByPlaintext: vi.fn(),
}));

const lookup = vi.mocked(findApiKeyByPlaintext);

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
  apiKeyHeader?: string;
  method?: string;
  sheetApi?: any;
}): any {
  return {
    headers: {
      authorization: opts.authorization ?? '',
      ...(opts.apiKeyHeader ? { 'x-api-key': opts.apiKeyHeader } : {}),
    },
    method: opts.method ?? 'GET',
    sheetApi: opts.sheetApi,
  };
}

const ALL_SCOPES = ['sheets:read', 'sheets:write', 'sheets:delete'];

/** An ApiKey row as findApiKeyByPlaintext would return it. */
function keyRecord(over: Partial<Record<string, any>> = {}): any {
  return {
    id: 'key_1',
    sheetApiId: 'api_1',
    active: true,
    scopes: ALL_SCOPES,
    expiresAt: null,
    lastUsedAt: null,
    createdAt: new Date(),
    ...over,
  };
}

/**
 * A SheetApi that already requires a credential. API keys only ever come into
 * play on a gated API — a public one short-circuits before the key is read.
 */
function gatedApi(over: Partial<Record<string, any>> = {}): any {
  return { id: 'api_1', bearerToken: PASS, bearerTokenHash: null, ...over };
}

beforeEach(() => {
  vi.useRealTimers();
  lookup.mockReset();
  lookup.mockResolvedValue(null);
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

describe('apiAuth — authEnabled kill switch', () => {
  it('lets a request through when authEnabled is false, even with a correct bearer token present', async () => {
    // The switch short-circuits before any credential is read — flipping it
    // back on must re-enforce the same stored token, so nothing here clears it.
    const reply = mockReply();
    await apiAuth(mockRequest({ sheetApi: gatedApi({ authEnabled: false }) }), reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('lets a request through when authEnabled is false, with a WRONG bearer token', async () => {
    const reply = mockReply();
    await apiAuth(
      mockRequest({
        authorization: 'Bearer totally-wrong',
        sheetApi: gatedApi({ authEnabled: false }),
      }),
      reply,
    );
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('never looks up an API key when authEnabled is false', async () => {
    const reply = mockReply();
    await apiAuth(
      mockRequest({ apiKeyHeader: 'whatever', sheetApi: gatedApi({ authEnabled: false }) }),
      reply,
    );
    expect(reply.status).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('still enforces the bearer token when authEnabled is true (default)', async () => {
    const reply = mockReply();
    await apiAuth(mockRequest({ sheetApi: gatedApi({ authEnabled: true }) }), reply);
    expect(reply.status).toHaveBeenCalledWith(401);
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

describe('apiAuth — API key', () => {
  const KEY = 'b3f1c2d4-0000-4000-8000-abcdefabcdef';

  it('accepts a valid key sent as X-API-Key', async () => {
    lookup.mockResolvedValue(keyRecord());
    const reply = mockReply();
    await apiAuth(mockRequest({ apiKeyHeader: KEY, sheetApi: gatedApi() }), reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('accepts a valid key sent as Authorization: Bearer', async () => {
    lookup.mockResolvedValue(keyRecord());
    const reply = mockReply();
    await apiAuth(mockRequest({ authorization: `Bearer ${KEY}`, sheetApi: gatedApi() }), reply);
    expect(reply.status).not.toHaveBeenCalled();
  });

  it("still accepts the API's own bearer token — consumers are unaffected", async () => {
    const reply = mockReply();
    await apiAuth(mockRequest({ authorization: `Bearer ${PASS}`, sheetApi: gatedApi() }), reply);
    expect(reply.status).not.toHaveBeenCalled();
    // The bearer token matched first, so the key lookup never ran.
    expect(lookup).not.toHaveBeenCalled();
  });

  it('rejects a valid key that belongs to a DIFFERENT SheetApi', async () => {
    // The lookup is global; without the ownership check this key would unlock
    // every spreadsheet on the account.
    lookup.mockResolvedValue(keyRecord({ sheetApiId: 'outra_api' }));
    const reply = mockReply();
    await apiAuth(mockRequest({ apiKeyHeader: KEY, sheetApi: gatedApi() }), reply);
    expect(reply.status).toHaveBeenCalledWith(401);
    // Generic message — must not confirm the key exists somewhere else.
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'API_UNAUTHORIZED' }),
    );
  });

  it('rejects an inactive key', async () => {
    lookup.mockResolvedValue(keyRecord({ active: false }));
    const reply = mockReply();
    await apiAuth(mockRequest({ apiKeyHeader: KEY, sheetApi: gatedApi() }), reply);
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_API_KEY' }),
    );
  });

  it('rejects an expired key', async () => {
    lookup.mockResolvedValue(keyRecord({ expiresAt: new Date(Date.now() - 1000) }));
    const reply = mockReply();
    await apiAuth(mockRequest({ apiKeyHeader: KEY, sheetApi: gatedApi() }), reply);
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'API_KEY_EXPIRED' }),
    );
  });

  it('lets a read-only key read', async () => {
    lookup.mockResolvedValue(keyRecord({ scopes: ['sheets:read'] }));
    const reply = mockReply();
    await apiAuth(
      mockRequest({ apiKeyHeader: KEY, method: 'GET', sheetApi: gatedApi() }),
      reply,
    );
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('blocks a read-only key from writing', async () => {
    lookup.mockResolvedValue(keyRecord({ scopes: ['sheets:read'] }));
    const reply = mockReply();
    await apiAuth(
      mockRequest({ apiKeyHeader: KEY, method: 'PUT', sheetApi: gatedApi() }),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INSUFFICIENT_SCOPES' }),
    );
  });

  it('blocks DELETE for a key without sheets:delete', async () => {
    lookup.mockResolvedValue(keyRecord({ scopes: ['sheets:read', 'sheets:write'] }));
    const reply = mockReply();
    await apiAuth(
      mockRequest({ apiKeyHeader: KEY, method: 'DELETE', sheetApi: gatedApi() }),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it('allows a full-scope key to delete', async () => {
    lookup.mockResolvedValue(keyRecord());
    const reply = mockReply();
    await apiAuth(
      mockRequest({ apiKeyHeader: KEY, method: 'DELETE', sheetApi: gatedApi() }),
      reply,
    );
    expect(reply.status).not.toHaveBeenCalled();
  });

  it('treats an unrecognized method as a write — fails closed', async () => {
    lookup.mockResolvedValue(keyRecord({ scopes: ['sheets:read'] }));
    const reply = mockReply();
    await apiAuth(
      mockRequest({ apiKeyHeader: KEY, method: 'TRACE', sheetApi: gatedApi() }),
      reply,
    );
    expect(reply.status).toHaveBeenCalledWith(403);
  });

  it('ignores a duplicated X-API-Key header instead of blowing up', async () => {
    // A repeated header can arrive as an array; passing that to the lookup
    // would reach Prisma as a malformed `where` and 500 from inside auth.
    const request = mockRequest({ sheetApi: gatedApi() });
    request.headers['x-api-key'] = ['chave-a', 'chave-b'];
    const reply = mockReply();
    await apiAuth(request, reply);
    expect(reply.status).toHaveBeenCalledWith(401);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('leaves a public API public and never looks a key up', async () => {
    const reply = mockReply();
    await apiAuth(
      mockRequest({
        apiKeyHeader: KEY,
        sheetApi: {
          id: 'api_1',
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
    expect(lookup).not.toHaveBeenCalled();
  });
});
