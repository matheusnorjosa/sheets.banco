/**
 * One-off migration: re-encrypt SheetApi.hmacSecret and
 * WebhookSubscription.secret in place.
 *
 * Iterates all rows. Rows whose value is already encrypted (gcm$ prefix) are
 * skipped — idempotent, safe to re-run. Rows with legacy plaintext are
 * encrypted and written back. Rows with null are left alone.
 *
 * Requires SECRETS_ENC_KEY env (64 hex chars, 32 bytes). Set it BEFORE running.
 *
 * Usage:
 *   SECRETS_ENC_KEY=<key> npx tsx scripts/encrypt-secrets.ts
 *
 * Output: counts only — never logs plaintext, encrypted blobs, or row IDs
 * tied to plaintext.
 */
import { PrismaClient } from '@prisma/client';
import { encrypt, isEncrypted } from '../src/lib/secret-cipher.js';

const prisma = new PrismaClient();

interface MigrationStats {
  scanned: number;
  alreadyEncrypted: number;
  newlyEncrypted: number;
  skippedNull: number;
}

async function migrateSheetApis(): Promise<MigrationStats> {
  const stats: MigrationStats = {
    scanned: 0,
    alreadyEncrypted: 0,
    newlyEncrypted: 0,
    skippedNull: 0,
  };
  const apis = await prisma.sheetApi.findMany({
    select: { id: true, hmacSecret: true },
  });
  for (const api of apis) {
    stats.scanned++;
    if (api.hmacSecret === null) {
      stats.skippedNull++;
      continue;
    }
    if (isEncrypted(api.hmacSecret)) {
      stats.alreadyEncrypted++;
      continue;
    }
    await prisma.sheetApi.update({
      where: { id: api.id },
      data: { hmacSecret: encrypt(api.hmacSecret) },
    });
    stats.newlyEncrypted++;
  }
  return stats;
}

async function migrateWebhookSubscriptions(): Promise<MigrationStats> {
  const stats: MigrationStats = {
    scanned: 0,
    alreadyEncrypted: 0,
    newlyEncrypted: 0,
    skippedNull: 0,
  };
  const subs = await prisma.webhookSubscription.findMany({
    select: { id: true, secret: true },
  });
  for (const sub of subs) {
    stats.scanned++;
    if (isEncrypted(sub.secret)) {
      stats.alreadyEncrypted++;
      continue;
    }
    await prisma.webhookSubscription.update({
      where: { id: sub.id },
      data: { secret: encrypt(sub.secret) },
    });
    stats.newlyEncrypted++;
  }
  return stats;
}

async function main(): Promise<void> {
  if (!process.env.SECRETS_ENC_KEY) {
    console.error('SECRETS_ENC_KEY is required. Set to 64 hex chars before running.');
    process.exit(1);
  }

  console.log('SheetApi.hmacSecret ...');
  const apiStats = await migrateSheetApis();
  console.log(`  scanned=${apiStats.scanned} alreadyEncrypted=${apiStats.alreadyEncrypted} newlyEncrypted=${apiStats.newlyEncrypted} skippedNull=${apiStats.skippedNull}`);

  console.log('WebhookSubscription.secret ...');
  const subStats = await migrateWebhookSubscriptions();
  console.log(`  scanned=${subStats.scanned} alreadyEncrypted=${subStats.alreadyEncrypted} newlyEncrypted=${subStats.newlyEncrypted} skippedNull=${subStats.skippedNull}`);
}

main()
  .catch((e) => {
    console.error('migration failed:', (e as Error).message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
