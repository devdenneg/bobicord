// Э1 — relay-дерево: сигналинг (WS) + менеджер дерева (Evolution-TZ).
// Только СИГНАЛИНГ: реестр пиров по streamId, назначение parent/child, релей SDP/ICE,
// ребаланс (reparent) при уходе узла. Реальные медиа-пиры (RTCPeerConnection) подключаются
// в Э2 (браузер-лист) / Э5 (нативный вещатель-корень) — этот файл их не создаёт.

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { turnCredentials } = require('./turnCreds');

const MAX_DEPTH = 4;          // инвариант CLAUDE.md: задержка видео <= 3с => глубина дерева <= 4
const NATIVE_CAPACITY = 4;    // сколько детей держит нативный (нужен ретранслирующий) узел
const BROWSER_CAPACITY = 0;   // браузер — всегда лист (инвариант 3), не ретранслирует

function newPeerId() { return 'p_' + crypto.randomBytes(6).toString('hex'); }

class Tree {
  constructor(streamId) { this.streamId = streamId; this.nodes = new Map(); this.broadcasterId = null; }
}

class TreeManager {
  constructor() { this.trees = new Map(); }

  tree(streamId) {
    let t = this.trees.get(streamId);
    if (!t) { t = new Tree(streamId); this.trees.set(streamId, t); }
    return t;
  }

  // Вещатель — это тоже нативный узел (браузер не вещает, инвариант 2), поэтому его
  // ёмкость такая же, как у любого нативного ретранслятора — иначе все зрители
  // цепляются прямо к корню и дерево никогда не ветвится.
  // Симметричный NAT (Evolution-TZ Э3): узел за ним недостижим как relay-родитель для
  // третьих сторон, даже если он нативный — всегда лист, capacity 0.
  capacityOf(node) {
    if (node.symmetricNat) return 0;
    return node.native ? NATIVE_CAPACITY : BROWSER_CAPACITY;
  }

  // BFS от вещателя — ближайший узел со свободной ёмкостью и depth+1 <= MAX_DEPTH.
  // Симметричный NAT/браузер (native:false) никогда не выбираются как родитель (capacity 0).
  pickParent(t, forNode) {
    if (!t.broadcasterId) return null;
    const root = t.nodes.get(t.broadcasterId);
    if (!root) return null;
    const queue = [root];
    const seen = new Set([root.id]);
    while (queue.length) {
      const cur = queue.shift();
      if (cur.id !== forNode.id && cur.children.length < this.capacityOf(cur) && cur.depth + 1 <= MAX_DEPTH) return cur;
      for (const cid of cur.children) {
        const c = t.nodes.get(cid);
        if (c && !seen.has(cid)) { seen.add(cid); queue.push(c); }
      }
    }
    return null;
  }

  join(streamId, node) {
    const t = this.tree(streamId);
    t.nodes.set(node.id, node);
    if (node.role === 'broadcaster') {
      t.broadcasterId = node.id;
      node.parent = null; node.depth = 0;
      return { parent: null };
    }
    const parent = this.pickParent(t, node);
    node.parent = parent ? parent.id : null;
    node.depth = parent ? parent.depth + 1 : 0;
    if (parent) parent.children.push(node.id);
    return { parent };
  }

  leave(streamId, nodeId) {
    const t = this.trees.get(streamId);
    if (!t) return { reparented: [], dropped: [], broadcasterLost: false };
    const node = t.nodes.get(nodeId);
    if (!node) return { reparented: [], dropped: [], broadcasterLost: false };
    t.nodes.delete(nodeId);
    if (node.parent) {
      const p = t.nodes.get(node.parent);
      if (p) p.children = p.children.filter((id) => id !== nodeId);
    }
    if (nodeId === t.broadcasterId) {
      // вещатель ушёл — дерево обрушено целиком, зрители получат drop-peer и переджойнятся
      const dropped = [...t.nodes.keys()];
      t.nodes.clear();
      t.broadcasterId = null;
      return { reparented: [], dropped, broadcasterLost: true };
    }
    const reparented = [];
    for (const childId of [...node.children]) {
      const child = t.nodes.get(childId);
      if (!child) continue;
      const parent = this.pickParent(t, child);
      child.parent = parent ? parent.id : null;
      child.depth = parent ? parent.depth + 1 : 0;
      if (parent) parent.children.push(childId);
      reparented.push(child);
    }
    if (t.nodes.size === 0) this.trees.delete(streamId);
    return { reparented, dropped: [], broadcasterLost: false };
  }

  maxDepth(t) { let m = 0; t.nodes.forEach((n) => { if (n.depth > m) m = n.depth; }); return m; }
  info(streamId) {
    const t = this.trees.get(streamId);
    if (!t) return null;
    return { depth: this.maxDepth(t), size: t.nodes.size };
  }
}

/**
 * Вешает WS-сигналинг дерева на существующий http.Server (тот же порт, что и Express API).
 * Аутентификация — тот же session-JWT, что и REST (?token=... в query, т.к. браузерный
 * WebSocket API не даёт слать кастомные заголовки на handshake).
 */
function attachTreeServer(httpServer, opts) {
  const {
    sessionSecret,
    path: wsPath = '/tree',
    stunServers = [{ urls: 'stun:stun.l.google.com:19302' }],
    turnSecret = '',           // Evolution-TZ Э3: пусто = TURN отключён (только STUN, как раньше)
    turnUrls = [],             // ['turn:host:3478', 'turn:host:3478?transport=tcp']
    turnTtlSec = 600,          // короткий TTL временных TURN-креды
  } = opts;

  const wss = new WebSocketServer({ noServer: true });
  const mgr = new TreeManager();
  const peers = new Map(); // peerId -> node {id, ws, streamId, role, native, identity, parent, children, depth}

  // Временные TURN-креды выдаются только авторизованным (Evolution-TZ Э3 AC) — привязаны
  // к id из уже проверенного session-JWT, генерятся заново на каждое ws-подключение.
  function iceServersFor(uid) {
    if (!turnSecret || !turnUrls.length) return stunServers;
    const { username, credential } = turnCredentials(turnSecret, uid, turnTtlSec);
    return [...stunServers, ...turnUrls.map((urls) => ({ urls, username, credential }))];
  }

  httpServer.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://internal'); } catch { socket.destroy(); return; }
    if (url.pathname !== wsPath) return; // не наш путь — оставляем другим upgrade-хендлерам
    const token = url.searchParams.get('token') || '';
    let payload;
    try { payload = jwt.verify(token, sessionSecret); }
    catch { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.__uid = payload.id || payload.u || 'anon';
      wss.emit('connection', ws, req);
    });
  });

  function send(peerId, obj) {
    const p = peers.get(peerId);
    if (p && p.ws.readyState === p.ws.OPEN) { try { p.ws.send(JSON.stringify(obj)); } catch { /**/ } }
  }

  // Э2: lightweight discovery — lets a browser show a "live" badge / watch button for a
  // stream it hasn't joined yet. Scoped per server (гильдия), не глобально: иначе зритель
  // в сервере A видел бы badge/мог смотреть стрим из сервера B, о котором вообще не должен
  // знать (streamId = identity вещателя, никак не привязан к серверу сам по себе).
  function broadcastToServer(serverId, obj) {
    for (const [pid, p] of peers) if (p.serverId === serverId) send(pid, obj);
  }

  function broadcastTreeInfo(streamId) {
    const info = mgr.info(streamId);
    if (!info) return;
    for (const [pid, p] of peers) {
      if (p.streamId === streamId) {
        send(pid, { t: 'tree-info', streamId, depth: info.depth, myDepth: p.depth, children: p.children.length, health: 'ok' });
      }
    }
  }

  // Discovery-сокет (браузер/натив, никогда не joins) сообщает свой сервер здесь —
  // до этого сообщения бэклог живых стримов не шлём (см. wss.on('connection')).
  function onHello(id, msg) {
    const node = peers.get(id);
    if (!node) return;
    node.serverId = msg.serverId || null;
    for (const [sid, t] of mgr.trees) {
      if (!t.broadcasterId) continue;
      const bnode = t.nodes.get(t.broadcasterId);
      if (bnode && bnode.serverId === node.serverId) send(id, { t: 'stream-live', streamId: sid, identity: bnode.identity, initial: true });
    }
  }

  function onJoin(id, msg) {
    const { streamId, role, native, identity, symmetricNat, serverId } = msg;
    if (!streamId || (role !== 'broadcaster' && role !== 'viewer')) return;
    const node = peers.get(id);
    node.streamId = streamId; node.role = role; node.native = !!native; node.identity = identity || id;
    node.symmetricNat = !!symmetricNat;
    node.serverId = serverId || node.serverId || null;
    node.parent = null; node.children = []; node.depth = 0;
    const { parent } = mgr.join(streamId, node);
    if (parent) {
      send(id, { t: 'assign-parent', streamId, parentId: parent.id });
      send(parent.id, { t: 'assign-child', streamId, childId: id });
    } else {
      send(id, { t: 'assign-parent', streamId, parentId: null });
    }
    broadcastTreeInfo(streamId);
    if (role === 'broadcaster') broadcastToServer(node.serverId, { t: 'stream-live', streamId, identity: node.identity, initial: false });
  }

  function onSignal(id, msg) {
    const p = peers.get(id);
    if (!p || !p.streamId || !msg.to) return;
    send(msg.to, { t: msg.t, streamId: p.streamId, from: id, type: msg.type, sdp: msg.sdp, candidate: msg.candidate });
  }

  function onLeave(id) {
    const p = peers.get(id);
    if (!p || !p.streamId) { peers.delete(id); return; }
    peers.delete(id);
    const oldParentId = p.parent;
    const { reparented, dropped, broadcasterLost } = mgr.leave(p.streamId, id);
    if (broadcasterLost) {
      dropped.forEach((peerId) => send(peerId, { t: 'drop-peer', streamId: p.streamId, peerId: id }));
      broadcastToServer(p.serverId, { t: 'stream-end', streamId: p.streamId, identity: p.identity });
      return;
    }
    if (oldParentId) send(oldParentId, { t: 'drop-peer', streamId: p.streamId, peerId: id });
    reparented.forEach((child) => {
      send(child.id, { t: 'assign-parent', streamId: p.streamId, parentId: child.parent });
      if (child.parent) send(child.parent, { t: 'assign-child', streamId: p.streamId, childId: child.id });
    });
    broadcastTreeInfo(p.streamId);
  }

  wss.on('connection', (ws) => {
    const id = newPeerId();
    peers.set(id, { id, ws, streamId: null, role: null, native: false, identity: id, serverId: null, parent: null, children: [], depth: 0 });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'join') onJoin(id, msg);
      else if (msg.t === 'sdp' || msg.t === 'ice') onSignal(id, msg);
      else if (msg.t === 'leave') onLeave(id);
      else if (msg.t === 'hello') onHello(id, msg);
      // msg.t === 'stats' — Э1: принимаем и игнорируем; BWE-ребаланс это Э8
    });
    ws.on('close', () => onLeave(id));
    send(id, { t: 'welcome', id, iceServers: iceServersFor(ws.__uid) });
  });

  return { mgr, peers, wss };
}

module.exports = { attachTreeServer, TreeManager, MAX_DEPTH, NATIVE_CAPACITY, BROWSER_CAPACITY };
