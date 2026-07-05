const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');
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
// вынесено в env (CLAUDE.md инвариант); дефолт — текущий прод-хост, для обратной совместимости
const WS_URL = process.env.LK_WS_URL || 'wss://138-16-170-21.sslip.io';
// coturn (Evolution-TZ Э3): TURN_SECRET пусто => TURN отключён, дереву достаётся только STUN
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_URLS = (process.env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
const TURN_TTL_SEC = parseInt(process.env.TURN_TTL_SEC || '600', 10);
const DATA_DIR = '/app/data';
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (e) {}

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
CREATE INDEX IF NOT EXISTS idx_msg_server ON messages(server_id, created);
CREATE INDEX IF NOT EXISTS idx_mem_server ON memberships(server_id);
CREATE INDEX IF NOT EXISTS idx_mem_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_inv_server ON invites(server_id);
`);

/* add new columns to pre-existing DBs (idempotent — throws if column exists) */
for (const sql of [
  "ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE messages ADD COLUMN image TEXT NOT NULL DEFAULT ''",
]) { try { db.exec(sql); } catch (e) { /* column already exists */ } }

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
async function onlineIn(serverId) {
  try { const ps = await rsc.listParticipants('srv:' + serverId); return ps.map(p => p.identity); }
  catch (e) { return []; }
}
const pubUser = u => ({ id: u.id, username: u.username, displayName: u.display_name, avatarColor: u.avatar_color, avatarUrl: u.avatar_url || '', bio: u.bio });
const UPLOAD_RE = /^\/api\/uploads\/[a-zA-Z0-9._-]+$/; // локальный путь к загрузке
const pubServer = s => ({ id: s.id, name: s.name, ownerId: s.owner_id, iconColor: s.icon_color, hasPassword: !!s.password_hash });
function isMember(uid, sid) { return !!db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND server_id=?').get(uid, sid); }
function memberCount(sid) { return db.prepare('SELECT COUNT(*) c FROM memberships WHERE server_id=?').get(sid).c; }
function roleOf(uid, sid) { const r = db.prepare('SELECT role FROM memberships WHERE user_id=? AND server_id=?').get(uid, sid); return r ? r.role : null; }

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

/* ---------------- PROFILE ---------------- */
app.get('/api/me', requireAuth, async (req, res) => {
  const rows = db.prepare(`
    SELECT s.*, m.role FROM servers s JOIN memberships m ON m.server_id=s.id
    WHERE m.user_id=? ORDER BY m.joined ASC`).all(req.user.id);
  const servers = await Promise.all(rows.map(async s => {
    const online = await onlineIn(s.id);
    return { ...pubServer(s), role: s.role, memberCount: memberCount(s.id), online, onlineCount: online.length };
  }));
  res.json({ user: pubUser(req.user), servers });
});

/* live presence for one server's member list (names online right now) */
app.get('/api/servers/:id/presence', requireAuth, async (req, res) => {
  if (!isMember(req.user.id, req.params.id)) return res.status(403).json({ error: 'нет' });
  res.json({ online: await onlineIn(req.params.id) });
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
app.use('/api/uploads', express.static(UPLOADS_DIR, { maxAge: '30d', immutable: true, index: false, fallthrough: false }));
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
app.post('/api/servers', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  const pass = String(req.body.password || '');
  if (name.length < 2) return res.status(400).json({ error: 'Название сервера минимум 2 символа' });
  const id = newId('s');
  const now = Date.now();
  db.prepare('INSERT INTO servers(id,name,owner_id,icon_color,password_hash,created) VALUES(?,?,?,?,?,?)')
    .run(id, name, req.user.id, hashColor(name), pass ? bcrypt.hashSync(pass, 10) : null, now);
  db.prepare('INSERT INTO memberships(user_id,server_id,role,joined) VALUES(?,?,?,?)').run(req.user.id, id, 'owner', now);
  const code = inviteCode();
  db.prepare('INSERT INTO invites(code,server_id,requires_password,created_by,created) VALUES(?,?,?,?,?)').run(code, id, 0, req.user.id, now);
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(id);
  res.json({ server: { ...pubServer(s), role: 'owner', memberCount: 1 }, invite: code });
});

app.get('/api/servers/:id', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Сервер не найден' });
  if (!isMember(req.user.id, s.id)) return res.status(403).json({ error: 'Ты не участник этого сервера' });
  const members = db.prepare(`
    SELECT u.id,u.username,u.display_name,u.avatar_color,u.avatar_url,u.bio,m.role FROM memberships m
    JOIN users u ON u.id=m.user_id WHERE m.server_id=? ORDER BY (m.role='owner') DESC, u.display_name ASC`).all(s.id)
    .map(u => ({ id: u.id, username: u.username, displayName: u.display_name, avatarColor: u.avatar_color, avatarUrl: u.avatar_url || '', bio: u.bio || '', role: u.role }));
  res.json({ server: { ...pubServer(s), memberCount: members.length }, members, myRole: roleOf(req.user.id, s.id) });
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
  db.prepare('DELETE FROM servers WHERE id=?').run(s.id);
  res.json({ ok: true });
});

/* server password (owner sets/changes) */
app.put('/api/servers/:id/password', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'нет' });
  if (s.owner_id !== req.user.id) return res.status(403).json({ error: 'Только владелец' });
  const pass = String(req.body.password || '');
  db.prepare('UPDATE servers SET password_hash=? WHERE id=?').run(pass ? bcrypt.hashSync(pass, 10) : null, s.id);
  res.json({ ok: true, hasPassword: !!pass });
});

/* ---------------- INVITES ---------------- */
app.post('/api/servers/:id/invites', requireAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'нет' });
  if (!isMember(req.user.id, s.id)) return res.status(403).json({ error: 'нет' });
  const reqPass = req.body.requiresPassword ? 1 : 0;
  if (reqPass && !s.password_hash) return res.status(400).json({ error: 'Сначала задай пароль сервера' });
  // переиспользуем существующий инвайт того же типа
  let inv = db.prepare('SELECT * FROM invites WHERE server_id=? AND requires_password=?').get(s.id, reqPass);
  if (!inv) {
    const code = inviteCode();
    db.prepare('INSERT INTO invites(code,server_id,requires_password,created_by,created) VALUES(?,?,?,?,?)').run(code, s.id, reqPass, req.user.id, Date.now());
    inv = { code, requires_password: reqPass };
  }
  res.json({ code: inv.code, requiresPassword: !!reqPass });
});

app.get('/api/invites/:code', (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE code=?').get(req.params.code);
  if (!inv) return res.status(404).json({ error: 'Приглашение не найдено или устарело' });
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(inv.server_id);
  if (!s) return res.status(404).json({ error: 'Сервер удалён' });
  res.json({ server: { ...pubServer(s), memberCount: memberCount(s.id) }, requiresPassword: !!inv.requires_password });
});

app.post('/api/invites/:code/join', requireAuth, (req, res) => {
  const inv = db.prepare('SELECT * FROM invites WHERE code=?').get(req.params.code);
  if (!inv) return res.status(404).json({ error: 'Приглашение не найдено' });
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(inv.server_id);
  if (!s) return res.status(404).json({ error: 'Сервер удалён' });
  if (!isMember(req.user.id, s.id)) {
    if (inv.requires_password) {
      const pass = String(req.body.password || '');
      if (!s.password_hash || !bcrypt.compareSync(pass, s.password_hash)) return res.status(403).json({ error: 'Неверный пароль сервера' });
    }
    db.prepare('INSERT OR IGNORE INTO memberships(user_id,server_id,role,joined) VALUES(?,?,?,?)').run(req.user.id, s.id, 'member', Date.now());
    db.prepare('UPDATE invites SET uses=uses+1 WHERE code=?').run(inv.code);
  }
  res.json({ server: { ...pubServer(s), role: roleOf(req.user.id, s.id), memberCount: memberCount(s.id) } });
});

/* ---------------- LIVEKIT TOKEN (per server) ---------------- */
app.get('/api/servers/:id/token', requireAuth, async (req, res) => {
  const s = db.prepare('SELECT * FROM servers WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'нет' });
  if (!isMember(req.user.id, s.id)) return res.status(403).json({ error: 'Ты не участник' });
  try {
    const at = new AccessToken(KEY, SECRET, { identity: req.user.username, name: req.user.display_name, ttl: '12h' });
    at.addGrant({ roomJoin: true, room: 'srv:' + s.id, canPublish: true, canSubscribe: true, canPublishData: true });
    res.json({ token: await at.toJwt(), url: WS_URL, room: 'srv:' + s.id });
  } catch (e) { res.status(500).json({ error: String(e) }); }
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
  const rows = db.prepare('SELECT user_id,display_name,avatar_color,text,emotes,image,created FROM messages WHERE server_id=? AND created>? ORDER BY created DESC LIMIT 100')
    .all(sid, Date.now() - WEEK_MS).reverse();
  res.json({ messages: rows.map(r => ({ uid: r.user_id, name: r.display_name, color: r.avatar_color, text: r.text, em: JSON.parse(r.emotes || '{}'), img: r.image || '', ts: r.created })) });
});
app.post('/api/servers/:id/messages', requireAuth, (req, res) => {
  const sid = req.params.id;
  if (!isMember(req.user.id, sid)) return res.status(403).json({ error: 'нет' });
  const text = String(req.body.text || '').slice(0, 1000);
  const image = (() => { const v = String(req.body.image || ''); return UPLOAD_RE.test(v) ? v : ''; })();
  if (!text.trim() && !image) return res.status(400).json({ error: 'пусто' });
  const em = JSON.stringify(req.body.em || {}).slice(0, 4000);
  const now = Date.now();
  db.prepare('INSERT INTO messages(server_id,user_id,display_name,avatar_color,text,emotes,image,created) VALUES(?,?,?,?,?,?,?,?)')
    .run(sid, req.user.id, req.user.display_name, req.user.avatar_color, text, em, image, now);
  db.prepare('DELETE FROM messages WHERE server_id=? AND created<?').run(sid, now - WEEK_MS);
  res.json({ ok: true });
});

/* ---------- legacy compat: old room token (kept so старый клиент не падает во время перехода) ---------- */
app.get('/api/token', requireAuth, async (req, res) => {
  try {
    const room = String(req.query.room || 'main').slice(0, 64) || 'main';
    const at = new AccessToken(KEY, SECRET, { identity: req.user.username, name: req.user.display_name, ttl: '12h' });
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
    res.json({ token: await at.toJwt(), url: WS_URL, room, username: req.user.username });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/healthz', (req, res) => res.send('ok'));

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
attachTreeServer(server, {
  sessionSecret: SESSION_SECRET,
  path: '/tree',
  turnSecret: TURN_SECRET,
  turnUrls: TURN_URLS,
  turnTtlSec: TURN_TTL_SEC,
});
server.listen(3000, () => console.log('voice API (servers+sqlite) + tree ws on :3000'));
