// Регрессия: орбита «корень <-> vrelay».
//
// Наблюдалось живьём (2026-07-10): вещатель с maxChildren=5 (слайдер «прямых подключений»),
// зритель садится под vrelay, затем клиент просит смену родителя — pickParent исключает
// текущего родителя, единственный оставшийся кандидат корень (глубина 0, слоты свободны),
// зритель уезжает на домашний аплинк вещателя. Тот не тянет вторую копию потока, потери 18%,
// frameDropReparent уводит зрителя обратно на vrelay, потери исчезают, клиент снова просит
// смену — и по кругу. У зрителя это выглядело как «лагает»: 7 watch-сессий за 2 минуты.
//
// Лечение: узел помнит забракованного родителя (badParents, BAD_PARENT_TTL_MS), pickParent
// его пропускает. Смягчение карантина — только для сироты (иначе «запасным» окажется как раз
// забракованный, и орбита восстановится).
//
// Запуск:  node tree-flap-test.js     (exit 0 = ок, 1 = орбита жива, 2 = тест не воспроизвёлся)
const http = require('http');
const jwt = require('jsonwebtoken');
const WebSocket = require('ws');
const { attachTreeServer } = require('./tree.js');

const SECRET = 'test-secret';
const srv = http.createServer();
attachTreeServer(srv, { sessionSecret: SECRET, path: '/tree' });

const tok = (id) => jwt.sign({ id }, SECRET, { expiresIn: 300 });
const open = (id) => new WebSocket(`ws://127.0.0.1:${srv.address().port}/tree?token=${tok(id)}`);
const wait = (ws, t) => new Promise((res) => ws.on('message', function h(d) {
  const m = JSON.parse(d); if (m.t === t) { ws.off('message', h); res(m); }
}));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));

  const agent = open('virtual-relay');
  await wait(agent, 'welcome');
  agent.send(JSON.stringify({ t: 'vrelay-hello', capacity: 8, maxTranscodes: 0 }));
  const ingest = wait(agent, 'vrelay-ingest');

  const bc = open('bob');
  const bcW = await wait(bc, 'welcome');
  bc.send(JSON.stringify({ t: 'join', streamId: 's1', role: 'broadcaster', native: true,
    serverIngest: true, maxChildren: 5, identity: 'bob', abr: true, maxBitrate: 4_500_000 }));
  await ingest;

  const vr = open('virtual-relay');
  const vrW = await wait(vr, 'welcome');
  vr.send(JSON.stringify({ t: 'join', streamId: 's1', role: 'viewer', native: true,
    virtual: true, maxChildren: 8, identity: 'server' }));
  await wait(vr, 'assign-parent');

  const v = open('vic');
  const vW = await wait(v, 'welcome');
  v.send(JSON.stringify({ t: 'join', streamId: 's1', role: 'viewer', native: true,
    maxChildren: 1, identity: 'vic' }));
  let cur = (await wait(v, 'assign-parent')).parentId;
  const name = (id) => (id === bcW.id ? 'ВЕЩАТЕЛЬ' : id === vrW.id ? 'vrelay' : id);
  console.log('1) при join зритель сел под:', name(cur));

  // assign-parent прилетает асинхронно (frameDropReparent на abr-тике) — разовый wait() теряет
  // сообщение, если подписаться после факта. Держим постоянный слушатель.
  const seen = [];
  let denied = null;
  v.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.t === 'assign-parent') { cur = m.parentId; seen.push(m.parentId); }
    if (m.t === 'reparent-denied') denied = m.reason;
  });
  const until = async (pred, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(250); } return false; };

  await sleep(15_500); // DRAIN_COOLDOWN_MS: свежепосаженного под виртуала не дёргают
  v.send(JSON.stringify({ t: 'request-reparent', streamId: 's1' }));
  await until(() => cur === bcW.id, 5000);
  console.log('2) после request-reparent:', name(cur));
  if (cur !== bcW.id) { console.log('   переезд на корень не воспроизвёлся — тест бессмыслен'); process.exit(2); }

  const badStats = () => bc.send(JSON.stringify({ t: 'stats', streamId: 's1', availableOutgoing: 5_000_000,
    toChild: [{ id: vW.id, loss: 0.30, rtt: 90, bitrate: 4_500_000 }] }));
  for (let i = 0; i < 8 && cur !== vrW.id; i++) { badStats(); await sleep(2100); }
  console.log('3) после отбраковки по потерям:', name(cur));
  if (cur !== vrW.id) { console.log('   frameDropReparent не увёл на vrelay'); process.exit(1); }

  await sleep(11_000); // REPARENT_COOLDOWN_MS — иначе запрос отобьётся по cooldown, карантин не проверится
  const before = seen.length; denied = null;
  v.send(JSON.stringify({ t: 'request-reparent', streamId: 's1' }));
  await until(() => seen.length > before || denied, 6000);

  const landed = seen.length > before ? seen[seen.length - 1] : null;
  if (landed === bcW.id) { console.log('\n4) ✘ вернулся на ВЕЩАТЕЛЯ — орбита жива'); process.exit(1); }
  console.log('\n4) ✔ на корень не вернулся:',
    landed ? 'остался/уехал на ' + name(landed) : denied ? 'reparent-denied (' + denied + ')' : 'сервер не двинул узел');
  process.exit(0);
})().catch((e) => { console.error('ОШИБКА:', e.message); process.exit(2); });
