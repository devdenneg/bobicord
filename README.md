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

Прод-workflow разворачивает образы только по SHA и после успешной health-проверки сохраняет этот
`IMAGE_TAG` в `/opt/voice/.env`; последующий ручной restart не может незаметно перейти на `latest`.

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
├─ .env                 # секреты (LK_KEY/LK_SECRET/SESSION_SECRET/VRELAY_AUTH_SECRET)
├─ livekit.yaml         # ключи LiveKit
└─ data/                # SQLite (создаётся сам)
```

1. `cp .env.example .env` и `cp livekit.example.yaml livekit.yaml`, вписать ключи:
   - `LK_KEY`/`LK_SECRET` — одинаковые в обоих файлах.
   - `SESSION_SECRET` — `openssl rand -hex 32`.
   - `VRELAY_AUTH_SECRET` — ещё один результат `openssl rand -hex 32`, обязательно отличный
     от `SESSION_SECRET`; то же значение записывается в `/opt/vrelay/.env` на media VPS.
   - в `livekit.yaml` — `node_ip` (публичный IP) и интерфейс; домен — в `apps/web/Caddyfile` (запекается в образ).
2. `docker login ghcr.io -u devdenneg` (PAT с read:packages).
3. Первый деплой запустит push в `main` (или Actions → Run workflow).

Локальная сборка образов (для отладки): `docker compose build` в корне не сработает — образы собираются в CI. Собрать фронт локально: `npm run build`.

## Email-авторизация и восстановление доступа

Письма отправляет `token` рядом с основным API и SQLite в `/opt/voice`. Используется управляемый
transactional SMTP-провайдер: пароль SMTP и отдельный pepper коротких кодов монтируются только в
этот контейнер как read-only Compose secrets. Сами значения нельзя помещать в `.env`, GitHub
Actions, compose-файл, образ или репозиторий.

Медиа-VPS из `deploy/vrelay-remote/` для почты не используется. Он разворачивается вручную, не
участвует в `deploy.yml` и сейчас не имеет почтового домена, HTTPS API и отдельной доверенной связи
с основным API. Разворачивать там mail-worker до выбора провайдера, DNS, TLS и модели аутентификации
нельзя: это добавит публичную поверхность атаки рядом с realtime-медиа и всё равно потребует второй
секрет связи на основном VPS.

### Что подготовить у почтового провайдера

1. Подтвердить домен отправителя и адрес вроде `no-reply@reelay.online`.
2. Опубликовать выданные провайдером DKIM и Return-Path/SPF записи, затем добавить DMARC. Не копируй
   DNS-примеры от другого провайдера: селекторы и значения выдаются конкретному аккаунту.
3. Использовать submission-порт `587` с обязательным STARTTLS (`SMTP_SECURE=0`,
   `SMTP_REQUIRE_TLS=1`) либо `465` с implicit TLS (`SMTP_SECURE=1`), если его требует провайдер.
   Проверку сертификата в production отключать нельзя.
4. Убедиться, что исходящее соединение с SMTP разрешено именно с основного API VPS, и проверить
   доставку, DKIM/SPF/DMARC и попадание не только в spam до обязательного rollout.

### Секреты на основном VPS

Сначала создай пустые root-only файлы без передачи значений через аргументы команды или shell
history, затем заполни их через защищённый интерактивный редактор или secret manager:

```bash
sudo install -d -m 700 /opt/voice/secrets
sudo install -m 600 /dev/null /opt/voice/secrets/smtp_password
sudo sh -c 'umask 077; openssl rand -hex 32 > /opt/voice/secrets/auth_code_pepper'
sudoedit /opt/voice/secrets/smtp_password
```

`auth_code_pepper` — независимый криптографически случайный секрет минимум из 32 байт, не
`SESSION_SECRET` и не SMTP-пароль. После заполнения оба файла должны остаться обычными непустыми
файлами с mode `600` (допустим `400`).
В `/opt/voice/.env` заполняются только настройки и пути:

```dotenv
APP_PUBLIC_URL=https://reelay.online
AUTH_EMAIL_ENFORCEMENT=disabled
MAIL_FROM_NAME=RelayApp
MAIL_FROM_ADDRESS=no-reply@reelay.online
SMTP_HOST=smtp.provider.example
SMTP_PORT=587
SMTP_SECURE=0
SMTP_REQUIRE_TLS=1
SMTP_USER=provider-user
SMTP_PASSWORD_SECRET_FILE=/opt/voice/secrets/smtp_password
AUTH_CODE_PEPPER_SECRET_FILE=/opt/voice/secrets/auth_code_pepper
```

Не запускай `docker compose config` без `--quiet` в CI или публичной диагностике: итоговая модель
содержит остальные runtime-переменные. Прод-workflow проверяет модель без вывода и при режимах
`optional`/`required` до обновления проверяет SMTP-настройки, secret-файлы и выполняет защищённый
SMTP handshake из immutable candidate-образа.

### Одноразовый bootstrap администратора denis

На чистой базе сначала создай единственного владельца приглашений — точный логин `denis`. Команда
работает offline, не принимает email или пароль в аргументах и никогда не печатает их. Она также
подходит для восстановления базы, где уже есть другие пользователи, но нет `denis`. Если `denis`
уже существует (в любом регистре), команда завершится ошибкой и ничего не перезапишет.

После загрузки нового образа останови API, создай два временных root-only файла и заполни их через
защищённый редактор. Email и пароль должны занимать ровно одну строку; пароль проходит ту же
проверку стойкости, что и обычная регистрация:

```bash
sudo install -d -m 700 /run/relay-bootstrap
sudo install -m 600 /dev/null /run/relay-bootstrap/admin_email
sudo install -m 600 /dev/null /run/relay-bootstrap/admin_password
sudoedit /run/relay-bootstrap/admin_email
sudoedit /run/relay-bootstrap/admin_password
# На чистой установке до первого запуска запиши в /opt/voice/.env точный 40-символьный
# SHA кандидата из успешно завершившегося build job: IMAGE_TAG=<этот SHA>.
sudoedit /opt/voice/.env
docker compose config --quiet
docker compose pull token
docker compose stop token
docker compose run --rm --no-deps \
  -e BOOTSTRAP_ADMIN_EMAIL_FILE=/run/bootstrap/admin_email \
  -e BOOTSTRAP_ADMIN_PASSWORD_FILE=/run/bootstrap/admin_password \
  --mount type=bind,src=/run/relay-bootstrap/admin_email,dst=/run/bootstrap/admin_email,readonly \
  --mount type=bind,src=/run/relay-bootstrap/admin_password,dst=/run/bootstrap/admin_password,readonly \
  token node bootstrap-admin.js
```

Команда пишет verified email, роль администратора и пароль в формате `prehash-v1` одной SQLite-
транзакцией. После сообщения об успехе удали оба временных файла и запускай обычный rollout:

```bash
sudo rm /run/relay-bootstrap/admin_email /run/relay-bootstrap/admin_password
sudo rmdir /run/relay-bootstrap
docker compose up -d
```

Каталог `/run` обычно находится в tmpfs и не попадает в дисковые snapshots. Не добавляй
bootstrap-файлы в постоянные Compose secrets и не сохраняй их в `.env`, резервных
копиях или истории команд. Для уже существующего `denis` email привязывается штатным экраном
миграции, а пароль восстанавливается штатным письмом — bootstrap для этого повторно не запускается.

### Безопасный rollout

1. Оставить `AUTH_EMAIL_ENFORCEMENT=disabled`, настроить DNS, SMTP и secret-файлы. В этом режиме
   существующие аккаунты не блокируются, но denis уже может проверить новую регистрацию по инвайту.
2. Выполнить `docker compose config --quiet`, развернуть API и проверить доставку, тестовую
   регистрацию, привязку email и полный сценарий восстановления пароля на вебе и desktop.
3. Переключить на `optional`: обновлённый клиент покажет обязательную миграцию, а старый клиент ещё
   не будет заблокирован сервером. Для забывшего старый пароль denis после внешней проверки личности
   выдаёт короткий одноразовый support-код из админки.
4. Проверить доставляемость, отсутствие секретов/reset URL в логах и долю привязанных аккаунтов.
5. Только после завершения миграции установить `AUTH_EMAIL_ENFORCEMENT=required`. API начнёт
   отклонять непроверенные сессии; verified-пользователи продолжат работать даже при временном
   падении SMTP, а незавершённая привязка сможет подтвердить уже доставленный код.

Пока реальные secret-файлы не подготовлены, оставь оба `*_SECRET_FILE=/dev/null` и режим
`disabled`. `/dev/null` запрещён для `optional` и `required` и будет отклонён preflight-проверкой.

Первый auth-capable deploy до перезапуска атомарно создаёт защитный baseline-marker. После этого
нельзя откатывать `token` на образ без `auth.js`: старый образ не учитывает отзыв JWT после смены
пароля/почты. Если первый запуск оборвался после pre-arm, восстановление выполняется только вперёд
исправленным auth-capable образом; успешный health-check отдельно помечает baseline активным.

## Порты

| Сервис  | Порт            | Назначение                          |
|---------|-----------------|-------------------------------------|
| Caddy   | 80/443          | HTTPS, статика, reverse-proxy       |
| token   | 127.0.0.1:3000  | REST API (за caddy `/api*`)         |
| LiveKit | 7880 / 7881 tcp / 7882 udp | сигналинг + WebRTC        |

## Безопасность

`.env` и `livekit.yaml` содержат секреты и в git **не** коммитятся (см. `.gitignore`).
В репозитории — только `*.example`. SQLite-база (`data/`) тоже игнорируется.

`SESSION_SECRET` остаётся только на основном API VPS. Удалённый `vrelay` подписывает
короткоживущие service-JWT отдельным `VRELAY_AUTH_SECRET`; API принимает их только с `HS256`,
аудиторией `relay-tree` и типом `vrelay`. Новый образ vrelay вообще не читает `SESSION_SECRET`.

### Первая ротация медиарелея без простоя

1. Сгенерировать новый `VRELAY_AUTH_SECRET` и заранее добавить одинаковое значение в
   `/opt/voice/.env` и `/opt/vrelay/.env`. Оно не должно совпадать с `SESSION_SECRET`.
2. Только для первого обновления установить на основном VPS
   `VRELAY_ACCEPT_LEGACY_SESSION_TOKEN=1` и развернуть основной стек. API напечатает security-warning,
   но старый vrelay продолжит работать до следующего шага.
3. Скопировать на media VPS новый `deploy/vrelay-remote/docker-compose.yml`, записать в
   `/opt/vrelay/.env` точный `VRELAY_IMAGE_TAG` из успешного deploy workflow, затем выполнить
   `docker compose pull && docker compose up -d`. Новый compose больше не
   передаёт `SESSION_SECRET`; после успешного подключения удалить эту строку и из его `.env`.
4. Проверить в логах API новое подключение без сообщения `legacy vrelay`.
5. Поскольку прежний `SESSION_SECRET` уже находился на менее доверенном media VPS, сгенерировать
   новый `SESSION_SECRET` только на основном API VPS, одновременно вернуть
   `VRELAY_ACCEPT_LEGACY_SESSION_TOKEN=0` и пересоздать `token`. Это намеренно завершит все текущие
   пользовательские сессии. Старое значение удалить с media VPS, резервных копий и secret manager.

Флаг совместимости по умолчанию выключен. Оставлять его включённым после шага 5 нельзя: пока он
равен `1`, скомпрометированный старый `SESSION_SECRET` всё ещё может выдать legacy-токен медиарелея.
