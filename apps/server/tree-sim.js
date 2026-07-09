// Э1 AC-имитатор: N ws-клиентов строят relay-дерево, логируем структуру и глубину,
// затем убиваем внутренний узел и меряем время reparent (< 2с по AC).
//
// Запуск: SESSION_SECRET=dev-secret-change node apps/server/tree-sim.js [N]
// (SESSION_SECRET должен совпадать с тем, что использует запущенный apps/server/index.js)

const http = require('http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachTreeServer, MAX_DEPTH, TreeManager, treeKey } = require('./tree');

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change';
const N = parseInt(process.argv[2], 10) || 20;
const PORT = 0; // случайный свободный порт — симулятор поднимает свой сервер, не трогая :3000

function token(sub) { return jwt.sign({ id: sub }, SESSION_SECRET, { expiresIn: '1h' }); }

async function main() {
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  attachTreeServer(server, { sessionSecret: SESSION_SECRET, path: '/tree' });
  await new Promise((resolve) => server.listen(PORT, resolve));
  const port = server.address().port;
  const url = `ws://127.0.0.1:${port}/tree?token=${encodeURIComponent(token('sim'))}`;

  const clients = []; // { ws, id, streamId, native, role, treeInfo }
  const streamId = 'sim-stream';

  function connect(role, native) {
    return new Promise((resolve) => {
      const ws = new WebSocket(url);
      const c = { ws, id: null, native, role, depth: null, topology: null, denied: null };
      // Э8: натив объявляет ёмкость relay (4), браузер — лист (0)
      const maxChildren = native ? 4 : 0;
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'welcome') {
          c.id = msg.id;
          ws.send(JSON.stringify({ t: 'join', streamId, role, native, maxChildren, identity: role + '-' + c.id }));
          resolve(c);
        } else if (msg.t === 'assign-parent') {
          c.parentId = msg.parentId;
        } else if (msg.t === 'tree-info') {
          c.depth = msg.depth;
        } else if (msg.t === 'tree-topology') {
          c.topology = msg.nodes;
        } else if (msg.t === 'reparent-denied') {
          c.denied = msg.reason;
        }
      });
      clients.push(c);
    });
  }

  // AC: джойн без валидного JWT отклоняется
  await new Promise((resolve) => {
    const bad = new WebSocket(`ws://127.0.0.1:${port}/tree?token=garbage`);
    bad.on('unexpected-response', (_req, res) => { console.log(`[sim] неавторизованный ws отклонён: HTTP ${res.statusCode}`); resolve(); });
    bad.on('error', () => resolve());
    bad.on('open', () => { console.error('[sim] FAIL: ws принял невалидный JWT'); process.exitCode = 1; resolve(); });
  });

  console.log(`[sim] запускаю дерево: 1 broadcaster + ${N - 1} viewers (микс native/browser)`);
  const broadcaster = await connect('broadcaster', true);
  const viewers = [];
  for (let i = 0; i < N - 1; i++) {
    // чередуем native (может ретранслировать) и browser (всегда лист)
    viewers.push(await connect('viewer', i % 3 !== 0));
  }

  await new Promise((r) => setTimeout(r, 500)); // дать дереву осесть

  const maxDepth = Math.max(...clients.map((c) => c.depth || 0));
  console.log(`[sim] дерево построено: ${clients.length} узлов, глубина=${maxDepth} (лимит ${MAX_DEPTH})`);
  console.log(`[sim] структура (id -> parentId):`);
  clients.forEach((c) => console.log(`  ${c.role.padEnd(10)} native=${String(c.native).padEnd(5)} id=${c.id} parent=${c.parentId || '(root)'}`));

  if (maxDepth > MAX_DEPTH) { console.error(`[sim] FAIL: глубина превышает лимит ${MAX_DEPTH}`); process.exitCode = 1; }

  // убиваем случайный ВНУТРЕННИЙ узел (тот, у кого есть дети) и меряем reparent-тайминг
  const internal = viewers.find((v) => clients.some((c) => c.parentId === v.id));
  if (internal) {
    console.log(`[sim] обрываю внутренний узел ${internal.id}, жду reparent...`);
    const affected = clients.filter((c) => c.parentId === internal.id);
    const t0 = Date.now();
    internal.ws.close();
    await new Promise((resolve) => {
      let remaining = affected.length;
      if (remaining === 0) return resolve();
      const check = setInterval(() => {
        remaining = affected.filter((c) => c.parentId === internal.id).length;
        if (remaining === 0) { clearInterval(check); resolve(); }
      }, 50);
      setTimeout(() => { clearInterval(check); resolve(); }, 3000);
    });
    const dt = Date.now() - t0;
    const ok = affected.every((c) => c.parentId !== internal.id);
    console.log(`[sim] reparent за ${dt}ms, все дети переназначены: ${ok} (лимит 2000ms)`);
    if (!ok || dt > 2000) { console.error('[sim] FAIL: reparent не уложился в AC'); process.exitCode = 1; }
  } else {
    console.log('[sim] нет внутреннего узла с детьми — дерево слишком плоское для этого теста (увеличь N)');
  }

  // Э8: ручной выбор пира зрителем — берём viewer, находим в его топологии свободный
  // узел (не он сам, не его текущий родитель, есть ёмкость) и просим переезд к нему.
  const mover = viewers.find((v) => v.ws.readyState === WebSocket.OPEN && v.topology && v.parentId);
  if (mover) {
    const target = mover.topology.find((n) =>
      n.id !== mover.id && n.id !== mover.parentId && n.children < n.capacity && n.parentId !== mover.id);
    if (target) {
      console.log(`[sim] ручной reparent: ${mover.id} -> ${target.id}`);
      const before = mover.parentId;
      mover.ws.send(JSON.stringify({ t: 'request-reparent', streamId, targetParentId: target.id }));
      await new Promise((r) => setTimeout(r, 400));
      if (mover.parentId === target.id) {
        console.log(`[sim] ручной reparent OK: ${before} -> ${mover.parentId}`);
      } else {
        console.error(`[sim] FAIL: ручной reparent не применён (parent=${mover.parentId}, denied=${mover.denied})`);
        process.exitCode = 1;
      }
    } else {
      console.log('[sim] нет свободного узла для ручного reparent (дерево заполнено)');
    }
  }

  clients.forEach((c) => { try { c.ws.close(); } catch { /**/ } });
  server.close();

  // Roadmap-flow-стриминга Д8: регрессия рендишн-деревьев (server-first). Проверяем на уровне
  // менеджера (без WS/агента/ffmpeg): source-дерево + рендишн-дерево `base::720` — раздельные
  // Tree в mgr.trees; vrelay pinned прямым ребёнком корня; структурная ИЗОЛЯЦИЯ КАЧЕСТВ —
  // узел из `::720` не может стать родителем узла из `::source` (разные деревья).
  renditionTreesTest();

  if (!process.exitCode) console.log('[sim] OK');
}

// Прямой (без WS) тест рендишн-деревьев над TreeManager: изоляция качеств + vrelay pinned.
function renditionTreesTest() {
  const mgr = new TreeManager();
  const base = 'rs';
  const srcKey = treeKey(base, 'source');
  const rKey = treeKey(base, '720');
  const now = Date.now();
  let fails = 0;
  const check = (name, cond) => { console.log(`[sim] рендишн: ${cond ? 'OK' : 'FAIL'} — ${name}`); if (!cond) { fails++; process.exitCode = 1; } };

  const mk = (id, over) => Object.assign({
    id, identity: id, role: 'viewer', native: true, virtual: false, maxChildren: undefined,
    children: [], parent: null, depth: 0, availableOutgoing: 0, symmetricNat: false,
    linkLoss: 0, linkRtt: 0, rendition: 'source', treeKey: srcKey, streamId: base,
    vrelayPinned: false, qualityPinned: false,
  }, over);

  // --- source-дерево (server-first): корень cap=1 (слот под vrelay), vrelay, зрители ---
  mgr.join(srcKey, mk('bc', { role: 'broadcaster', maxChildren: 1 }));
  const srcT = mgr.trees.get(srcKey);
  srcT.serverFirst = true; // server-first (Д8-дефолт) — vrelay предпочтительный родитель
  mgr.join(srcKey, mk('vr', { virtual: true, maxChildren: 8 }));
  srcT.nodes.get('vr').vrelayPinned = true; // Д1: pinned постоянный медиаузел
  mgr.join(srcKey, mk('v1', { availableOutgoing: 0 }));
  mgr.join(srcKey, mk('v2', { native: false }));

  check('vrelay — прямой ребёнок корня (depth 1, pinned)',
    srcT.nodes.get('vr').parent === 'bc' && srcT.nodes.get('vr').depth === 1 && srcT.nodes.get('vr').vrelayPinned);
  check('server-first зритель садится под vrelay (не под корень)',
    srcT.nodes.get('v1').parent === 'vr' && srcT.nodes.get('v2').parent === 'vr');

  // --- рендишн-дерево base::720: рендишн-корень (ffmpeg vrelay-агента, native:true, virtual:false
  // ради обхода self-loop в ensureVirtualAttached) + свои зрители ---
  mgr.join(rKey, mk('rr', { role: 'broadcaster', native: true, rendition: '720', treeKey: rKey }));
  mgr.join(rKey, mk('rv1', { rendition: '720', treeKey: rKey }));
  const rT = mgr.trees.get(rKey);

  check('source и ::720 — РАЗДЕЛЬНЫЕ деревья в mgr.trees',
    srcT !== rT && mgr.trees.has(srcKey) && mgr.trees.has(rKey));
  check('узлы ::720 отсутствуют в source-дереве и наоборот',
    !srcT.nodes.has('rr') && !srcT.nodes.has('rv1') && !rT.nodes.has('bc') && !rT.nodes.has('vr'));
  check('зритель ::720 садится под рендишн-корень', rT.nodes.get('rv1').parent === 'rr');

  // Изоляция качеств: узел из ::720 (rr) НЕ может стать родителем узла из ::source (v1).
  const cross = mgr.reparent(srcKey, 'v1', 'rr', now);
  check('reparent source-узла к ::720-узлу ОТКЛОНЁН (изоляция качеств)',
    cross.ok === false && cross.reason === 'target-gone');
  // pickParent для source-сироты возвращает только узлы source-дерева (никогда rr/rv1).
  const orphan = mk('v3', {});
  mgr.trees.get(srcKey).nodes.set('v3', orphan);
  const picked = mgr.pickParent(srcT, orphan);
  check('pickParent(source) возвращает только узлы source-дерева',
    !!picked && srcT.nodes.has(picked.id) && !rT.nodes.has(picked.id));

  console.log(`[sim] рендишн-деревья: ${fails === 0 ? 'все проверки зелёные' : fails + ' FAIL'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
