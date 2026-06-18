# Webhooks

Each SheetApi can subscribe one or more URLs to receive HTTP callbacks when the underlying sheet data changes. Deliveries are async, signed, and retried.

This guide is for consumers (the people writing the receiving endpoint) and operators (who manage subscriptions in the dashboard).

## Events

| Event | Trigger | Notes |
|---|---|---|
| `row.created` | A `POST /api/v1/:apiId` (append) job succeeds. | Single event per write, even when the write created multiple rows. |
| `row.updated` | A `PATCH /api/v1/:apiId/:col/:val` job succeeds. | |
| `row.deleted` | A `DELETE /api/v1/:apiId/:col/:val` job succeeds. | |
| `rows.cleared` | A `DELETE /api/v1/:apiId/all` job succeeds. | |

Events fire from inside the `sheets-write` worker after Google Sheets confirms the write. If the write fails, no event is dispatched.

## Subscribe

Subscriptions are per-SheetApi and managed via the dashboard API. JWT-authenticated as the SheetApi owner.

```bash
curl -X POST "https://api.example.com/dashboard/apis/<apiId>/webhooks" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your.endpoint/sheets-banco",
    "events": ["row.created", "row.updated", "row.deleted", "rows.cleared"]
  }'
```

Response includes the freshly-minted `secret` — **store it now**, you can't retrieve it again. The server generates 32 random bytes (hex-encoded) per subscription; rotation today means delete + recreate.

Other routes on the same prefix:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/dashboard/apis/:id/webhooks` | List subscriptions for this API |
| `PATCH` | `/dashboard/apis/:id/webhooks/:webhookId` | Update url/events/active |
| `DELETE` | `/dashboard/apis/:id/webhooks/:webhookId` | Remove subscription |
| `GET` | `/dashboard/apis/:id/webhooks/:webhookId/deliveries` | Last 50 deliveries (status, response code, attempts) |

## Request format

The server sends a `POST` to your URL with:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Webhook-Event` | The event name (`row.created`, etc.) |
| `X-Webhook-Delivery-Id` | The BullMQ job ID — unique per delivery attempt set. |
| `X-Webhook-Timestamp` | Unix seconds at signing time. |
| `X-Signature-256` | `sha256=<hex>` — HMAC of `timestamp.body` (see below). |

Body shape (same shape as the worker emits today):

```json
{
  "type": "append",
  "spreadsheetId": "1Zj_I7sqYAJ9uaYbVoBfskl0LqxGM3SAFzwm4Zpph1RI",
  "sheetName": "Agenda",
  "result": { "created": 3 }
}
```

`type` is one of `append`/`update`/`delete`/`clear`. `result` carries the per-type counts (`{ created }` / `{ updated }` / `{ deleted }`).

Body shape is intentionally **not** the full rows — receivers needing the changed data should re-fetch via the API. This keeps payloads small and gives consumers consistent semantics (no risk of seeing webhook-payload data that's older than what the API now returns).

## Signature

Same algorithm as common webhook providers (Stripe-style):

```
canonical = "<X-Webhook-Timestamp>.<raw body bytes>"
signature = HEX(HMAC_SHA256(canonical, subscription.secret))
header    = "sha256=" + signature
```

Verify on your end using a timing-safe comparison. The `timestamp` prefix gives you a free replay-prevention check — reject if it's outside a ~5min window.

### Node

```js
import crypto from 'node:crypto';

export function verify(rawBody, header, secret, opts = { maxAgeSeconds: 300 }) {
  const m = /^sha256=([a-f0-9]{64})$/.exec(header || '');
  if (!m) return false;
  const [, hex] = m;

  // Replay window: timestamp must be present and recent.
  const ts = Number(request.headers['x-webhook-timestamp']);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > opts.maxAgeSeconds) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${ts}.${rawBody}`)
    .digest('hex');
  const a = Buffer.from(hex, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

The `rawBody` must be the bytes you received over the wire — if you let your framework re-parse + re-stringify, the signature won't match. In Express, use `express.raw({ type: 'application/json' })` or capture the raw body in `verify` middleware.

### Python

```python
import hmac, hashlib, time

def verify(raw_body: bytes, header: str, timestamp: str, secret: str, max_age=300) -> bool:
    if not header or not header.startswith("sha256="):
        return False
    provided = header.split("=", 1)[1]

    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs(time.time() - ts) > max_age:
        return False

    canonical = f"{ts}.{raw_body.decode('utf-8')}".encode("utf-8")
    expected = hmac.new(secret.encode("utf-8"), canonical, hashlib.sha256).hexdigest()
    return hmac.compare_digest(provided, expected)
```

### Go

```go
package webhooks

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "strconv"
    "strings"
    "time"
)

func Verify(rawBody []byte, sigHeader, tsHeader, secret string, maxAge time.Duration) bool {
    const prefix = "sha256="
    if !strings.HasPrefix(sigHeader, prefix) {
        return false
    }
    provided, err := hex.DecodeString(strings.TrimPrefix(sigHeader, prefix))
    if err != nil {
        return false
    }

    ts, err := strconv.ParseInt(tsHeader, 10, 64)
    if err != nil {
        return false
    }
    if delta := time.Since(time.Unix(ts, 0)); delta < -maxAge || delta > maxAge {
        return false
    }

    h := hmac.New(sha256.New, []byte(secret))
    fmt.Fprintf(h, "%d.%s", ts, rawBody)
    expected := h.Sum(nil)
    return hmac.Equal(provided, expected)
}
```

## Retry behavior

The `webhook-delivery` queue retries each delivery up to **5 attempts** with **10s exponential backoff** (10s → 20s → 40s → 80s → 160s — ~310s total). Full retry/backoff/manual-replay docs in [docs/queues.md](./queues.md).

Your endpoint should:

- Return **2xx within 10s** to mark the delivery successful (the API uses a 10s `AbortController` timeout per attempt).
- Be **idempotent** — `X-Webhook-Delivery-Id` is stable across retries of the same delivery, use it as a dedup key.
- Return 4xx for **permanent** failures (invalid payload format from your perspective). They still consume retry attempts; we don't yet distinguish "don't retry me" — open an issue if you need this.

After 5 failed attempts the `WebhookDelivery` row is marked `failed` and stays in the database for inspection. The subscription itself remains active — no auto-disable. The next event fires deliveries the normal way.

## Operational

### Inspect delivery history

```bash
curl "https://api.example.com/dashboard/apis/<apiId>/webhooks/<webhookId>/deliveries" \
  -H "Authorization: Bearer <JWT>"
```

Returns the most recent 50 deliveries with `status` (`pending`/`success`/`failed`), `responseCode`, `attempts`, `createdAt`.

### Replay a failed delivery

There's no UI for manual replay yet. From a Node REPL with the API env loaded:

```js
import { enqueueWebhookDelivery } from './packages/api/src/queues/webhook-delivery.queue.js';
import { prisma } from './packages/api/src/lib/prisma.js';

const delivery = await prisma.webhookDelivery.findUnique({ where: { id: '<deliveryId>' } });
const sub = await prisma.webhookSubscription.findUnique({ where: { id: delivery.subscriptionId } });
await enqueueWebhookDelivery({
  subscriptionId: sub.id,
  url: sub.url,
  secret: sub.secret,
  event: delivery.event,
  payload: delivery.payload,
});
```

This creates a fresh delivery attempt with the original payload — the receiver should treat it as a repeat of `X-Webhook-Delivery-Id` and dedup if already processed.
