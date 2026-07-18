# --- build ---
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_GIPHY_API_KEY
ENV VITE_GIPHY_API_KEY=${VITE_GIPHY_API_KEY}
RUN npm run build

# --- serve (caddy отдаёт статику + проксирует api/livekit) ---
FROM caddy:2
COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
