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

## Деплой (VPS)

Требуется Docker + Docker Compose.

1. Конфиги из шаблонов:
   ```bash
   cp .env.example .env
   cp livekit.example.yaml livekit.yaml
   ```
2. Вписать в `.env` и `livekit.yaml`:
   - `LK_KEY` / `LK_SECRET` — одинаковые в обоих файлах (блок `keys:` в livekit.yaml).
   - `SESSION_SECRET` — `openssl rand -hex 32`.
   - в `livekit.yaml`: `node_ip` (публичный IP) и сетевой интерфейс.
   - в `Caddyfile`: свой домен.
3. Собрать фронт: `npm run build` (даёт `apps/web/dist`, монтируется в caddy).
4. Поднять стек:
   ```bash
   docker compose up -d --build
   ```

Обновление фронта: `npm run build` → пересинкать `apps/web/dist` на сервер (caddy отдаёт с `no-cache`).
Обновление бэка: `docker compose up -d --build token`.

## Порты

| Сервис  | Порт            | Назначение                          |
|---------|-----------------|-------------------------------------|
| Caddy   | 80/443          | HTTPS, статика, reverse-proxy       |
| token   | 127.0.0.1:3000  | REST API (за caddy `/api*`)         |
| LiveKit | 7880 / 7881 tcp / 7882 udp | сигналинг + WebRTC        |

## Безопасность

`.env` и `livekit.yaml` содержат секреты и в git **не** коммитятся (см. `.gitignore`).
В репозитории — только `*.example`. SQLite-база (`data/`) тоже игнорируется.
