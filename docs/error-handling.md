# Error handling

Every error response from the API uses the same JSON envelope:

```json
{
  "error": true,
  "message": "Human-readable explanation.",
  "code": "STABLE_MACHINE_CODE",
  "statusCode": 400,
  "request_id": "req_a1b2c3d4e5",
  "details": { "...optional, code-specific...": "..." }
}
```

The same `request_id` is echoed in the `X-Request-Id` response header and is what the server logs the request under. Quote it when reporting a problem — it lets the maintainers find the matching log line in one query.

Clients can also **set** `X-Request-Id` on the request. The server uses the inbound value verbatim if present, otherwise generates `req_<10 random chars>`. Useful when your own logs already track a correlation ID and you want the server to log under the same one.

## When you should retry

| Behaviour | Codes | Strategy |
|---|---|---|
| Retry with exponential backoff | `GOOGLE_RATE_LIMIT`, `GOOGLE_QUOTA_EXCEEDED`, `RATE_LIMIT_EXCEEDED`, transient `INTERNAL_ERROR` | Start at 1s, double up to 60s, cap at 5 attempts. Honor `Retry-After` if present. |
| Re-authenticate, then retry once | `UNAUTHORIZED`, `API_KEY_EXPIRED`, `SIGNATURE_EXPIRED` | Refresh the token / re-sign the request. Don't loop. |
| Don't retry — fix and try again | `VALIDATION_ERROR`, `INVALID_API_KEY`, `INSUFFICIENT_SCOPES`, `INVALID_CREDENTIALS`, `EMAIL_EXISTS`, `NOT_FOUND`, `SHEET_ACCESS_ERROR`, `GOOGLE_API_NOT_ENABLED`, `*_DISABLED`, `IP_FORBIDDEN`, `CORS_FORBIDDEN`, `SIGNATURE_MISSING`, `SIGNATURE_INVALID` | The request itself is wrong. Retrying will produce the same response. |

## Code catalog

Codes are stable. New codes may appear in future releases; existing codes will not change meaning.

### Authentication & authorization

| Code | Status | When |
|---|---|---|
| `UNAUTHORIZED` | 401 | JWT missing, invalid, or expired. |
| `INVALID_CREDENTIALS` | 401 | Wrong email/password on `/auth/login`. |
| `INVALID_PASSWORD` | 401 | Password check failed during a sensitive operation (e.g. enable 2FA). |
| `INVALID_TOKEN` | 401 / 400 | 2FA token invalid, expired, or used for the wrong stage. |
| `EMAIL_EXISTS` | 409 | `/auth/register` with an email already in use. |
| `INVALID_API_KEY` | 401 | `X-Api-Key` header is unknown or the key is deactivated. |
| `API_KEY_EXPIRED` | 401 | API key past its `expiresAt`. |
| `INSUFFICIENT_SCOPES` | 403 | API key lacks one or more scopes the route requires. `message` lists the missing ones. |
| `API_UNAUTHORIZED` | 401 | Per-API auth (Basic / Bearer / API key) failed for a route that requires it. |
| `IP_FORBIDDEN` | 403 | Caller IP is not in the API's allowlist. |
| `CORS_FORBIDDEN` | 403 | Browser origin not allowed by the API's CORS config. |

### Request signing (HMAC)

| Code | Status | When |
|---|---|---|
| `SIGNATURE_MISSING` | 401 | `X-Signature` or `X-Timestamp` header absent on a route that requires signing. |
| `SIGNATURE_EXPIRED` | 401 | `X-Timestamp` is outside the acceptable clock skew (default 5 min). |
| `SIGNATURE_INVALID` | 401 | HMAC did not match. Check the signing secret and the canonical request. |

### Input & resource

| Code | Status | When |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Request body or query failed schema validation. |
| `NOT_FOUND` | 404 | Resource ID does not exist or is not visible to the caller. |
| `SHEET_ACCESS_ERROR` | 403 | Generic 403/404 from Google Sheets — usually the sheet wasn't shared with the OAuth user, or the ID is wrong. |
| `INVALID_SHEET_ID` | 400 | The provided Google Sheets ID has the wrong shape. |
| `HEADER_ROW_OUTSIDE_RANGE` | 400 | Configured header row falls outside the chosen range. |
| `WORKBOOK_SHEET_REQUIRED` | 400 | Operation needs a `sheet` query param but none was supplied. |
| `UNSUPPORTED_SHEET_TYPE` | 400 | Operation does not support this sheet's detected type. |

### Feature gates

These are 403s emitted when the SheetApi has the corresponding write mode disabled. The fix is to enable it in the dashboard (`PATCH /dashboard/apis/:id`).

| Code | Status | When |
|---|---|---|
| `READ_DISABLED` | 403 | Read access turned off for this API. |
| `CREATE_DISABLED` | 403 | `POST` blocked — creation disabled. |
| `UPDATE_DISABLED` | 403 | `PATCH` / `PUT` blocked — updates disabled. |
| `DELETE_DISABLED` | 403 | `DELETE` blocked — deletion disabled. |

### Rate limiting & quotas

| Code | Status | When |
|---|---|---|
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests against this server. Per-route limits — see the route docs. |
| `GOOGLE_RATE_LIMIT` | 429 | Google Sheets returned a rate-limit error after our internal backoff retries (3×) gave up. |
| `GOOGLE_QUOTA_EXCEEDED` | 429 | Google Sheets project quota exceeded. Different from rate limits — usually means you need to request a higher quota. |

### Google Sheets configuration

| Code | Status | When | `details` |
|---|---|---|---|
| `GOOGLE_API_NOT_ENABLED` | 400 | The Sheets API is not enabled for the OAuth user's Google Cloud project. | `enable_url`: one-click console URL that enables the API. |

### Server

| Code | Status | When |
|---|---|---|
| `INTERNAL_ERROR` | 500 | Unexpected failure. The `request_id` is the only thing you can do about it — quote it when reporting. |
| `CLIENT_ERROR` | 4xx | Fallback for Fastify-level client errors that don't fit another bucket (e.g. body parser failures, content-type mismatches). |

## Example: handling `GOOGLE_API_NOT_ENABLED`

When a user first sets up an API, Google often hasn't enabled the Sheets API for their project. The response gives the consumer everything needed to fix it:

```json
{
  "error": true,
  "message": "Google Sheets API has not been used in project 123456 before...",
  "code": "GOOGLE_API_NOT_ENABLED",
  "statusCode": 400,
  "request_id": "req_a1b2c3d4e5",
  "details": {
    "enable_url": "https://console.developers.google.com/apis/api/sheets.googleapis.com/overview?project=123456"
  }
}
```

A dashboard can render `details.enable_url` as a "Fix this" button.

## Example: retry loop

```ts
async function callWithRetry(fn) {
  let delay = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fn();
    if (res.ok) return res;
    const body = await res.json();
    const retriable = [
      'GOOGLE_RATE_LIMIT',
      'GOOGLE_QUOTA_EXCEEDED',
      'RATE_LIMIT_EXCEEDED',
    ];
    if (!retriable.includes(body.code)) {
      throw new Error(`${body.code}: ${body.message} (request_id=${body.request_id})`);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 60_000);
  }
  throw new Error('Retries exhausted');
}
```
