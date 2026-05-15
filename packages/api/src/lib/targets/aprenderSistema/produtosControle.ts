import type { EnvelopeRecord } from '../../envelope/build.js';
import type { NormalizedProduto } from '../../normalize/types/produtos.js';
import type { TargetProdutosControle, TargetRecord, TargetIssue } from './types.js';
import { buildReviewRecord } from './review.js';

export function adaptProdutosControleRecord(rec: EnvelopeRecord): TargetRecord {
  if (rec.validation.status === 'invalid') {
    return buildReviewRecord(rec, 'produtos', { suggested_target: 'produtos_controle' });
  }

  const n = rec.normalized as unknown as NormalizedProduto;
  const issues: TargetIssue[] = [];

  for (const w of rec.validation.warnings) {
    issues.push({ code: w.code, severity: 'warning', message: w.message, field: w.field });
  }

  // We don't have a product catalog yet — every row gets a soft hint so the
  // consumer knows the produto name is unverified. Catalog is a future PR.
  issues.push({
    code: 'PRODUCT_REVIEW_RECOMMENDED',
    severity: 'info',
    message: 'Produto não conferido contra catálogo canônico (catálogo não implementado).',
    field: 'produto',
  });

  return {
    target_type: 'produtos_controle',
    codigo: n.codigo_original || null,
    produto: n.produto_original,
    quantidade: n.quantidade ?? 0,
    municipio: n.municipio_original,
    uf: n.uf ?? '',
    data: n.data ?? '',
    uso_das_colecoes: n.uso_colecao_2026 === null
      ? null
      : n.uso_colecao_2026 ? 'SIM' : 'NAO',
    source_row_number: rec.source.row_number ?? null,
    import_hash: rec.import_hash,
    issues,
  };
}
