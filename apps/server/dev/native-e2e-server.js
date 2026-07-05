// Э5 smoke-harness: минимальный сервер дерева (без SQLite/LiveKit — index.js
// хардкодит DATA_DIR='/app/data', локально без Docker не поднимается, см.
// tree-sim.js) + раздача tree-test-viewer.html. Печатает готовые token/URL для
// нативного вещателя (apps/native/src-tauri/examples/broadcast_smoke.rs) и для
// вставки в tree-test-viewer.html в браузере.
//
// Запуск: node apps/server/dev/native-e2e-server.js [streamId] [port]

const http = require('http');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { attachTreeServer } = require('../tree');

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change';
const streamId = process.argv[2] || 'native-smoketest';
const PORT = parseInt(process.argv[3], 10) || 4001;

function token(sub) { return jwt.sign({ id: sub }, SESSION_SECRET, { expiresIn: '1h' }); }

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/dev/tree-test-viewer.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(fs.readFileSync(path.join(__dirname, 'tree-test-viewer.html')));
    return;
  }
  res.writeHead(404); res.end();
});

attachTreeServer(server, { sessionSecret: SESSION_SECRET, path: '/tree' });

server.listen(PORT, () => {
  const wsUrl = `ws://127.0.0.1:${PORT}/tree?token=${encodeURIComponent(token('native-broadcaster'))}`;
  const viewerToken = token('test-viewer');
  console.log(`[e2e] tree signaling on ws://127.0.0.1:${PORT}/tree`);
  console.log(`[e2e] streamId = ${streamId}`);
  console.log(`[e2e] --- нативный вещатель (broadcast_smoke) ---`);
  console.log(`[e2e] WS_URL="${wsUrl}"`);
  console.log(`[e2e] --- браузер-зритель ---`);
  console.log(`[e2e] open: http://127.0.0.1:${PORT}/dev/tree-test-viewer.html`);
  console.log(`[e2e] token: ${viewerToken}`);
});
