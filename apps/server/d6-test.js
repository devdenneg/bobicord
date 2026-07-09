// Roadmap-flow-стриминга Д6 — ad-hoc тест супер-сидеров (arbitrateServerSlots + динамическая
// ёмкость из upload). Строим дерево напрямую в возвращённом TreeManager (send() для узлов вне
// peers-мапы = no-op, поэтому WS не нужен), дёргаем реальный arbitrateServerSlots и проверяем
// пункты AC (a)-(g). Запуск: node apps/server/d6-test.js
//
// НЕ требует запущенного сервера/агента/вещателя. Проверяет ПОЛИТИКУ (planServerSlotSwap) +
// ИСПОЛНИТЕЛЯ (arbitrateServerSlots) на уровне менеджера — детерминированно.

const http = require('http');
const { attachTreeServer, treeKey } = require('./tree');

let failed = 0;
function ok(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) failed++; }

const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
const api = attachTreeServer(server, { sessionSecret: 'test' });
// Гасим фоновые таймеры — иначе abrTimer/arbitrate дёрнули бы наши ручные деревья между шагами.
for (const k of ['abrTimer', 'hbTimer', 'drainTimer', 'renditionTimer']) { try { clearInterval(api[k]); } catch { /**/ } }
const { mgr, arbitrateServerSlots } = api;
const KEY = treeKey('S', 'source');

// Фабрика узла со всеми полями, которые читают capacityOf/planServerSlotSwap/reparent.
function node(id, over) {
  return Object.assign({
    id, identity: id, role: 'viewer', native: true, virtual: false,
    children: [], parent: null, depth: 0, availableOutgoing: 0,
    maxChildren: undefined, treeKey: KEY, rendition: 'source',
    reparentCooldownUntil: 0, vrelayPinned: false, qualityPinned: false,
    symmetricNat: false, maxBitrate: 0, streamId: 'S',
  }, over);
}

// Строит дерево из списка [id, parentId, overrides]; parentId=null → broadcaster/корень.
function build(spec) {
  mgr.trees.clear();
  const t = mgr.tree(KEY);
  t.serverFirst = true;
  for (const [id, parentId, over] of spec) {
    const n = node(id, over || {});
    n.parent = parentId;
    mgr.trees.get(KEY).nodes.set(id, n);
    if (n.role === 'broadcaster') { t.broadcasterId = id; n.depth = 0; }
  }
  // проставим depth и children по parent-ссылкам
  const t2 = mgr.trees.get(KEY);
  for (const n of t2.nodes.values()) if (n.parent) { const p = t2.nodes.get(n.parent); if (p) p.children.push(n.id); }
  // depth BFS от корня
  const q = [t2.broadcasterId];
  while (q.length) { const cur = t2.nodes.get(q.shift()); for (const cid of cur.children) { const c = t2.nodes.get(cid); c.depth = cur.depth + 1; q.push(cid); } }
  return t2;
}

const MB = 1_000_000;

// ---------- CASE 0: динамическая ёмкость из upload (server-first зритель) ----------
{
  const t = build([
    ['bc', null, { role: 'broadcaster', maxBitrate: 5 * MB, maxChildren: 1 }],
    ['vr', 'bc', { virtual: true, maxChildren: 2 }],
  ]);
  const mk = (up) => { const n = node('x', { availableOutgoing: up }); mgr.trees.get(KEY).nodes.set('x', n); return mgr.capacityOf(n); };
  // br=5M, headroom 1.3 → нужен ≥13M на 2, ≥6.5M на 1.
  ok('C0 upload 20M → cap 2 (запас на ветвление)', mk(20 * MB) === 2);
  ok('C0 upload 8M → cap 1 (хватает на одного)', mk(8 * MB) === 1);
  ok('C0 upload 1M → cap 0 (доказанно слабый — детей не даёт)', mk(1 * MB) === 0);
  ok('C0 upload 0 (не измерен) → cap 1 (консервативно, не раздуваем)', mk(0) === 1);
  // браузер — всегда лист
  const br = node('b', { native: false, availableOutgoing: 30 * MB, maxChildren: 5 });
  mgr.trees.get(KEY).nodes.set('b', br);
  ok('C0 браузер cap 0 (не доверяем самозаявленному upload)', mgr.capacityOf(br) === 0);
  void t;
}

// ---------- CASE 1: (a) ровно одна рокировка, (b) сильный ↑ слабый ↓, (g) cooldown обоим ----------
{
  build([
    ['bc', null, { role: 'broadcaster', maxBitrate: 5 * MB, maxChildren: 1 }],
    ['vr', 'bc', { virtual: true, maxChildren: 2 }],       // серверный узел, cap 2 — ЗАНЯТ (D1,D2)
    ['D1', 'vr', { availableOutgoing: 15 * MB }],           // прямой, крепкий, держит S
    ['D2', 'vr', { availableOutgoing: 1 * MB }],            // прямой ЛИСТ, слабый → жертва
    ['S',  'D1', { availableOutgoing: 20 * MB }],           // сильный В ГЛУБИНЕ → кандидат
  ]);
  const now = 1_000_000;
  const swaps = arbitrateServerSlots(now);
  const t = mgr.trees.get(KEY);
  const S = t.nodes.get('S'), D2 = t.nodes.get('D2');
  ok('C1(a) ровно одна рокировка за тик', swaps === 1);
  ok('C1(b) сильный S поднят в прямой слот vrelay', S.parent === 'vr');
  ok('C1(b) слабый D2 вытеснен в глубину (не прямой ребёнок vrelay)', D2.parent !== 'vr' && D2.depth >= 3);
  ok('C1(b) D2 сел под сильного/крепкого узла', D2.parent === 'S' || D2.parent === 'D1');
  ok('C1(g) cooldown 30с на кандидате (perViewerAbr его пропустит)', S.reparentCooldownUntil === now + 30_000);
  ok('C1(g) cooldown 30с на жертве', D2.reparentCooldownUntil === now + 30_000);
  // повтор в тот же тик — второй рокировки НЕТ (cooldown + уже оптимально)
  ok('C1(a) второй вызов в тот же момент — 0 рокировок', arbitrateServerSlots(now) === 0);
}

// ---------- CASE 2: (c) браузер в глубине НЕ поднимается в relay-слот ----------
{
  build([
    ['bc', null, { role: 'broadcaster', maxBitrate: 5 * MB, maxChildren: 1 }],
    ['vr', 'bc', { virtual: true, maxChildren: 2 }],
    ['D1', 'vr', { availableOutgoing: 1 * MB }],
    ['D2', 'vr', { availableOutgoing: 1 * MB }],
    ['B',  'D1', { native: false, availableOutgoing: 30 * MB }], // «сильный» БРАУЗЕР в глубине (врёт upload)
  ]);
  const swaps = arbitrateServerSlots(2_000_000);
  const B = mgr.trees.get(KEY).nodes.get('B');
  ok('C2(c) браузер в глубине не поднят (нет натив-кандидата → 0 рокировок)', swaps === 0);
  ok('C2(c) браузер остался в глубине (parent=D1)', B.parent === 'D1');
}

// ---------- CASE 2b: браузер-ЖЕРТВА вытесняется в глубину и остаётся ЛИСТОМ (валидное дерево) ----------
{
  build([
    ['bc', null, { role: 'broadcaster', maxBitrate: 5 * MB, maxChildren: 1 }],
    ['vr', 'bc', { virtual: true, maxChildren: 2 }],
    ['D1', 'vr', { availableOutgoing: 15 * MB }],
    ['Bd', 'vr', { native: false, availableOutgoing: 0 }],  // прямой браузер-ЛИСТ → жертва
    ['S',  'D1', { availableOutgoing: 20 * MB }],            // сильный натив → кандидат
  ]);
  const swaps = arbitrateServerSlots(3_000_000);
  const t = mgr.trees.get(KEY);
  const S = t.nodes.get('S'), Bd = t.nodes.get('Bd');
  ok('C2b одна рокировка', swaps === 1);
  ok('C2b сильный натив S в прямом слоте', S.parent === 'vr');
  ok('C2b браузер Bd вытеснен в глубину', Bd.parent !== 'vr');
  ok('C2b браузер Bd остался ЛИСТОМ (детей не получил)', Bd.children.length === 0);
  // ни один браузер в дереве не имеет детей
  let browserWithKids = false;
  for (const n of t.nodes.values()) if (!n.native && n.children.length) browserWithKids = true;
  ok('C2b НИ ОДИН браузер не ретранслирует (всегда лист)', browserWithKids === false);
}

// ---------- CASE 3: (d) гистерезис 25% — «сильный лишь на 10% лучше» → рокировки НЕТ ----------
{
  build([
    ['bc', null, { role: 'broadcaster', maxBitrate: 5 * MB, maxChildren: 1 }],
    ['vr', 'bc', { virtual: true, maxChildren: 2 }],
    ['D1', 'vr', { availableOutgoing: 10 * MB }],
    ['D2', 'vr', { availableOutgoing: 10 * MB }],  // худший прямой = 10M
    ['S',  'D1', { availableOutgoing: 11 * MB }],  // на 10% лучше (11M < 10M×1.25=12.5M)
  ]);
  ok('C3(d) сильный на 10% лучше — рокировки НЕТ (гистерезис 25%)', arbitrateServerSlots(4_000_000) === 0);
}

// ---------- CASE 4: (e) cooldown 30с блокирует, по истечении — рокировка происходит ----------
{
  build([
    ['bc', null, { role: 'broadcaster', maxBitrate: 5 * MB, maxChildren: 1 }],
    ['vr', 'bc', { virtual: true, maxChildren: 2 }],
    ['D1', 'vr', { availableOutgoing: 15 * MB }],
    ['D2', 'vr', { availableOutgoing: 1 * MB }],
    ['S',  'D1', { availableOutgoing: 20 * MB, reparentCooldownUntil: 5_030_000 }], // кандидат в cooldown
  ]);
  ok('C4(e) кандидат в cooldown → рокировки НЕТ', arbitrateServerSlots(5_000_000) === 0);
  // по истечении cooldown (now > 5_030_000) — рокировка проходит
  ok('C4(e) после cooldown — рокировка происходит', arbitrateServerSlots(5_031_000) === 1);
  ok('C4(e) сильный поднят после cooldown', mgr.trees.get(KEY).nodes.get('S').parent === 'vr');
}

// ---------- CASE 5: (f) нет прямых листьев → вытесняем узел с МЕНЬШИМ поддеревом ----------
{
  build([
    ['bc', null, { role: 'broadcaster', maxBitrate: 5 * MB, maxChildren: 1 }],
    ['vr', 'bc', { virtual: true, maxChildren: 2 }],
    ['D1', 'vr', { availableOutgoing: 5 * MB }],   // поддерево высотой 1 (A)
    ['A',  'D1', { availableOutgoing: 20 * MB }],  // сильный лист → кандидат
    ['D2', 'vr', { availableOutgoing: 5 * MB }],   // поддерево высотой 2 (B→C) — больше
    ['B',  'D2', { availableOutgoing: 2 * MB }],
    ['C',  'B',  { availableOutgoing: 1 * MB }],
  ]);
  const swaps = arbitrateServerSlots(6_000_000);
  const t = mgr.trees.get(KEY);
  const D1 = t.nodes.get('D1'), D2 = t.nodes.get('D2'), A = t.nodes.get('A');
  ok('C5(f) одна рокировка', swaps === 1);
  ok('C5(f) вытеснен D1 (меньшее поддерево), НЕ D2', D1.parent !== 'vr' && D2.parent === 'vr');
  ok('C5(f) кандидат A поднят в прямой слот', A.parent === 'vr');
}

server.close();
console.log(failed ? `\n${failed} FAIL` : '\nВсе проверки Д6 зелёные');
process.exit(failed ? 1 : 0);
