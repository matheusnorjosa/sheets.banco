# Per-API security

Each SheetApi has seven independent primitives. They compose: any failure short-circuits the request before it touches Google Sheets.

This page is the map. Per-feature deep-dives live in [hmac-signing.md](./hmac-signing.md) and the API reference. The "at rest" section at the bottom covers where the secrets themselves live (and the encryption foundation that's landing).

## Order of evaluation

```
1. CORS check          (preflight rejected → 403 CORS_FORBIDDEN)
2. IP allowlist        (off-list → 403 IP_FORBIDDEN)
3. Bearer / Basic / API key (no/wrong creds → 401 API_UNAUTHORIZED)
4. HMAC signature      (only if requireSigning, → 401 SIGNATURE_*)
5. Rate limit          (over budget → 429 RATE_LIMIT_EXCEEDED)
6. Feature gates       (allowRead/Create/Update/Delete → 403 *_DISABLED)
7. Handler
```

Steps 1–4 are `onRequest` / `preHandler` hooks in `packages/api/src/routes/v1/sheets.ts`. Rate limit is enforced by `@fastify/rate-limit`. Feature gates are inside the handler.

## The seven primitives

| Primitive | Field(s) on SheetApi | Strength | When to enable | Trade-off |
|---|---|---|---|---|
| **Bearer token** | `bearerToken`, `bearerTokenPrevious`, `bearerTokenRotatedAt` | Long random string. Constant-time compare. 1h grace on previous token. | Default for server-to-server callers. | Stored plaintext today (#62 migrates to bcrypt). |
| **Basic auth** | `basicUser`, `basicPass` | Same string match, constant-time. No rotation grace. | Tools that only speak Basic (curl scripts, legacy clients). | No rotation grace — caller breaks the moment you change it. Prefer bearer. |
| **API key** | `ApiKey` rows (`keyHash`, `keyPrefix`, `scopes`, `active`, `expiresAt`) | bcrypt, looked up by indexed prefix. Scoped per HTTP method, individually revocable, optional expiry. | Ad-hoc or short-lived clients you don't want holding the shared bearer token. | Costs one DB lookup per request (only when the bearer token didn't already match). |
| **HMAC signing** | `requireSigning`, `hmacSecret` | HMAC-SHA256 over canonical (METHOD\nPATH\nTS\nHASH(body)), 5min replay window. v2 uses raw body bytes. | Writes from untrusted networks; partners who already speak HMAC. | Adds client complexity. See [hmac-signing.md](./hmac-signing.md). |
| **IP allowlist** | `ipWhitelist` (string array) | Exact match against `request.ip` (Fastify uses `trustProxy: true` so X-Forwarded-For is honored). | Calls from a known-stable office or VPN egress. | Falls apart with mobile/roaming callers. |
| **CORS** | `corsOrigins` (string array) | Per-API origin allowlist; composed with the global CORS for dashboard routes. | Browsers consuming the API directly. | If unset, all origins are allowed for browser callers (use deliberately). |
| **Rate limit** | `rateLimitRpm` (default in env) | `@fastify/rate-limit` per-API key (apiId + IP). | Always (the default is reasonable). | Aggressive limits frustrate legit polling. |

## When to combine

| Caller type | Recommendation |
|---|---|
| Internal service-to-service | Bearer token + IP allowlist |
| Public read-only | CORS allowlist + rate limit |
| Public read+write | Bearer token + HMAC v2 (signing) + rate limit |
| Browser-fronted via SDK | CORS allowlist + bearer (if not public) |
| Webhook receiver wanting outbound signing | Bearer (or none) + HMAC v2 for writes |
| Ad-hoc client / scripting agent | Scoped API key (read-only unless it must write) |

## API keys

The bearer token is a single shared secret per API: everything that calls the
API holds the same string, so handing it to one more client means every client
now shares a secret with that one, and revoking it means coordinating a swap
with all of them.

API keys are the per-client alternative. They live in the `ApiKey` table —
many per API, each labelled, individually revocable, optionally expiring, and
scoped:

| Scope | Grants |
|---|---|
| `sheets:read` | `GET`, `HEAD`, `OPTIONS` |
| `sheets:write` | `POST`, `PUT`, `PATCH` |
| `sheets:delete` | `DELETE` |

An unrecognized method requires `sheets:write` — the mapping fails closed.

Send one either way; both are equivalent:

```bash
curl -H "X-API-Key: <key>" https://api.example.com/api/v1/<apiId>
curl -H "Authorization: Bearer <key>" https://api.example.com/api/v1/<apiId>
```

Bearer is accepted so clients that only speak `Authorization` can use a key
without special-casing. The API's own bearer token is checked first, so keys
never add a database lookup to traffic that already authenticates.

Create one at `POST /dashboard/apis/:id/keys` (or the dashboard's **Chaves de
API** tab). **The plaintext is returned exactly once, in that response** —
every other endpoint returns only `keyPrefix`. Lost key → revoke and issue a
new one.

Two things worth knowing:

- **A key cannot close an open API.** If a SheetApi has no bearer token and no
  basic auth it is public, and it stays public no matter how many keys exist.
  Keys narrow *who* gets into an API that already demands a credential. The
  dashboard warns when you mint a key in this state.
- **Keys are bound to one SheetApi.** The lookup is global, so `apiAuth`
  verifies `apiKey.sheetApiId` matches the API being called. A key for one
  spreadsheet is rejected on every other one, with the same generic 401 as an
  invalid key — the response never confirms that the key exists elsewhere.

## Bearer token rotation

The 1-hour grace period exists so you can rotate without coordinating an exact swap with consumers:

```bash
# 1. Generate a new token
NEW=$(openssl rand -hex 32)

# 2. Rotate — sets bearerTokenPrevious = old, bearerToken = NEW, bearerTokenRotatedAt = now.
curl -X POST "https://api.example.com/dashboard/apis/<id>/rotate-token" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d "{\"newToken\": \"$NEW\"}"

# 3. Update consumers to use $NEW. They have 60 min before the previous token expires.

# 4. After all consumers are on $NEW (verify via UsageLog or logs), call rotate again
#    with a dummy value to clear bearerTokenPrevious explicitly, or wait — it stops
#    being accepted automatically once the grace window elapses.
```

Basic auth has **no rotation grace** — changing `basicPass` breaks the next caller immediately. Move to bearer if you need rotation.

## CORS composition

There are two CORS layers:

- **Global** (`packages/api/src/index.ts`, `env.ALLOWED_ORIGINS`) — applies to dashboard + auth routes. Strict in production.
- **Per-API** (`SheetApi.corsOrigins`) — applies to `/api/v1/:apiId/*`. Independent of the global config.

A browser hitting `/api/v1/:apiId` needs the per-API list to include its origin. A browser hitting `/auth/login` needs the global list. They don't share state.

## At-rest secret storage

Status today (this PR introduces the foundation, **not** the migration):

| Field | Storage today | Status |
|---|---|---|
| `User.passwordHash` | bcrypt | ✅ never plaintext |
| `User.totpSecret` | plaintext | Tracked for envelope encryption |
| `SheetApi.bearerToken`, `bearerTokenPrevious` | **dual-read (plaintext + bcrypt)** | Phase A in flight. After backfill + observation window, the plaintext columns drop. |
| `SheetApi.basicPass` | **dual-read (plaintext + bcrypt)** | Same as above. |
| `SheetApi.hmacSecret` | **encrypted (AES-256-GCM)** | Phase B done. Create/rotate via dashboard returns plaintext once, persists encrypted. |
| `WebhookSubscription.secret` | **encrypted (AES-256-GCM)** | Phase B done. Create returns plaintext once, persists encrypted. |
| `ApiKey.key` | **dual-read (plaintext + bcrypt + indexed prefix)** | Phase A in flight; lookup uses `keyPrefix` index → bcrypt.compare. |

`lib/secret-cipher.ts` provides `encrypt()` / `decrypt()` / `isEncrypted()` / `decryptIfEncrypted()` against a master key (`SECRETS_ENC_KEY` env, 32 bytes hex). The envelope format is `gcm$<iv>$<ct>$<tag>` (base64url parts) — the prefix discriminates encrypted from legacy plaintext so the dual-read transition can route per-row.

### Phase A — bcrypt for ApiKey / bearer / basic (in flight)

The transition is invisible to consumers — they keep sending the same `Bearer xxx` / `X-Api-Key yyy` they always did. The dual-read code in `middleware/api-auth.ts` and `lib/api-key-lookup.ts` tries bcrypt first and falls back to legacy plaintext per row.

**Strategy A (no consumer rotation needed):**

1. **Schema** — added `bearerTokenHash`, `bearerTokenPreviousHash`, `basicPassHash` on SheetApi; `keyHash` + `keyPrefix` on ApiKey. Plaintext columns kept.
2. **Backfill** — `scripts/backfill-hashes.ts` walks every existing row, computes bcrypt(plaintext), and populates the hash columns. Idempotent. No plaintext column is changed.
3. **Reads** — `verifyCredential(input, hash, plain)` checks the hash if present, else the plaintext, else fails. After backfill the fallback path is dead code.
4. **Writes** — `POST /:id/rotate-token`, `PATCH /:id` (when caller sets `bearerToken` / `basicPass`), and `POST /:id/keys` populate both columns so any operator action keeps the migration converging.
5. **ApiKey lookup** — `findApiKeyByPlaintext()` narrows candidates by `keyPrefix` (indexed) then bcrypt-compares each. Legacy `findUnique({ where: { key } })` is consulted only when the prefix path returns no match.
6. **Drop columns** — second PR after a ≥2-week observation window with zero auth fallback hits in logs. At that point `verifyCredential` collapses to `bcrypt.compare(input, hash)`.

Why this avoids consumer breakage: every credential currently in flight remains valid through both branches throughout the transition. No rotation, no coordination, no email to consumers.

### Phase B — encryption for hmacSecret / webhook secret (done)

Live in production once the migration script runs. Implementation:

- **Writes** — every `POST /dashboard/apis/:id/rotate-hmac-secret` and `POST /dashboard/apis/:id/webhooks` generates plaintext server-side, returns it once in the response, and persists `encrypt(plaintext)` to the DB. The caller must capture the plaintext from that response — there's no way to retrieve it later.
- **Reads** — `middleware/hmac-verify.ts` and `workers/webhook-delivery.worker.ts` call `decryptIfEncrypted()` at the verification / signing moment. Plaintext lives only in process memory for the duration of the operation.
- **Dual-read** — `decryptIfEncrypted` passes plaintext through unchanged when the envelope prefix is absent, so any legacy rows that haven't been re-encrypted yet keep working.
- **Migration script** — `scripts/encrypt-secrets.ts` walks both tables, encrypts in place, idempotent (skips rows that already start with `gcm$`). Run once after deploy.
- **Boot guard** — `eagerLoadCipherKey()` runs at API startup; missing `SECRETS_ENC_KEY` in production fails fast with a descriptive error instead of erroring on the first signed request.

### Operating notes

- `SECRETS_ENC_KEY` is generated once per environment and **must not change** without a coordinated re-encryption of every stored value. There is no DEK rotation built in; documented as a follow-up.
- Loss of `SECRETS_ENC_KEY` = permanent loss of all encrypted secrets (no recovery — they're random anyway, but consumers must rotate every credential). Store it like a database root password.
- Never log decrypted values. The `pino` redact list should be updated alongside any new field that flows through it.

### Deploying Phase B to a fresh environment

1. Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
2. Set it as `SECRETS_ENC_KEY` in the environment (Render dashboard / `.env` / etc.) **before** deploying the version that requires it. The API refuses to boot in production without the key.
3. Deploy.
4. Run the migration once: `SECRETS_ENC_KEY=<key> npx tsx packages/api/scripts/encrypt-secrets.ts`. Idempotent.
5. Verify: re-run the script and confirm all counts are `alreadyEncrypted` with `newlyEncrypted=0`.
