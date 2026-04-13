# sheets.banco

Turn Google Sheets into REST APIs. Connect a spreadsheet, get an API endpoint, and perform full CRUD operations via HTTP.

## Features

- **Full CRUD** — Read, create, update, and delete rows via REST endpoints
- **Search & Filtering** — AND/OR search with wildcards, negation, and comparison operators
- **Pagination & Sorting** — `limit`, `offset`, `sort_by`, `sort_order` (asc/desc/random)
- **Multi-tab support** — Access any worksheet tab via `?sheet=` param
- **Google OAuth** — Sign in with Google and access your sheets directly
- **Dashboard** — Web UI to manage APIs, settings, API keys, and usage stats
- **Per-API Security** — Rate limiting, CORS config, IP whitelist, bearer token auth
- **In-memory Cache** — Configurable TTL per API, auto-invalidated on writes
- **Formula Injection Protection** — Sanitizes cell values on writes
- **JavaScript SDK** — Zero-dependency typed client for browser and Node.js
- **Usage Logging** — Track requests per API with method, status, response time

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Node.js + TypeScript + Fastify |
| Database | PostgreSQL + Prisma ORM |
| Frontend | Next.js 16 + Tailwind CSS |
| Auth | JWT + Google OAuth 2.0 |
| Sheets API | Google Sheets API v4 (per-user OAuth) |
| SDK | TypeScript + tsup (CJS + ESM) |

## Project Structure

```
sheets.banco/
├── packages/
│   ├── api/          # Fastify backend
│   ├── web/          # Next.js dashboard
│   ├── sdk/          # JavaScript SDK
│   └── shared/       # Shared types
├── prisma/
│   └── schema.prisma
├── docs/             # API reference, getting started, SDK docs
├── Dockerfile        # Backend container
└── Dockerfile.web    # Frontend container
```

## Getting Started

### Prerequisites

- Node.js >= 18
- PostgreSQL database
- Google Cloud project with OAuth 2.0 credentials and Sheets API enabled

### 1. Clone and install

```bash
git clone https://github.com/matheusnorjosa/sheets.banco.git
cd sheets.banco
npm install
```

### 2. Configure environment

Create a `.env` file in the root:

```env
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/sheets_banco"

# Google OAuth
GOOGLE_CLIENT_ID="your-client-id"
GOOGLE_CLIENT_SECRET="your-client-secret"
GOOGLE_REDIRECT_URI="http://localhost:3000/auth/google/callback"

# JWT
JWT_SECRET="a-secure-random-string-min-16-chars"

# Server
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info

# Frontend URL (for OAuth redirects)
FRONTEND_URL=http://localhost:3001
```

For the frontend (`packages/web/.env.local`):

```env
NEXT_PUBLIC_API_URL=http://localhost:3000
```

### 3. Set up the database

```bash
npx prisma db push --schema prisma/schema.prisma
npx prisma generate --schema prisma/schema.prisma
```

### 4. Run

```bash
# Backend (port 3000)
npm run dev

# Frontend (port 3001, in another terminal)
npm run dev:web
```

## API Endpoints

### Sheet Data (public or protected per API)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/v1/:apiId` | Read all rows |
| `GET` | `/api/v1/:apiId/search?col=val` | AND search |
| `GET` | `/api/v1/:apiId/search_or?col=val` | OR search |
| `GET` | `/api/v1/:apiId/keys` | Column names |
| `GET` | `/api/v1/:apiId/count` | Row count |
| `POST` | `/api/v1/:apiId` | Create rows |
| `PATCH` | `/api/v1/:apiId/:column/:value` | Update matching rows |
| `DELETE` | `/api/v1/:apiId/:column/:value` | Delete matching rows |
| `DELETE` | `/api/v1/:apiId/all` | Clear all data rows |

### Query Parameters

| Param | Example | Description |
|-------|---------|-------------|
| `sheet` | `?sheet=Products` | Select worksheet tab |
| `limit` | `?limit=10` | Limit results |
| `offset` | `?offset=20` | Skip results |
| `sort_by` | `?sort_by=name` | Sort by column |
| `sort_order` | `?sort_order=desc` | `asc`, `desc`, or `random` |
| `cast_numbers` | `?cast_numbers=true` | Cast numeric strings to numbers |
| `single_object` | `?single_object=true` | Return first result as object |

### Search Operators

| Pattern | Meaning |
|---------|---------|
| `name=Tom` | Exact match |
| `name=!Tom` | Not equal |
| `age=>18` | Greater than |
| `age=<=100` | Less or equal |
| `name=T*` | Starts with |
| `name=*om` | Ends with |
| `name=*o*` | Contains |

### Auth & Dashboard

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/auth/register` | Create account |
| `POST` | `/auth/login` | Sign in (returns JWT) |
| `GET` | `/auth/me` | Current user |
| `GET` | `/auth/google` | Google OAuth flow |
| `GET/POST/PATCH/DELETE` | `/dashboard/apis/...` | Manage APIs, keys, usage |

## SDK Usage

```typescript
import { SheetsBanco } from '@sheets-banco/sdk';

const db = new SheetsBanco({
  apiId: 'your-api-id',
  baseUrl: 'https://your-api-url.com',
});

// Read all rows
const rows = await db.read();

// Search
const results = await db.search({ name: 'Alice', age: '>18' });

// Create
await db.create([{ name: 'Bob', email: 'bob@example.com' }]);

// Update
await db.update('name', 'Bob', { email: 'newemail@example.com' });

// Delete
await db.delete('name', 'Bob');
```

## Deployment

### Backend (Docker)

```bash
docker build -t sheets-banco-api .
docker run -p 3000:3000 --env-file .env sheets-banco-api
```

### Frontend (Vercel)

Set `NEXT_PUBLIC_API_URL` to your backend URL and deploy the `packages/web` directory.

## License

MIT
