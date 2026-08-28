// Регрессия: один кривой кадр от одного клиента ронял ВЕСЬ API.
// В wss.on('connection') не было слушателя 'error', а ws эмитит его на самом сокете
// (превышение maxPayload, битый фрейм, невалидный UTF-8). EventEmitter без слушателя
// 'error' бросает асинхронно — мимо try/catch диспетчера и мимо try{ws.send}catch, —
// и уходит в uncaughtException, по которому index.js делает process.exit(1).
// Здесь такое исключение уронило бы сам тест-процесс, поэтому проверка честная.
const assert = require('node:assert/strict');
const http = require('node:http');
const WebSocket = require('ws');
const { attachTreeServer } = require('./tree');

const open = (url) => new Promise((resolve, reject) => {
  const ws = new WebSocket(url);
  ws.on('message', (raw) => resolve({ ws, first: JSON.parse(raw.toString()) }));
  ws.on('error', reject);
});

(async () => {
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const tree = attachTreeServer(server, { verifySession: () => ({ id: 'u1' }), path: '/tree' });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
  const url = `ws://127.0.0.1:${port}/tree?token=x`;

  const a = await open(url);
  assert.equal(a.first.t, 'welcome', 'сокет должен подняться штатно');

  const closed = new Promise((resolve) => a.ws.on('close', (code) => resolve(code)));
  a.ws.on('error', () => {}); // клиентская сторона тоже увидит обрыв — нам важен сервер
  a.ws.send('x'.repeat(512 * 1024)); // вдвое больше серверного maxPayload (256 КиБ)
  // 1006 — наш обработчик 'error' делает terminate(): битый сокет освобождается сразу, не дожидаясь
  // штатного close-хендшейка (который по мёртвому пути мог бы и не завершиться). 1009 — если ws успел
  // отправить свой close-фрейм раньше. Важно ровно одно: соединение закрыто, а не унесло процесс.
  const code = await closed;
  assert.ok(code === 1006 || code === 1009, `сокет должен закрыться (получен код ${code})`);

  // Процесс жив и принимает новых клиентов — значит 'error' был обработан, а не улетел в uncaught.
  const b = await open(url);
  assert.equal(b.first.t, 'welcome', 'сервер должен пережить кривой кадр предыдущего клиента');
  b.ws.close();

  for (const t of [tree.abrTimer, tree.hbTimer, tree.drainTimer, tree.renditionTimer]) if (t) clearInterval(t);
  tree.wss.close();
  server.close();
  console.log('ok — кривой кадр закрывает только свой сокет, сервер жив');
  process.exit(0);
})().catch((e) => { console.error('ПРОВАЛ:', e && e.message); process.exit(1); });
