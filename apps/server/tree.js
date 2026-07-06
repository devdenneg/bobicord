// Э1/Э8 — relay-дерево: сигналинг (WS) + менеджер дерева (Evolution-TZ).
// Э1: реестр пиров по streamId, назначение parent/child, релей SDP/ICE, reparent при уходе.
// Э8: ёмкость из join (лимит вещателя), best-peer по stats (RTT/loss/выход), миграция
//     (авто по деградации + ручной выбор пира зрителем), проброс keyframe к корню для
//     passthrough-relay, рассылка топологии дерева зрителям. Реальные медиа-пиры
//     (RTCPeerConnection) — в браузере (Э2) / нативе (Э5 корень, Э8 relay-viewer).

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { turnCredentials } = require('./turnCreds');

const MAX_DEPTH = 4;          // инвариант CLAUDE.md: задержка видео <= 3с => глубина дерева <= 4
const NATIVE_CAPACITY = 4;    // дефолт для нативного relay-узла, если join не прислал maxChildren
const BROWSER_CAPACITY = 0;   // дефолт для браузера: лист (пока treeVideo не пришлёт maxChildren>0)
const MAX_CHILDREN_CAP = 8;   // жёсткий потолок на объявленную ёмкость (защита от абьюза)
const REPARENT_COOLDOWN_MS = 10_000; // гистерезис авто-миграции — не мигрировать чаще

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

  // Ёмкость узла (сколько прямых детей он держит). Симметричный NAT (Evolution-TZ Э3):
  // узел недостижим как relay-родитель для третьих сторон — всегда лист (0). Иначе —
  // объявленный узлом maxChildren (вещатель задаёт лимит прямых зрителей в UI; натив-relay
  // и браузер-relay сообщают свою ёмкость сами), с потолком MAX_CHILDREN_CAP. Fallback на
  // старые константы, если maxChildren не пришёл (обратная совместимость).
  capacityOf(node) {
    if (node.symmetricNat) return 0;
    if (typeof node.maxChildren === 'number') return Math.max(0, Math.min(node.maxChildren, MAX_CHILDREN_CAP));
    return node.native ? NATIVE_CAPACITY : BROWSER_CAPACITY;
  }

  // Все потомки узла (для запрета циклов при ручном reparent — нельзя стать ребёнком
  // собственного потомка).
  descendants(t, nodeId) {
    const out = new Set();
    const stack = [nodeId];
    while (stack.length) {
      const cur = t.nodes.get(stack.pop());
      if (!cur) continue;
      for (const cid of cur.children) { if (!out.has(cid)) { out.add(cid); stack.push(cid); } }
    }
    return out;
  }

  // Высота поддерева под узлом (0 = листа нет детей). Нужна, чтобы ручной reparent не
  // утопил чужое поддерево за MAX_DEPTH.
  subtreeHeight(t, nodeId) {
    const node = t.nodes.get(nodeId);
    if (!node || !node.children.length) return 0;
    let h = 0;
    for (const cid of node.children) h = Math.max(h, 1 + this.subtreeHeight(t, cid));
    return h;
  }

  // Скоринг кандидата в родители (меньше — лучше). Приоритеты: меньшая глубина (латентность),
  // затем меньшая загрузка и лучшее качество (больше свободного выхода, меньше loss/rtt).
  scoreParent(cand) {
    const cap = this.capacityOf(cand) || 1;
    const depthCost = cand.depth * 100;                 // мелкое дерево сильно предпочтительнее
    const loadCost = (cand.children.length / cap) * 40; // не перегружать один узел
    const outBonus = Math.min(cand.availableOutgoing || 0, 20_000_000) / 1_000_000; // Мбит выхода
    const lossCost = (cand.linkLoss || 0) * 50;         // потери на входящем линке кандидата
    const rttCost = (cand.linkRtt || 0) / 20;
    return depthCost + loadCost + lossCost + rttCost - outBonus;
  }

  // Best-peer: среди всех узлов дерева со свободной ёмкостью и depth+1 <= MAX_DEPTH выбираем
  // лучший по scoreParent. Исключаем сам узел, его поддерево (цикл) и опционально текущего
  // родителя (при миграции). Учитываем высоту поддерева переезжающего узла, чтобы не
  // превысить MAX_DEPTH ниже по ветке.
  pickParent(t, forNode, excludeParentId = null) {
    if (!t.broadcasterId || !t.nodes.get(t.broadcasterId)) return null;
    const banned = this.descendants(t, forNode.id);
    banned.add(forNode.id);
    if (excludeParentId) banned.add(excludeParentId);
    const height = this.subtreeHeight(t, forNode.id);
    let best = null, bestScore = Infinity;
    for (const cand of t.nodes.values()) {
      if (banned.has(cand.id)) continue;
      if (cand.children.length >= this.capacityOf(cand)) continue;
      if (cand.depth + 1 + height > MAX_DEPTH) continue;
      const s = this.scoreParent(cand);
      if (s < bestScore) { bestScore = s; best = cand; }
    }
    return best;
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

  // Пересчёт глубины поддерева после переезда узла (миграция меняет depth всей ветки).
  updateSubtreeDepth(t, nodeId) {
    const node = t.nodes.get(nodeId);
    if (!node) return;
    const queue = [nodeId];
    while (queue.length) {
      const cur = t.nodes.get(queue.shift());
      for (const cid of cur.children) {
        const c = t.nodes.get(cid);
        if (!c) continue;
        c.depth = cur.depth + 1;
        queue.push(cid);
      }
    }
  }

  // Миграция узла к новому родителю. targetId задан — ручной выбор зрителя (жёсткая
  // валидация); null — авто (best-peer, с гистерезисом-cooldown). Возвращает
  // {ok, oldParentId, newParentId} либо {ok:false, reason}.
  reparent(streamId, nodeId, targetId, now) {
    const t = this.trees.get(streamId);
    if (!t) return { ok: false, reason: 'no-tree' };
    const node = t.nodes.get(nodeId);
    if (!node) return { ok: false, reason: 'no-node' };
    if (nodeId === t.broadcasterId) return { ok: false, reason: 'broadcaster' };

    let target;
    if (targetId) {
      target = t.nodes.get(targetId);
      if (!target) return { ok: false, reason: 'target-gone' };
      if (targetId === node.parent) return { ok: false, reason: 'already-parent' };
      const banned = this.descendants(t, nodeId);
      if (targetId === nodeId || banned.has(targetId)) return { ok: false, reason: 'cycle' };
      if (target.children.length >= this.capacityOf(target)) return { ok: false, reason: 'full' };
      const height = this.subtreeHeight(t, nodeId);
      if (target.depth + 1 + height > MAX_DEPTH) return { ok: false, reason: 'too-deep' };
    } else {
      if (node.reparentCooldownUntil && now < node.reparentCooldownUntil) return { ok: false, reason: 'cooldown' };
      target = this.pickParent(t, node, node.parent);
      if (!target) return { ok: false, reason: 'no-candidate' };
      node.reparentCooldownUntil = now + REPARENT_COOLDOWN_MS;
    }

    const oldParentId = node.parent;
    if (oldParentId) {
      const op = t.nodes.get(oldParentId);
      if (op) op.children = op.children.filter((cid) => cid !== nodeId);
    }
    target.children.push(nodeId);
    node.parent = target.id;
    node.depth = target.depth + 1;
    this.updateSubtreeDepth(t, nodeId);
    return { ok: true, oldParentId, newParentId: target.id };
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
      this.updateSubtreeDepth(t, childId);
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

  // Снимок топологии для визуализации зрителю (Э8): узлы + связи parent->child + метрики.
  topology(streamId) {
    const t = this.trees.get(streamId);
    if (!t) return null;
    return [...t.nodes.values()].map((n) => ({
      id: n.id,
      identity: n.identity,
      parentId: n.parent,
      depth: n.depth,
      children: n.children.length,
      capacity: this.capacityOf(n),
      native: !!n.native,
      broadcaster: n.id === t.broadcasterId,
      availableOutgoing: n.availableOutgoing || 0,
      rtt: n.linkRtt || 0,
      loss: n.linkLoss || 0,
    }));
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
  const peers = new Map(); // peerId -> node {id, ws, streamId, role, native, identity, parent, children, depth, maxChildren, stats...}

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

  // Э8: полная топология дерева — зритель видит, у кого берёт стрим, и может вручную
  // выбрать другого пира (см. onRequestReparent). Шлём всем, кто на этом streamId.
  function broadcastTopology(streamId) {
    const nodes = mgr.topology(streamId);
    if (!nodes) return;
    for (const [pid, p] of peers) {
      if (p.streamId === streamId) send(pid, { t: 'tree-topology', streamId, you: pid, nodes });
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
    const { streamId, role, native, identity, symmetricNat, serverId, maxChildren } = msg;
    if (!streamId || (role !== 'broadcaster' && role !== 'viewer')) return;
    const node = peers.get(id);
    node.streamId = streamId; node.role = role; node.native = !!native; node.identity = identity || id;
    node.symmetricNat = !!symmetricNat;
    node.serverId = serverId || node.serverId || null;
    node.maxChildren = typeof maxChildren === 'number' ? maxChildren : undefined;
    node.parent = null; node.children = []; node.depth = 0;
    const { parent } = mgr.join(streamId, node);
    if (parent) {
      send(id, { t: 'assign-parent', streamId, parentId: parent.id });
      send(parent.id, { t: 'assign-child', streamId, childId: id });
    } else {
      send(id, { t: 'assign-parent', streamId, parentId: null });
    }
    broadcastTreeInfo(streamId);
    broadcastTopology(streamId);
    if (role === 'broadcaster') broadcastToServer(node.serverId, { t: 'stream-live', streamId, identity: node.identity, initial: false });
  }

  function onSignal(id, msg) {
    const p = peers.get(id);
    if (!p || !p.streamId || !msg.to) return;
    send(msg.to, { t: msg.t, streamId: p.streamId, from: id, type: msg.type, sdp: msg.sdp, candidate: msg.candidate });
  }

  // Э8: приём stats от узла — availableOutgoing его самого + rtt/loss на линках к его детям
  // (используется best-peer скорингом и решением о миграции). peers и t.nodes держат один и
  // тот же объект узла, так что пишем прямо в него.
  function onStats(id, msg) {
    const p = peers.get(id);
    if (!p) return;
    if (typeof msg.availableOutgoing === 'number') p.availableOutgoing = msg.availableOutgoing;
    if (Array.isArray(msg.toChild)) {
      for (const s of msg.toChild) {
        const c = peers.get(s.id);
        if (c) { c.linkRtt = s.rtt || 0; c.linkLoss = s.loss || 0; }
      }
    }
  }

  // Э8: узел просит миграцию. targetParentId — ручной выбор зрителя из дерева (жёсткая
  // валидация в mgr.reparent); отсутствует — авто по деградации (best-peer + cooldown).
  function onRequestReparent(id, msg) {
    const p = peers.get(id);
    if (!p || !p.streamId) return;
    const res = mgr.reparent(p.streamId, id, msg.targetParentId || null, Date.now());
    if (!res.ok) { send(id, { t: 'reparent-denied', streamId: p.streamId, reason: res.reason }); return; }
    if (res.oldParentId) send(res.oldParentId, { t: 'drop-peer', streamId: p.streamId, peerId: id });
    send(id, { t: 'assign-parent', streamId: p.streamId, parentId: res.newParentId });
    if (res.newParentId) send(res.newParentId, { t: 'assign-child', streamId: p.streamId, childId: id });
    broadcastTreeInfo(p.streamId);
    broadcastTopology(p.streamId);
  }

  // Э8: relay-узел (натив passthrough) не энкодит и сам IDR не сделает — при подключении
  // нового ребёнка просит keyframe у корня. Релеим прямо вещателю (он форсит IDR глобально).
  function onRequestKeyframe(id) {
    const p = peers.get(id);
    if (!p || !p.streamId) return;
    const t = mgr.trees.get(p.streamId);
    if (!t || !t.broadcasterId) return;
    send(t.broadcasterId, { t: 'request-keyframe', streamId: p.streamId });
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
    broadcastTopology(p.streamId);
  }

  wss.on('connection', (ws) => {
    const id = newPeerId();
    peers.set(id, {
      id, ws, streamId: null, role: null, native: false, identity: id, serverId: null,
      parent: null, children: [], depth: 0,
      maxChildren: undefined, availableOutgoing: 0, linkRtt: 0, linkLoss: 0, reparentCooldownUntil: 0,
    });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.t === 'join') onJoin(id, msg);
      else if (msg.t === 'sdp' || msg.t === 'ice') onSignal(id, msg);
      else if (msg.t === 'leave') onLeave(id);
      else if (msg.t === 'hello') onHello(id, msg);
      else if (msg.t === 'stats') onStats(id, msg);
      else if (msg.t === 'request-reparent') onRequestReparent(id, msg);
      else if (msg.t === 'request-keyframe') onRequestKeyframe(id);
    });
    ws.on('close', () => onLeave(id));
    send(id, { t: 'welcome', id, iceServers: iceServersFor(ws.__uid) });
  });

  return { mgr, peers, wss };
}

module.exports = { attachTreeServer, TreeManager, MAX_DEPTH, NATIVE_CAPACITY, BROWSER_CAPACITY };
