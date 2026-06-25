/**
 * One-off migration: backfill bcrypt hashes for SheetApi.bearerToken,
 * SheetApi.bearerTokenPrevious, SheetApi.basicPass, and ApiKey.key.
 *
 * Idempotent — rows whose `*Hash` column is already populated are skipped.
 * Rows with null plaintext are skipped (nothing to hash).
 *
 * No external key required (bcrypt is self-contained).
 *
 * Usage:
 *   DATABASE_URL=... npx tsx packages/api/scripts/backfill-hashes.ts
 *
 * Output: counts only — never logs plaintext, hashes, or row IDs alongside
 * the plaintext.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { deriveKeyPrefix } from '../src/lib/api-key-lookup.js';

const prisma = new PrismaClient();
const BCRYPT_ROUNDS = 10;

interface ColStats {
  scanned: number;
  alreadyHashed: number;
  newlyHashed: number;
  skippedNull: number;
}

function emptyStats(): ColStats {
  return { scanned: 0, alreadyHashed: 0, newlyHashed: 0, skippedNull: 0 };
}

async function backfillSheetApis(): Promise<{
  bearerToken: ColStats;
  bearerTokenPrevious: ColStats;
  basicPass: ColStats;
}> {
  const result = {
    bearerToken: emptyStats(),
    bearerTokenPrevious: emptyStats(),
    basicPass: emptyStats(),
  };
  const apis = await prisma.sheetApi.findMany({
    select: {
      id: true,
      bearerToken: true,
      bearerTokenHash: true,
      bearerTokenPrevious: true,
      bearerTokenPreviousHash: true,
      basicPass: true,
      basicPassHash: true,
    },
  });
  for (const api of apis) {
    const updates: Record<string, string> = {};

    result.bearerToken.scanned++;
    if (api.bearerTokenHash) {
      result.bearerToken.alreadyHashed++;
    } else if (api.bearerToken) {
      updates.bearerTokenHash = await bcrypt.hash(api.bearerToken, BCRYPT_ROUNDS);
      result.bearerToken.newlyHashed++;
    } else {
      result.bearerToken.skippedNull++;
    }

    result.bearerTokenPrevious.scanned++;
    if (api.bearerTokenPreviousHash) {
      result.bearerTokenPrevious.alreadyHashed++;
    } else if (api.bearerTokenPrevious) {
      updates.bearerTokenPreviousHash = await bcrypt.hash(api.bearerTokenPrevious, BCRYPT_ROUNDS);
      result.bearerTokenPrevious.newlyHashed++;
    } else {
      result.bearerTokenPrevious.skippedNull++;
    }

    result.basicPass.scanned++;
    if (api.basicPassHash) {
      result.basicPass.alreadyHashed++;
    } else if (api.basicPass) {
      updates.basicPassHash = await bcrypt.hash(api.basicPass, BCRYPT_ROUNDS);
      result.basicPass.newlyHashed++;
    } else {
      result.basicPass.skippedNull++;
    }

    if (Object.keys(updates).length > 0) {
      await prisma.sheetApi.update({ where: { id: api.id }, data: updates });
    }
  }
  return result;
}

async function backfillApiKeys(): Promise<ColStats> {
  const stats = emptyStats();
  const keys = await prisma.apiKey.findMany({
    select: { id: true, key: true, keyHash: true, keyPrefix: true },
  });
  for (const k of keys) {
    stats.scanned++;
    if (k.keyHash && k.keyPrefix) {
      stats.alreadyHashed++;
      continue;
    }
    if (!k.key) {
      stats.skippedNull++;
      continue;
    }
    await prisma.apiKey.update({
      where: { id: k.id },
      data: {
        keyHash: k.keyHash ?? (await bcrypt.hash(k.key, BCRYPT_ROUNDS)),
        keyPrefix: k.keyPrefix ?? deriveKeyPrefix(k.key),
      },
    });
    stats.newlyHashed++;
  }
  return stats;
}

function printStats(label: string, s: ColStats): void {
  console.log(
    `  ${label}: scanned=${s.scanned} alreadyHashed=${s.alreadyHashed} newlyHashed=${s.newlyHashed} skippedNull=${s.skippedNull}`,
  );
}

async function main(): Promise<void> {
  console.log('SheetApi columns ...');
  const sheetStats = await backfillSheetApis();
  printStats('bearerToken', sheetStats.bearerToken);
  printStats('bearerTokenPrevious', sheetStats.bearerTokenPrevious);
  printStats('basicPass', sheetStats.basicPass);

  console.log('ApiKey ...');
  const apiKeyStats = await backfillApiKeys();
  printStats('key', apiKeyStats);
}

main()
  .catch((e) => {
    console.error('backfill failed:', (e as Error).message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
