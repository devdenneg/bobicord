#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# media-relay: аудио-релей YouTube для совместного прослушивания (обход блокировки).
#
# Зачем: официальный IFrame-плеер тянет аудио с googlevideo.com напрямую в браузер —
# у заблокированных провайдером юзеров не играет. Этот релей на ОТДЕЛЬНОМ боксе
# (не основной VPS!) извлекает аудиопоток через yt-dlp и проксирует его браузеру, так
# что egress основного медиа-VPS (потолок ~14-20 Мбит/с) не задет: аудио идёт
# браузер ↔ этот бокс напрямую.
#
# Контракт (проверяет token = HMAC с истечением, подписывает основной сервер):
#   GET /health                      → "ok"
#   GET /meta/<videoId>?t=<token>    → {"title","duration"}
#   GET /audio/<videoId>?t=<token>   → аудио (m4a/webm), с Range для перемотки
#
# Запуск (root на боксе 138.68.76.148):
#   MEDIA_RELAY_DOMAIN=media.reelay.online ./setup.sh
#   # секрет сгенерируется и напечатается в конце — впиши его в .env основного сервера
#   # (MEDIA_RELAY_SECRET) и укажи там же MEDIA_RELAY_URL=https://media.reelay.online
#
# ПРЕДВАРИТЕЛЬНО: A-запись MEDIA_RELAY_DOMAIN → IP этого бокса ДОЛЖНА уже резолвиться
# (Caddy берёт Let's Encrypt-сертификат по ней; без DNS сертификат не выпустится).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

[ "$(id -u)" = "0" ] || { echo "нужен root"; exit 1; }

DOMAIN="${MEDIA_RELAY_DOMAIN:-media.reelay.online}"
SECRET="${MEDIA_RELAY_SECRET:-$(openssl rand -hex 32)}"
PORT="${PORT:-8080}"
FMT="${MEDIA_RELAY_FMT:-bestaudio[ext=m4a]/bestaudio}"  # формат для self-test и relay.js (одна истина)

echo "== media-relay setup: domain=$DOMAIN port=$PORT =="

# --- 1. зависимости: node (только core-модули), yt-dlp (свежий standalone бинарь), caddy ---
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl ca-certificates nodejs debian-keyring debian-archive-keyring apt-transport-https

# yt-dlp — standalone-бинарь (PyInstaller, python не нужен); держим свежим (YouTube часто ломает старые).
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp

# Caddy — авто-HTTPS (Let's Encrypt) + reverse-proxy на наш node-сервис.
if ! command -v caddy >/dev/null 2>&1; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
fi

# nginx-дефолт (если стоит) занимает :80/:443 — освобождаем под Caddy.
systemctl stop nginx 2>/dev/null || true
systemctl disable nginx 2>/dev/null || true

# --- 2. relay-сервис (только node core: http/https/crypto/child_process — без npm-зависимостей) ---
mkdir -p /opt/media-relay
cat >/opt/media-relay/relay.js <<'RELAY_EOF'
'use strict';
// Аудио-релей YouTube. Слушает 127.0.0.1 (Caddy проксирует HTTPS снаружи). Токен — HMAC(videoId.exp).
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SECRET = process.env.MEDIA_RELAY_SECRET || '';
const PORT = parseInt(process.env.PORT || '8080', 10);
const FMT = process.env.MEDIA_RELAY_FMT || 'bestaudio[ext=m4a]/bestaudio';
const CACHE_TTL = 4 * 3600 * 1000; // < ~6ч жизни googlevideo-URL: одна экстракция обслуживает все Range-запросы трека
const cache = new Map();           // videoId -> { url, exp }

if (!SECRET) { console.error('MEDIA_RELAY_SECRET не задан'); process.exit(1); }

function verify(videoId, t) {
  if (!t) return false;
  const dot = String(t).indexOf('.');
  if (dot < 0) return false;
  const expStr = t.slice(0, dot), sig = t.slice(dot + 1);
  const exp = parseInt(expStr, 10);
  if (!exp || Date.now() > exp) return false;
  const good = crypto.createHmac('sha256', SECRET).update(videoId + '.' + expStr).digest('hex');
  try { return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)); } catch { return false; }
}
function ytUrl(videoId) { return 'https://www.youtube.com/watch?v=' + videoId; }

function extract(videoId, cb) {
  const c = cache.get(videoId);
  if (c && c.exp > Date.now()) return cb(null, c.url);
  execFile('yt-dlp', ['-f', FMT, '-g', '--no-warnings', '--no-playlist', ytUrl(videoId)], { timeout: 25000 }, (err, out) => {
    if (err) return cb(err);
    const url = String(out).trim().split('\n')[0];
    if (!/^https:\/\//.test(url)) return cb(new Error('no url'));
    cache.set(videoId, { url, exp: Date.now() + CACHE_TTL });
    cb(null, url);
  });
}

function proxyAudio(directUrl, req, res) {
  let u; try { u = new URL(directUrl); } catch { res.writeHead(502); return res.end(); }
  const headers = { 'user-agent': 'Mozilla/5.0' };
  if (req.headers.range) headers.range = req.headers.range;
  const up = https.request(u, { method: 'GET', headers }, (r) => {
    // 403 = URL протух на стороне googlevideo → сбросить кэш, чтобы след. запрос пере-извлёк
    if (r.statusCode === 403) cache.clear();
    const h = {};
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) if (r.headers[k]) h[k] = r.headers[k];
    if (!h['accept-ranges']) h['accept-ranges'] = 'bytes';
    res.writeHead(r.statusCode || 200, h);
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.on('close', () => up.destroy());
  up.end();
}

const server = http.createServer((req, res) => {
  let url; try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'health') { res.writeHead(200); return res.end('ok'); }
  const videoId = parts[1] || '';
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) { res.writeHead(400); return res.end(); }
  if (!verify(videoId, url.searchParams.get('t'))) { res.writeHead(403); return res.end(); }

  if (parts[0] === 'meta') {
    execFile('yt-dlp', ['--no-warnings', '--no-playlist', '--skip-download', '--print', '%(title)s|||%(duration)s', ytUrl(videoId)], { timeout: 25000 }, (err, out) => {
      if (err) { res.writeHead(502); return res.end(); }
      const [title, dur] = String(out).trim().split('|||');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ title: title || videoId, duration: parseInt(dur, 10) || 0 }));
    });
    return;
  }
  if (parts[0] === 'audio') {
    extract(videoId, (err, directUrl) => {
      if (err) { console.error('[extract]', videoId, err.message); res.writeHead(502); return res.end(); }
      proxyAudio(directUrl, req, res);
    });
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(PORT, '127.0.0.1', () => console.log('media-relay on 127.0.0.1:' + PORT));
RELAY_EOF

# --- 3. systemd-юнит ---
cat >/etc/systemd/system/media-relay.service <<UNIT_EOF
[Unit]
Description=YouTube audio relay
After=network.target

[Service]
Environment=MEDIA_RELAY_SECRET=${SECRET}
Environment=PORT=${PORT}
ExecStart=/usr/bin/node /opt/media-relay/relay.js
Restart=always
RestartSec=2
User=root

[Install]
WantedBy=multi-user.target
UNIT_EOF

# --- 4. Caddy: HTTPS-фронт (авто-LE) → node на 127.0.0.1:PORT ---
cat >/etc/caddy/Caddyfile <<CADDY_EOF
${DOMAIN} {
	reverse_proxy 127.0.0.1:${PORT}
}
CADDY_EOF

# авто-обновление yt-dlp раз в неделю (YouTube ломает старые версии за недели → релей отвалится)
cat >/etc/cron.weekly/yt-dlp-update <<'CRON_EOF'
#!/bin/sh
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp && systemctl restart media-relay
CRON_EOF
chmod +x /etc/cron.weekly/yt-dlp-update

systemctl daemon-reload
systemctl enable media-relay >/dev/null 2>&1 || true
systemctl restart media-relay   # restart (не enable --now): подхватить новый секрет/код при повторном прогоне
systemctl restart caddy

echo
echo "== self-test: извлекает ли yt-dlp аудио с ЭТОГО IP (YouTube банит датацентры) =="
if timeout 30 yt-dlp -f "$FMT" -g --no-warnings --no-playlist "https://www.youtube.com/watch?v=dQw4w9WgXcQ" >/tmp/ytt 2>/tmp/ytt.err; then
  echo "  PASS ✅  yt-dlp вернул URL: $(head -c 60 /tmp/ytt)…"
else
  echo "  FAIL ❌  yt-dlp НЕ извлёк (вероятно bot-detection датацентр-IP). Причина:"
  sed 's/^/    /' /tmp/ytt.err | tail -5
  echo "  → нужен cookies-файл или PoToken (см. README). Дальше строить смысла нет, пока не PASS."
fi

echo
echo "== health релея =="
sleep 1; curl -s "http://127.0.0.1:${PORT}/health" && echo " (локально ок)"
echo
echo "════════════════════════════════════════════════════════════════"
echo " ГОТОВО. Впиши в .env ОСНОВНОГО сервера (reelay.online):"
echo "   MEDIA_RELAY_URL=https://${DOMAIN}"
echo "   MEDIA_RELAY_SECRET=${SECRET}"
echo " Проверка снаружи (после того как DNS+LE поднимутся, ~1-2 мин):"
echo "   curl -sI https://${DOMAIN}/health"
echo "════════════════════════════════════════════════════════════════"
