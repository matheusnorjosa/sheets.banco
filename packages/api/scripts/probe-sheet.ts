/**
 * probe-sheet — safe, metrics-only diagnostic for matrix-shaped tabs.
 *
 * Calls GET /:apiId/workbook.json against a running sheets.banco instance
 * and prints shape metrics ONLY. Never prints cell content, header names,
 * row payloads, or the credential — even on error.
 *
 * Auth:
 *   - `API_KEY`     → sent as `X-API-Key: <value>` (current real contract)
 *   - `API_BEARER`  → sent as `Authorization: Bearer <value>` (fallback)
 *   - When both are set, `API_KEY` wins.
 *   - When neither is set, the script aborts before any HTTP call.
 *
 * Usage:
 *   API_BASE_URL=https://sheets-banco-api.onrender.com \
 *   API_KEY=<api-key> \
 *   tsx scripts/probe-sheet.ts \
 *     --apiId <cuid> \
 *     --sheet "ℹ️ FORMAÇÕES" \
 *     --ranges "A1:Z20,A3:AZ30,A5:AZ40,A10:AZ60"
 *
 * Each range is probed sequentially. Output is one JSON line per probe so
 * results stream cleanly. The script does not write to disk. Pipe the
 * output to `jq -s .` if you want an array, or to a file you control.
 */

type AuthMode = 'apikey' | 'bearer';

interface ProbeArgs {
  apiId: string;
  sheet: string;
  ranges: string[];
  headerRows: number[];
  baseUrl: string;
  auth: { mode: AuthMode; value: string };
}

interface ProbeMetric {
  sheet_name: string;
  range: string | null;
  header_row: number | null;
  status: number;
  row_count: number | null;
  headers_count: number | null;
  non_empty_headers_count: number | null;
  empty_header_count: number | null;
  has_duplicate_headers: boolean | null;
  raw_width_mode: number | null;
  raw_width_distribution: Record<string, number> | null;
  values_keys_count: number | null;
  detected_type: string | null;
  error_code: string | null;
}

function parseArgs(argv: string[]): ProbeArgs {
  const out: Partial<ProbeArgs> = { ranges: [], headerRows: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === '--apiId') { out.apiId = next; i++; }
    else if (a === '--sheet') { out.sheet = next; i++; }
    else if (a === '--ranges' && next) { out.ranges = next.split(',').map((s) => s.trim()).filter(Boolean); i++; }
    else if (a === '--headerRows' && next) { out.headerRows = next.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0); i++; }
  }
  out.baseUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';
  const apiKey = process.env.API_KEY;
  const bearer = process.env.API_BEARER;
  if (apiKey) out.auth = { mode: 'apikey', value: apiKey };
  else if (bearer) out.auth = { mode: 'bearer', value: bearer };
  else throw new Error('Missing API_KEY or API_BEARER');
  if (!out.apiId) throw new Error('Missing --apiId');
  if (!out.sheet) throw new Error('Missing --sheet');
  if ((out.ranges?.length ?? 0) === 0 && (out.headerRows?.length ?? 0) === 0) {
    throw new Error('Pass at least one --ranges or --headerRows value (the no-arg call is the existing default behaviour and is already in your manifest.json — running it here adds nothing).');
  }
  return out as ProbeArgs;
}

function histogram(rows: Array<{ raw?: unknown }>): Record<number, number> {
  const h: Record<number, number> = {};
  for (const r of rows) {
    const raw = (r as { raw?: unknown }).raw;
    const w = Array.isArray(raw) ? raw.length : 0;
    h[w] = (h[w] ?? 0) + 1;
  }
  return h;
}

function modeWidth(hist: Record<number, number>): number {
  let best = 0;
  let bestCount = -1;
  for (const [k, v] of Object.entries(hist)) {
    if (v > bestCount) { bestCount = v; best = parseInt(k, 10); }
  }
  return best;
}

async function probe(args: ProbeArgs, range: string | null, headerRow: number | null): Promise<ProbeMetric> {
  const params = new URLSearchParams({ sheet: args.sheet });
  if (range) params.set('range', range);
  if (headerRow !== null) params.set('headerRow', String(headerRow));
  const url = `${args.baseUrl}/api/v1/${encodeURIComponent(args.apiId)}/workbook.json?${params.toString()}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (args.auth.mode === 'apikey') headers['X-API-Key'] = args.auth.value;
  else headers.Authorization = `Bearer ${args.auth.value}`;

  const res = await fetch(url, { headers });
  const status = res.status;
  const metric: ProbeMetric = {
    sheet_name: args.sheet,
    range,
    header_row: headerRow,
    status,
    row_count: null,
    headers_count: null,
    non_empty_headers_count: null,
    empty_header_count: null,
    has_duplicate_headers: null,
    raw_width_mode: null,
    raw_width_distribution: null,
    values_keys_count: null,
    detected_type: null,
    error_code: null,
  };

  let body: unknown;
  try { body = await res.json(); } catch { body = null; }

  if (status !== 200 || !body || typeof body !== 'object') {
    const obj = (body ?? {}) as { code?: string };
    metric.error_code = typeof obj.code === 'string' ? obj.code : null;
    return metric;
  }

  const sheet = (body as { sheet?: unknown }).sheet;
  if (!sheet || typeof sheet !== 'object') return metric;

  const headersArr = (sheet as { headers?: unknown }).headers;
  if (Array.isArray(headersArr)) {
    metric.headers_count = headersArr.length;
    const empty = headersArr.filter((h) => typeof h === 'string' && h.trim() === '').length;
    metric.empty_header_count = empty;
    metric.non_empty_headers_count = headersArr.length - empty;
    const distinct = new Set(headersArr.map((h) => String(h ?? '')));
    metric.has_duplicate_headers = distinct.size !== headersArr.length;
  }

  const rows = (sheet as { rows?: unknown }).rows;
  if (Array.isArray(rows)) {
    const hist = histogram(rows as Array<{ raw?: unknown }>);
    metric.raw_width_mode = modeWidth(hist);
    metric.raw_width_distribution = Object.fromEntries(Object.entries(hist));
    // values keys: take the first row's values object (count only)
    const first = rows[0] as { values?: unknown } | undefined;
    if (first && typeof first.values === 'object' && first.values !== null) {
      metric.values_keys_count = Object.keys(first.values as Record<string, unknown>).length;
    }
  }
  metric.row_count = typeof (sheet as { row_count?: unknown }).row_count === 'number'
    ? ((sheet as { row_count: number }).row_count)
    : null;
  metric.detected_type = typeof (sheet as { detected_type?: unknown }).detected_type === 'string'
    ? ((sheet as { detected_type: string }).detected_type)
    : null;
  return metric;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const range of args.ranges.length ? args.ranges : [null]) {
    for (const headerRow of args.headerRows.length ? args.headerRows : [null]) {
      if (range === null && headerRow === null) continue;
      try {
        const m = await probe(args, range, headerRow);
        process.stdout.write(JSON.stringify(m) + '\n');
      } catch (err) {
        process.stdout.write(JSON.stringify({
          sheet_name: args.sheet,
          range,
          header_row: headerRow,
          status: 0,
          error_code: (err as Error).message,
        }) + '\n');
      }
    }
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
