# --- build ---
FROM node:20-slim AS build
WORKDIR /app
# .env.local (VITE_VIDEO_TRANSPORT=tree) — в .gitignore, CI его не видит; без явного
# дефолта прод-сборка тихо падает на VideoTransport по умолчанию (livekit, Evolution-TZ
# до Э2) — видео уедет на старый SFU вместо P2P-дерева.
ARG VITE_VIDEO_TRANSPORT=tree
ENV VITE_VIDEO_TRANSPORT=$VITE_VIDEO_TRANSPORT
COPY package.json ./
RUN npm install
COPY . .
RUN npm run build

# --- serve (caddy отдаёт статику + проксирует api/livekit) ---
FROM caddy:2
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
