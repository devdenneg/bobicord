const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const WebSocket = require('ws');
const { attachTreeServer } = require('./tree');

function startTree() {
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const tree = attachTreeServer(server, {
    verifySession: (token) => ({ id: token === 'u2' ? 'u2' : 'u1', u: token === 'u2' ? 'bob' : 'alice' }),
    authorizePeer: (uid, params) => uid === 'u1' && params.serverId === 'srv-a'
      && (params.role === 'discovery' || String(params.identity || '').split('#', 1)[0] === 'alice'),
    path: '/tree',
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, tree, url: `ws://127.0.0.1:${server.address().port}/tree` })));
}

function open(url, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}?token=${token}`);
    const messages = [];
    ws.on('message', (raw) => { messages.push(JSON.parse(raw.toString())); resolve({ ws, messages }); });
    ws.on('error', reject);
  });
}

function waitForMessage(ws, predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('tree message timeout')); }, timeoutMs);
    const onMessage = (raw) => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const cleanup = () => { clearTimeout(timer); ws.off('message', onMessage); };
    ws.on('message', onMessage);
  });
}

function closeTree(ctx) {
  for (const peer of ctx.tree.peers.values()) { try { peer.ws.terminate(); } catch { /**/ } }
  for (const t of [ctx.tree.abrTimer, ctx.tree.hbTimer, ctx.tree.drainTimer, ctx.tree.renditionTimer]) if (t) clearInterval(t);
  ctx.tree.wss.close();
  return new Promise((resolve) => ctx.server.close(resolve));
}

test('tree rejects unknown server membership and mismatched identity', async () => {
  const ctx = await startTree();
  try {
    const badServer = await open(ctx.url, 'u1');
    const badClose = new Promise((resolve) => badServer.ws.once('close', resolve));
    badServer.ws.send(JSON.stringify({ t: 'hello', serverId: 'srv-b' }));
    assert.equal(await badClose, 4003);

    const badIdentity = await open(ctx.url, 'u1');
    const identityClose = new Promise((resolve) => badIdentity.ws.once('close', resolve));
    badIdentity.ws.send(JSON.stringify({ t: 'join', serverId: 'srv-a', streamId: 'alice', role: 'viewer', identity: 'bob' }));
    assert.equal(await identityClose, 4003);
  } finally {
    await closeTree(ctx);
  }
});

test('discovery hello receives an application liveness acknowledgement', async () => {
  const ctx = await startTree();
  try {
    const discovery = await open(ctx.url, 'u1');
    const acknowledged = waitForMessage(discovery.ws, (message) => message.t === 'hello-ack');
    discovery.ws.send(JSON.stringify({ t: 'hello', serverId: 'srv-a' }));
    assert.deepEqual(await acknowledged, { t: 'hello-ack', serverId: 'srv-a' });
  } finally {
    await closeTree(ctx);
  }
});

test('second broadcaster cannot replace the existing tree root', async () => {
  const ctx = await startTree();
  try {
    const first = await open(ctx.url, 'u1');
    first.ws.send(JSON.stringify({ t: 'join', serverId: 'srv-a', streamId: 'stream', role: 'broadcaster', identity: 'alice' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await open(ctx.url, 'u1');
    const secondClose = new Promise((resolve) => second.ws.once('close', resolve));
    second.ws.send(JSON.stringify({ t: 'join', serverId: 'srv-a', streamId: 'stream', role: 'broadcaster', identity: 'alice#other' }));
    assert.equal(await secondClose, 4009);
    assert.equal(ctx.tree.mgr.trees.get('stream::source').broadcasterId, first.messages[0].id);
  } finally {
    await closeTree(ctx);
  }
});
