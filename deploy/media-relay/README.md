# media-relay — аудио-релей YouTube (обход блокировки прослушивания)

Отдельный бокс (НЕ основной медиа-VPS), который извлекает аудиопоток YouTube через
`yt-dlp` и проксирует его браузеру. Официальный IFrame-плеер тянет аудио с
`googlevideo.com` напрямую в браузер — у заблокированных провайдером юзеров не играет.
Релей это лечит, при этом **egress основного VPS не задет**: аудио течёт браузер ↔ этот
бокс напрямую (потому и отдельный хост + свой HTTPS-сабдомен).

Аналог `deploy/vrelay-remote/` — ставится руками на выделенный VPS, `deploy.yml` его не катает.

## Установка

1. **DNS.** A-запись `media.reelay.online` → IP бокса (`138.68.76.148`). Дождись, пока
   резолвится (`dig +short media.reelay.online`) — Caddy без этого не выпустит сертификат.

2. **Скрипт на боксе** (root). С Мака:
   ```bash
   scp deploy/media-relay/setup.sh root@138.68.76.148:/root/
   ssh root@138.68.76.148 'MEDIA_RELAY_DOMAIN=media.reelay.online bash /root/setup.sh'
   ```
   Скрипт ставит `yt-dlp` (свежий standalone), Node, Caddy; поднимает relay-сервис
   (systemd) + HTTPS; печатает **сгенерированный секрет** и результат self-test.

3. **Секрет → в основной сервер.** Из вывода скрипта впиши в `.env` на `reelay.online`:
   ```
   MEDIA_RELAY_URL=https://media.reelay.online
   MEDIA_RELAY_SECRET=<секрет из вывода>
   ```
   Тот же секрет подписывает токены на основном сервере и проверяется боксом (HMAC).

4. **Проверка снаружи** (после ~1-2 мин на DNS+LE):
   ```bash
   curl -sI https://media.reelay.online/health   # 200 ok
   ```

## Контракт

Токен `t = <exp_ms>.<hmac_sha256(videoId + "." + exp_ms, SECRET)>` (подписывает основной сервер).

| Роут | Ответ |
|---|---|
| `GET /health` | `ok` |
| `GET /meta/<id>?t=…` | `{"title","duration"}` |
| `GET /audio/<id>?t=…` | аудио (m4a/webm), Range-совместимо (перемотка) |

`id` — 11-символьный YouTube videoId. Прямой googlevideo-URL кэшируется per-video (TTL 4ч <
времени жизни URL) — одна экстракция обслуживает все Range-запросы трека.

## Если self-test = FAIL (yt-dlp не извлекает)

YouTube банит датацентр-IP («Sign in to confirm you're not a bot»). Тогда:

- **Cookies** (быстрее всего): экспортируй cookies аккаунта YouTube в `cookies.txt`
  (Netscape-формат), положи `/opt/media-relay/cookies.txt`, добавь в relay.js аргумент
  `--cookies /opt/media-relay/cookies.txt` к вызовам `yt-dlp`, перезапусти
  `systemctl restart media-relay`. Минус: cookies протухают, аккаунт под риском бана.
- **PoToken** (стабильнее, сложнее): подними `bgutil-ytdlp-pot-provider` рядом и передавай
  токен через `--extractor-args`. См. вики yt-dlp «PO Token Guide».
- Держи yt-dlp свежим: `curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp && systemctl restart media-relay`.

## Обновление yt-dlp (периодически — YouTube ломает старые версии)

```bash
ssh root@138.68.76.148 'curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp && systemctl restart media-relay'
```

## Логи

```bash
journalctl -u media-relay -f      # relay-сервис (ошибки экстракции)
journalctl -u caddy -f            # HTTPS/сертификат
```
