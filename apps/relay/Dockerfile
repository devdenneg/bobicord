# vrelay — headless-агент виртуального fallback-relay (Э9). Контекст сборки — КОРЕНЬ репо
# (path-dependency на apps/relay-core): в deploy.yml шаг собирается с context: . и
# file: apps/relay/Dockerfile. Корневой .dockerignore отсекает target/ и node_modules.
FROM rust:1.82-bookworm AS build
WORKDIR /src
COPY apps/relay-core ./apps/relay-core
COPY apps/relay ./apps/relay
RUN cargo build --release --manifest-path apps/relay/Cargo.toml

FROM debian:bookworm-slim
# ca-certificates — на случай TREE_WS_URL по wss:// (rustls webpki); по умолчанию агент
# ходит на локальный ws://127.0.0.1:3000/tree того же хоста.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/apps/relay/target/release/vrelay /usr/local/bin/vrelay
ENTRYPOINT ["vrelay"]
