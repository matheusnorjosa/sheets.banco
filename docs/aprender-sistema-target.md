# Target adapter — `aprender_sistema`

This document describes the `aprender_sistema` target: an intermediate,
import-oriented projection of `sheets.banco` envelope data, plus the CSV
exports used to feed the destination system.

The adapter and the CSV exports are read-only. Nothing here writes to the
destination system, calls external APIs, or persists state in a database.

## Surfaces

There are six HTTP shapes available on top of the same `:apiId` resource.
They are listed in increasing level of opinion:

| URL | Shape | Stability |
|---|---|---|
| `GET /api/v1/:apiId` | Flat array of rows (legacy) | Stable, never changes |
| `GET /api/v1/:apiId?envelope=v1` | Envelope (records / sheets / summary / document) | Stable v1 |
| `GET /api/v1/:apiId?envelope=v1&target=aprender_sistema` | Envelope **+ `target` field** | Stable v1 |
| `GET /api/v1/:apiId/report?target=aprender_sistema` | Aggregated counts (no PII) | Stable v1 |
| `GET /api/v1/:apiId/export.csv?target=aprender_sistema&type=<type>` | CSV per export type (streamed) | Stable v1 |
| `GET /api/v1/:apiId/workbook.json?sheet=<name>` | Raw per-sheet snapshot for staging imports | Stable v1 |

All four of the envelope/target/report/CSV surfaces accept `?sheet=<name>` to
scope the work to a single tab — see [Per-sheet extraction](#per-sheet-extraction).

### Backward compatibility

- `GET /api/v1/:apiId` (no query params) still returns a plain array.
- `GET /api/v1/:apiId?envelope=v1` without `target` returns the envelope
  exactly as before — no `target` key.
- The `target` field is only attached when `?target=<known>` is explicitly
  requested. Unknown targets return `400 UNSUPPORTED_TARGET`.
- `?sheet=<name>` is opt-in. Without it, the heavy surfaces still process
  every tab — fine for small spreadsheets, risky for big ones.

## Value rendering — `?render=` and `?dateTime=`

Two opt-in params forward directly to Google's `valueRenderOption` and
`dateTimeRenderOption`, letting consumers choose how cell values are
serialised:

| Query | Maps to | Meaning |
|---|---|---|
| `?render=formatted` | `FORMATTED_VALUE` | strings the user sees (default) |
| `?render=unformatted` | `UNFORMATTED_VALUE` | raw types — numbers as numbers, booleans as booleans |
| `?render=formula` | `FORMULA` | formula text when present, else the value |
| `?dateTime=serial` | `SERIAL_NUMBER` | Excel-style serial date |
| `?dateTime=string` | `FORMATTED_STRING` | user-visible date string |

Honored on `GET /:apiId` (legacy), `GET /:apiId?envelope=v1`, and
`GET /:apiId/workbook.json`. **Not** honored on the target adapter paths
(`?target=aprender_sistema`, `/report`, `/export.csv`) — those have their
own normalization layer and need formatted strings.

Default (no param) preserves the previous behaviour exactly.

## Hidden Google Sheets tabs

Hidden Google Sheets tabs (`properties.hidden === true`) are intentionally
excluded from public API outputs. They are not listed in `/sheets` or
`/sheets?include=types` and cannot be exported through `/workbook.json` —
requests targeting a hidden tab by name return a generic `404`. The legacy
`GET /api/v1/:apiId` without `?sheet=` also picks the first **visible** tab
as the default. Hide a tab in the Google Sheets UI to make it disappear
from the API surface.

Cache TTL means hide/unhide operations can take up to ~5 minutes to
reflect in API responses; that trade-off keeps reads cheap.

## Per-sheet extraction

For spreadsheets with many tabs or many rows, **always pass `?sheet=<name>`**.
Each per-sheet request keeps memory bounded to a single tab's worth of records
regardless of how many tabs the spreadsheet has. The legacy "all sheets" mode
(no `?sheet=`) is still supported, but a large enough spreadsheet can run the
API out of memory.

When a single tab is so large that one tab's worth of records doesn't fit in
memory either (the adapter materialises every row before streaming CSV), use
`?range=<A1:Z1000>` alongside `?sheet=` to bound memory to a row slice:

```
GET /api/v1/:apiId/export.csv?target=aprender_sistema&type=review&sheet=Huge&range=A1:Z2000
GET /api/v1/:apiId/export.csv?target=aprender_sistema&type=review&sheet=Huge&range=A2001:Z4000
...
```

`?range=` is honoured on `?envelope=v1[&target=...]`, `/report`, and
`/export.csv`. It requires `?sheet=<name>` (A1 notation is per-tab); using
`?range=` without `?sheet=` returns `400 RANGE_REQUIRES_SHEET`.

Memory model summary:

| Query | Memory ceiling | When to use |
|---|---|---|
| (no `?sheet=`) | whole spreadsheet | only for small spreadsheets |
| `?sheet=X` | one tab | most cases |
| `?sheet=X&range=A1:Z1000` | one slice | when a single tab is too big to fit |

The recommended consumer pattern (the same one the existing Apps Script
extraction uses, proven in production for years):

```
1. GET /api/v1/:apiId/sheets?include=types
   → {
       "sheets": [
         { "name": "Super",  "detected_type": "agenda",    "columns": [...] },
         { "name": "Random", "detected_type": "unknown",   "columns": [...] }
       ]
     }

2. For each sheet whose detected_type is exportable:
   GET /api/v1/:apiId/export.csv?target=aprender_sistema&type=<type>&sheet=N
   GET /api/v1/:apiId/report?target=aprender_sistema&sheet=N
   GET /api/v1/:apiId?envelope=v1&target=aprender_sistema&sheet=N
```

`?include=types` fetches only the first row of each tab (one batched call,
~100ms regardless of spreadsheet size), classifies via the same `detectType`
the envelope uses, and lets the consumer plan extraction without
hardcoding tab names or pulling cell data to discover the schema.

Without `?include=types`, `/sheets` keeps its legacy shape
(`{ sheets: string[] }`) for backward compatibility.

CSV responses are streamed line-by-line (Node `Readable` → HTTP body) so
even a single huge tab does not materialise as one big string server-side.

To avoid Render cold-starts, ping any lightweight endpoint every few minutes
(the Apps Script keep-alive uses `GET /api/v1/:apiId?sheet=X&limit=1`).

## Exportable target types

| `target_type` | Source sheets (detected) | CSV available |
|---|---|---|
| `usuarios` | `users` | yes |
| `produtos_controle` | `produtos` | yes |
| `agenda_solicitacoes` | `eventos`, `agenda` | yes |
| `disponibilidade_bloqueios` | `bloqueios` (only `T`/`P`) | yes |
| `review` | anything ambiguous, invalid, or out-of-contract | yes |

Records that can't be safely projected to one of the four exportable types are
routed to `review` — they remain visible to consumers, but with their raw and
normalized payloads preserved for human inspection.

## CSV exports

### Endpoint

```
GET /api/v1/:apiId/export.csv?target=aprender_sistema&type=<type>
```

Response headers:

```
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename="aprender_sistema_<type>_<apiId>.csv"
```

The CSV body uses RFC-4180 escaping: fields containing `,`, `"`, `\n`, or
`\r` are wrapped in double quotes; internal double quotes are doubled. Lines
are separated by `\r\n`. UTF-8 is preserved; no BOM is emitted.

Null and missing values render as empty CSV fields.

### Error responses

| Status | Code | Trigger |
|---|---|---|
| 400 | `TARGET_REQUIRED` | `target` query param missing |
| 400 | `UNSUPPORTED_TARGET` | `target` is not `aprender_sistema` |
| 400 | `EXPORT_TYPE_REQUIRED` | `type` query param missing |
| 400 | `UNSUPPORTED_EXPORT_TYPE` | `type` is not one of the five supported values |

### Headers per export type

#### `type=usuarios`

```
cpf,nome,email,telefone,cargo,is_active,grupos,issues
```

- `issues` is a `;`-separated list of issue codes (no severity, no message).
- `grupos` is left blank by the adapter — there is no safe mapping from
  `cargo` to RBAC groups yet (see "Not implemented" below).

#### `type=produtos_controle`

```
CÓD,Produto,Quant.,Município,UF,Data,Uso das coleções,issues
```

- Header names keep their accents for compatibility with the destination
  template.
- `Data` is `yyyy-mm-dd`.
- The product is not matched against a canonical catalog — every row carries
  the `PRODUCT_REVIEW_RECOMMENDED` issue.

#### `type=agenda_solicitacoes`

```
municipio,uf,projeto,tipo_evento,data,hora_inicio,hora_fim,coordenador,formador1,formador2,formador3,formador4,formador5,encontro,segmento,local,issues
```

- `data` is `yyyy-mm-dd`; `hora_inicio` and `hora_fim` are `HH:mm:ss`.
- Convidados (guests, by email) are **not** auto-promoted to formadores.
  When the source sheet has guests, the adapter surfaces issues
  (`GUESTS_NOT_IMPORTED`, `FORMADOR_REVIEW_REQUIRED`) but leaves the formador
  columns blank.

#### `type=disponibilidade_bloqueios`

```
usuario,inicio,fim,tipo,motivo,issues
```

- Only rows with `tipo` in `T` or `P` reach this CSV. `D` is routed to
  `review` with reason code `UNSUPPORTED_BLOCK_TYPE_D`.
- Matrix availability sheets (`disponibilidade_mensal`, `disponibilidade_anual`)
  and `deslocamento` rows go to `review` instead.

#### `type=review`

```
source_type,row_number,reason_codes,suggested_target,import_hash,raw,normalized
```

- `reason_codes` is `;`-separated.
- `raw` and `normalized` are serialised as JSON strings (and CSV-escaped on
  top, so double quotes appear doubled).
- This CSV is for human / technical review; it is not safe to import directly.

## What goes to `review`

The adapter routes a record to `review` (instead of an exportable type) when
any of the following holds:

- the underlying envelope record is `invalid` (e.g. missing required field);
- the source sheet is `unknown`;
- a `bloqueios` row has `tipo=D` (unsupported) or an unknown tipo;
- a `eventos` row has a SIM/NÃO leaking into the `titulo` column;
- the source is `disponibilidade_mensal` / `disponibilidade_anual` (matrix
  shape with no stable direct mapping today);
- the source is `deslocamento` (no stable bloqueio contract yet).

Records with warning-only issues (e.g. `DUPLICATE_CPF`, `GUESTS_NOT_IMPORTED`)
stay in their exportable type and carry the issue codes through to the CSV.

## Not implemented (intentionally, in this iteration)

- Product catalog / aliases / confidence score
- Group/RBAC mapping from `cargo`
- A UI for human review
- Direct integration with the destination system
- API calls to or writes into the destination system
- Async import jobs
- Prisma migration to persist any of this server-side

The adapter is a stateless transform. The destination system or a future PR
can layer any of the above on top of these CSVs / envelopes.

## Workbook snapshot — raw per-sheet export for staging

For when the consumer needs the **raw cell data** of a tab (not the target
projection), use:

```
GET /api/v1/:apiId/workbook.json?sheet=<tab name>
```

`?sheet=` is required. There is no full-workbook variant: the smoke against
the Controle workbook showed that a single all-sheets response reliably OOMs
the Render instance. Per-sheet keeps memory bounded.

Response shape:

```json
{
  "api_id": "<id>",
  "exported_at": "2026-05-18T...",
  "sheet": {
    "sheet_index": 0,
    "sheet_name": "🟥 COMPRAS",
    "detected_type": "produtos",
    "headers": ["id", "Produto", "Quant.", "..."],
    "row_count": 1978,
    "rows": [
      {
        "row_number": 2,
        "values": { "id": "<v>", "Produto": "<v>", "...": "<v>" },
        "raw": ["<v>", "<v>", "..."]
      }
    ]
  }
}
```

Key contract details:

- **`headers`** is exactly what the spreadsheet returned for the first row of
  the range (or row 1 when no range is given). It is **not** mutated for
  empty/duplicate columns.
- **`values`** uses safe keys derived from `headers`:
  - Empty/blank header → `__col_<1-based index>` (e.g. `__col_3`).
  - Duplicate header → first stays as-is, subsequent get `__2`, `__3` suffixes
    (e.g. `Produto`, `Produto__2`, `Produto__3`).
- **`raw`** is an array of values in column order — always mirrors the headers
  array length; useful when you need positional access regardless of header
  text.
- **`row_number`** is the spreadsheet row number (1-based; header is row 1
  unless `?range=` anchors elsewhere). Rows whose every cell is empty are
  dropped, but `row_number` always points back to the spreadsheet — so gaps
  in the sequence indicate dropped empty rows.
- **`detected_type`** comes from `detectType` over `headers`. Tabs with
  unknown shapes are **included** in the export with `detected_type: "unknown"`
  — workbook.json never filters tabs by type.
- **`?range=A1:Z1000`** is accepted and forwarded to the same slicing used
  by `/report` / `/export.csv` (PR 9E). When the range does not include the
  spreadsheet's real header row, `headers` and `detected_type` are derived
  from the first row IN the range — paginate by row offset only if you
  understand this.
- **OOB range** (e.g. `A999999:Z999999`) returns `200` with
  `row_count: 0` and `rows: []`, same contract as the rest of the heavy
  surfaces post Issue #20.

Consumer pattern:

```
1. GET /api/v1/:apiId/sheets?include=types
2. For each tab name N (including unknown):
     GET /api/v1/:apiId/workbook.json?sheet=N
```

Full workbook zip / multi-sheet export is **out of scope** for this version
and lives in a future PR if/when the staging consumer needs it.

## Example URLs

Single-tab (recommended for any spreadsheet that might grow):

```
GET /api/v1/my-api/sheets?include=types
GET /api/v1/my-api?envelope=v1&target=aprender_sistema&sheet=Super
GET /api/v1/my-api/report?target=aprender_sistema&sheet=Super
GET /api/v1/my-api/export.csv?target=aprender_sistema&type=agenda_solicitacoes&sheet=Super
GET /api/v1/my-api/workbook.json?sheet=Super
```

Paginated within a tab (for tabs large enough to OOM on their own):

```
GET /api/v1/my-api/export.csv?target=aprender_sistema&type=review&sheet=Huge&range=A1:Z2000
GET /api/v1/my-api/export.csv?target=aprender_sistema&type=review&sheet=Huge&range=A2001:Z4000
```

All-tabs (only safe for small spreadsheets):

```
GET /api/v1/my-api?envelope=v1&target=aprender_sistema
GET /api/v1/my-api/report?target=aprender_sistema
GET /api/v1/my-api/export.csv?target=aprender_sistema&type=usuarios
GET /api/v1/my-api/export.csv?target=aprender_sistema&type=produtos_controle
GET /api/v1/my-api/export.csv?target=aprender_sistema&type=agenda_solicitacoes
GET /api/v1/my-api/export.csv?target=aprender_sistema&type=disponibilidade_bloqueios
GET /api/v1/my-api/export.csv?target=aprender_sistema&type=review
```
