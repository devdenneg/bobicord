// Регрессия прода 2026-10-23: перезапуск vrelay посреди эфира.
//   A. Вернувшийся агент обязан встать в живой server-first эфир, даже если сирот нет
//      (зрители уже пересели под вещателя) и даже если метка прошлой активации свежая.
//   B. Отвал агента чистит реестр рендишнов и шлёт rendition-unavailable их зрителям.
//   C. Уход рендишн-корня (ffmpeg упал) чистит запись реестра: следующий заход в рендишн
//      поднимает транскод заново, а не вешает зрителя сиротой без корня.
// Без WS: пиры с фейковым ws складывают исходящие сообщения в outbox. Запуск: node apps/server/vrelay-reconnect-test.js

const http = require('http');
const { attachTreeServer, treeKey } = require('./tree');

let failed = 0;
const realLog = console.log;
console.log = () => {}; // tlog дерева не нужен в выводе теста
function ok(name, cond) { realLog(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) failed++; }

const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
const api = attachTreeServer(server, { sessionSecret: 'test' });
for (const k of ['abrTimer', 'hbTimer', 'drainTimer', 'renditionTimer']) { try { clearInterval(api[k]); } catch { /**/ } }
const { mgr, peers } = api;
const { onVrelayHello, onLeave, ensureRendition } = api._test;

const outbox = new Map(); // peerId -> [msg]
function fakeWs(id, uid) {
  return { __uid: uid, readyState: 1, OPEN: 1, send: (raw) => { if (!outbox.has(id)) outbox.set(id, []); outbox.get(id).push(JSON.parse(raw)); } };
}
const sent = (id, t) => (outbox.get(id) || []).filter((m) => m.t === t);

function peer(id, over) {
  const p = Object.assign({
    id, identity: id, role: 'viewer', native: true, virtual: false, children: [], parent: null, depth: 0,
    availableOutgoing: 0, maxChildren: 4, streamId: 'S', rendition: 'source', treeKey: null, serverId: 'srv',
    reparentCooldownUntil: 0, vrelayPinned: false, qualityPinned: false, symmetricNat: false, maxBitrate: 5_000_000,
    linkLoss: 0, linkRtt: 0, statsAt: 0, framesDroppedPct: 0, framesDropAt: 0, dropBadTicks: 0,
  }, over);
  p.ws = fakeWs(id, p.uid || id);
  peers.set(id, p);
  return p;
}
function place(t, n, parentId) {
  t.nodes.set(n.id, n);
  n.treeKey = t.key || n.treeKey;
  if (parentId) { const par = t.nodes.get(parentId); par.children.push(n.id); n.parent = parentId; n.depth = par.depth + 1; }
}
function reset() { mgr.trees.clear(); peers.clear(); outbox.clear(); }

// ---------- A: агент вернулся — встаёт в живой server-first эфир ----------
{
  reset();
  const SRC = treeKey('S', 'source');
  const t = mgr.tree(SRC); t.key = SRC; t.serverFirst = true;
  const b = peer('B', { role: 'broadcaster', treeKey: SRC, serverIngest: true, maxChildren: 9 });
  place(t, b, null); t.broadcasterId = 'B';
  place(t, peer('V', { treeKey: SRC }), 'B'); // зритель уже пересел под вещателя — сирот нет
  t.vrelayActivateAt = Date.now(); // метка активации от ПРЕЖНЕГО агента
  peer('A', { uid: 'virtual-relay', treeKey: null, streamId: null });
  onVrelayHello('A', { capacity: 24, maxTranscodes: 1 });
  const ingest = sent('A', 'vrelay-ingest');
  ok('A: вернувшийся агент получает vrelay-ingest для живого server-first эфира', ingest.length === 1 && ingest[0].streamId === 'S');
}

// ---------- A2: legacy-дерево без сирот агента не трогает (поведение прежнее) ----------
{
  reset();
  const SRC = treeKey('L', 'source');
  const t = mgr.tree(SRC); t.key = SRC; t.serverFirst = false;
  const b = peer('LB', { role: 'broadcaster', treeKey: SRC, streamId: 'L' });
  place(t, b, null); t.broadcasterId = 'LB';
  place(t, peer('LV', { treeKey: SRC, streamId: 'L' }), 'LB');
  peer('A', { uid: 'virtual-relay', treeKey: null, streamId: null });
  onVrelayHello('A', { capacity: 24, maxTranscodes: 1 });
  ok('A2: legacy-эфир без сирот не получает активацию', sent('A', 'vrelay-activate').length === 0 && sent('A', 'vrelay-ingest').length === 0);
}

// ---------- B: отвал агента чистит реестр рендишнов ----------
{
  reset();
  const SRC = treeKey('S', 'source');
  const R = treeKey('S', '1080');
  const t = mgr.tree(SRC); t.key = SRC; t.serverFirst = true;
  place(t, peer('B', { role: 'broadcaster', treeKey: SRC }), null); t.broadcasterId = 'B';
  t.renditions = new Map([['1080', { state: 'live', lastConsumerAt: Date.now(), presetBitrate: 4_500_000 }]]);
  const rt = mgr.tree(R); rt.key = R;
  place(rt, peer('V1080', { treeKey: R, rendition: '1080' }), null); // сирота: корень уже ушёл
  peer('A', { uid: 'virtual-relay', treeKey: null, streamId: null });
  onVrelayHello('A', { capacity: 24, maxTranscodes: 1 });
  onLeave('A', 'ws close');
  ok('B: реестр рендишнов очищен после отвала агента', !t.renditions.has('1080'));
  ok('B: зритель рендишна получил rendition-unavailable', sent('V1080', 'rendition-unavailable').length === 1);
}

// ---------- C: ушёл рендишн-корень — следующий заход поднимает транскод заново ----------
{
  reset();
  const SRC = treeKey('S', 'source');
  const R = treeKey('S', '1080');
  const t = mgr.tree(SRC); t.key = SRC; t.serverFirst = true;
  place(t, peer('B', { role: 'broadcaster', treeKey: SRC }), null); t.broadcasterId = 'B';
  t.renditions = new Map([['1080', { state: 'live', lastConsumerAt: Date.now(), presetBitrate: 4_500_000 }]]);
  const rt = mgr.tree(R); rt.key = R;
  place(rt, peer('ROOT', { role: 'broadcaster', identity: 'vrelay-1080', treeKey: R, rendition: '1080', virtual: false }), null);
  rt.broadcasterId = 'ROOT';
  place(rt, peer('VR', { treeKey: R, rendition: '1080' }), 'ROOT');
  peer('A', { uid: 'virtual-relay', treeKey: null, streamId: null });
  onVrelayHello('A', { capacity: 24, maxTranscodes: 1 });
  outbox.clear();
  onLeave('ROOT', 'ws close');
  ok('C: запись реестра снята вместе с рендишн-корнем', !t.renditions.has('1080'));
  const started = ensureRendition('S', '1080');
  ok('C: следующий заход в 1080 заново поднимает транскод', started && sent('A', 'vrelay-rendition-start').length === 1);
}

console.log = realLog;
server.close();
if (failed) { realLog(`\n${failed} FAIL`); process.exit(1); }
realLog('\nвсе проверки прошли');
process.exit(0);
