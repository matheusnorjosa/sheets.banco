import crypto from 'node:crypto';

/**
 * AES-256-GCM envelope cipher for "secrets at rest" — hmacSecret,
 * WebhookSubscription.secret, and any future plaintext credentials the DB
 * carries. Format on disk:
 *
 *     gcm$<iv_b64url>$<ciphertext_b64url>$<tag_b64url>
 *
 * Prefix discriminates the format so the dual-read transition (plaintext +
 * encrypted) can call `isEncrypted(s)` and route to the right path during
 * the migration window. The `gcm` tag is the algorithm version — bump to
 * `gcm2` if the algorithm ever changes.
 *
 * Key sourcing: `SECRETS_ENC_KEY` env (64 hex chars = 32 bytes). Required in
 * production, optional in dev/test (so unit tests that don't touch encrypted
 * fields keep working). `encrypt`/`decrypt` throw a descriptive error in
 * dev/test if the key is absent — fail-loud, not silently fall back to
 * plaintext.
 *
 * Key rotation: not handled here. To rotate, decrypt with old key, re-encrypt
 * with new — a one-off script, since this codebase has no built-in DEK
 * versioning. Document in docs/api-security.md.
 */

const PREFIX = 'gcm$';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function loadKey(): Buffer {
  const hex = process.env.SECRETS_ENC_KEY;
  if (!hex) {
    throw new Error(
      'SECRETS_ENC_KEY missing. Set to 64 hex chars (32 bytes). Generate: ' +
        'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('SECRETS_ENC_KEY must be 64 hex chars (32 bytes).');
  }
  return Buffer.from(hex, 'hex');
}

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (!cachedKey) cachedKey = loadKey();
  return cachedKey;
}

/** True if `s` carries an encrypted envelope (the `gcm$` prefix). */
export function isEncrypted(s: string | null | undefined): boolean {
  return typeof s === 'string' && s.startsWith(PREFIX);
}

/** Encrypt a UTF-8 string. Random IV per call (GCM requirement). */
export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${b64(iv)}$${b64(ct)}$${b64(tag)}`;
}

/**
 * Decrypt an envelope produced by `encrypt`. Throws on tampered ciphertext
 * (GCM tag mismatch) or malformed input — intentional; silent fallback would
 * mask compromise.
 */
export function decrypt(envelope: string): string {
  if (!isEncrypted(envelope)) {
    throw new Error('decrypt: input is not an encrypted envelope (missing gcm$ prefix)');
  }
  const parts = envelope.slice(PREFIX.length).split('$');
  if (parts.length !== 3) {
    throw new Error('decrypt: malformed envelope (expected iv$ct$tag)');
  }
  const [ivB64, ctB64, tagB64] = parts as [string, string, string];
  const iv = ub64(ivB64);
  const ct = ub64(ctB64);
  const tag = ub64(tagB64);
  if (iv.length !== IV_BYTES) throw new Error(`decrypt: IV must be ${IV_BYTES} bytes`);
  if (tag.length !== TAG_BYTES) throw new Error(`decrypt: tag must be ${TAG_BYTES} bytes`);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * Dual-read helper for the migration window. Returns the plaintext for any
 * stored value — accepts both legacy plaintext and the new envelope. Use this
 * everywhere a DB column today holds a raw secret string; swap callers to
 * `decrypt` directly once the migration is done and the legacy plaintext is
 * gone from the DB.
 */
export function decryptIfEncrypted(value: string): string {
  return isEncrypted(value) ? decrypt(value) : value;
}

/**
 * Only call after `SECRETS_ENC_KEY` validation has run — use during startup
 * to fail loudly when prod is misconfigured rather than at the first read of
 * an encrypted column. No-op in dev/test if no key (the lazy `loadKey` path
 * still throws on the first encrypt/decrypt call).
 */
export function eagerLoadCipherKey(): void {
  // Read NODE_ENV directly (not via the validated env module) so this file
  // stays usable in test setups that don't supply DATABASE_URL etc.
  if (process.env.NODE_ENV === 'production' || process.env.SECRETS_ENC_KEY) {
    loadKey();
  }
}

// base64url helpers — same alphabet Node accepts natively in v16+.
function b64(buf: Buffer): string {
  return buf.toString('base64url');
}
function ub64(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}
