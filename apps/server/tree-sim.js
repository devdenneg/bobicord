// Э1 AC-имитатор: N ws-клиентов строят relay-дерево, логируем структуру и глубину,
// затем убиваем внутренний узел и меряем время reparent (< 2с по AC).
//
// Запуск: SESSION_SECRET=dev-secret-change node apps/server/tree-sim.js [N]
// (SESSION_SECRET должен совпадать с тем, что использует запущенный apps/server/index.js)

const http = require('http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachTreeServer } = require('./tree');

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
      const c = { ws, id: null, native, role, depth: null };
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.t === 'welcome') {
          c.id = msg.id;
          ws.send(JSON.stringify({ t: 'join', streamId, role, native, identity: role + '-' + c.id }));
          resolve(c);
        } else if (msg.t === 'assign-parent') {
          c.parentId = msg.parentId;
        } else if (msg.t === 'tree-info') {
          c.depth = msg.depth;
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
  console.log(`[sim] дерево построено: ${clients.length} узлов, глубина=${maxDepth} (лимит 4)`);
  console.log(`[sim] структура (id -> parentId):`);
  clients.forEach((c) => console.log(`  ${c.role.padEnd(10)} native=${String(c.native).padEnd(5)} id=${c.id} parent=${c.parentId || '(root)'}`));

  if (maxDepth > 4) { console.error('[sim] FAIL: глубина превышает лимит 4'); process.exitCode = 1; }

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

  clients.forEach((c) => { try { c.ws.close(); } catch { /**/ } });
  server.close();
  if (!process.exitCode) console.log('[sim] OK');
}

main().catch((e) => { console.error(e); process.exit(1); });
