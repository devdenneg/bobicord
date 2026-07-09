// Roadmap-flow-стриминга Д7 — ad-hoc тест серверной отбраковки плохого родителя (frameDropReparent)
// для НАТИВНОГО зрителя. Строим дерево напрямую в TreeManager (send() для узлов вне peers = no-op,
// WS не нужен), дёргаем реальный frameDropReparent и проверяем миграцию/гейты. НЕ требует
// сервера/агента/вещателя. Запуск: node apps/server/d7-test.js

const http = require('http');
const { attachTreeServer, treeKey } = require('./tree');

let failed = 0;
const logs = [];
const realLog = console.log;
// Перехват tlog (tree.js пишет через console.log) — проверяем reason=frame-drops.
console.log = (...a) => { logs.push(a.join(' ')); };
function ok(name, cond) { realLog(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) failed++; }

const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
const api = attachTreeServer(server, { sessionSecret: 'test' });
for (const k of ['abrTimer', 'hbTimer', 'drainTimer', 'renditionTimer']) { try { clearInterval(api[k]); } catch { /**/ } }
const { mgr, frameDropReparent } = api;

const NOW = 1_000_000;
const KEY = treeKey('S', 'source');

// Фабрика узла со всеми полями frameDropReparent/reparent/capacityOf.
function node(id, over) {
  return Object.assign({
    id, identity: id, role: 'viewer', native: true, virtual: false,
    children: [], parent: null, depth: 0, availableOutgoing: 0,
    maxChildren: 4, treeKey: KEY, rendition: 'source', streamId: 'S',
    reparentCooldownUntil: 0, vrelayPinned: false, qualityPinned: false,
    symmetricNat: false, maxBitrate: 5_000_000,
    linkLoss: 0, linkRtt: 0, statsAt: 0, framesDroppedPct: 0, framesDropAt: 0, dropBadTicks: 0,
  }, over);
}

// Строит дерево [id, parentId, over]; parentId=null → broadcaster.
function build(spec, serverFirst = false, key = KEY) {
  mgr.trees.clear();
  const t = mgr.tree(key);
  t.serverFirst = serverFirst;
  for (const [id, parentId, over] of spec) {
    const n = node(id, Object.assign({ treeKey: key }, over || {}));
    n.parent = parentId;
    t.nodes.set(id, n);
    if (n.role === 'broadcaster') { t.broadcasterId = id; n.depth = 0; }
  }
  for (const n of t.nodes.values()) if (n.parent) { const p = t.nodes.get(n.parent); if (p) p.children.push(n.id); }
  const q = [t.broadcasterId];
  while (q.length) { const cur = t.nodes.get(q.shift()); for (const cid of cur.children) { const c = t.nodes.get(cid); c.depth = cur.depth + 1; q.push(cid); } }
  return t;
}

// bad-стата: свежие потери на upstream + высокий framesDroppedPct.
const BAD = { linkLoss: 0.2, statsAt: NOW, framesDroppedPct: 10, framesDropAt: NOW };

// Хелпер: прогнать N тиков, вернуть сумму миграций.
function ticks(n) { let m = 0; for (let i = 0; i < n; i++) m += frameDropReparent(NOW); return m; }

// ---------- CASE A: натив-лист под ПИРОМ с дропами → миграция за 2 тика, исключая родителя ----------
{
  const t = build([
    ['bc', null, { role: 'broadcaster', maxChildren: 4 }],
    ['P1', 'bc', {}],                    // ПЛОХОЙ родитель-пир
    ['P2', 'bc', {}],                    // альтернативный пир (есть ёмкость)
    ['V', 'P1', BAD],                    // жертва: натив-лист под P1 с дропами
  ]);
  const moved1 = frameDropReparent(NOW);  // тик 1: dropBadTicks 0→1, миграции нет (гистерезис)
  ok('(A) 1 тик — миграции НЕТ (badTicks<2)', moved1 === 0 && t.nodes.get('V').parent === 'P1');
  const moved2 = frameDropReparent(NOW);  // тик 2: dropBadTicks→2 → миграция
  const V = t.nodes.get('V');
  ok('(A) 2-й тик — миграция', moved2 === 1);
  ok('(A) новый родитель ≠ старый (P1 исключён)', V.parent !== 'P1' && V.parent != null);
  ok('(A) залогирован reason=frame-drops', logs.some((l) => l.includes('[frame-drops] reparent') && l.includes('(V)')));
  ok('(A) cooldown выставлен после миграции', V.reparentCooldownUntil > NOW);
}

// ---------- CASE B: два сигнала — потери есть, но framesDroppedPct низкий → НЕТ ----------
{
  build([
    ['bc', null, { role: 'broadcaster', maxChildren: 4 }],
    ['P1', 'bc', {}], ['P2', 'bc', {}],
    ['V', 'P1', { linkLoss: 0.2, statsAt: NOW, framesDroppedPct: 2, framesDropAt: NOW }], // дропы <5%
  ]);
  ok('(B) высокий loss но дропы <5% → НЕТ (второй сигнал)', ticks(3) === 0);
}

// ---------- CASE C: потери НИЖЕ порога → НЕТ (даже при высоких дропах) ----------
{
  build([
    ['bc', null, { role: 'broadcaster', maxChildren: 4 }],
    ['P1', 'bc', {}], ['P2', 'bc', {}],
    ['V', 'P1', { linkLoss: 0.05, statsAt: NOW, framesDroppedPct: 10, framesDropAt: NOW }], // loss <ABR_LOSS_HI(0.1)
  ]);
  ok('(C) loss ниже порога → НЕТ', ticks(3) === 0);
}

// ---------- CASE D: лист под СЕРВЕРНЫМ узлом (vrelay) → НЕТ (территория Д4 perViewerAbr) ----------
{
  const t = build([
    ['bc', null, { role: 'broadcaster', maxChildren: 4 }],
    ['vr', 'bc', { virtual: true, maxChildren: 8 }],
    ['V', 'vr', BAD],                    // под vrelay — reparent бессмыслен, реакция = рендишн
  ], true);
  ok('(D) под vrelay → НЕТ (Д4 понижает рендишн, не reparent)', ticks(3) === 0 && t.nodes.get('V').parent === 'vr');
}

// ---------- CASE E: БРАУЗЕРНЫЙ лист под пиром → НЕТ (клиент судит сам, dropDetector) ----------
{
  const t = build([
    ['bc', null, { role: 'broadcaster', maxChildren: 4 }],
    ['P1', 'bc', {}], ['P2', 'bc', {}],
    ['V', 'P1', Object.assign({ native: false }, BAD)],
  ]);
  ok('(E) браузер → НЕТ (сервер не дублирует клиентский детектор)', ticks(3) === 0 && t.nodes.get('V').parent === 'P1');
}

// ---------- CASE F: устаревшая стата (statsAt протух) → НЕТ ----------
{
  build([
    ['bc', null, { role: 'broadcaster', maxChildren: 4 }],
    ['P1', 'bc', {}], ['P2', 'bc', {}],
    ['V', 'P1', { linkLoss: 0.2, statsAt: NOW - 60_000, framesDroppedPct: 10, framesDropAt: NOW - 60_000 }],
  ]);
  ok('(F) протухшая upstream-стата → НЕТ', ticks(3) === 0);
}

// ---------- CASE G: framesDroppedPct не шлётся (loss-only) → миграция по одному сетевому сигналу ----------
{
  const t = build([
    ['bc', null, { role: 'broadcaster', maxChildren: 4 }],
    ['P1', 'bc', {}], ['P2', 'bc', {}],
    ['V', 'P1', { linkLoss: 0.2, statsAt: NOW }], // без framesDroppedPct/framesDropAt (старый клиент)
  ]);
  const moved = ticks(2);
  ok('(G) loss-only (нет framesDroppedPct) → миграция за 2 тика', moved === 1 && t.nodes.get('V').parent !== 'P1');
}

realLog(`\n${failed === 0 ? 'ВСЕ ТЕСТЫ ПРОШЛИ' : failed + ' FAIL'}`);
process.exit(failed ? 1 : 0);
