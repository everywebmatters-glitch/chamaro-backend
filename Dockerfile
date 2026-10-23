# Chamaro backend image for Google Cloud Run (see deploy/cloudrun/README.md).

FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src
# prisma.config.ts reads DATABASE_URL even for `prisma generate`; nothing connects during the build.
RUN DATABASE_URL="mysql://build:build@localhost:3306/build" npm ci

# Runs `prisma migrate deploy` as a Cloud Run job; keeps the Prisma CLI, which the runtime image drops.
FROM build AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

FROM build AS prune
RUN npm prune --omit=dev --ignore-scripts

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production APP_ENV=production
COPY --from=prune /app/package.json ./
COPY --from=prune /app/node_modules ./node_modules
COPY --from=prune /app/dist ./dist
USER node
# Cloud Run sets PORT (8080); config/env.ts reads it and binds 0.0.0.0.
CMD ["node", "dist/src/server.js"]
