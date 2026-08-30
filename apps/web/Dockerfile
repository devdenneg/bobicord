# --- build ---
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci
COPY . .
# Cross-package and release-policy tests run in Actions before this scoped image build.
RUN npm run build:bundle

# --- serve (caddy отдаёт статику + проксирует api/livekit) ---
FROM caddy:2
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
