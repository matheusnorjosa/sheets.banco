# HMAC request signing

When a SheetApi has `requireSigning: true`, every request to its `/api/v1/:apiId/*` routes must include an HMAC-SHA256 signature derived from a shared `hmacSecret`. The server rejects unsigned, expired, or invalid requests with `401`.

This guide is for client implementers. The middleware is at `packages/api/src/middleware/hmac-verify.ts`.

## When to use it

Signing is per-API. Enable it when:

- The API exposes write routes (`POST` / `PATCH` / `DELETE`) and you want strong authenticity guarantees beyond Bearer token / API key.
- You're calling from a server-to-server context (browsers shouldn't see the secret).
- You're integrating with a partner who already runs HMAC-signed webhooks and you want symmetry.

For browser-fronted public reads, signing is overkill — stick with API keys + IP allowlist.

## Algorithm

```
canonical = METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + HEX(SHA256(body))
signature = HEX(HMAC_SHA256(canonical, hmacSecret))
```

- `METHOD` — uppercase HTTP verb (`POST`, `GET`, …).
- `PATH` — the request path *as the server sees it*, including query string. E.g. `/api/v1/clx123?limit=10`.
- `TIMESTAMP` — Unix seconds (a string). Must be within ±5 minutes of server time.
- `body` — exact bytes you sent (see **Signing versions** below).
- `hmacSecret` — the shared secret stored on the SheetApi.

## Required headers

| Header | Value |
|---|---|
| `X-Signature` | Hex string, lowercase, 64 chars. |
| `X-Timestamp` | Unix seconds, decimal integer. |
| `X-Signature-Version` | `2` for new integrations. Omit (or `1`) to use the legacy serializer-dependent path. |

## Signing versions

There are two versions. **New integrations should use v2.**

### v2 — raw body (current)

The body part of the canonical is `HEX(SHA256(<exact bytes you sent over the wire>))`. The server reads `request.rawBody` (captured by `fastify-raw-body`) and hashes it. Both sides agree on the same bytes regardless of how either parses the JSON.

Send `X-Signature-Version: 2`.

This is the right choice if your client is in Go, Python, Rust, Ruby, or any language whose JSON serializer doesn't perfectly match V8's. It's also the right choice if you ever want to send non-JSON payloads (form-encoded, raw text, etc.).

### v1 — JSON.stringify(body) (legacy)

The body part is `HEX(SHA256(JSON.stringify(parsedBody)))` — but `JSON.stringify` here is V8's. Any divergence in key ordering, whitespace, or number formatting between your serializer and V8's produces a signature mismatch even when the payload is semantically identical.

v1 exists only for back-compat. New clients must not use it. The header `X-Signature-Version` defaults to `1` when absent, so existing integrations keep working.

## Error responses

| Code | Meaning |
|---|---|
| `SIGNATURE_MISSING` | `X-Signature` or `X-Timestamp` not present. |
| `SIGNATURE_EXPIRED` | Timestamp drift > 5 minutes (or not numeric). Check your client clock. |
| `SIGNATURE_INVALID` | HMAC mismatch. Check the canonical string and the secret. |

Full envelope shape in [docs/error-handling.md](./error-handling.md).

## Enable signing on a SheetApi

Set `requireSigning` and `hmacSecret` on the SheetApi record:

```bash
curl -X PATCH https://api.example.com/dashboard/apis/<id> \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "requireSigning": true,
    "hmacSecret": "<at-least-32-random-bytes-base64>"
  }'
```

Generate a secret with `openssl rand -base64 32` or `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Store it somewhere you can pull from on every signed request — don't hard-code it.

## Examples (v2)

### curl

```bash
SECRET="your-shared-secret"
TS=$(date +%s)
METHOD=POST
PATH="/api/v1/clx123"
BODY='{"data":{"name":"Alice"}}'

BODY_HASH=$(printf %s "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')
CANONICAL=$(printf '%s\n%s\n%s\n%s' "$METHOD" "$PATH" "$TS" "$BODY_HASH")
SIG=$(printf %s "$CANONICAL" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')

curl -X POST "https://api.example.com$PATH" \
  -H "Content-Type: application/json" \
  -H "X-Timestamp: $TS" \
  -H "X-Signature: $SIG" \
  -H "X-Signature-Version: 2" \
  --data-raw "$BODY"
```

The `--data-raw` flag matters — curl's default `--data` strips newlines and would change the bytes you sign.

### Node (no SDK)

```js
import crypto from 'node:crypto';

function signedFetch(method, url, body, secret) {
  const u = new URL(url);
  const path = u.pathname + u.search;
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyBytes = body == null ? '' : Buffer.from(body, 'utf8');
  const bodyHash = crypto.createHash('sha256').update(bodyBytes).digest('hex');
  const canonical = `${method}\n${path}\n${ts}\n${bodyHash}`;
  const sig = crypto.createHmac('sha256', secret).update(canonical).digest('hex');

  return fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Timestamp': ts,
      'X-Signature': sig,
      'X-Signature-Version': '2',
    },
    body: body ?? undefined,
  });
}

const body = JSON.stringify({ data: { name: 'Alice' } });
const res = await signedFetch('POST', 'https://api.example.com/api/v1/clx123', body, process.env.HMAC_SECRET);
```

Notice: the body you pass to `fetch` is the same string you hash. That's the contract.

### Python

```python
import hashlib, hmac, json, time
from urllib.parse import urlsplit
import httpx

def signed_request(method, url, body, secret):
    parts = urlsplit(url)
    path = parts.path + (("?" + parts.query) if parts.query else "")
    ts = str(int(time.time()))
    body_bytes = body.encode("utf-8") if body is not None else b""
    body_hash = hashlib.sha256(body_bytes).hexdigest()
    canonical = f"{method}\n{path}\n{ts}\n{body_hash}"
    sig = hmac.new(secret.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()

    return httpx.request(
        method,
        url,
        headers={
            "Content-Type": "application/json",
            "X-Timestamp": ts,
            "X-Signature": sig,
            "X-Signature-Version": "2",
        },
        content=body_bytes,
    )

payload = json.dumps({"data": {"name": "Alice"}})
res = signed_request("POST", "https://api.example.com/api/v1/clx123", payload, os.environ["HMAC_SECRET"])
```

Again — `httpx.content=body_bytes` ensures the wire bytes match what was hashed.

### Go

```go
package main

import (
    "crypto/hmac"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "net/http"
    "net/url"
    "strings"
    "time"
)

func signedRequest(method, rawURL, body, secret string) (*http.Request, error) {
    u, err := url.Parse(rawURL)
    if err != nil {
        return nil, err
    }
    path := u.Path
    if u.RawQuery != "" {
        path += "?" + u.RawQuery
    }
    ts := fmt.Sprintf("%d", time.Now().Unix())
    h := sha256.Sum256([]byte(body))
    bodyHash := hex.EncodeToString(h[:])
    canonical := fmt.Sprintf("%s\n%s\n%s\n%s", method, path, ts, bodyHash)
    mac := hmac.New(sha256.New, []byte(secret))
    mac.Write([]byte(canonical))
    sig := hex.EncodeToString(mac.Sum(nil))

    req, err := http.NewRequest(method, rawURL, strings.NewReader(body))
    if err != nil {
        return nil, err
    }
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("X-Timestamp", ts)
    req.Header.Set("X-Signature", sig)
    req.Header.Set("X-Signature-Version", "2")
    return req, nil
}
```

## Pitfalls

- **Don't re-serialize the body between hashing and sending.** Hash the same string you put on the wire. Most signature mismatches come from "I hashed `JSON.stringify(obj)` but `fetch` re-serialized it differently."
- **Path includes the query string.** If you sign `/api/v1/clx123` but call `/api/v1/clx123?limit=10`, the server's canonical won't match yours.
- **Clock skew.** The 5-minute window is generous but real. If your NTP is off, you'll get `SIGNATURE_EXPIRED`.
- **Don't leak the secret in client-side code.** Sign on the server.

## Migration: v1 → v2

If you're already signing with v1:

1. Update your client to hash the exact wire bytes (see examples above).
2. Add `X-Signature-Version: 2` to the request.
3. Done — server accepts both versions, so you can cut over per-client without coordination.

We'll deprecate v1 after telemetry shows < 1% of signed requests still using it. There's no removal date yet; this guide will be updated when there is one.
