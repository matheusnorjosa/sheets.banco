import type { Envelope, EnvelopeRecord } from '../../envelope/build.js';
import { buildEnvelope } from '../../envelope/build.js';
import type { RawRow } from '../../normalize/row.js';

/**
 * Test-only helper to build an envelope around a single sheet. Keeps each test
 * file readable.
 */
export function envelopeOf(sheetName: string, rows: RawRow[]): Envelope {
  return buildEnvelope({
    apiId: 'test-api',
    apiName: 'Test API',
    sheets: [{ name: sheetName, rows }],
  });
}

export function recordsOf(envelope: Envelope): EnvelopeRecord[] {
  return envelope.records;
}
