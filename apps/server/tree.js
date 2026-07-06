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

// Э8 ABR: сервер держит целевой битрейт дерева и шлёт его корню (set-bitrate). Управление —
// loss/RTT-based AIMD по худшему линку дерева (истинный GCC-BWE в webrtc-rs незрел). Единый
// passthrough-энкод: один медленный зритель тянет всех вниз — это компромисс, лечится репарентом.
const ABR_FLOOR = 800_000;         // нижняя полка (совпадает с BITRATE_FLOOR в натив mod.rs)
const ABR_DEFAULT_MAX = 6_000_000; // если вещатель не прислал maxBitrate (старый клиент)
const ABR_TICK_MS = 2_000;         // темп пересчёта (совпадает со stats-тиком узлов)
const ABR_LOSS_HI = 0.10;          // худший линк >10% потерь → быстрый спад
const ABR_LOSS_LO = 0.02;          // <2% потерь и низкий RTT → медленная проба вверх
const ABR_RTT_HI = 600;            // мс — порог деградации по задержке
const ABR_RTT_LO = 300;            // мс — «здоровый» RTT для подъёма
const ABR_DOWN = 0.9;              // мультипликативное снижение (мягче прежних 0.85)
const ABR_HYSTERESIS = 0.05;       // не слать корню, пока изменение цели <5%
const ABR_EWMA = 0.4;              // вес свежего сэмпла в сглаживании loss/rtt (0.4 новое + 0.6 старое)
const ABR_BAD_TICKS = 2;           // снижаем битрейт только после N подряд плохих тиков (не по одному всплеску)

function newPeerId() { return 'p_' + crypto.randomBytes(6).toString('hex'); }

class Tree {
  constructor(streamId) { this.streamId = streamId; this.nodes = new Map(); this.broadcasterId = null; }
}

class TreeManager {
  // turnEnabled: с TURN симметричный NAT НЕ рубит relay-ёмкость (обе стороны берут
  // relay-кандидаты, узел достижим как offerer). Без TURN — симметричный узел лист.
  constructor(turnEnabled = false) { this.trees = new Map(); this.turnEnabled = turnEnabled; }

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
    if (node.symmetricNat && !this.turnEnabled) return 0; // без TURN симметричный = лист
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
    // Симметричный NAT как РОДИТЕЛЬ = offerer через TURN-relay: работает только при живом TURN,
    // выше задержка (двойной relay), хрупко. Штраф > стоимости уровня (250 > depth*100), чтобы
    // не-симметричный узел даже на уровень глубже предпочитался — симметричный берём в родители
    // лишь когда другого relay нет вовсе (тогда capacityOf уже гарантировал наличие TURN).
    const natCost = cand.symmetricNat ? 250 : 0;
    return depthCost + loadCost + lossCost + rttCost + natCost - outBonus;
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
      t.targetBitrate = null; t.lastSentBitrate = 0; // сброс ABR под нового вещателя
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

  // Сироты: зрители, джойнившиеся когда свободного родителя не было (pickParent -> null,
  // parent=null, не вещатель) — раньше висели навсегда, т.к. leave() репарентит только детей
  // ушедшего, а не глобальных сирот. Вызывается после join/leave/reparent (ёмкость могла
  // появиться). Многопроходно: разместив relay-способного сироту, он сам даёт слот следующему
  // — так дерево ветвится (кейс лимита прямых=1, где 2-й зритель обязан идти через 1-го).
  // Возвращает [{node, parentId}] для рассылки assign-parent/assign-child.
  placeOrphans(streamId) {
    const t = this.trees.get(streamId);
    if (!t || !t.broadcasterId) return [];
    const placed = [];
    let progress = true;
    while (progress) {
      progress = false;
      for (const node of t.nodes.values()) {
        if (node.id === t.broadcasterId || node.parent) continue;
        const parent = this.pickParent(t, node);
        if (!parent) continue;
        node.parent = parent.id;
        node.depth = parent.depth + 1;
        parent.children.push(node.id);
        placed.push({ node, parentId: parent.id });
        progress = true;
      }
    }
    return placed;
  }

  // Э8 ABR: пересчёт целевого битрейта дерева по худшему линку (loss/RTT-based AIMD).
  // Каждый линк покрыт stats-репортом его родителя (broadcaster→прямые дети, relay→дети),
  // так что скан linkLoss/linkRtt по всем узлам видит все линки. Возвращает
  // {broadcasterId, bitrate}, если цель сменилась заметно (гистерезис), иначе null.
  abrTick(streamId) {
    const t = this.trees.get(streamId);
    if (!t || !t.broadcasterId) return null;
    const bc = t.nodes.get(t.broadcasterId);
    if (!bc || !bc.abr) return null; // авто-адаптация выключена вещателем → статичный битрейт
    const ceil = bc.maxBitrate > 0 ? bc.maxBitrate : ABR_DEFAULT_MAX;
    if (t.targetBitrate == null) t.targetBitrate = ceil; // старт оптимистично с потолка
    let worstLoss = 0, worstRtt = 0;
    for (const n of t.nodes.values()) {
      if ((n.linkLoss || 0) > worstLoss) worstLoss = n.linkLoss;
      if ((n.linkRtt || 0) > worstRtt) worstRtt = n.linkRtt;
    }
    let target = t.targetBitrate;
    if (worstLoss > ABR_LOSS_HI || worstRtt > ABR_RTT_HI) {
      // Снижаем не по одному плохому тику, а после ABR_BAD_TICKS подряд — иначе редкий
      // всплеск потерь дёргал бы битрейт всему дереву (пилообразное качество).
      t.badTicks = (t.badTicks || 0) + 1;
      if (t.badTicks >= ABR_BAD_TICKS) target = Math.max(ABR_FLOOR, Math.floor(target * ABR_DOWN));
    } else {
      t.badTicks = 0;
      if (worstLoss < ABR_LOSS_LO && worstRtt < ABR_RTT_LO) {
        target = Math.min(ceil, target + Math.max(500_000, Math.floor(target * 0.08))); // проба вверх
      }
    }
    t.targetBitrate = target;
    const last = t.lastSentBitrate || 0;
    if (last === 0 || Math.abs(target - last) / last > ABR_HYSTERESIS) {
      t.lastSentBitrate = target;
      return { broadcasterId: t.broadcasterId, bitrate: target };
    }
    return null;
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
  const mgr = new TreeManager(!!(turnSecret && turnUrls.length));
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

  // Размещает зависших сирот (см. mgr.placeOrphans) и рассылает им assign-parent, их новым
  // родителям — assign-child. Дёргается после каждого изменения топологии, где могла
  // появиться ёмкость (новый узел вошёл, кто-то ушёл/переехал).
  function settleOrphans(streamId) {
    const placed = mgr.placeOrphans(streamId);
    for (const { node, parentId } of placed) {
      send(node.id, { t: 'assign-parent', streamId, parentId });
      send(parentId, { t: 'assign-child', streamId, childId: node.id });
    }
    if (placed.length) { broadcastTreeInfo(streamId); broadcastTopology(streamId); }
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
    const { streamId, role, native, identity, symmetricNat, serverId, maxChildren, maxBitrate, abr } = msg;
    if (!streamId || (role !== 'broadcaster' && role !== 'viewer')) return;
    const node = peers.get(id);
    node.streamId = streamId; node.role = role; node.native = !!native; node.identity = identity || id;
    node.symmetricNat = !!symmetricNat;
    node.serverId = serverId || node.serverId || null;
    node.maxChildren = typeof maxChildren === 'number' ? maxChildren : undefined;
    node.maxBitrate = typeof maxBitrate === 'number' ? maxBitrate : 0; // Э8 ABR: потолок вещателя
    node.abr = !!abr;                                                  // Э8 ABR: авто-адаптация вкл
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
    // Новый узел мог дать ёмкость (relay-способный зритель) или это вернувшийся вещатель —
    // размещаем зависших сирот. Для вещателя это подхватывает зрителей, ждавших стрим.
    settleOrphans(streamId);
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
        if (c) {
          // EWMA-сглаживание: RTCP RR даёт мгновенный fraction_lost — один всплеск потерь
          // раньше сразу ронял битрейт всему дереву. Сглаживаем, чтобы реагировать на тренд.
          c.linkRtt = (c.linkRtt || 0) * (1 - ABR_EWMA) + (s.rtt || 0) * ABR_EWMA;
          c.linkLoss = (c.linkLoss || 0) * (1 - ABR_EWMA) + (s.loss || 0) * ABR_EWMA;
        }
      }
    }
  }

  // Э8: узел просит миграцию. targetParentId — ручной выбор зрителя из дерева (жёсткая
  // валидация в mgr.reparent); отсутствует — авто по деградации (best-peer + cooldown).
  function onRequestReparent(id, msg) {
    const p = peers.get(id);
    if (!p || !p.streamId) return;
    const now = Date.now();
    const res = mgr.reparent(p.streamId, id, msg.targetParentId || null, now);
    if (!res.ok) {
      // Реаттач к тому же родителю. Кейс «корень + единственный зритель»: pickParent
      // исключает текущего родителя, других кандидатов нет → no-candidate, и зритель с
      // упавшим ICE (при живом WS) фризил бы навсегда. Пересоздаём PC с тем же родителем
      // (drop-peer родителю -> assign-parent узлу -> assign-child родителю) — это свежий
      // PC = фактический ICE-restart (мы answerer, restart_ice сами инициировать не можем).
      // Топология не меняется. Cooldown как у обычной миграции — против спама.
      if (!msg.targetParentId && res.reason === 'no-candidate' && p.parent) {
        const t = mgr.trees.get(p.streamId);
        const parent = t && t.nodes.get(p.parent);
        if (parent && (!p.reparentCooldownUntil || now >= p.reparentCooldownUntil)) {
          p.reparentCooldownUntil = now + REPARENT_COOLDOWN_MS;
          send(p.parent, { t: 'drop-peer', streamId: p.streamId, peerId: id });      // родитель закрывает старый child-PC
          send(id, { t: 'assign-parent', streamId: p.streamId, parentId: p.parent }); // узел сбрасывает upstream, ждёт offer
          send(p.parent, { t: 'assign-child', streamId: p.streamId, childId: id });   // родитель поднимает свежий PC + offer
          return;
        }
      }
      send(id, { t: 'reparent-denied', streamId: p.streamId, reason: res.reason }); return;
    }
    if (res.oldParentId) send(res.oldParentId, { t: 'drop-peer', streamId: p.streamId, peerId: id });
    send(id, { t: 'assign-parent', streamId: p.streamId, parentId: res.newParentId });
    if (res.newParentId) send(res.newParentId, { t: 'assign-child', streamId: p.streamId, childId: id });
    broadcastTreeInfo(p.streamId);
    broadcastTopology(p.streamId);
    settleOrphans(p.streamId); // ручная миграция могла освободить слот — подхватываем сирот
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
    settleOrphans(p.streamId); // ушедший освободил ёмкость — подхватываем сирот
  }

  wss.on('connection', (ws) => {
    const id = newPeerId();
    // Heartbeat: помечаем живым, pong сбрасывает флаг. Мёртвый (полуоткрытый TCP —
    // мобильный NAT, засыпание) иначе висел бы до ОС-таймаута минутами, а всё поддерево
    // под мёртвым relay — без drop-peer/reparent.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    peers.set(id, {
      id, ws, streamId: null, role: null, native: false, identity: id, serverId: null,
      parent: null, children: [], depth: 0,
      maxChildren: undefined, maxBitrate: 0, abr: false, availableOutgoing: 0, linkRtt: 0, linkLoss: 0, reparentCooldownUntil: 0,
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

  // Э8 ABR: раз в тик пересчитываем целевой битрейт каждого дерева и шлём корню, если сменился.
  const abrTimer = setInterval(() => {
    for (const streamId of mgr.trees.keys()) {
      const cmd = mgr.abrTick(streamId);
      if (cmd) send(cmd.broadcasterId, { t: 'set-bitrate', streamId, bps: cmd.bitrate });
    }
  }, ABR_TICK_MS);
  abrTimer.unref?.(); // не держим процесс живым только ради ABR-тика

  // Heartbeat-пинг: непришедший pong за один интервал (~HEARTBEAT_MS) => terminate =>
  // ws 'close' => onLeave репарентит поддерево. Браузерный WebSocket и tokio-tungstenite
  // отвечают pong автоматически — клиентских правок не нужно. Пингуем и discovery-сокеты.
  const HEARTBEAT_MS = 10_000;
  const hbTimer = setInterval(() => {
    for (const [, p] of peers) {
      const ws = p.ws;
      if (!ws || ws.readyState !== ws.OPEN) continue;
      if (ws.isAlive === false) { try { ws.terminate(); } catch { /**/ } continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch { /**/ }
    }
  }, HEARTBEAT_MS);
  hbTimer.unref?.();

  return { mgr, peers, wss, abrTimer, hbTimer };
}

module.exports = { attachTreeServer, TreeManager, MAX_DEPTH, NATIVE_CAPACITY, BROWSER_CAPACITY };
