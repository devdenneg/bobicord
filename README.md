# Voice

Discord-подобное веб-приложение: голос, текстовый чат и стриминг экрана.
Своя вёрстка, WebRTC-медиа через [LiveKit](https://livekit.io) SFU.

## Стек

- **Фронт** — React 18 + TypeScript + Vite + Zustand, `livekit-client`. Императивный `Engine` (медиа/presence/чат) подключён к React через `useSyncExternalStore`.
- **Бэк** — Node.js + Express, SQLite (`better-sqlite3`), выдаёт LiveKit-токены и хранит пользователей/серверы/историю чата.
- **Медиа** — LiveKit SFU (WebRTC): микрофон, демонстрация экрана + звук, data-канал для чата/эмоутов.
- **Прокси/TLS** — Caddy (авто-HTTPS, статика фронта, reverse-proxy на API и LiveKit).

## Структура

```
voice/
├─ apps/
│  ├─ web/                  # фронт (Vite SPA)
│  │  ├─ src/
│  │  │  ├─ engine.ts       # ядро: LiveKit room, mic-пайплайн, presence, чат
│  │  │  ├─ store.ts        # Zustand-стор + жизненный цикл сервера
│  │  │  ├─ api.ts          # REST-клиент
│  │  │  ├─ components/     # Auth, ServerView, Modals, EmotePicker, Toasts
│  │  │  └─ ...
│  │  └─ package.json
│  └─ server/               # бэк (= token-server в деплое)
│     ├─ index.js           # Express: auth, серверы, инвайты, настройки, сообщения, LK-токены
│     ├─ Dockerfile
│     └─ package.json
├─ docker-compose.yml       # livekit + token + caddy
├─ Caddyfile
├─ livekit.example.yaml     # -> скопировать в livekit.yaml, вписать ключи
├─ .env.example             # -> скопировать в .env, вписать секреты
└─ package.json             # корневые скрипты
```

## Разработка (фронт)

```bash
npm install --prefix apps/web
npm run dev            # vite dev-сервер
npm run typecheck      # tsc --noEmit
npm run build          # -> apps/web/dist
```

Бэк локально обычно не поднимают — работает в Docker на сервере. Фронт ходит на `/api` того же origin (в проде это caddy); для локальной работы против удалённого API добавь `server.proxy` в `apps/web/vite.config.ts`.

## Деплой — CI/CD (GitHub Actions → GHCR → VPS)

**Любой push в `main` (от любого коллаборатора) деплоит всё приложение на прод.**
Workflow `.github/workflows/deploy.yml`:

1. Собирает Docker-образы `bobicord-server` и `bobicord-web` (caddy + собранный фронт + Caddyfile запечены внутрь).
2. Пушит их в GitHub Container Registry (приватные).
3. По SSH заходит на VPS: `docker compose pull && docker compose up -d`.

Разработчику **не нужен** доступ к VPS или ключи — секреты живут в репо, Actions деплоит от их имени. Добавляй людей в **Settings → Collaborators** (роль Write) → они пушат в `main` → прод обновляется сам.

### Секреты репозитория (Settings → Secrets and variables → Actions)

| Секрет        | Значение                                             |
|---------------|------------------------------------------------------|
| `SSH_HOST`    | IP VPS                                                |
| `SSH_USER`    | пользователь SSH (напр. `root`)                      |
| `SSH_KEY`     | приватный deploy-ключ (пара — публичный на VPS)      |
| `GHCR_TOKEN`  | GitHub PAT с `read:packages` (VPS тянет приватные образы) |

### Разовая настройка VPS

Требуется Docker + Docker Compose. На VPS в `/opt/voice` — **только** рантайм, без сорсов:

```
/opt/voice/
├─ docker-compose.yml   # из репо (образы GHCR)
├─ .env                 # секреты (LK_KEY/LK_SECRET/SESSION_SECRET)
├─ livekit.yaml         # ключи LiveKit
└─ data/                # SQLite (создаётся сам)
```

1. `cp .env.example .env` и `cp livekit.example.yaml livekit.yaml`, вписать ключи:
   - `LK_KEY`/`LK_SECRET` — одинаковые в обоих файлах.
   - `SESSION_SECRET` — `openssl rand -hex 32`.
   - в `livekit.yaml` — `node_ip` (публичный IP) и интерфейс; домен — в `apps/web/Caddyfile` (запекается в образ).
2. `docker login ghcr.io -u devdenneg` (PAT с read:packages).
3. Первый деплой запустит push в `main` (или Actions → Run workflow).

Локальная сборка образов (для отладки): `docker compose build` в корне не сработает — образы собираются в CI. Собрать фронт локально: `npm run build`.

## Порты

| Сервис  | Порт            | Назначение                          |
|---------|-----------------|-------------------------------------|
| Caddy   | 80/443          | HTTPS, статика, reverse-proxy       |
| token   | 127.0.0.1:3000  | REST API (за caddy `/api*`)         |
| LiveKit | 7880 / 7881 tcp / 7882 udp | сигналинг + WebRTC        |

## Безопасность

`.env` и `livekit.yaml` содержат секреты и в git **не** коммитятся (см. `.gitignore`).
В репозитории — только `*.example`. SQLite-база (`data/`) тоже игнорируется.
