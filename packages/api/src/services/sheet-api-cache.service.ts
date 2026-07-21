import { prisma } from '../lib/prisma.js';
import * as cache from './cache.service.js';

/**
 * Mirror of the Prisma SheetApi shape. The generated Prisma client in this
 * project is typed as `any`, so callers that care about the structure rely on
 * this local declaration.
 */
export interface SheetApi {
  id: string;
  name: string;
  spreadsheetId: string;
  slug: string | null;
  userId: string | null;
  allowRead: boolean;
  allowCreate: boolean;
  allowUpdate: boolean;
  allowDelete: boolean;
  bearerToken: string | null;
  bearerTokenHash: string | null;
  bearerTokenPrevious: string | null;
  bearerTokenPreviousHash: string | null;
  bearerTokenRotatedAt: Date | null;
  basicUser: string | null;
  basicPass: string | null;
  basicPassHash: string | null;
  authEnabled: boolean;
  hmacSecret: string | null;
  requireSigning: boolean;
  corsOrigins: string | null;
  ipWhitelist: string | null;
  rateLimitRpm: number;
  cacheTtlSeconds: number;
  syncEnabled: boolean;
  syncCron: string | null;
  autoSnapshotOnWrite: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const TTL_SECONDS = 300; // 5 min — short enough that dashboard edits show up fast

function key(idOrSlug: string): string {
  return `sheetApi:${idOrSlug}`;
}

const DATE_FIELDS = ['createdAt', 'updatedAt', 'bearerTokenRotatedAt'] as const;

/**
 * JSON.stringify turns Date fields into ISO strings; rehydrate them so the
 * cached object is structurally identical to a fresh Prisma result. Mutates
 * in place and returns the same reference.
 */
function rehydrateDates(parsed: any): SheetApi {
  for (const f of DATE_FIELDS) {
    const v = parsed?.[f];
    if (v && typeof v === 'string') {
      parsed[f] = new Date(v);
    }
  }
  return parsed as SheetApi;
}

/**
 * Resolve a SheetApi by id or slug, hitting Redis first. On miss, falls back
 * to Prisma (id lookup, then slug) and caches under both id and slug keys so
 * subsequent requests with either form skip Postgres entirely.
 *
 * Returns null when no SheetApi exists — null is NOT cached so a 404 hammer
 * doesn't go stale through dashboard changes. Rate limiting handles that case.
 */
export async function findSheetApiCached(idOrSlug: string): Promise<SheetApi | null> {
  const cached = await cache.get<SheetApi>(key(idOrSlug));
  if (cached) return rehydrateDates(cached);

  let record = await prisma.sheetApi.findUnique({ where: { id: idOrSlug } });
  if (!record) {
    record = await prisma.sheetApi.findUnique({ where: { slug: idOrSlug } });
  }
  if (!record) return null;

  await cache.set(key(record.id), record, TTL_SECONDS);
  if (record.slug && record.slug !== record.id) {
    await cache.set(key(record.slug), record, TTL_SECONDS);
  }
  return record;
}

/**
 * Drop the cache entries for a SheetApi after a mutation. Pass the record
 * (or {id, slug} pair) so both lookup forms get cleared in one call. Also
 * accepts a prior slug to clear when a rename leaves the old slug stale.
 */
export async function invalidateSheetApiCache(
  record: { id: string; slug: string | null },
  previousSlug?: string | null,
): Promise<void> {
  await cache.del(key(record.id));
  if (record.slug) await cache.del(key(record.slug));
  if (previousSlug && previousSlug !== record.slug) {
    await cache.del(key(previousSlug));
  }
}
