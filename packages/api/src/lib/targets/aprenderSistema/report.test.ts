import { describe, it, expect } from 'vitest';
import { buildAprenderSistemaTarget } from './index.js';
import { buildAprenderSistemaReport } from './report.js';
import { envelopeOf } from './test-helpers.js';

describe('aprender_sistema target — report', () => {
  it('aggregates totals by type and issue codes', () => {
    const env = envelopeOf('Usuários', [
      { Nome: 'A', CPF: '12345678901', Email: 'a@example.com', Cargo: 'X', 'Gerência': 'Y' },
      { Nome: 'B', CPF: '98765432109', Email: 'b@example.com', Cargo: 'X', 'Gerência': 'Y' },
    ]);
    const target = buildAprenderSistemaTarget(env);
    const report = buildAprenderSistemaReport(target);

    expect(report.target).toBe('aprender_sistema');
    expect(report.total_records).toBe(2);
    expect(report.exportable_records).toBe(2);
    expect(report.review_records).toBe(0);
    expect(report.by_type.usuarios).toBe(2);
    // GROUP_MAPPING_REQUIRED is info severity — should NOT appear in
    // warnings_by_code or issues_by_code.
    expect(report.warnings_by_code.GROUP_MAPPING_REQUIRED).toBeUndefined();
    expect(report.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('counts review records separately from exportable', () => {
    const env = envelopeOf('Random', [{ foo: 'bar' }]);
    const report = buildAprenderSistemaReport(buildAprenderSistemaTarget(env));
    expect(report.review_records).toBe(1);
    expect(report.exportable_records).toBe(0);
    expect(report.by_type.review).toBe(1);
  });

  it('issues_by_code captures errors from invalid records routed to review', () => {
    const env = envelopeOf('Usuários', [
      // Missing CPF -> invalid -> review (errors preserved in record.issues).
      { Nome: 'A', CPF: '', Email: 'a@example.com', Cargo: 'X', 'Gerência': 'Y' },
    ]);
    const report = buildAprenderSistemaReport(buildAprenderSistemaTarget(env));
    expect(report.review_records).toBe(1);
    expect(report.issues_by_code.CPF_REQUIRED).toBe(1);
  });
});
