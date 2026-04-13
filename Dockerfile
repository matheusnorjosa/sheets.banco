# Stage 1: Build
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/shared/package.json packages/shared/
COPY prisma/ prisma/

RUN npm ci --workspace=packages/api --workspace=packages/shared --include-workspace-root

COPY tsconfig.base.json ./
COPY packages/api/ packages/api/
COPY packages/shared/ packages/shared/

RUN npx prisma generate --schema prisma/schema.prisma
RUN npm run build -w packages/api

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/api/package.json packages/api/
COPY packages/shared/package.json packages/shared/
COPY prisma/ prisma/

RUN npm ci --workspace=packages/api --workspace=packages/shared --include-workspace-root --omit=dev
RUN npx prisma generate --schema prisma/schema.prisma

COPY --from=builder /app/packages/api/dist packages/api/dist
COPY --from=builder /app/packages/shared packages/shared

EXPOSE 3000

CMD ["node", "packages/api/dist/src/index.js"]
