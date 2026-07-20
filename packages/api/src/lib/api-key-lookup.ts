import bcrypt from 'bcrypt';
import { prisma } from './prisma.js';

/**
 * Shape returned by lookup — the fields `apiAuth` needs from a Prisma row to
 * decide whether a key is usable: ownership, active, expiry and scopes.
 */
export interface ApiKeyRecord {
  id: string;
  sheetApiId: string;
  active: boolean;
  scopes: string[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/**
 * Width of the indexed prefix we store alongside the bcrypt hash. bcrypt
 * salts each hash with random bytes, so a direct `WHERE keyHash = bcrypt(x)`
 * is impossible — instead we narrow candidates by an indexed prefix of the
 * plaintext, then bcrypt.compare against each.
 *
 * 8 hex chars from a cuid is ~32 bits of entropy → ~1 in 4 billion collision
 * for unrelated keys. With ~hundreds of keys in flight, prefix lookup returns
 * 1 candidate at p>0.999; the loop below tolerates collisions gracefully.
 */
export const KEY_PREFIX_LEN = 8;

export function deriveKeyPrefix(plaintext: string): string {
  return plaintext.slice(0, KEY_PREFIX_LEN);
}

/**
 * Resolve an ApiKey by plaintext header value. Two paths during the #99
 * migration window:
 *
 *   1. New path — find candidates by `keyPrefix` index, bcrypt.compare each
 *      until a match.
 *   2. Legacy path — if no candidate matched the new path, try the unique
 *      plaintext lookup. Skips entirely once the legacy column drops.
 *
 * Returns null when neither path matches; callers treat null as 401.
 */
export async function findApiKeyByPlaintext(plaintext: string): Promise<ApiKeyRecord | null> {
  // Path 1: indexed prefix + bcrypt.compare
  const prefix = deriveKeyPrefix(plaintext);
  const candidates = await prisma.apiKey.findMany({
    where: { keyPrefix: prefix },
    select: {
      id: true,
      sheetApiId: true,
      keyHash: true,
      active: true,
      scopes: true,
      expiresAt: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });
  for (const cand of candidates) {
    if (!cand.keyHash) continue;
    try {
      if (await bcrypt.compare(plaintext, cand.keyHash)) {
        return {
          id: cand.id,
          sheetApiId: cand.sheetApiId,
          active: cand.active,
          scopes: cand.scopes,
          expiresAt: cand.expiresAt,
          lastUsedAt: cand.lastUsedAt,
          createdAt: cand.createdAt,
        };
      }
    } catch {
      // Treat malformed/legacy hashes as a non-match; the legacy plaintext
      // path below covers them.
    }
  }

  // Path 2: legacy plaintext (will be removed after backfill window)
  const legacy = await prisma.apiKey.findUnique({
    where: { key: plaintext },
    select: {
      id: true,
      sheetApiId: true,
      active: true,
      scopes: true,
      expiresAt: true,
      lastUsedAt: true,
      createdAt: true,
    },
  });
  return legacy;
}
