// Регрессия: агент vrelay подключился ПОЗЖЕ старта стрима — ingest не поднимался никогда.
//
// Наблюдалось живьём (2026-08-02, стрим penis14, два рестарта token подряд). Попытка поднять
// постоянный медиаузел делается один раз, в onJoin корня. Рестарт token рвёт все WS разом, и
// вещатель, зрители и агент возвращаются в произвольном порядке; агент — внешний хост, обычно
// последний. Корень успевал зайти раньше него, получал `фолбэк нужен, но агент vrelay не
// подключён`, и на этом всё: ретрай в onVrelayHello требовал СИРОТ (условие Э9, где vrelay был
// фолбэком), а при server-first зрители сиротами не становятся — спокойно цепляются к корню.
// Итог: стрим до конца вещания жил вообще без vrelay, все зрители висели прямыми детьми
// домашнего аплинка вещателя, [health] печатал им 1.1-6.1% потерь.
//
// Лечение: в onVrelayHello `needs` истинно для любого server-first-дерева без медиаузла.
//
// Запуск:  node vrelay-late-test.js    (exit 0 = ок, 1 = баг жив, 2 = тест не воспроизвёлся)
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
const timeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

(async () => {
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));

  // 1) Вещатель заходит ПЕРВЫМ, агента vrelay ещё нет.
  const bc = open('bob');
  const bcW = await wait(bc, 'welcome');
  bc.send(JSON.stringify({ t: 'join', streamId: 's1', role: 'broadcaster', native: true,
    serverIngest: true, maxChildren: 5, identity: 'bob', abr: true, maxBitrate: 4_500_000 }));

  // 2) Зритель заходит и садится под КОРЕНЬ — сиротой он не становится, и именно поэтому
  //    прежнее условие ретрая (по сиротам) не срабатывало.
  const v = open('vic');
  await wait(v, 'welcome');
  v.send(JSON.stringify({ t: 'join', streamId: 's1', role: 'viewer', native: true,
    maxChildren: 1, identity: 'vic' }));
  const assign = await timeout(wait(v, 'assign-parent'), 3000);
  if (!assign) { console.error('тест не воспроизвёлся: зритель не получил родителя'); process.exit(2); }
  if (assign.parentId !== bcW.id) {
    console.error(`тест не воспроизвёлся: ожидали зрителя под корнем, а он под ${assign.parentId}`);
    process.exit(2);
  }
  console.log('1) зритель сел под ВЕЩАТЕЛЯ, сирот в дереве нет');

  // 3) Агент появляется только сейчас. Дерево обязано дозапросить постоянный ingest.
  const agent = open('virtual-relay');
  await wait(agent, 'welcome');
  const ingest = wait(agent, 'vrelay-ingest');
  agent.send(JSON.stringify({ t: 'vrelay-hello', capacity: 8, maxTranscodes: 0 }));

  const got = await timeout(ingest, 5000);
  if (!got) {
    console.error('2) ПРОВАЛ: агент подключился, но vrelay-ingest не пришёл — стрим остался без медиаузла');
    process.exit(1);
  }
  if (got.streamId !== 's1') {
    console.error(`2) ПРОВАЛ: ingest пришёл на чужой стрим ${got.streamId}`);
    process.exit(1);
  }
  console.log('2) ОК: после vrelay-hello дерево дозапросило ingest для s1');
  process.exit(0);
})().catch((e) => { console.error('тест не воспроизвёлся:', e); process.exit(2); });
