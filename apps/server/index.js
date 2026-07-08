const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
const { WebSocketServer } = require('ws');
const { attachTreeServer } = require('./tree');

const app = express();
// Нативный (Tauri) клиент грузит локальный bundle — его origin (tauri://localhost)
// всегда кросс-доменный к API. Auth — только Bearer-токен (без cookies), поэтому
// wildcard-CORS безопасен: credentials не используются.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '32kb' }));

const KEY = process.env.LK_KEY;
const SECRET = process.env.LK_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change';
if (!process.env.SESSION_SECRET) console.warn('WARN: SESSION_SECRET не задан в env — использую дефолт. Задай его в .env на VPS для безопасности сессий.');
// вынесено в env (CLAUDE.md инвариант); дефолт — текущий прод-хост, для обратной совместимости
const WS_URL = process.env.LK_WS_URL || 'wss://138-16-170-21.sslip.io';
// coturn (Evolution-TZ Э3): TURN_SECRET пусто => TURN отключён, дереву достаётся только STUN
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_URLS = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TURN_TTL_SEC = parseInt(process.env.TURN_TTL_SEC || '600', 10);
const DATA_DIR = '/app/data';
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
// сюда CI (build-windows.yml) заливает установщик натива + latest.json (updater-манифест)
const RELEASES_DIR = path.join(DATA_DIR, 'releases');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(RELEASES_DIR, { recursive: true }); } catch (e) {}

/* ---------------- DB ---------------- */
const db = new Database(path.join(DATA_DIR, 'voice.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  passhash TEXT NOT NULL,
  avatar_color INTEGER NOT NULL DEFAULT 0,
  avatar_url TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS servers(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  icon_color INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memberships(
  user_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joined INTEGER NOT NULL,
  PRIMARY KEY(user_id, server_id)
);
CREATE TABLE IF NOT EXISTS invites(
  code TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  requires_password INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS server_settings(
  user_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY(user_id, server_id)
);
CREATE TABLE IF NOT EXISTS user_settings(
  user_id TEXT PRIMARY KEY,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_color INTEGER NOT NULL DEFAULT 0,
  text TEXT NOT NULL,
  emotes TEXT NOT NULL DEFAULT '{}',
  image TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS roles(
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  permissions INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS member_roles(
  server_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  PRIMARY KEY(server_id, user_id, role_id)
);
CREATE TABLE IF NOT EXISTS voice_channels(
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs(
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_prefs(
  user_id TEXT PRIMARY KEY,
  mention INTEGER NOT NULL DEFAULT 1,
  stream INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS read_state(
  user_id TEXT NOT NULL,
  server_id TEXT NOT NULL,
  last_read INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id, server_id)
);
CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id);
CREATE INDEX IF NOT EXISTS idx_vc_server ON voice_channels(server_id, position);
CREATE INDEX IF NOT EXISTS idx_msg_server ON messages(server_id, created);
CREATE INDEX IF NOT EXISTS idx_msg_server_id ON messages(server_id, id);
CREATE INDEX IF NOT EXISTS idx_mem_server ON memberships(server_id);
CREATE INDEX IF NOT EXISTS idx_mem_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_inv_server ON invites(server_id);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles(server_id);
CREATE INDEX IF NOT EXISTS idx_mroles ON member_roles(server_id, user_id);
`);

/* add new columns to pre-existing DBs (idempotent — throws if column exists) */
for (const sql of [
  "ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE messages ADD COLUMN image TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE messages ADD COLUMN reply_to TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE servers ADD COLUMN description TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE servers ADD COLUMN icon_url TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE invites ADD COLUMN expires INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE messages ADD COLUMN client_key TEXT NOT NULL DEFAULT ''",
]) { try { db.exec(sql); } catch (e) { /* column already exists */ } }

// Идемпотентность отправки: клиент шлёт стабильный dedup-ключ (переживает retry). Partial-unique
// индекс (только для непустого ключа — старые/безключевые сообщения не задеты) даёт INSERT OR IGNORE
// схлопнуть повторный POST, если первый дошёл в БД, а ответ до клиента не добрался.
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_ckey ON messages(server_id, user_id, client_key) WHERE client_key <> ''"); } catch (e) {}

/* one-time migration of legacy users.json -> users table */
(function migrateLegacy() {
  const legacy = path.join(DATA_DIR, 'users.json');
  if (!fs.existsSync(legacy)) return;
  try {
    const obj = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    const ins = db.prepare('INSERT OR IGNORE INTO users(id,username,display_name,passhash,avatar_color,bio,created) VALUES(?,?,?,?,?,?,?)');
    const now = Date.now();
    for (const uname of Object.keys(obj)) {
      const u = obj[uname];
      if (!u || !u.passhash) continue;
      ins.run(newId('u'), uname, uname, u.passhash, hashColor(uname), '', u.created || now);
    }
    fs.renameSync(legacy, legacy + '.migrated');
    console.log('migrated legacy users:', Object.keys(obj).length);
  } catch (e) { console.log('legacy migration skipped:', e.message); }
})();

/* ---------------- helpers ---------------- */
function newId(prefix) { return prefix + '_' + crypto.randomBytes(8).toString('hex'); }
function inviteCode() { return crypto.randomBytes(6).toString('base64url'); }
function hashColor(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 8; }
const UNAME = /^[a-zA-Z0-9_]{3,20}$/;
const norm = u => String(u || '').trim().toLowerCase();
const makeSession = id => jwt.sign({ id }, SESSION_SECRET, { expiresIn: '30d' });

function authUser(req) {
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  try {
    const p = jwt.verify(t, SESSION_SECRET);
    if (p.id) return db.prepare('SELECT * FROM users WHERE id=?').get(p.id) || null;
    if (p.u) return db.prepare('SELECT * FROM users WHERE username=?').get(p.u) || null; // legacy session
    return null;
  } catch (e) { return null; }
}
function requireAuth(req, res, next) {
  const u = authUser(req);
  if (!u) return res.status(401).json({ error: 'Не авторизован' });
  req.user = u; next();
}
const rsc = new RoomServiceClient(WS_URL.replace('wss://', 'https://'), KEY, SECRET);
// LiveKit identity = `username#<nonce>` (уникально на сессию — иначе второй девайс кикает первого).
// Наружу (presence/voice) отдаём БАЗОВЫЙ username, дедуплицируя несколько сессий одного юзера.
const baseIdentity = id => { const s = String(id || ''); const i = s.indexOf('#'); return i < 0 ? s : s.slice(0, i); };
async function onlineIn(serverId) {
  try { const ps = await rsc.listParticipants('srv:' + serverId); return [...new Set(ps.map(p => baseIdentity(p.identity)))]; }
  catch (e) { return []; }
}
// Детальный online-состав для превью на главной: аватар/имя + чем занят (стрим/голос). Стрим —
// LiveKit ScreenShare-трек (браузерное вещание) ИЛИ активный tree-broadcaster (нативное). Голос —
// mic-трек или vc-атрибут. Сессии одного юзера сводим к одному. LK TrackSource: MICROPHONE=2, SCREEN_SHARE=3.
async function onlineDetailed(serverId) {
  try {
    const ps = await rsc.listParticipants('srv:' + serverId);
    const byUser = new Map();
    for (const p of ps) {
      const u = baseIdentity(p.identity);
      const tracks = p.tracks || [];
      const streaming = tracks.some(t => t.source === 3);
      const inVoice = tracks.some(t => t.source === 2) || !!(p.attributes && p.attributes.vc);
      // Игровой статус (натив-атрибуты game/gicon) — для блока «Играют сейчас» на главной (кросс-сервер).
      const game = p.attributes && p.attributes.game ? String(p.attributes.game).slice(0, 64) : '';
      const gicon = p.attributes && p.attributes.gicon ? String(p.attributes.gicon) : '';
      const cur = byUser.get(u) || { streaming: false, inVoice: false, game: '', gicon: '' };
      byUser.set(u, { streaming: cur.streaming || streaming, inVoice: cur.inVoice || inVoice, game: cur.game || game, gicon: cur.gicon || gicon });
    }
    for (const u of treeSrv.liveBroadcastersIn(serverId)) { const c = byUser.get(u) || { streaming: false, inVoice: false }; c.streaming = true; byUser.set(u, c); }
    const stmt = db.prepare('SELECT display_name, avatar_color, avatar_url FROM users WHERE username=?');
    const out = [];
    for (const [username, st] of byUser) {
      const r = stmt.get(username);
      out.push({ username, displayName: r ? r.display_name : username, avatarColor: r ? r.avatar_color : 0, avatarUrl: r ? (r.avatar_url || '') : '', streaming: st.streaming, inVoice: st.inVoice, game: st.game || undefined, gicon: st.gicon || undefined });
    }
    // сначала стримеры, потом в голосе, потом остальные — для превью
    out.sort((a, b) => (b.streaming - a.streaming) || (b.inVoice - a.inVoice));
    return out;
  } catch (e) { return []; }
}
// online-состав + карта {username: channelId} (кто в каком голосовом канале) из participant-атрибута vc.
// Отдаём это в /presence, чтобы состав голосовых каналов был виден сразу на загрузке — не дожидаясь,
// пока у зрителя локально поднимется LiveKit-комната. Несколько сессий одного юзера сводим к одному.
async function voiceStateIn(serverId) {
  try {
    const ps = await rsc.listParticipants('srv:' + serverId);
    const online = new Set(), voice = {};
    for (const p of ps) { const u = baseIdentity(p.identity); online.add(u); const vc = p.attributes && p.attributes.vc; if (vc) voice[u] = vc; }
    return { online: [...online], voice };
  } catch (e) { return { online: [], voice: {} }; }
}
/* ---------------- Web Push (VAPID) — фоновые уведомления для PWA (iOS/Android) и закрытого приложения ----------------
 * Ключи берём из env (VAPID_PUBLIC/VAPID_PRIVATE), иначе авто-генерим и СТАБИЛЬНО храним в
 * DATA_DIR/vapid.json — рестарт не должен инвалидировать уже выданные подписки. web-push не
 * установлен / ключи не завелись → push просто отключён (не роняем сервер). */
let VAPID = null;
(function initVapid() {
  try {
    const webpush = require('web-push');
    let pub = process.env.VAPID_PUBLIC, priv = process.env.VAPID_PRIVATE;
    const subject = process.env.VAPID_SUBJECT || 'mailto:admin@relay.app';
    if (!pub || !priv) {
      const f = path.join(DATA_DIR, 'vapid.json');
      if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); pub = j.publicKey; priv = j.privateKey; }
      else { const k = webpush.generateVAPIDKeys(); pub = k.publicKey; priv = k.privateKey; fs.writeFileSync(f, JSON.stringify(k)); console.log('VAPID keys сгенерированы →', f); }
    }
    webpush.setVapidDetails(subject, pub, priv);
    VAPID = { webpush, publicKey: pub };
    console.log('Web Push включён');
  } catch (e) { console.warn('Web Push отключён:', e.message); }
})();

// Разослать web-push набору user_id. kind фильтруется по push_prefs (юзер мог выключить тип);
// отсутствие строки prefs = дефолт «всё включено». Протухшие подписки (404/410) удаляем.
async function pushToUsers(kind, userIds, payload) {
  if (!VAPID || !userIds || !userIds.length) return;
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return;
  const ph = ids.map(() => '?').join(',');
  const prefCol = kind === 'stream' ? 'stream' : 'mention';
  const rows = db.prepare(
    `SELECT s.* FROM push_subs s WHERE s.user_id IN (${ph}) ` +
    `AND NOT EXISTS (SELECT 1 FROM push_prefs p WHERE p.user_id=s.user_id AND p.${prefCol}=0)`
  ).all(...ids);
  const body = JSON.stringify(payload);
  // urgency:'high' — КРИТИЧНО для мгновенной доставки: без него push-сервисы (FCM/APNs/Mozilla)
  // считают уведомление низкоприоритетным и БАТЧАТ его (доставка минутами, особенно на спящем
  // мобильном) → симптом «приходят не сразу». high → FCM high priority / APNs apns-priority:10.
  // TTL 1 день — переживёт короткий оффлайн (доставится при реконнекте устройства), но не копится
  // вечно. topic НЕ ставим: он схлопнул бы разные упоминания (два тега оффлайн → видно только последний).
  const opts = { TTL: 86400, urgency: 'high' };
  await Promise.all(rows.map(async (r) => {
    try { await VAPID.webpush.sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, body, opts); }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) db.prepare('DELETE FROM push_subs WHERE endpoint=?').run(r.endpoint); }
  }));
}

// Кого упоминает text среди members (mirror engine.textMentionsMe: @username / @displayName /
// @everyone|@all|@все, с учётом многословных ников). Возвращает Set user_id.
function mentionedIds(text, members) {
  const out = new Set();
  const raw = String(text || '');
  if (!raw) return out;
  if (/@(everyone|all|все)\b/i.test(raw)) { for (const m of members) out.add(m.id); return out; }
  const low = raw.toLowerCase();
  const tokens = new Set(); let mm; const re = /@([^\s@]+)/g;
  while ((mm = re.exec(low))) tokens.add(mm[1]);
  for (const m of members) {
    const u = String(m.username || '').toLowerCase();
    const d = String(m.display_name || '').toLowerCase();
    if (tokens.has(u) || tokens.has(d)) { out.add(m.id); continue; }
    if (d.includes(' ') && low.includes('@' + d)) out.add(m.id);
  }
  return out;
}
function serverMembersFull(sid) {
  return db.prepare('SELECT u.id,u.username,u.display_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.server_id=?').all(sid);
}

// Глобальный live-notify канал (WS /ws): не привязан к серверной LiveKit-комнате, поэтому юзер
// получает уведомление о упоминании/трансляции в ЛЮБОМ своём сервере — даже в НЕ подключённом
// (веб-push бьёт только по свёрнутому/закрытому; натив web-push не получает вообще). Карта
// user_id → набор живых ws-соединений (несколько устройств/вкладок). Заполняется в WS-setup внизу.
const notifyConns = new Map();
function notifyUser(userId, payload) {
  const set = notifyConns.get(userId);
  if (!set || !set.size) return;
  const data = JSON.stringify(payload);
  for (const ws of set) { if (ws.readyState === 1 /* OPEN */) { try { ws.send(data); } catch (e) { /**/ } } }
}
function serverName(sid) { const s = db.prepare('SELECT name FROM servers WHERE id=?').get(sid); return s ? s.name : 'Сервер'; }

const pubUser = u => ({ id: u.id, username: u.username, displayName: u.display_name, avatarColor: u.avatar_color, avatarUrl: u.avatar_url || '', bio: u.bio });
const UPLOAD_RE = /^\/api\/uploads\/[a-zA-Z0-9._-]+$/; // локальный путь к загрузке
const pubServer = s => ({ id: s.id, name: s.name, ownerId: s.owner_id, iconColor: s.icon_color, iconUrl: s.icon_url || '', description: s.description || '' });
function isMember(uid, sid) { return !!db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND server_id=?').get(uid, sid); }
function memberCount(sid) { return db.prepare('SELECT COUNT(*) c FROM memberships WHERE server_id=?').get(sid).c; }
// Непрочитанные: чат-сообщения сервера НОВЕЕ last_read юзера и НЕ его собственные. Системных
// событий (стрим/обновление) в БД нет — их клиент добавляет к бейджу локально.
const _lastReadStmt = db.prepare('SELECT last_read FROM read_state WHERE user_id=? AND server_id=?');
const _unreadStmt = db.prepare('SELECT COUNT(*) c FROM messages WHERE server_id=? AND id>? AND user_id!=?');
function unreadCount(uid, sid) {
  const r = _lastReadStmt.get(uid, sid);
  if (!r) {
    // первое обращение — считаем весь бэклог прочитанным (иначе на раскатке/первом входе каждый
    // сервер открылся бы с сотнями «непрочитанных» и дивайдером у самого верха). Лениво сеем.
    markRead(uid, sid, db.prepare('SELECT MAX(id) m FROM messages WHERE server_id=?').get(sid).m || 0);
    return 0;
  }
  return _unreadStmt.get(sid, r.last_read, uid).c;
}
function markRead(uid, sid, lastId) {
  db.prepare('INSERT INTO read_state(user_id,server_id,last_read) VALUES(?,?,?) ON CONFLICT(user_id,server_id) DO UPDATE SET last_read=MAX(last_read, excluded.last_read)')
    .run(uid, sid, Number(lastId) || 0);
}
function roleOf(uid, sid) { const r = db.prepare('SELECT role FROM memberships WHERE user_id=? AND server_id=?').get(uid, sid); return r ? r.role : null; }

/* ---- права (битовая маска; задел на будущее — часть уже проверяется) ---- */
const PERM = { MANAGE_SERVER: 1, MANAGE_ROLES: 2, MANAGE_MEMBERS: 4, MANAGE_MESSAGES: 8, CREATE_INVITE: 16, MANAGE_CHANNELS: 32 };
const MAX_CHANNELS = 5;
const ALL_PERMS = Object.values(PERM).reduce((a, b) => a | b, 0);
const isOwner = (uid, sid) => { const s = db.prepare('SELECT owner_id FROM servers WHERE id=?').get(sid); return !!s && s.owner_id === uid; };
function permsOf(uid, sid) {
  if (isOwner(uid, sid)) return ALL_PERMS;
  const rows = db.prepare('SELECT r.permissions p FROM member_roles mr JOIN roles r ON r.id=mr.role_id WHERE mr.server_id=? AND mr.user_id=?').all(sid, uid);
  return rows.reduce((a, r) => a | (r.p || 0), 0);
}
const can = (uid, sid, perm) => (permsOf(uid, sid) & perm) === perm;
const pubRole = r => ({ id: r.id, name: r.name, color: r.color || '', permissions: r.permissions || 0, position: r.position || 0 });
function rolesOfServer(sid) { return db.prepare('SELECT * FROM roles WHERE server_id=? ORDER BY position DESC, created ASC').all(sid).map(pubRole); }
function rolesOfMember(sid, uid) { return db.prepare('SELECT r.* FROM member_roles mr JOIN roles r ON r.id=mr.role_id WHERE mr.server_id=? AND mr.user_id=? ORDER BY r.position DESC').all(sid, uid).map(pubRole); }

/* ---- голосовые каналы (несколько на сервер, максимум MAX_CHANNELS) ---- */
const pubChannel = c => ({ id: c.id, name: c.name, position: c.position || 0 });
function channelsOf(sid) { return db.prepare('SELECT * FROM voice_channels WHERE server_id=? ORDER BY position ASC, created ASC').all(sid).map(pubChannel); }
// у каждого сервера всегда есть хотя бы один канал; для legacy-серверов создаём «Общий» лениво
function ensureDefaultChannel(sid) {
  const n = db.prepare('SELECT COUNT(*) c FROM voice_channels WHERE server_id=?').get(sid).c;
  if (n === 0) db.prepare('INSERT INTO voice_channels(id,server_id,name,position,created) VALUES(?,?,?,?,?)').run(newId('vc'), sid, 'Общий', 0, Date.now());
}

/* ---------------- AUTH ---------------- */
app.post('/api/register', (req, res) => {
  const uname = norm(req.body.username);
  const pass = String(req.body.password || '');
  if (!UNAME.test(uname)) return res.status(400).json({ error: 'Логин: 3-20 символов, латиница/цифры/_' });
  if (pass.length < 4) return res.status(400).json({ error: 'Пароль минимум 4 символа' });
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(uname)) return res.status(409).json({ error: 'Логин занят' });
  const id = newId('u');
  db.prepare('INSERT INTO users(id,username,display_name,passhash,avatar_color,bio,created) VALUES(?,?,?,?,?,?,?)')
    .run(id, uname, uname, bcrypt.hashSync(pass, 10), hashColor(uname), '', Date.now());
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  res.json({ token: makeSession(id), user: pubUser(u), username: u.username });
});

app.post('/api/login', (req, res) => {
  const uname = norm(req.body.username);
  const pass = String(req.body.password || '');
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(uname);
  if (!u || !bcrypt.compareSync(pass, u.passhash)) return res.status(401).json({ error: 'Неверный логин или пароль' });
  res.json({ token: makeSession(u.id), user: pubUser(u), username: u.username });
});

/* ---------------- Discord detectable-games (аллоулист для натив-детекта игры) ---------------- */
// Дистиллируем публичный список Discord (тысячи игр) в компактный [{name, exes:[win32 path-suffix]}].
// Кэш в памяти + на диске, обновление раз в сутки. Натив-клиент фетчит и матчит запущенные процессы по
// суффиксу пути exe → точный детект без фуллскрин-эвристики (убирает и «слабо ловит», и «лишние программы»).
let _detCache = null, _detAt = 0;
const _DET_FILE = path.join(DATA_DIR, 'detectable.json');
async function getDetectableGames() {
  const now = Date.now();
  if (_detCache && now - _detAt < 24 * 3600 * 1000) return _detCache;
  try {
    const r = await fetch('https://discord.com/api/v10/applications/detectable', { signal: AbortSignal.timeout(20000) });
    const list = await r.json();
    const out = [];
    for (const g of Array.isArray(list) ? list : []) {
      const exes = (g.executables || [])
        .filter(e => e && e.os === 'win32' && !e.is_launcher && e.name)
        .map(e => String(e.name).toLowerCase().replace(/\\/g, '/'));
      if (exes.length && g.name) out.push({ name: String(g.name).slice(0, 80), exes: [...new Set(exes)] });
    }
    if (out.length) { _detCache = out; _detAt = now; try { fs.writeFileSync(_DET_FILE, JSON.stringify(out)); } catch (e) {} }
    return _detCache || out;
  } catch (e) {
    if (_detCache) return _detCache;
    try { _detCache = JSON.parse(fs.readFileSync(_DET_FILE, 'utf8')); _detAt = now; return _detCache; } catch (e2) { return []; }
  }
}
app.get('/api/detectable-games', requireAuth, async (req, res) => {
  try { res.json({ games: await getDetectableGames() }); } catch (e) { res.json({ games: [] }); }
});

/* ---------------- PROFILE ---------------- */
app.get('/api/me', requireAuth, async (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, m.role FROM servers s JOIN memberships m ON m.server_id=s.id
    WHERE m.user_id=? ORDER BY m.joined ASC`).all(req.user.id);
  const servers = await Promise.all(rows.map(async s => {
    const online = await onlineDetailed(s.id); // объекты {username,displayName,avatarColor,avatarUrl,streaming,inVoice}
    const unread = unreadCount(req.user.id, s.id); // может лениво засеять read_state (первое обращение)
    const lr = _lastReadStmt.get(req.user.id, s.id);
    return { ...pubServer(s), role: s.role, memberCount: memberCount(s.id), online, onlineCount: online.length, unread, lastRead: lr ? lr.last_read : 0 };
  }));
  res.json({ user: pubUser(req.user), servers });
});

/* live presence for one server's member list (names online right now) */
app.get('/api/servers/:id/presence', requireAuth, async (req, res) => {
  if (!isMember(req.user.id, req.params.id)) return res.status(403).json({ error: 'нет' });
  res.json(await voiceStateIn(req.params.id));
});

/* ---------- непрочитанные (badge в рейле/таскбаре) ---------- */
// Отметить прочитанным до lastId (клиент шлёт при просмотре чата в самом низу).
app.post('/api/servers/:id/read', requireAuth, (req, res) => {
  if (!isMember(req.user.id, req.params.id)) return res.status(403).json({ error: 'нет' });
  // all:true — «прочитать всё» (last_read = максимальный id сервера). Нужно, т.к. ЖИВЫЕ сообщения на
  // клиенте не имеют серверного sid (узнаются лишь через refetch) → клиент не может назвать актуальный
  // lastId, last_read отставал бы, и прочитанное считалось бы непрочитанным (на главной / др. устройстве).
  const lastId = req.body.all
    ? (db.prepare('SELECT MAX(id) m FROM messages WHERE server_id=?').get(req.params.id).m || 0)
    : req.body.lastId;
  markRead(req.user.id, req.params.id, lastId);
  const lr = _lastReadStmt.get(req.user.id, req.params.id);
  const lastRead = lr ? lr.last_read : 0;
  res.json({ ok: true, lastRead });
  // КРОСС-ДЕВАЙС: read_state в БД — источник правды. Мгновенно сообщаем ДРУГИМ устройствам этого юзера
  // (notify-WS), что сервер прочитан → они сбрасывают unread и двигают дивайдер, даже для ПОДКЛЮЧЁННОГО
  // сервера (его клиент ведёт unread локально и /unread-поллинг его пропускает — без этого badge завис бы).
  try { notifyUser(req.user.id, { t: 'read', serverId: req.params.id, lastRead }); } catch (e) { /**/ }
});
// Лёгкий поллинг непрочитанных по всем серверам юзера (без LiveKit — только БД).
app.get('/api/unread', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT server_id FROM memberships WHERE user_id=?').all(req.user.id);
  const out = {};
  for (const r of rows) out[r.server_id] = unreadCount(req.user.id, r.server_id);
  res.json(out);
});

/* ---------- Web Push: подписка PWA/браузера на фоновые уведомления ---------- */
// Публичный VAPID-ключ для PushManager.subscribe на клиенте (+ флаг, включён ли push вообще).
app.get('/api/push/vapid', (req, res) => {
  res.json({ enabled: !!VAPID, key: VAPID ? VAPID.publicKey : '' });
});
// Сохранить/обновить подписку текущего юзера (+ его пер-типовые предпочтения push).
app.post('/api/push/subscribe', requireAuth, (req, res) => {
  const sub = req.body && req.body.sub;
  if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return res.status(400).json({ error: 'плохая подписка' });
  db.prepare('INSERT INTO push_subs(endpoint,user_id,p256dh,auth,created) VALUES(?,?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth')
    .run(String(sub.endpoint).slice(0, 512), req.user.id, String(sub.keys.p256dh).slice(0, 256), String(sub.keys.auth).slice(0, 128), Date.now());
  const pr = req.body && req.body.prefs;
  if (pr && typeof pr === 'object') {
    db.prepare('INSERT INTO push_prefs(user_id,mention,stream) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET mention=excluded.mention,stream=excluded.stream')
      .run(req.user.id, pr.mention === false ? 0 : 1, pr.stream === false ? 0 : 1);
  }
  res.json({ ok: true });
});
// Отписаться (юзер выключил уведомления / вышел). Удаляем по endpoint.
app.post('/api/push/unsubscribe', requireAuth, (req, res) => {
  const ep = req.body && req.body.endpoint;
  if (ep) db.prepare('DELETE FROM push_subs WHERE endpoint=? AND user_id=?').run(String(ep), req.user.id);
  res.json({ ok: true });
});
// Вещатель начал трансляцию → пуш участникам сервера, которых сейчас НЕТ в комнате (те, кто в
// комнате, узнают через LiveKit/дерево — без дублей). Клиент дёргает это на старте шары.
app.post('/api/servers/:id/stream-start', requireAuth, async (req, res) => {
  const sid = req.params.id;
  if (!isMember(req.user.id, sid)) return res.status(403).json({ error: 'нет' });
  res.json({ ok: true });
  try {
    // ВСЕМ участникам кроме автора. Глобальный notify-WS (мгновенно онлайн, любой сервер) + web-push
    // (свёрнуто/закрыто). Дедуп с живым путём — на клиенте по connectedServerId.
    const targets = serverMembersFull(sid).filter(m => m.id !== req.user.id).map(m => m.id);
    const nm = serverName(sid);
    for (const uid of targets) notifyUser(uid, { t: 'notify', kind: 'stream', serverId: sid, serverName: nm, title: req.user.display_name, body: 'начал(а) трансляцию' });
    if (VAPID) pushToUsers('stream', targets, { kind: 'stream', title: req.user.display_name, body: 'начал(а) трансляцию', serverId: sid, tag: 'stream:' + sid, url: '/?server=' + sid }).catch(() => {});
  } catch (e) { console.error('[notify] stream-start:', e && e.message); }
});

app.patch('/api/me', requireAuth, (req, res) => {
  const dn = req.body.displayName != null ? String(req.body.displayName).trim().slice(0, 32) : null;
  const bio = req.body.bio != null ? String(req.body.bio).slice(0, 200) : null;
  const ac = req.body.avatarColor != null ? (parseInt(req.body.avatarColor, 10) % 8 + 8) % 8 : null;
  let au = null;
  if (req.body.avatarUrl != null) {
    const v = String(req.body.avatarUrl);
    if (v === '' || UPLOAD_RE.test(v)) au = v; else return res.status(400).json({ error: 'Неверный аватар' });
  }
  if (dn !== null && dn.length < 1) return res.status(400).json({ error: 'Имя не может быть пустым' });
  db.prepare('UPDATE users SET display_name=COALESCE(?,display_name), bio=COALESCE(?,bio), avatar_color=COALESCE(?,avatar_color), avatar_url=COALESCE(?,avatar_url) WHERE id=?')
    .run(dn, bio, ac, au, req.user.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ user: pubUser(u) });
});

/* ---------------- IMAGE UPLOADS (avatars + chat, <=10MB) ---------------- */
const MIME_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
app.use('/api/uploads', express.static(UPLOADS_DIR, { maxAge: '30d', immutable: true, index: false, fallthrough: false, setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff') }));
app.post('/api/upload', requireAuth, express.raw({ type: Object.keys(MIME_EXT), limit: '10mb' }), (req, res) => {
  const ct = String(req.headers['content-type'] || '').split(';')[0].trim();
  const ext = MIME_EXT[ct];
  if (!ext || !Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'Только картинки: png, jpg, gif, webp' });
  const name = crypto.randomBytes(12).toString('hex') + '.' + ext;
  try { fs.writeFileSync(path.join(UPLOADS_DIR, name), req.body); }
  catch (e) { return res.status(500).json({ error: 'Не удалось сохранить файл' }); }
  res.json({ url: '/api/uploads/' + name });
});

/* ---------------- SERVERS ---------------- */
const INVITE_TTL = 30 * 60 * 1000; // приглашение живёт 30 минут
function makeInvite(sid, uid) {
  const code = inviteCode();
  const expires = Date.now() + INVITE_TTL;
  db.prepare('INSERT INTO invites(code,server_id,requires_password,created_by,created,expires) VALUES(?,?,0,?,?,?)').run(code, sid, uid, Date.now(), expires);
  return { code, expires };
}

app.post('/api/servers', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (name.length < 2) return res.status(400).json({ error: 'Название сервера минимум 2 символа' });
  const id = newId('s');
  const now = Date.now();
  // все серверы приватны — попасть можно только по приглашению (пароли убраны)
  db.prepare('INSERT INTO servers(id,name,owner_id,icon_color,password_hash,created) VALUES(?,?,?,?,?,?)')
    .run(id, name, req.user.id, hashColor(name), null, now);
  db.prepare('INSERT INTO memberships(user_id,server_id,role,joined) VALUES(?,?,?,?)').run(req.user.id, id, 'owner', now);
  db.prepare('INSERT INTO voice_channels(id,server_id,name,position,created) VALUES(?,?,?,?,?)').run(newId('vc'), id, 'Общий', 0, now);
  const inv = makeInvite(id, req.user.id);
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(id);
  res.json({ server: { ...pubServer(s), role: 'owner', memberCount: 1 }, invite: inv.code, inviteExpires: inv.expires });
});

app.get('/api/servers/:id', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  if (!isMember(req.user.id, s.id)) return res.status(403).json({ error: 'Ты не участник этого сервера' });
  const members = db.prepare(`
    SELECT u.id,u.username,u.display_name,u.avatar_color,u.avatar_url,u.bio,m.role FROM memberships m
    JOIN users u ON u.id=m.user_id WHERE m.server_id=? ORDER BY (m.role='owner') DESC, u.display_name ASC`).all(s.id)
    .map(u => ({ id: u.id, username: u.username, displayName: u.display_name, avatarColor: u.avatar_color, avatarUrl: u.avatar_url || '', bio: u.bio || '', role: u.role, roles: rolesOfMember(s.id, u.id) }));
  ensureDefaultChannel(s.id);
  res.json({ server: { ...pubServer(s), memberCount: members.length, roles: rolesOfServer(s.id), channels: channelsOf(s.id) }, members, myRole: roleOf(req.user.id, s.id), myPerms: permsOf(req.user.id, s.id) });
});

/* owner kicks a member */
app.post('/api/servers/:id/kick', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'нет' });
  if (!can(req.user.id, s.id, PERM.MANAGE_MEMBERS)) return res.status(403).json({ error: 'Нет прав' });
  const uid = String(req.body.userId || '');
  if (!uid || uid === s.owner_id) return res.status(400).json({ error: 'Нельзя' });
  db.prepare('DELETE FROM memberships WHERE user_id=? AND server_id=?').run(uid, s.id);
  db.prepare('DELETE FROM member_roles WHERE user_id=? AND server_id=?').run(uid, s.id);
  db.prepare('DELETE FROM server_settings WHERE user_id=? AND server_id=?').run(uid, s.id);
  const ku = db.prepare('SELECT username FROM users WHERE id=?').get(uid);
  // выгоняем ВСЕ live-сессии юзера из комнаты (identity = username#nonce)
  if (ku) { try { rsc.listParticipants('srv:' + s.id).then(ps => ps.filter(p => baseIdentity(p.identity) === ku.username).forEach(p => rsc.removeParticipant('srv:' + s.id, p.identity).catch(() => {}))).catch(() => {}); } catch (e) {} }
  res.json({ ok: true });
});

app.post('/api/servers/:id/leave', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'нет' });
  if (s.owner_id === req.user.id) return res.status(400).json({ error: 'Владелец не может выйти — удали сервер' });
  db.prepare('DELETE FROM memberships WHERE user_id=? AND server_id=?').run(req.user.id, s.id);
  res.json({ ok: true });
});

app.delete('/api/servers/:id', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'нет' });
  if (s.owner_id !== req.user.id) return res.status(403).json({ error: 'Только владелец' });
  db.prepare('DELETE FROM memberships WHERE server_id=?').run(s.id);
  db.prepare('DELETE FROM invites WHERE server_id=?').run(s.id);
  db.prepare('DELETE FROM server_settings WHERE server_id=?').run(s.id);
  db.prepare('DELETE FROM roles WHERE server_id=?').run(s.id);
  db.prepare('DELETE FROM member_roles WHERE server_id=?').run(s.id);
  db.prepare('DELETE FROM messages WHERE server_id=?').run(s.id);
  db.prepare('DELETE FROM servers WHERE id=?').run(s.id);
  res.json({ ok: true });
});

/* owner/manage-server: правка названия/описания/обложки */
app.patch('/api/servers/:id', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'нет' });
  if (!can(req.user.id, s.id, PERM.MANAGE_SERVER)) return res.status(403).json({ error: 'Нет прав' });
  const name = req.body.name != null ? String(req.body.name).trim().slice(0, 40) : null;
  const desc = req.body.description != null ? String(req.body.description).slice(0, 300) : null;
  const ic = req.body.iconColor != null ? (parseInt(req.body.iconColor, 10) % 8 + 8) % 8 : null;
  let iu = null;
  if (req.body.iconUrl != null) { const v = String(req.body.iconUrl); if (v === '' || UPLOAD_RE.test(v)) iu = v; else return res.status(400).json({ error: 'Неверная обложка' }); }
  if (name !== null && name.length < 2) return res.status(400).json({ error: 'Название минимум 2 символа' });
  db.prepare('UPDATE servers SET name=COALESCE(?,name), description=COALESCE(?,description), icon_color=COALESCE(?,icon_color), icon_url=COALESCE(?,icon_url) WHERE id=?')
    .run(name, desc, ic, iu, s.id);
  const ns = db.prepare('SELECT * FROM servers WHERE id=?').get(s.id);
  res.json({ server: { ...pubServer(ns), memberCount: memberCount(s.id) } });
});

/* ---------------- INVITES (только приглашение, 30 мин) ---------------- */
app.post('/api/servers/:id/invites', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'нет' });
  if (!isMember(req.user.id, s.id)) return res.status(403).json({ error: 'нет' });
  // любой участник может пригласить; каждый раз новая ссылка, старые истекают сами через 30 мин
  const inv = makeInvite(s.id, req.user.id);
  res.json({ code: inv.code, expires: inv.expires });
});

app.get('/api/invites/:code', (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE code=?').get(req.params.code);
  if (!inv || (inv.expires && inv.expires < Date.now())) return res.status(404).json({ error: 'Приглашение не найдено или устарело' });
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(inv.server_id);
  if (!s) return res.status(404).json({ error: 'Сервер удалён' });
  res.json({ server: { ...pubServer(s), memberCount: memberCount(s.id) }, requiresPassword: false });
});

app.post('/api/invites/:code/join', requireAuth, (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE code=?').get(req.params.code);
  if (!inv || (inv.expires && inv.expires < Date.now())) return res.status(404).json({ error: 'Приглашение устарело — попроси новое' });
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(inv.server_id);
  if (!s) return res.status(404).json({ error: 'Сервер удалён' });
  if (!isMember(req.user.id, s.id)) {
    db.prepare('INSERT OR IGNORE INTO memberships(user_id,server_id,role,joined) VALUES(?,?,?,?)').run(req.user.id, s.id, 'member', Date.now());
    db.prepare('UPDATE invites SET uses=uses+1 WHERE code=?').run(inv.code);
  }
  res.json({ server: { ...pubServer(s), role: roleOf(req.user.id, s.id), memberCount: memberCount(s.id) } });
});

/* ---------------- ROLES (кастомные роли + назначение) ---------------- */
function validColor(c) { return typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : ''; }
app.get('/api/servers/:id/roles', requireAuth, (req, res) => {
  if (!isMember(req.user.id, req.params.id)) return res.status(403).json({ error: 'нет' });
  res.json({ roles: rolesOfServer(req.params.id) });
});
app.post('/api/servers/:id/roles', requireAuth, (req, res) => {
  const sid = req.params.id;
  if (!can(req.user.id, sid, PERM.MANAGE_ROLES)) return res.status(403).json({ error: 'Нет прав' });
  const name = String(req.body.name || '').trim().slice(0, 24);
  if (name.length < 1) return res.status(400).json({ error: 'Название роли не может быть пустым' });
  const color = validColor(req.body.color);
  const perms = (parseInt(req.body.permissions, 10) || 0) & ALL_PERMS;
  const maxPos = db.prepare('SELECT COALESCE(MAX(position),0) p FROM roles WHERE server_id=?').get(sid).p;
  const id = newId('r');
  db.prepare('INSERT INTO roles(id,server_id,name,color,permissions,position,created) VALUES(?,?,?,?,?,?,?)').run(id, sid, name, color, perms, maxPos + 1, Date.now());
  res.json({ role: pubRole(db.prepare('SELECT * FROM roles WHERE id=?').get(id)) });
});
app.patch('/api/servers/:id/roles/:rid', requireAuth, (req, res) => {
  const sid = req.params.id;
  if (!can(req.user.id, sid, PERM.MANAGE_ROLES)) return res.status(403).json({ error: 'Нет прав' });
  const r = db.prepare('SELECT * FROM roles WHERE id=? AND server_id=?').get(req.params.rid, sid);
  if (!r) return res.status(404).json({ error: 'Роль не найдена' });
  const name = req.body.name != null ? String(req.body.name).trim().slice(0, 24) : null;
  if (name !== null && name.length < 1) return res.status(400).json({ error: 'Название роли не может быть пустым' });
  const color = req.body.color != null ? validColor(req.body.color) : null;
  const perms = req.body.permissions != null ? ((parseInt(req.body.permissions, 10) || 0) & ALL_PERMS) : null;
  const pos = req.body.position != null ? (parseInt(req.body.position, 10) || 0) : null;
  db.prepare('UPDATE roles SET name=COALESCE(?,name), color=COALESCE(?,color), permissions=COALESCE(?,permissions), position=COALESCE(?,position) WHERE id=?')
    .run(name, color, perms, pos, r.id);
  res.json({ role: pubRole(db.prepare('SELECT * FROM roles WHERE id=?').get(r.id)) });
});
app.delete('/api/servers/:id/roles/:rid', requireAuth, (req, res) => {
  const sid = req.params.id;
  if (!can(req.user.id, sid, PERM.MANAGE_ROLES)) return res.status(403).json({ error: 'Нет прав' });
  db.prepare('DELETE FROM roles WHERE id=? AND server_id=?').run(req.params.rid, sid);
  db.prepare('DELETE FROM member_roles WHERE role_id=? AND server_id=?').run(req.params.rid, sid);
  res.json({ ok: true });
});
app.put('/api/servers/:id/members/:uid/roles', requireAuth, (req, res) => {
  const sid = req.params.id;
  if (!can(req.user.id, sid, PERM.MANAGE_ROLES)) return res.status(403).json({ error: 'Нет прав' });
  const uid = req.params.uid;
  if (!isMember(uid, sid)) return res.status(404).json({ error: 'Не участник' });
  const ids = Array.isArray(req.body.roleIds) ? req.body.roleIds.map(String) : [];
  const valid = new Set(db.prepare('SELECT id FROM roles WHERE server_id=?').all(sid).map(r => r.id));
  db.prepare('DELETE FROM member_roles WHERE server_id=? AND user_id=?').run(sid, uid);
  const ins = db.prepare('INSERT OR IGNORE INTO member_roles(server_id,user_id,role_id) VALUES(?,?,?)');
  for (const rid of ids) if (valid.has(rid)) ins.run(sid, uid, rid);
  res.json({ roles: rolesOfMember(sid, uid) });
});

/* ---------------- ГОЛОСОВЫЕ КАНАЛЫ (создание/переименование/удаление) ---------------- */
app.get('/api/servers/:id/channels', requireAuth, (req, res) => {
  if (!isMember(req.user.id, req.params.id)) return res.status(403).json({ error: 'нет' });
  ensureDefaultChannel(req.params.id);
  res.json({ channels: channelsOf(req.params.id) });
});
app.post('/api/servers/:id/channels', requireAuth, (req, res) => {
  const sid = req.params.id;
  if (!can(req.user.id, sid, PERM.MANAGE_CHANNELS)) return res.status(403).json({ error: 'Нет прав' });
  ensureDefaultChannel(sid);
  const count = db.prepare('SELECT COUNT(*) c FROM voice_channels WHERE server_id=?').get(sid).c;
  if (count >= MAX_CHANNELS) return res.status(400).json({ error: `Максимум ${MAX_CHANNELS} голосовых каналов` });
  const name = String(req.body.name || '').trim().slice(0, 24);
  if (name.length < 1) return res.status(400).json({ error: 'Название канала не может быть пустым' });
  const maxPos = db.prepare('SELECT COALESCE(MAX(position),-1) p FROM voice_channels WHERE server_id=?').get(sid).p;
  const id = newId('vc');
  db.prepare('INSERT INTO voice_channels(id,server_id,name,position,created) VALUES(?,?,?,?,?)').run(id, sid, name, maxPos + 1, Date.now());
  res.json({ channel: pubChannel(db.prepare('SELECT * FROM voice_channels WHERE id=?').get(id)), channels: channelsOf(sid) });
});
app.patch('/api/servers/:id/channels/:cid', requireAuth, (req, res) => {
  const sid = req.params.id;
  if (!can(req.user.id, sid, PERM.MANAGE_CHANNELS)) return res.status(403).json({ error: 'Нет прав' });
  const c = db.prepare('SELECT * FROM voice_channels WHERE id=? AND server_id=?').get(req.params.cid, sid);
  if (!c) return res.status(404).json({ error: 'Канал не найден' });
  const name = String(req.body.name || '').trim().slice(0, 24);
  if (name.length < 1) return res.status(400).json({ error: 'Название не может быть пустым' });
  db.prepare('UPDATE voice_channels SET name=? WHERE id=?').run(name, c.id);
  res.json({ channels: channelsOf(sid) });
});
app.delete('/api/servers/:id/channels/:cid', requireAuth, (req, res) => {
  const sid = req.params.id;
  if (!can(req.user.id, sid, PERM.MANAGE_CHANNELS)) return res.status(403).json({ error: 'Нет прав' });
  const count = db.prepare('SELECT COUNT(*) c FROM voice_channels WHERE server_id=?').get(sid).c;
  if (count <= 1) return res.status(400).json({ error: 'Нельзя удалить последний голосовой канал' });
  db.prepare('DELETE FROM voice_channels WHERE id=? AND server_id=?').run(req.params.cid, sid);
  res.json({ channels: channelsOf(sid) });
});

/* ---------------- ADMIN: очистка чата ---------------- */
app.post('/api/servers/:id/clear', requireAuth, (req, res) => {
  const sid = req.params.id;
  if (!can(req.user.id, sid, PERM.MANAGE_MESSAGES)) return res.status(403).json({ error: 'Нет прав' });
  db.prepare('DELETE FROM messages WHERE server_id=?').run(sid);
  res.json({ ok: true });
});

/* ---------------- LIVEKIT TOKEN (per server) ---------------- */
app.get('/api/servers/:id/token', requireAuth, async (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'нет' });
  if (!isMember(req.user.id, s.id)) return res.status(403).json({ error: 'Ты не участник' });
  try {
    const at = new AccessToken(KEY, SECRET, { identity: req.user.username + '#' + crypto.randomBytes(4).toString('hex'), name: req.user.display_name, ttl: '12h' });
    at.addGrant({ roomJoin: true, room: 'srv:' + s.id, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true });
    res.json({ token: await at.toJwt(), url: WS_URL, room: 'srv:' + s.id });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

/* ---------------- ACCOUNT-WIDE SETTINGS (хоткеи и т.п. — следуют за юзером, не за устройством) ---------------- */
app.get('/api/me/settings', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM user_settings WHERE user_id=?').get(req.user.id);
  res.json({ data: row ? JSON.parse(row.data) : {} });
});
app.put('/api/me/settings', requireAuth, (req, res) => {
  const data = JSON.stringify(req.body.data || {}).slice(0, 20000);
  db.prepare(`INSERT INTO user_settings(user_id,data) VALUES(?,?)
    ON CONFLICT(user_id) DO UPDATE SET data=excluded.data`).run(req.user.id, data);
  res.json({ ok: true });
});

/* ---------------- PER-SERVER SETTINGS (volumes etc) ---------------- */
app.get('/api/servers/:id/settings', requireAuth, (req, res) => {
  const row = db.prepare('SELECT data FROM server_settings WHERE user_id=? AND server_id=?').get(req.user.id, req.params.id);
  res.json({ data: row ? JSON.parse(row.data) : {} });
});
app.put('/api/servers/:id/settings', requireAuth, (req, res) => {
  if (!isMember(req.user.id, req.params.id)) return res.status(403).json({ error: 'нет' });
  const data = JSON.stringify(req.body.data || {}).slice(0, 20000);
  db.prepare(`INSERT INTO server_settings(user_id,server_id,data) VALUES(?,?,?)
    ON CONFLICT(user_id,server_id) DO UPDATE SET data=excluded.data`).run(req.user.id, req.params.id, data);
  res.json({ ok: true });
});

/* ---------- CHAT HISTORY (persist 7 days) ---------- */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
app.get('/api/servers/:id/messages', requireAuth, (req, res) => {
  const sid = req.params.id;
  if (!isMember(req.user.id, sid)) return res.status(403).json({ error: 'нет' });
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 30));
  const before = parseInt(req.query.before, 10) || 0; // курсор: id, СТАРШЕ которого грузим (0 = последняя страница)
  const minTs = Date.now() - WEEK_MS;
  // берём limit+1, чтобы понять, есть ли ещё более старые сообщения (hasMore)
  const rows = before > 0
    ? db.prepare('SELECT id,user_id,display_name,avatar_color,text,emotes,image,reply_to,created FROM messages WHERE server_id=? AND created>? AND id<? ORDER BY id DESC LIMIT ?').all(sid, minTs, before, limit + 1)
    : db.prepare('SELECT id,user_id,display_name,avatar_color,text,emotes,image,reply_to,created FROM messages WHERE server_id=? AND created>? ORDER BY id DESC LIMIT ?').all(sid, minTs, limit + 1);
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit).reverse(); // ASC: старые → новые (как рисуем в чате)
  res.json({
    hasMore,
    messages: page.map(r => ({ id: r.id, uid: r.user_id, name: r.display_name, color: r.avatar_color, text: r.text, em: JSON.parse(r.emotes || '{}'), img: r.image || '', reply: r.reply_to ? JSON.parse(r.reply_to) : undefined, ts: r.created })),
  });
});
app.post('/api/servers/:id/messages', requireAuth, (req, res) => {
  const sid = req.params.id;
  if (!isMember(req.user.id, sid)) return res.status(403).json({ error: 'нет' });
  const text = String(req.body.text || '').slice(0, 1000);
  const image = (() => { const v = String(req.body.image || ''); return UPLOAD_RE.test(v) ? v : ''; })();
  if (!text.trim() && !image) return res.status(400).json({ error: 'пусто' });
  const em = JSON.stringify(req.body.em || {}).slice(0, 4000);
  // reply-ссылка на исходное сообщение (санитайзим, ограничиваем размер)
  const replyTo = (() => {
    const rp = req.body.reply;
    if (!rp || typeof rp !== 'object') return '';
    const author = String(rp.author || '').slice(0, 80);
    if (!author) return '';
    const clean = { author, text: String(rp.text || '').slice(0, 160), img: !!rp.img };
    if (rp.uid) clean.uid = String(rp.uid).slice(0, 64);
    if (Number.isFinite(rp.sid)) clean.sid = rp.sid;
    return JSON.stringify(clean).slice(0, 500);
  })();
  const now = Date.now();
  const clientKey = String(req.body.key || '').slice(0, 64);
  // OR IGNORE: повторный POST с тем же (server_id,user_id,client_key) схлопывается (retry после
  // потери ответа). info.changes===0 → это дубль: не чистим/не пушим повторно, но отвечаем ok
  // (сообщение уже в БД — для клиента это успех).
  const info = db.prepare('INSERT OR IGNORE INTO messages(server_id,user_id,display_name,avatar_color,text,emotes,image,reply_to,created,client_key) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(sid, req.user.id, req.user.display_name, req.user.avatar_color, text, em, image, replyTo, now, clientKey);
  res.json({ ok: true });
  if (info.changes === 0) return; // дубль — дальше (cleanup/push) не нужно
  db.prepare('DELETE FROM messages WHERE server_id=? AND created<?').run(sid, now - WEEK_MS);
  // Уведомление упомянутым/адресату ответа. ДВА канала: (1) глобальный notify-WS — мгновенно тем,
  // кто онлайн в приложении (натив + веб), для ЛЮБОГО сервера, даже НЕ подключённого («куда зайти»);
  // (2) web-push — свёрнуто/закрыто. Дедуп с живым LiveKit-путём на клиенте (по connectedServerId).
  // Fire-and-forget: ответ клиенту уже отдан.
  (() => {
    try {
      const members = serverMembersFull(sid);
      const ids = mentionedIds(text, members);
      let rpUid = ''; try { const rp = replyTo ? JSON.parse(replyTo) : null; if (rp && rp.uid) rpUid = rp.uid; } catch (e) {}
      if (rpUid) ids.add(rpUid);
      ids.delete(req.user.id); // не себе
      if (!ids.size) return;
      const targets = [...ids];
      const body = text.slice(0, 140) || '🖼 изображение';
      const nm = serverName(sid);
      for (const uid of targets) notifyUser(uid, { t: 'notify', kind: 'mention', serverId: sid, serverName: nm, title: req.user.display_name, body, msgId: info.lastInsertRowid });
      if (VAPID) pushToUsers('mention', targets, { kind: 'mention', title: req.user.display_name, body, serverId: sid, tag: 'mention:' + sid, url: '/?server=' + sid }).catch(() => {});
    } catch (e) { console.error('[notify] mention:', e && e.message); }
  })();
});

app.get('/healthz', (req, res) => res.send('ok'));

// Диагностика прод-обрывов: упавший промис/исключение раньше могли молча ронять процесс
// (docker перезапускал, причина терялась, если логи контейнера пересоздавались) — фиксируем
// стек явно. uncaughtException НЕ глушим (процесс должен упасть и перезапуститься чистым).
process.on('unhandledRejection', (e) => console.error('[fatal] unhandledRejection:', e));
process.on('uncaughtException', (e) => { console.error('[fatal] uncaughtException:', e); process.exit(1); });

/* ---------- РЕЛИЗЫ НАТИВА: updater-манифест + установщик (публично, без auth) ----------
 * CI (build-windows.yml) заливает *-setup.exe + latest.json в RELEASES_DIR.
 * latest.json — updater-эндпоинт для Tauri (plugins.updater.endpoints); сам exe качают
 * и updater'ом, и с лендинга в вебе. /api/app/latest — то же, но для UI (может дать 404). */
app.get('/api/app/latest', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try { res.json(JSON.parse(fs.readFileSync(path.join(RELEASES_DIR, 'latest.json'), 'utf8'))); }
  catch (e) { res.status(404).json({ error: 'билд ещё не собран' }); }
});
app.use('/api/app', express.static(RELEASES_DIR, {
  index: false,
  setHeaders: (r, filePath) => {
    r.setHeader('X-Content-Type-Options', 'nosniff');
    // Манифест никогда не кэшировать (WebView/прокси): иначе updater видит стейл-версию.
    if (filePath.endsWith('latest.json')) r.setHeader('Cache-Control', 'no-store');
  },
}));

/* ---------- Э2 dev-only harness: browser test-publisher for the relay tree ----------
 * NOT part of prod (Dockerfile only COPYs index.js+tree.js, this file isn't in the image;
 * gated on NODE_ENV as a second guard in case someone runs this file directly against prod data). */
if (process.env.NODE_ENV !== 'production') {
  app.get('/dev/tree-test-publisher.html', (req, res) => res.sendFile(path.join(__dirname, 'dev', 'tree-test-publisher.html')));
  // Э5: симметричный харнесс — браузер-зритель для проверки приёма от нативного вещателя.
  app.get('/dev/tree-test-viewer.html', (req, res) => res.sendFile(path.join(__dirname, 'dev', 'tree-test-viewer.html')));
}

/* JSON errors for body-parser / static failures */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === 'entity.too.large' || err.status === 413)) return res.status(413).json({ error: 'Файл больше 10 МБ' });
  if (err && err.status === 404) return res.status(404).json({ error: 'Не найдено' });
  if (err) return res.status(400).json({ error: 'Ошибка запроса' });
  next();
});

/* ---------- relay-дерево: WS-сигналинг на том же порту (Э1) ---------- */
const server = http.createServer(app);
const treeSrv = attachTreeServer(server, {
  sessionSecret: SESSION_SECRET,
  path: '/tree',
  turnSecret: TURN_SECRET,
  turnUrls: TURN_URLS,
  turnTtlSec: TURN_TTL_SEC,
});

/* ---------- Глобальный notify-WS (/ws): уведомления по любому серверу, вкл. не подключённый ---------- */
const notifyWss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  let url; try { url = new URL(req.url, 'http://internal'); } catch { return; }
  if (url.pathname !== '/ws') return; // не наш путь — оставляем tree-хендлеру
  let p; try { p = jwt.verify(url.searchParams.get('token') || '', SESSION_SECRET); }
  catch (e) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  const uid = p.id || (p.u && (db.prepare('SELECT id FROM users WHERE username=?').get(p.u) || {}).id);
  if (!uid) { socket.destroy(); return; }
  notifyWss.handleUpgrade(req, socket, head, (ws) => {
    let set = notifyConns.get(uid); if (!set) { set = new Set(); notifyConns.set(uid, set); }
    set.add(ws);
    ws.on('close', () => { const s = notifyConns.get(uid); if (s) { s.delete(ws); if (!s.size) notifyConns.delete(uid); } });
    ws.on('error', () => { try { ws.close(); } catch (e) {} });
    ws.on('message', () => { /* клиент только слушает (ping игнорим) */ });
  });
});
// heartbeat: закрываем мёртвые notify-сокеты, иначе висят в notifyConns
setInterval(() => { for (const set of notifyConns.values()) for (const ws of set) { if (ws.readyState === 1) { try { ws.ping(); } catch (e) {} } } }, 30000).unref?.();

server.listen(3000, () => console.log('voice API (servers+sqlite) + tree ws + notify ws on :3000'));
