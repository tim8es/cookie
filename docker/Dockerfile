# Shared compiled artifacts for local Docker staging and future image-based deployment.
# Node 26 no longer bundles Corepack: explicitly pin it.
FROM node:26-trixie-slim AS builder
WORKDIR /workspace
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN npm install --global corepack@0.36.0 && corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/platform-db/package.json packages/platform-db/package.json
RUN pnpm install --frozen-lockfile
COPY . .
# Fail closed by default: no sessionStorage demo in the staged web build.
RUN pnpm build && VITE_COOKIE_DATA_MODE=api pnpm build:web

FROM node:26-trixie-slim AS api
WORKDIR /workspace
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=builder /workspace/package.json ./package.json
COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /workspace/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /workspace/dist ./dist
COPY --from=builder /workspace/db/migrations ./db/migrations
# pnpm's Fastify link is in apps/api/node_modules; compiled output lives in dist.
RUN ln -s ../../../apps/api/node_modules /workspace/dist/apps/api/node_modules
USER node
EXPOSE 3000
CMD ["node", "dist/apps/api/src/main.js"]

FROM nginx:1.27-alpine AS web
COPY docker/nginx-staging.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
