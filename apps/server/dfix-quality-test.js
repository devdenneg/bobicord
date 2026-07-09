// Д-фикс (Roadmap-flow-стриминга) — ad-hoc ws-тест: сервер не объявляет рендишн-лестницу, которую
// агент vrelay физически не поднимет (VRELAY_MAX_TRANSCODES=0 на проде, 1 vCPU). По образцу
// tree-sim.js: поднимаем реальный tree-сигналинг, подключаем фейкового вещателя (serverIngest,
// 1920x1080), фейкового агента vrelay (vrelay-hello {maxTranscodes}) и зрителей по ws.
// Проверяем пункты (a)-(e) из ТЗ. Запуск: node apps/server/dfix-quality-test.js

const http = require('http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachTreeServer, treeKey } = require('./tree');

const SECRET = 'test';
let failed = 0;
function ok(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) failed++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = (sub) => jwt.sign({ id: sub }, SECRET, { expiresIn: '1h' });
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  const api = attachTreeServer(server, { sessionSecret: SECRET });
  // Гасим фоновые таймеры — ABR/idle-teardown/heartbeat не должны дёргать наши ручные деревья.
  for (const k of ['abrTimer', 'hbTimer', 'drainTimer', 'renditionTimer']) { try { clearInterval(api[k]); } catch { /**/ } }
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  const wsUrl = (sub) => `ws://127.0.0.1:${port}/tree?token=${encodeURIComponent(token(sub))}`;

  // WS-клиент, аккумулирующий stream-live и rendition-unavailable.
  function client(sub) {
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl(sub));
      const c = { ws, id: null, streamLive: [], unavailable: [] };
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.t === 'welcome') { c.id = m.id; resolve(c); }
        else if (m.t === 'stream-live') c.streamLive.push(m);
        else if (m.t === 'rendition-unavailable') c.unavailable.push(m);
      });
      ws.on('error', () => { /**/ });
    });
  }
  const send = (c, obj) => c.ws.send(JSON.stringify(obj));
  const lastRen = (c) => (c.streamLive.length ? c.streamLive[c.streamLive.length - 1].renditions : null);

  // --- агент vrelay без транскод-ёмкости (прод: 1 vCPU, VRELAY_MAX_TRANSCODES=0) ---
  let agent = await client('virtual-relay');
  send(agent, { t: 'vrelay-hello', capacity: 4, maxTranscodes: 0 });
  await sleep(60);

  // --- вещатель: serverIngest, выходное 1920x1080 ---
  const bc = await client('bc');
  send(bc, { t: 'join', streamId: 'S', role: 'broadcaster', native: true, serverIngest: true, width: 1920, height: 1080, serverId: 'srv', identity: 'streamer', maxChildren: 1 });
  await sleep(60);

  // --- discovery-сокет зрителя (hello → бэклог stream-live; сюда же прилетают ре-анонсы) ---
  const disc = await client('disc');
  send(disc, { t: 'hello', serverId: 'srv' });
  await sleep(80);

  // (a) при maxTranscodes=0 объявлена только исходная дорожка
  ok('(a) stream-live.renditions == [source] при агенте maxTranscodes=0', eq(lastRen(disc), ['source']));

  // --- watch-сокет зрителя: реально joins в ::source ---
  const watch = await client('w1');
  send(watch, { t: 'join', streamId: 'S', role: 'viewer', native: false, quality: 'source', serverId: 'srv', identity: 'viewer1', maxChildren: 0 });
  await sleep(80);

  // (b) set-quality 720 → немедленный rendition-unavailable, зритель ОСТАЁТСЯ в ::source
  watch.unavailable.length = 0;
  send(watch, { t: 'set-quality', rendition: '720' });
  await sleep(100);
  ok('(b) rendition-unavailable на set-quality 720', watch.unavailable.some((m) => m.rendition === '720'));
  ok('(b) зритель ОСТАЛСЯ в ::source (не осиротел в ::720)', api.peers.get(watch.id) && api.peers.get(watch.id).treeKey === treeKey('S', 'source'));

  // (c) агент реконнект с maxTranscodes:2 → лестница снова содержит 1080/720/480 (source 1080p)
  agent.ws.close();
  await sleep(60);
  disc.streamLive.length = 0;
  agent = await client('virtual-relay');
  send(agent, { t: 'vrelay-hello', capacity: 4, maxTranscodes: 2 });
  await sleep(120);
  const rc = lastRen(disc) || [];
  ok('(c) при maxTranscodes:2 лестница содержит 1080/720/480', rc.includes('1080') && rc.includes('720') && rc.includes('480'));

  // (d) агент без поля maxTranscodes (старый бандл) → консервативный дефолт 0 → только [source]
  agent.ws.close();
  await sleep(60);
  disc.streamLive.length = 0;
  agent = await client('virtual-relay');
  send(agent, { t: 'vrelay-hello', capacity: 4 }); // поле maxTranscodes отсутствует
  await sleep(120);
  ok('(d) старый агент (без maxTranscodes) → дефолт 0 → [source]', eq(lastRen(disc), ['source']));

  // (e) агент отвалился → лестница схлопывается в [source]
  disc.streamLive.length = 0;
  agent.ws.close();
  await sleep(120);
  ok('(e) агент отвалился → лестница схлопнулась в [source]', eq(lastRen(disc), ['source']));

  server.close();
  console.log(failed ? `\n${failed} FAIL` : '\nВсе проверки Д-фикс зелёные');
  process.exit(failed ? 1 : 0);
}
main();
