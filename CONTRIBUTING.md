# Contributing to sheets.banco

Thanks for your interest. This guide covers the practical workflow.

## Project layout

Monorepo with these packages:

- `packages/api` — Fastify backend (TypeScript, Prisma, Postgres, Redis/BullMQ)
- `packages/web` — Next.js dashboard (React)
- `packages/sdk` — JavaScript SDK
- `packages/cli` — Command-line client
- `prisma/` — DB schema + migrations

## Setting up

```bash
git clone https://github.com/matheusnorjosa/sheets.banco.git
cd sheets.banco
npm install
```

`npm install` runs `husky` via the `prepare` script, which installs a `pre-commit` hook that lint-fixes staged `packages/api/**/*.ts` files and runs `typecheck` for the API package. Set `HUSKY=0` in your shell to bypass install. Per-commit bypass: `git commit --no-verify` — discouraged outside genuine emergencies (CI still runs the same gates).

Required env vars: `DATABASE_URL`, `REDIS_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `JWT_SECRET`. See `packages/api/src/config/env.ts` for defaults and all options.

To run the API locally:

```bash
npm run dev -w packages/api
```

To run the dashboard:

```bash
npm run dev -w packages/web
```

## Orientation

New contributors: start with [docs/architecture.md](./docs/architecture.md) for the topology + request flows, then [docs/api-reference.md](./docs/api-reference.md) for the routes. Cross-cutting concerns: [error-handling](./docs/error-handling.md), [queues](./docs/queues.md), [hmac-signing](./docs/hmac-signing.md).

## Workflow

1. **Branch from `main`** — name it `feat/<thing>` or `fix/<thing>` or `chore/<thing>`.
2. **Write a test** alongside your code when adding behavior. Tests live in `*.test.ts` files next to source.
3. **Type-check + tests** before pushing:
   ```bash
   npm run typecheck -w packages/api
   npm test -w packages/api
   ```
4. **Open a PR** against `main`. CI must be green:
   - API typecheck + tests
   - Web build
   - SDK build
   - `npm audit` (no high or critical CVEs)
   - Secret scan
   - CodeQL static analysis

`main` is protected — direct pushes are blocked. Every change goes through a PR with required status checks.

## Backward compatibility rule

The default response of `GET /api/v1/:apiId` is a **flat JSON array**, consumed by external projects. Do not change this shape. New response shapes are opt-in:

- `?envelope=v1` for the structured envelope
- `?target=aprender_sistema` for the target adapter projection
- `?layout=raw|matrix` for non-tabular sheets
- `?range=A1:Z100` for slicing

## Commit messages

Conventional Commits with focused scope:

```
feat(envelope): add disponibilidade_anual normalizer
fix(security): drop await from rate-limit registration
chore(deps): bump @types/node from 25.x to 26.x
```

## Reviewer expectations

A PR should:

- Touch only what's required for its scope
- Include or update tests when behavior changes
- Pass CI green
- Have a description that explains *why* (not just *what*)
- Not introduce new high/critical security alerts

## Reporting bugs / proposing features

Use the GitHub issue templates (`.github/ISSUE_TEMPLATE/`). For security issues, follow `SECURITY.md` — please don't open public issues for vulnerabilities.
