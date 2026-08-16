# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Shared dependency layer.
#
# Manifests are copied before source so that a code change does not invalidate
# the install layer — by far the slowest step in this build.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/agents/package.json packages/agents/
COPY packages/config/package.json packages/config/

RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------
# Build both applications.
# ---------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
ARG VITE_API_URL=http://localhost:3001
ENV VITE_API_URL=$VITE_API_URL

COPY . .
RUN pnpm build

# ---------------------------------------------------------------------------
# API runtime.
#
# The db package ships as TypeScript source and is executed with tsx for the
# migrate and seed steps, so both it and the workspace node_modules come along.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS api
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/packages ./packages

# Run as the unprivileged user the base image already provides.
USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]

# ---------------------------------------------------------------------------
# Web runtime — static files behind nginx.
# ---------------------------------------------------------------------------
FROM nginx:alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY scripts/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
