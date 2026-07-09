// Регрессия прод-бага 2026-07-09: «стрим лагал → 0 fps → "качество 720p недоступно" → стрим закрылся».
//
// Цепочка: плохой линк → perViewerAbr решает понизить зрителя → берёт лестницу из availableRungs
// (режет ТОЛЬКО по разрешению source, про транскод-ёмкость агента не знает) → видит там 720 →
// moveNodeToRendition → ensureRendition отказывает (VRELAY_MAX_TRANSCODES=0) → сервер шлёт
// зрителю rendition-unavailable (хотя тот ничего не просил) → клиент «возвращает на source»,
// где и так был → unwatch+watch → у натива watch-слот один → СТРИМ ЗАКРЫВАЕТСЯ.
//
// Почему это не поймал dfix-quality-test.js: он ГЛУШИТ abrTimer, а его фейковый агент не входит
// в дерево виртуалом (родителем зрителя оставался вещатель → perViewerAbr такие узлы пропускает).
// Здесь ABR живой, виртуал реально родитель зрителя.
//
// Запуск: node apps/server/dfix-abr-test.js   (~15с — ждём реальные ABR-тики)

const http = require('http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachTreeServer, treeKey } = require('./tree');

const SECRET = 'test';
let failed = 0;
function ok(name, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`); if (!cond) failed++; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const token = (sub) => jwt.sign({ id: sub }, SECRET, { expiresIn: '1h' });

async function main() {
  const server = http.createServer((_q, r) => { r.writeHead(404); r.end(); });
  const api = attachTreeServer(server, { sessionSecret: SECRET });
  // abrTimer оставляем ЖИВЫМ — он и есть предмет теста. Остальные фоновые глушим.
  for (const k of ['hbTimer', 'drainTimer', 'renditionTimer']) { try { clearInterval(api[k]); } catch { /**/ } }
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;
  const wsUrl = (sub) => `ws://127.0.0.1:${port}/tree?token=${encodeURIComponent(token(sub))}`;

  function client(sub) {
    return new Promise((resolve) => {
      const ws = new WebSocket(wsUrl(sub));
      const c = { ws, id: null, unavailable: [], assignParent: [] };
      ws.on('message', (raw) => {
        let m; try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.t === 'welcome') { c.id = m.id; resolve(c); }
        else if (m.t === 'rendition-unavailable') c.unavailable.push(m);
        else if (m.t === 'assign-parent') c.assignParent.push(m);
      });
      ws.on('error', () => { /**/ });
    });
  }
  const send = (c, obj) => c.ws.send(JSON.stringify(obj));
  const keyOf = (c) => { const p = api.peers.get(c.id); return p ? p.treeKey : null; };

  // Поднимает стрим: агент(maxTranscodes) → вещатель(serverIngest) → виртуал в дерево → зритель.
  // Возвращает {agent, bc, watch}. Зритель обязан оказаться под ВИРТУАЛОМ (иначе ABR его не смотрит).
  async function setup(streamId, maxTranscodes) {
    const agent = await client('virtual-relay');
    send(agent, { t: 'vrelay-hello', capacity: 4, maxTranscodes });
    await sleep(60);

    const bc = await client('bc-' + streamId);
    send(bc, { t: 'join', streamId, role: 'broadcaster', native: true, serverIngest: true, width: 1920, height: 1080, serverId: 'srv', identity: 'streamer-' + streamId, maxChildren: 1 });
    await sleep(80);

    // Виртуал входит в дерево (как настоящий vrelay по vrelay-ingest).
    send(agent, { t: 'join', streamId, role: 'viewer', native: true, virtual: true, maxChildren: 4, serverId: 'srv', identity: 'vrelay' });
    await sleep(100);

    const watch = await client('w-' + streamId);
    send(watch, { t: 'join', streamId, role: 'viewer', native: false, quality: 'source', serverId: 'srv', identity: 'viewer-' + streamId, maxChildren: 0 });
    await sleep(120);
    return { agent, bc, watch };
  }

  // Родитель (виртуал) репортит УЖАСНЫЙ линк к зрителю. Держим stats свежими (STATS_TTL_MS=10с)
  // и ждём >= ABR_BAD_TICKS(2) тиков ABR_TICK_MS(2с).
  //
  // ВАЖНО: свежепосаженному под виртуала узлу ставится reparentCooldownUntil = +15с
  // (DRAIN_COOLDOWN_MS). perViewerAbr на нём делает `continue` ДО выбора target. Без обнуления
  // cooldown тест был бы ВАКУУМНЫМ: «нет хода» проходило бы даже при полностью сломанном гейте
  // (первая версия этого теста именно так и «зеленела» в случае 1). Симулируем истёкший cooldown.
  async function pumpBadStats(agent, watch, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const p = api.peers.get(watch.id);
      if (p) p.reparentCooldownUntil = 0;
      send(agent, { t: 'stats', availableOutgoing: 37_000_000, toChild: [{ id: watch.id, loss: 0.5, rtt: 900 }] });
      await sleep(700);
    }
  }

  /* ---------- Случай 1: транскода НЕТ (прод). ABR обязан быть ИНЕРТЕН ---------- */
  const s1 = await setup('S0', 0);
  ok('setup: зритель сидит под виртуалом (иначе ABR его не рассматривает)',
    (() => { const p = api.peers.get(s1.watch.id); const par = p && api.peers.get(p.parent); return !!(par && par.virtual); })());
  ok('setup: зритель в ::source', keyOf(s1.watch) === treeKey('S0', 'source'));

  s1.watch.unavailable.length = 0;
  await pumpBadStats(s1.agent, s1.watch, 7000);

  ok('(1) maxTranscodes=0: НЕТ rendition-unavailable (сервер не дёргает зрителя авто-ходом)',
    s1.watch.unavailable.length === 0);
  ok('(1) maxTranscodes=0: зритель ОСТАЛСЯ в ::source (стрим не порван)',
    keyOf(s1.watch) === treeKey('S0', 'source'));
  s1.agent.ws.close(); s1.bc.ws.close(); s1.watch.ws.close();
  await sleep(150);

  /* ---------- Случай 2: транскод ЕСТЬ. ABR обязан ПОНИЗИТЬ (негативный контроль) ----------
     Без этого случая тест (1) проходил бы даже если ABR вовсе сломан/выключен.            */
  const s2 = await setup('S1', 2);
  ok('setup2: зритель под виртуалом', (() => { const p = api.peers.get(s2.watch.id); const par = p && api.peers.get(p.parent); return !!(par && par.virtual); })());

  await pumpBadStats(s2.agent, s2.watch, 7000);
  const k2 = keyOf(s2.watch);
  ok('(2) maxTranscodes=2: ABR ПОНИЗИЛ зрителя из ::source (тест не вакуумный — ABR жив)',
    k2 !== null && k2 !== treeKey('S1', 'source'));
  ok('(2) авто-ход НЕ породил rendition-unavailable (клиента не дёргаем)',
    s2.watch.unavailable.length === 0);
  s2.agent.ws.close(); s2.bc.ws.close(); s2.watch.ws.close();
  await sleep(150);

  clearInterval(api.abrTimer);
  server.close();
  console.log(failed ? `\n${failed} FAIL` : '\nВсе проверки ABR-регрессии зелёные');
  process.exit(failed ? 1 : 0);
}
main();
