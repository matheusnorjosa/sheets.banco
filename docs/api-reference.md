# API Reference

Base URL: `http://localhost:3000/api/v1`

All sheet endpoints use the format: `GET /api/v1/:apiId`

## Read

### GET /:apiId

Returns all rows as JSON array.

**Query parameters:**

| Param | Description |
|-------|-------------|
| `sheet` | Sheet tab name (default: first tab) |
| `limit` | Max rows to return |
| `offset` | Skip N rows |
| `sort_by` | Column to sort by |
| `sort_order` | `asc`, `desc`, or `random` |
| `cast_numbers` | `true` to convert numeric strings to numbers |
| `single_object` | `true` to return first row as object instead of array |

**Example:**

```bash
curl "http://localhost:3000/api/v1/clx123/limit=10&sort_by=name&sort_order=asc"
```

**Response:**

```json
[
  { "id": "1", "name": "Alice", "age": "30" },
  { "id": "2", "name": "Bob", "age": "25" }
]
```

### GET /:apiId/keys

Returns column names (headers from row 1).

```json
["id", "name", "age"]
```

### GET /:apiId/count

Returns row count (excluding header).

```json
{ "rows": 42 }
```

## Search

### GET /:apiId/search

AND search — all conditions must match.

```bash
curl "http://localhost:3000/api/v1/clx123/search?name=Alice&age=>25"
```

### GET /:apiId/search_or

OR search — any condition can match.

```bash
curl "http://localhost:3000/api/v1/clx123/search_or?name=Alice&name=Bob"
```

**Filter syntax:**

| Pattern | Meaning |
|---------|---------|
| `name=Tom` | Exact match |
| `name=!Tom` | Not equal |
| `age=>18` | Greater than |
| `age=<30` | Less than |
| `age=>=18` | Greater or equal |
| `age=<=30` | Less or equal |
| `name=T*` | Starts with |
| `name=*om` | Ends with |
| `name=*o*` | Contains |

Additional params: `casesensitive=true`, plus all pagination params from GET.

## Create

### POST /:apiId

Create one or more rows.

```bash
curl -X POST http://localhost:3000/api/v1/clx123 \
  -H "Content-Type: application/json" \
  -d '{"data": {"name": "Charlie", "age": "28"}}'
```

Create multiple rows:

```bash
curl -X POST http://localhost:3000/api/v1/clx123 \
  -H "Content-Type: application/json" \
  -d '{"data": [{"name": "Charlie", "age": "28"}, {"name": "Diana", "age": "32"}]}'
```

**Response:** `{ "created": 2 }`

**Special values:**

| Value | Replaced with |
|-------|---------------|
| `TIMESTAMP` | Unix timestamp (seconds) |
| `DATETIME` | ISO 8601 datetime string |

## Update

### PATCH /:apiId/:column/:value

Update all rows where column matches value.

```bash
curl -X PATCH http://localhost:3000/api/v1/clx123/name/Alice \
  -H "Content-Type: application/json" \
  -d '{"data": {"age": "31"}}'
```

**Response:** `{ "updated": 1 }`

## Delete

### DELETE /:apiId/:column/:value

Delete all rows where column matches value.

```bash
curl -X DELETE http://localhost:3000/api/v1/clx123/name/Alice
```

**Response:** `{ "deleted": 1 }`

### DELETE /:apiId/all

Delete all data rows (keeps headers).

**Response:** `{ "deleted": 42 }`

## Authentication

Sheet endpoints support optional authentication (configured per API):

**Bearer Token:**

```bash
curl -H "Authorization: Bearer your-token" http://localhost:3000/api/v1/clx123
```

**Basic Auth:**

```bash
curl -u user:password http://localhost:3000/api/v1/clx123
```

If no auth is configured on the API, endpoints are public.

## Error Response Format

All errors follow this format:

```json
{
  "error": true,
  "message": "Description of the error",
  "code": "ERROR_CODE",
  "statusCode": 404
}
```
