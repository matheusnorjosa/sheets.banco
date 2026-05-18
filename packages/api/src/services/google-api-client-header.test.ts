/**
 * Tests for the x-goog-api-client header builder (issue #32).
 * The mock for googleapis is here too, but it's unused — the import side
 * effect (google.options being called once at module load) is what we want
 * to keep silent during tests.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('googleapis', () => ({
  google: {
    options: vi.fn(),
    sheets: () => ({
      spreadsheets: {
        get: vi.fn(),
        values: { get: vi.fn(), batchGet: vi.fn() },
      },
    }),
  },
}));

vi.mock('./oauth-pool.service.js', () => ({
  getOAuthClient: vi.fn(async () => ({})),
}));

vi.mock('./cache.service.js', () => ({
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => {}),
  del: vi.fn(async () => {}),
  invalidate: vi.fn(async () => {}),
}));

import { buildGoogleApiClientHeader } from './google-sheets.service.js';
import { google } from 'googleapis';

describe('buildGoogleApiClientHeader', () => {
  it('emits `gl-nodejs/sheets.banco-<version>` for a real version', () => {
    expect(buildGoogleApiClientHeader('0.1.0')).toBe('gl-nodejs/sheets.banco-0.1.0');
    expect(buildGoogleApiClientHeader('1.2.3-rc.4')).toBe('gl-nodejs/sheets.banco-1.2.3-rc.4');
  });

  it('falls back to "unknown" when the version is empty', () => {
    expect(buildGoogleApiClientHeader('')).toBe('gl-nodejs/sheets.banco-unknown');
  });
});

describe('module load — google.options', () => {
  it('was called once with an x-goog-api-client header', () => {
    // google.options is invoked at import time. By the time this test runs,
    // it has already been called. Check the call site emitted the right shape.
    const calls = (google.options as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const firstArg = calls[0]?.[0] as { headers?: Record<string, string> };
    expect(firstArg).toBeDefined();
    expect(firstArg.headers).toBeDefined();
    expect(firstArg.headers!['x-goog-api-client']).toMatch(/^gl-nodejs\/sheets\.banco-/);
  });
});
