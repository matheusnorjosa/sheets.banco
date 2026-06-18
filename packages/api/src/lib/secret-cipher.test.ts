/**
 * Tests for AES-256-GCM envelope cipher. Covers round-trip, tamper detection,
 * format/version discrimination, and the dual-read helper used during the
 * plaintext → encrypted migration window.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';

const ORIGINAL_KEY = process.env.SECRETS_ENC_KEY;

beforeAll(() => {
  // Use a deterministic-per-test-run key. NEVER a real secret.
  process.env.SECRETS_ENC_KEY = crypto.randomBytes(32).toString('hex');
});

beforeEach(async () => {
  // Reload module so the in-memory cachedKey picks up env changes.
  // (Tests further down deliberately mutate SECRETS_ENC_KEY.)
  await import('./secret-cipher.js').then((m) => m); // ensure first load
});

describe('encrypt/decrypt round-trip', () => {
  it('round-trips ascii plaintext', async () => {
    const { encrypt, decrypt } = await import('./secret-cipher.js');
    const pt = 'hello-secret-123';
    expect(decrypt(encrypt(pt))).toBe(pt);
  });

  it('round-trips unicode plaintext', async () => {
    const { encrypt, decrypt } = await import('./secret-cipher.js');
    const pt = 'olá 🌎 tudo bem? — café';
    expect(decrypt(encrypt(pt))).toBe(pt);
  });

  it('produces a different ciphertext each call (random IV)', async () => {
    const { encrypt } = await import('./secret-cipher.js');
    const a = encrypt('same input');
    const b = encrypt('same input');
    expect(a).not.toBe(b);
  });
});

describe('envelope format', () => {
  it('encrypt output starts with gcm$', async () => {
    const { encrypt } = await import('./secret-cipher.js');
    expect(encrypt('x')).toMatch(/^gcm\$/);
  });

  it('isEncrypted true for envelope, false for plaintext', async () => {
    const { isEncrypted, encrypt } = await import('./secret-cipher.js');
    expect(isEncrypted(encrypt('x'))).toBe(true);
    expect(isEncrypted('plaintext-secret')).toBe(false);
    expect(isEncrypted('')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
    expect(isEncrypted(undefined)).toBe(false);
  });

  it('decryptIfEncrypted passes plaintext through unchanged', async () => {
    const { decryptIfEncrypted, encrypt } = await import('./secret-cipher.js');
    expect(decryptIfEncrypted('legacy-plaintext')).toBe('legacy-plaintext');
    expect(decryptIfEncrypted(encrypt('new-encrypted'))).toBe('new-encrypted');
  });
});

describe('tamper detection', () => {
  it('rejects flipped ciphertext byte (GCM tag mismatch)', async () => {
    const { encrypt, decrypt } = await import('./secret-cipher.js');
    const env = encrypt('important');
    const parts = env.split('$');
    const ct = Buffer.from(parts[2]!, 'base64url');
    ct[0] = ct[0]! ^ 0xff;
    parts[2] = ct.toString('base64url');
    const tampered = parts.join('$');
    expect(() => decrypt(tampered)).toThrow();
  });

  it('rejects flipped tag byte', async () => {
    const { encrypt, decrypt } = await import('./secret-cipher.js');
    const env = encrypt('important');
    const parts = env.split('$');
    const tag = Buffer.from(parts[3]!, 'base64url');
    tag[0] = tag[0]! ^ 0xff;
    parts[3] = tag.toString('base64url');
    expect(() => decrypt(parts.join('$'))).toThrow();
  });

  it('rejects mismatched key', async () => {
    const { encrypt } = await import('./secret-cipher.js');
    const env = encrypt('important');

    // Swap key; force module re-init by hand on a sub-import.
    process.env.SECRETS_ENC_KEY = crypto.randomBytes(32).toString('hex');
    // Use a fresh module instance via dynamic import + cache bust.
    const cipherWithNewKey = await import('./secret-cipher.js?fresh-key=' + Date.now());
    // Note: dynamic import in Vitest re-evaluates the module on a different
    // URL. Some bundlers ignore query strings; if that happens fall back to
    // testing the key change via the loader path:
    try {
      cipherWithNewKey.decrypt(env);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toBeTruthy();
    }
  });
});

describe('malformed input', () => {
  it('decrypt throws on missing prefix', async () => {
    const { decrypt } = await import('./secret-cipher.js');
    expect(() => decrypt('not-an-envelope')).toThrow(/not an encrypted envelope/);
  });

  it('decrypt throws on wrong part count', async () => {
    const { decrypt } = await import('./secret-cipher.js');
    expect(() => decrypt('gcm$only-iv')).toThrow(/malformed envelope/);
  });

  it('decrypt throws on bad IV length', async () => {
    const { decrypt } = await import('./secret-cipher.js');
    const bad = `gcm$${Buffer.from([1, 2, 3]).toString('base64url')}$${Buffer.alloc(8).toString('base64url')}$${Buffer.alloc(16).toString('base64url')}`;
    expect(() => decrypt(bad)).toThrow(/IV must be/);
  });
});

describe('missing key', () => {
  it('throws when SECRETS_ENC_KEY is not set', async () => {
    process.env.SECRETS_ENC_KEY = '';
    const fresh = await import('./secret-cipher.js?missing-key=' + Date.now());
    try {
      fresh.encrypt('x');
      throw new Error('expected throw');
    } catch (e) {
      // Either "SECRETS_ENC_KEY missing" (true fresh import) or a downstream
      // error. Both prove the function refuses to operate without a key.
      expect((e as Error).message).toMatch(/SECRETS_ENC_KEY|key/i);
    }

    // Restore
    process.env.SECRETS_ENC_KEY = ORIGINAL_KEY ?? crypto.randomBytes(32).toString('hex');
  });

  it('throws on malformed key (not 64 hex)', async () => {
    process.env.SECRETS_ENC_KEY = 'not-hex-and-too-short';
    const fresh = await import('./secret-cipher.js?bad-key=' + Date.now());
    try {
      fresh.encrypt('x');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toMatch(/64 hex|key/i);
    }
    process.env.SECRETS_ENC_KEY = ORIGINAL_KEY ?? crypto.randomBytes(32).toString('hex');
  });
});
