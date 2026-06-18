# Getting Started

sheets.banco turns your Google Sheets into REST APIs. This guide walks through standing up an instance — backend, dashboard, and a first connected sheet.

Auth model: **per-user OAuth**. Each user signs in with Google, grants Sheets access, and the API holds their refresh token. There is no service account in this codebase.

## Prerequisites

- Node.js >= 18
- PostgreSQL (local, Supabase, Neon, or any managed Postgres)
- Redis (optional; without it BullMQ-backed writes/webhooks/scheduled-sync are disabled but reads work)
- A Google Cloud project with **OAuth 2.0** credentials and the **Google Sheets API** enabled

## 1. Clone and install

```bash
git clone https://github.com/matheusnorjosa/sheets.banco.git
cd sheets.banco
npm install
```

## 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in the values. The schema lives in `packages/api/src/config/env.ts` and is validated at startup — invalid or missing values exit the process with a clear message.

Required for local dev:
- `DATABASE_URL` — Postgres connection string.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` — OAuth credentials (see §3).
- `JWT_SECRET` — random string, **≥ 32 chars in production**, ≥ 16 in dev.

Optional with defaults:
- `NODE_ENV` (default `development`)
- `PORT` / `HOST` (default `3000` / `0.0.0.0`)
- `REDIS_URL` (default `redis://localhost:6379`; unset → queues disabled)
- `LOG_LEVEL` (default `info`)
- `BODY_LIMIT` (default `1048576`, i.e. 1 MiB)
- `FRONTEND_URL` (default `http://localhost:3001`)
- `ALLOWED_ORIGINS` (CSV; **required in production**, falls back to `FRONTEND_URL` in dev)

Frontend (`packages/web/.env.local`):

```bash
cp packages/web/.env.local.example packages/web/.env.local
```

```env
NEXT_PUBLIC_API_URL=http://localhost:3000
```

## 3. Google Cloud Console — OAuth setup

1. Go to https://console.cloud.google.com/.
2. Create a project (or pick an existing one).
3. Enable the **Google Sheets API**: APIs & Services → Library → search "Google Sheets API" → Enable.
4. OAuth consent screen: APIs & Services → OAuth consent screen.
   - User type: **External** (or Internal if you're in a Workspace org).
   - Add the required scopes when prompted: `auth/spreadsheets`, `auth/drive.metadata.readonly`, `auth/userinfo.email`, `auth/userinfo.profile`.
   - In dev, add yourself as a test user.
5. Credentials: APIs & Services → Credentials → **Create credentials** → OAuth client ID.
   - Application type: **Web application**.
   - Authorized redirect URIs: `http://localhost:3000/auth/google/callback` (and your production URL when deploying).
   - Click Create. Copy the **Client ID** and **Client secret** into `.env`.

## 4. Set up the database

```bash
npx prisma db push --schema prisma/schema.prisma
npx prisma generate --schema prisma/schema.prisma
```

## 5. Run

```bash
# Backend (port 3000)
npm run dev

# Frontend (port 3001, in another terminal)
npm run dev:web
```

## 6. Connect a Google Sheet

Two ways:

**Dashboard (recommended):**
1. Open http://localhost:3001.
2. Click **Sign in with Google** — accept the scopes.
3. Click **New API** → paste a Google Sheet URL/ID → name it.
4. The dashboard returns an API ID like `cmnxiiduj0001k601qj7lcb8k`.

**CLI (skips the dashboard):**

```bash
npm run seed -- "https://docs.google.com/spreadsheets/d/YOUR_SHEET_ID/edit" "My API"
```

This requires a User row in Postgres; if none exists, sign in via the dashboard first so the user record is created with valid `googleAccessToken` / `googleRefreshToken`.

## 7. Try it

```bash
curl http://localhost:3000/api/v1/YOUR_API_ID
```

You should see the sheet's rows as JSON.

## Where to go next

- API surface, search operators, query params: [`api-reference.md`](api-reference.md).
- Talk to the API from JavaScript: [`sdk.md`](sdk.md).
- Target-adapter exports (envelope, target=aprender_sistema, CSV): [`aprender-sistema-target.md`](aprender-sistema-target.md).

## Troubleshooting

- **`Invalid environment variables: ALLOWED_ORIGINS` on production boot** — required in production. Set the CSV in your hosting env.
- **`PrismaClientInitializationError` at startup** — check `DATABASE_URL` and that the DB is reachable; for Supabase use the **session pooler** (port 5432), not the transaction pooler (6543).
- **OAuth callback 401/redirect mismatch** — the redirect URI in Google Cloud Console must match `GOOGLE_REDIRECT_URI` byte-for-byte (scheme, host, port, path).
- **Sheets API 403 on first read** — make sure the sheet is shared with the email that signed in (or in your Drive); per-user OAuth means the API uses *your* permissions.
- **BullMQ-backed features (writes / webhooks / scheduled-sync) silent** — Redis is unset. Set `REDIS_URL` and restart.
