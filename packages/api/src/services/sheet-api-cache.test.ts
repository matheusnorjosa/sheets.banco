import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock both cache and prisma BEFORE importing the SUT so the SUT picks up
// the mocked exports rather than the real Redis/Postgres clients.
vi.mock('./cache.service.js', () => {
  const store = new Map<string, unknown>();
  return {
    __store: store,
    get: vi.fn(async <T>(k: string): Promise<T | undefined> => store.get(k) as T | undefined),
    set: vi.fn(async (k: string, v: unknown) => { store.set(k, v); }),
    del: vi.fn(async (k: string) => { store.delete(k); }),
    invalidate: vi.fn(async () => {}),
  };
});

vi.mock('../lib/prisma.js', () => {
  return {
    prisma: {
      sheetApi: {
        findUnique: vi.fn(),
      },
    },
  };
});

// Imported AFTER the mocks so the SUT binds to them.
import { findSheetApiCached, invalidateSheetApiCache } from './sheet-api-cache.service.js';
import * as cache from './cache.service.js';
import { prisma } from '../lib/prisma.js';

const cacheStore = (cache as any).__store as Map<string, unknown>;

function makeApi(overrides: Partial<any> = {}): any {
  return {
    id: 'cuid-123',
    slug: 'my-api',
    name: 'Test',
    spreadsheetId: 'sheet-1',
    userId: 'user-1',
    allowRead: true,
    allowCreate: true,
    allowUpdate: true,
    allowDelete: true,
    bearerToken: null,
    bearerTokenPrevious: null,
    bearerTokenRotatedAt: null,
    basicUser: null,
    basicPass: null,
    hmacSecret: null,
    requireSigning: false,
    corsOrigins: null,
    ipWhitelist: null,
    rateLimitRpm: 60,
    cacheTtlSeconds: 60,
    syncEnabled: false,
    syncCron: null,
    autoSnapshotOnWrite: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  cacheStore.clear();
  vi.clearAllMocks();
});

describe('findSheetApiCached', () => {
  it('cache miss: calls prisma by id, caches under both id and slug', async () => {
    const api = makeApi();
    (prisma.sheetApi.findUnique as any).mockResolvedValueOnce(api);

    const result = await findSheetApiCached('cuid-123');
    expect(result).toEqual(api);
    expect(prisma.sheetApi.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.sheetApi.findUnique).toHaveBeenCalledWith({ where: { id: 'cuid-123' } });
    expect(cacheStore.has('sheetApi:cuid-123')).toBe(true);
    expect(cacheStore.has('sheetApi:my-api')).toBe(true);
  });

  it('cache hit: does NOT call prisma', async () => {
    const api = makeApi();
    cacheStore.set('sheetApi:cuid-123', api);

    const result = await findSheetApiCached('cuid-123');
    expect(result).toEqual(api);
    expect(prisma.sheetApi.findUnique).not.toHaveBeenCalled();
  });

  it('falls back to slug lookup when id lookup misses', async () => {
    const api = makeApi();
    (prisma.sheetApi.findUnique as any)
      .mockResolvedValueOnce(null) // id miss
      .mockResolvedValueOnce(api); // slug hit

    const result = await findSheetApiCached('my-api');
    expect(result).toEqual(api);
    expect(prisma.sheetApi.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.sheetApi.findUnique).toHaveBeenNthCalledWith(2, { where: { slug: 'my-api' } });
    expect(cacheStore.has('sheetApi:cuid-123')).toBe(true);
    expect(cacheStore.has('sheetApi:my-api')).toBe(true);
  });

  it('returns null and does NOT cache when nothing is found', async () => {
    (prisma.sheetApi.findUnique as any)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const result = await findSheetApiCached('does-not-exist');
    expect(result).toBeNull();
    expect(cacheStore.size).toBe(0);
  });

  it('rehydrates Date fields after a cache hit so .getTime() still works', async () => {
    // Simulate what happens when Redis returns JSON-parsed data: Dates are
    // strings. The SUT must turn them back into Date instances so middleware
    // that calls .getTime() on bearerTokenRotatedAt keeps working.
    const cached = {
      ...makeApi(),
      bearerTokenRotatedAt: '2026-03-01T12:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    };
    cacheStore.set('sheetApi:cuid-123', cached);

    const result = await findSheetApiCached('cuid-123');
    expect(result?.bearerTokenRotatedAt).toBeInstanceOf(Date);
    expect(result?.createdAt).toBeInstanceOf(Date);
    expect(result?.updatedAt).toBeInstanceOf(Date);
    expect(result?.bearerTokenRotatedAt!.getTime()).toBe(Date.parse('2026-03-01T12:00:00.000Z'));
  });

  it('skips slug cache entry when the SheetApi has no slug', async () => {
    const api = makeApi({ slug: null });
    (prisma.sheetApi.findUnique as any).mockResolvedValueOnce(api);

    await findSheetApiCached('cuid-123');
    expect(cacheStore.has('sheetApi:cuid-123')).toBe(true);
    expect(cacheStore.size).toBe(1);
  });
});

describe('invalidateSheetApiCache', () => {
  it('clears both id and slug keys', async () => {
    cacheStore.set('sheetApi:cuid-123', makeApi());
    cacheStore.set('sheetApi:my-api', makeApi());

    await invalidateSheetApiCache({ id: 'cuid-123', slug: 'my-api' });
    expect(cacheStore.size).toBe(0);
  });

  it('also clears a previous slug when a rename changed it', async () => {
    cacheStore.set('sheetApi:cuid-123', makeApi());
    cacheStore.set('sheetApi:old-slug', makeApi());
    cacheStore.set('sheetApi:new-slug', makeApi());

    await invalidateSheetApiCache({ id: 'cuid-123', slug: 'new-slug' }, 'old-slug');
    expect(cacheStore.size).toBe(0);
  });

  it('is a no-op when nothing is cached', async () => {
    await invalidateSheetApiCache({ id: 'cuid-123', slug: null });
    expect(cacheStore.size).toBe(0);
  });
});
