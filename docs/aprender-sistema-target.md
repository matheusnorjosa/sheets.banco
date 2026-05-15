# Target adapter — `aprender_sistema`

This document describes the `aprender_sistema` target: an intermediate,
import-oriented projection of `sheets.banco` envelope data, plus the CSV
exports used to feed the destination system.

The adapter and the CSV exports are read-only. Nothing here writes to the
destination system, calls external APIs, or persists state in a database.

## Surfaces

There are five HTTP shapes available on top of the same `:apiId` resource.
They are listed in increasing level of opinion:

| URL | Shape | Stability |
|---|---|---|
| `GET /api/v1/:apiId` | Flat array of rows (legacy) | Stable, never changes |
| `GET /api/v1/:apiId?envelope=v1` | Envelope (records / sheets / summary / document) | Stable v1 |
| `GET /api/v1/:apiId?envelope=v1&target=aprender_sistema` | Envelope **+ `target` field** | Stable v1 |
| `GET /api/v1/:apiId/report?target=aprender_sistema` | Aggregated counts (no PII) | Stable v1 |
| `GET /api/v1/:apiId/export.csv?target=aprender_sistema&type=<type>` | CSV per export type | Stable v1 |

### Backward compatibility

- `GET /api/v1/:apiId` (no query params) still returns a plain array.
- `GET /api/v1/:apiId?envelope=v1` without `target` returns the envelope
  exactly as before — no `target` key.
- The `target` field is only attached when `?target=<known>` is explicitly
  requested. Unknown targets return `400 UNSUPPORTED_TARGET`.

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

## Example URLs

```
GET /api/v1/my-api?envelope=v1&target=aprender_sistema
GET /api/v1/my-api/report?target=aprender_sistema
GET /api/v1/my-api/export.csv?target=aprender_sistema&type=usuarios
GET /api/v1/my-api/export.csv?target=aprender_sistema&type=produtos_controle
GET /api/v1/my-api/export.csv?target=aprender_sistema&type=agenda_solicitacoes
GET /api/v1/my-api/export.csv?target=aprender_sistema&type=disponibilidade_bloqueios
GET /api/v1/my-api/export.csv?target=aprender_sistema&type=review
```
