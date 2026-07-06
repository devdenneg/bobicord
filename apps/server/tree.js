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
const MAX_CHILDREN_CAP = 10;  // жёсткий потолок на объявленную ёмкость (защита от абьюза; = максимум слайдера в UI)
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
const ABR_LOSS_CRIT = 0.25;        // >25% потерь — обвал линка: режем сразу и сильнее, без ожидания BAD_TICKS
const ABR_DOWN_CRIT = 0.6;         // множитель аварийного снижения
const STATS_TTL_MS = 10_000;       // linkLoss/linkRtt старше — считаем неизвестными (родитель перестал слать
                                   // stats: умер/мигрировал) — иначе застрявший «плохой» сэмпл давил битрейт вечно
const KF_FORWARD_MIN_MS = 1000;    // rate-limit проброса request-keyframe к корню на ДЕРЕВО: IDR дорог
                                   // (100-300КБ спайк всем зрителям), N relay-узлов иначе суммируются

// Э9 — виртуальный серверный fallback-relay (vrelay): headless-агент на VPS, джойнится в
// дерево как viewer с ёмкостью и passthrough-ретранслирует. Строго фолбэк: живые пиры
// всегда предпочитаются (VIRTUAL_COST), активация только когда сироты без кандидатов
// (или зритель явно попросил «через сервер»), дренаж уводит детей на живые пиры.
const VIRTUAL_COST = 1000;         // штраф виртуала в scoreParent: потолок score живого кандидата
                                   // ~740 (depth<=300 + natCost 250 + load 40 + loss 50 + rtt ~100),
                                   // 1000 гарантирует проигрыш ЛЮБОМУ живому relay, но виртуал
                                   // остаётся единственным кандидатом, когда живых нет
const VIRTUAL_CHILDREN_CAP = 16;   // кап ёмкости виртуала (датацентр — выше пользовательского MAX_CHILDREN_CAP)
const DRAIN_TICK_MS = 5000;        // темп дренажа детей виртуала на живые пиры
const DRAIN_COOLDOWN_MS = 15_000;  // гистерезис: свежепосаженного под виртуала не дёргаем сразу
const VRELAY_ACTIVATE_TIMEOUT_MS = 15_000; // активация «в полёте»: не слать повторный activate, пока не истёк
const VRELAY_UID = 'virtual-relay'; // JWT-uid агента: флагу virtual в join верим только при нём
const VRELAY_TARGET = 'vrelay';    // сентинел targetParentId в request-reparent = «хочу через сервер»

function newPeerId() { return 'p_' + crypto.randomBytes(6).toString('hex'); }

// Лог жизненного цикла дерева (join/leave/reparent/heartbeat/ABR/vrelay) в stdout →
// docker compose logs token. Объём низкий (только события топологии, не stats/ice) —
// всегда включён: прод-обрывы иначе недиагностируемы (раньше тут не было НИ ОДНОЙ строки).
function tlog(msg) { console.log(`[tree] ${msg}`); }

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
    // Э9: виртуал — серверный процесс без NAT, кап у него свой (выше пользовательского).
    if (node.virtual) return Math.max(0, Math.min(typeof node.maxChildren === 'number' ? node.maxChildren : 8, VIRTUAL_CHILDREN_CAP));
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

  // Узел связан с корнем (цепочка parent доводит до вещателя)? Сироты (parent=null) и
  // повисшие цепочки НЕ годятся в родители: depth у них 0 и скоринг считал бы их лучшими,
  // а зритель под ними не получил бы медиа (нет upstream к корню). Особенно бьёт по Э9:
  // виртуал, вошедший в забитое дерево, сам сирота — без этой проверки placeOrphans
  // сажал под него зрителей в никуда.
  attachedToRoot(t, node) {
    let cur = node, hops = 0;
    while (cur && hops++ <= t.nodes.size) {
      if (cur.id === t.broadcasterId) return true;
      cur = cur.parent ? t.nodes.get(cur.parent) : null;
    }
    return false;
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
    // Э9: виртуал (серверный fallback) проигрывает любому живому relay — см. VIRTUAL_COST.
    const virtualCost = cand.virtual ? VIRTUAL_COST : 0;
    return depthCost + loadCost + lossCost + rttCost + natCost + virtualCost - outBonus;
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
      if (!this.attachedToRoot(t, cand)) continue; // сирота/повисшая цепочка — не родитель
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
      if (!this.attachedToRoot(t, target)) return { ok: false, reason: 'target-detached' }; // сирота — медиа не течёт
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
    const now = Date.now();
    let worstLoss = 0, worstRtt = 0;
    for (const n of t.nodes.values()) {
      // Протухшие сэмплы (родитель линка умер/мигрировал и stats больше не шлёт)
      // сбрасываем: иначе последний плохой замер давил бы битрейт дерева вечно.
      if (n.statsAt && now - n.statsAt > STATS_TTL_MS) { n.linkLoss = 0; n.linkRtt = 0; n.statsAt = 0; continue; }
      if ((n.linkLoss || 0) > worstLoss) worstLoss = n.linkLoss;
      if ((n.linkRtt || 0) > worstRtt) worstRtt = n.linkRtt;
    }
    let target = t.targetBitrate;
    if (worstLoss > ABR_LOSS_CRIT) {
      // Обвал (>25% потерь): AIMD-спад по -10% за 4с не успевает — линк уже задыхается,
      // IDR-ретраи только добивают. Аварийный сброс сразу.
      t.badTicks = 0;
      target = Math.max(ABR_FLOOR, Math.floor(target * ABR_DOWN_CRIT));
    } else if (worstLoss > ABR_LOSS_HI || worstRtt > ABR_RTT_HI) {
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
      return { broadcasterId: t.broadcasterId, bitrate: target, worstLoss, worstRtt };
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
      virtual: !!n.virtual,
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
    catch (e) { tlog(`ws 401 (${e.message}) from ${req.socket.remoteAddress}`); socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
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

  // ---------- Э9: виртуальный fallback-relay ----------
  function findVirtual(t) {
    for (const n of t.nodes.values()) if (n.virtual) return n;
    return null;
  }

  // Просит агента vrelay заджойниться в дерево. true = виртуал есть/активация уже в полёте/
  // отправлена; false = агента нет (фолбэк недоступен).
  function requestVrelayActivation(streamId) {
    const t = mgr.trees.get(streamId);
    if (!t || !t.broadcasterId) return false;
    if (findVirtual(t)) return true;
    const now = Date.now();
    if (t.vrelayActivateAt && now - t.vrelayActivateAt < VRELAY_ACTIVATE_TIMEOUT_MS) return true;
    let agent = null;
    for (const p of peers.values()) if (p.isVrelayAgent && p.ws.readyState === p.ws.OPEN) { agent = p; break; }
    if (!agent) { tlog(`[${streamId}] фолбэк нужен, но агент vrelay не подключён`); return false; }
    const bc = t.nodes.get(t.broadcasterId);
    t.vrelayActivateAt = now;
    tlog(`[${streamId}] vrelay-activate -> агент ${agent.id}`);
    send(agent.id, { t: 'vrelay-activate', streamId, serverId: bc ? bc.serverId : null });
    return true;
  }

  // Э9: виртуал вошёл в забитое дерево (нет свободного слота нигде) и повис сиротой —
  // фолбэк не сработал бы именно тогда, когда нужен. Выселяем «жертву» из-под корня:
  // отцепляем одного не-виртуального ребёнка вещателя (drop-peer), сажаем виртуала в
  // освободившийся слот, жертва (с поддеревом) уезжает под виртуала через settleOrphans.
  function ensureVirtualAttached(streamId) {
    const t = mgr.trees.get(streamId);
    if (!t || !t.broadcasterId) return;
    const virt = findVirtual(t);
    if (!virt || virt.parent) return;
    const bc = t.nodes.get(t.broadcasterId);
    if (!bc) return;
    // Жертва — предпочтительно лист (не тащить поддерево), иначе первый попавшийся.
    let victimId = null;
    for (const cid of bc.children) {
      const c = t.nodes.get(cid);
      if (!c || c.virtual) continue;
      if (victimId == null) victimId = cid;
      if (!c.children.length) { victimId = cid; break; }
    }
    if (victimId == null) return; // у корня нет детей => есть слот => placeOrphans справится сам
    const victim = t.nodes.get(victimId);
    tlog(`[${streamId}] виртуал ${virt.id} сирота (дерево забито) — выселяю жертву ${victimId} (${victim.identity}) из-под корня`);
    bc.children = bc.children.filter((cid) => cid !== victimId);
    victim.parent = null; victim.depth = 0;
    send(t.broadcasterId, { t: 'drop-peer', streamId, peerId: victimId });
    virt.parent = bc.id; virt.depth = 1; bc.children.push(virt.id);
    mgr.updateSubtreeDepth(t, virt.id);
    send(virt.id, { t: 'assign-parent', streamId, parentId: bc.id });
    send(bc.id, { t: 'assign-child', streamId, childId: virt.id });
    settleOrphans(streamId); // жертва сядет под виртуала (единственный кандидат со слотом)
    if (victim.parent) mgr.updateSubtreeDepth(t, victimId); // placeOrphans не пересчитывает глубины поддерева
    broadcastTreeInfo(streamId);
    broadcastTopology(streamId);
  }

  // Размещает зависших сирот (см. mgr.placeOrphans) и рассылает им assign-parent, их новым
  // родителям — assign-child. Дёргается после каждого изменения топологии, где могла
  // появиться ёмкость (новый узел вошёл, кто-то ушёл/переехал).
  function settleOrphans(streamId) {
    const placed = mgr.placeOrphans(streamId);
    const now = Date.now();
    for (const { node, parentId } of placed) {
      // Свежепосаженного под виртуала не дёргаем дренажом сразу (анти-болтанка).
      const t = mgr.trees.get(streamId);
      const parent = t && t.nodes.get(parentId);
      if (parent && parent.virtual) node.reparentCooldownUntil = now + DRAIN_COOLDOWN_MS;
      tlog(`[${streamId}] сирота ${node.id} (${node.identity}) -> parent ${parentId}`);
      send(node.id, { t: 'assign-parent', streamId, parentId });
      send(parentId, { t: 'assign-child', streamId, childId: node.id });
    }
    if (placed.length) { broadcastTreeInfo(streamId); broadcastTopology(streamId); }
    // Э9: сироты остались (кандидатов нет вовсе) — будим виртуальный fallback-relay.
    const t = mgr.trees.get(streamId);
    if (t && t.broadcasterId && !findVirtual(t)) {
      for (const n of t.nodes.values()) {
        if (n.id !== t.broadcasterId && !n.parent) { requestVrelayActivation(streamId); break; }
      }
    }
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
      if (bnode && bnode.serverId === node.serverId) send(id, { t: 'stream-live', streamId: sid, identity: bnode.identity, initial: true, appName: bnode.appName || null, appIcon: bnode.appIcon || null });
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
    // Метаданные стримящегося приложения (иконка/имя окна) — только от вещателя; капы
    // длины страхуют от абьюза (иконка — base64 PNG 32×32, штатно 1-3 КБ).
    node.appName = role === 'broadcaster' && typeof msg.appName === 'string' ? msg.appName.slice(0, 120) : null;
    node.appIcon = role === 'broadcaster' && typeof msg.appIcon === 'string' && msg.appIcon.length <= 24000 ? msg.appIcon : null;
    // Э9: флагу virtual верим только агенту с JWT-uid VRELAY_UID — обычный клиент не может
    // объявить себя «сервером» (получил бы приоритетный трафик и увидел бы vrelay-release).
    node.virtual = !!msg.virtual && node.ws.__uid === VRELAY_UID;
    node.vrelayPinned = false;
    node.parent = null; node.children = []; node.depth = 0;
    const { parent } = mgr.join(streamId, node);
    tlog(`[${streamId}] join ${id} ${role} identity=${node.identity} native=${node.native}${node.virtual ? ' VIRTUAL' : ''} cap=${mgr.capacityOf(node)} symNat=${node.symmetricNat} -> ${role === 'broadcaster' ? 'корень' : parent ? `parent ${parent.id} (depth ${node.depth})` : 'СИРОТА (нет кандидатов)'}`);
    if (parent) {
      if (parent.virtual) node.reparentCooldownUntil = Date.now() + DRAIN_COOLDOWN_MS;
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
    // Э9: виртуал вошёл — активация состоялась; выполняем отложенные ручные запросы
    // «через сервер» (зрители, попросившие vrelay до его джойна).
    if (node.virtual) {
      const t = mgr.trees.get(streamId);
      if (t) {
        t.vrelayActivateAt = 0;
        ensureVirtualAttached(streamId); // дерево могло быть забито — выселяем жертву из-под корня
        if (t.vrelayPending && t.vrelayPending.size) {
          const now = Date.now();
          const attached = mgr.attachedToRoot(t, node);
          for (const pid of t.vrelayPending) {
            const pn = t.nodes.get(pid);
            if (!pn) continue;
            if (!attached) { send(pid, { t: 'reparent-denied', streamId, reason: 'no-vrelay' }); continue; }
            if (pn.parent === id) { pn.vrelayPinned = true; continue; }
            const res = mgr.reparent(streamId, pid, id, now);
            if (res.ok) { pn.vrelayPinned = true; applyReparent(streamId, pid, res); }
          }
          t.vrelayPending.clear();
        }
      }
    }
    if (role === 'broadcaster') broadcastToServer(node.serverId, { t: 'stream-live', streamId, identity: node.identity, initial: false, appName: node.appName || null, appIcon: node.appIcon || null });
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
          c.statsAt = Date.now(); // свежесть — см. STATS_TTL_MS (abrTick)
        }
      }
    }
  }

  // Рассылка успешной миграции (общая для ручного/авто reparent, дренажа и vrelay-путей):
  // старому родителю drop-peer, узлу assign-parent, новому родителю assign-child.
  function applyReparent(streamId, nodeId, res) {
    tlog(`[${streamId}] reparent ${nodeId}: ${res.oldParentId || '-'} -> ${res.newParentId}`);
    if (res.oldParentId) send(res.oldParentId, { t: 'drop-peer', streamId, peerId: nodeId });
    send(nodeId, { t: 'assign-parent', streamId, parentId: res.newParentId });
    if (res.newParentId) send(res.newParentId, { t: 'assign-child', streamId, childId: nodeId });
    broadcastTreeInfo(streamId);
    broadcastTopology(streamId);
    settleOrphans(streamId); // миграция могла освободить слот — подхватываем сирот
  }

  // Э9: зритель явно попросил «смотреть через сервер» (targetParentId='vrelay'). Виртуал
  // уже в дереве — обычный ручной reparent на него; нет — будим агента и запоминаем
  // запрос (исполнится в onJoin виртуала). Pin защищает от дренажа: раз выбрал сам —
  // не уводим обратно, пока сам не мигрирует.
  function onRequestVrelay(id) {
    const p = peers.get(id);
    if (!p || !p.streamId) return;
    const t = mgr.trees.get(p.streamId);
    if (!t || !t.broadcasterId) return;
    let virt = findVirtual(t);
    const now = Date.now();
    if (virt && !mgr.attachedToRoot(t, virt)) { ensureVirtualAttached(p.streamId); virt = findVirtual(t); }
    if (virt && mgr.attachedToRoot(t, virt)) {
      if (p.parent === virt.id) { p.vrelayPinned = true; return; }
      const res = mgr.reparent(p.streamId, id, virt.id, now);
      if (!res.ok) { send(id, { t: 'reparent-denied', streamId: p.streamId, reason: res.reason }); return; }
      p.vrelayPinned = true;
      applyReparent(p.streamId, id, res);
      return;
    }
    if (!requestVrelayActivation(p.streamId)) {
      send(id, { t: 'reparent-denied', streamId: p.streamId, reason: 'no-vrelay' });
      return;
    }
    if (!t.vrelayPending) t.vrelayPending = new Set();
    t.vrelayPending.add(id);
  }

  // Э8: узел просит миграцию. targetParentId — ручной выбор зрителя из дерева (жёсткая
  // валидация в mgr.reparent); отсутствует — авто по деградации (best-peer + cooldown).
  // Э9: targetParentId='vrelay' — запрос «через сервер» (см. onRequestVrelay).
  function onRequestReparent(id, msg) {
    const p = peers.get(id);
    if (!p || !p.streamId) return;
    if (msg.targetParentId === VRELAY_TARGET) return onRequestVrelay(id);
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
          tlog(`[${p.streamId}] reattach ${id} (${p.identity}) к тому же родителю ${p.parent} (ICE-restart, no-candidate)`);
          send(p.parent, { t: 'drop-peer', streamId: p.streamId, peerId: id });      // родитель закрывает старый child-PC
          send(id, { t: 'assign-parent', streamId: p.streamId, parentId: p.parent }); // узел сбрасывает upstream, ждёт offer
          send(p.parent, { t: 'assign-child', streamId: p.streamId, childId: id });   // родитель поднимает свежий PC + offer
          return;
        }
      }
      tlog(`[${p.streamId}] reparent-denied ${id} (${p.identity}) target=${msg.targetParentId || 'auto'} reason=${res.reason}`);
      send(id, { t: 'reparent-denied', streamId: p.streamId, reason: res.reason }); return;
    }
    // Pin «через сервер» живёт, пока зритель сам не мигрировал; ручной выбор виртуала
    // по его peer-id из панели дерева — тоже осознанный выбор, пиним.
    const t = mgr.trees.get(p.streamId);
    const newParent = t && t.nodes.get(res.newParentId);
    p.vrelayPinned = !!(newParent && newParent.virtual && msg.targetParentId);
    applyReparent(p.streamId, id, res);
  }

  // Э9: control-сокет агента vrelay представился. Гейт по JWT-uid — как у флага virtual
  // в join. Агент никогда не joins этим сокетом (стримы — на отдельных WS).
  function onVrelayHello(id, msg) {
    const p = peers.get(id);
    if (!p || p.ws.__uid !== VRELAY_UID) return;
    p.isVrelayAgent = true;
    p.vrelayCapacity = typeof msg.capacity === 'number' ? msg.capacity : 8;
    tlog(`агент vrelay подключён: ${id} capacity=${p.vrelayCapacity}`);
    // Агент (пере)подключился — деревья могли ждать фолбэк (сироты/ручные запросы).
    for (const [sid, t] of mgr.trees) {
      if (!t.broadcasterId || findVirtual(t)) continue;
      let needs = !!(t.vrelayPending && t.vrelayPending.size);
      if (!needs) for (const n of t.nodes.values()) { if (n.id !== t.broadcasterId && !n.parent) { needs = true; break; } }
      if (needs) requestVrelayActivation(sid);
    }
  }

  // Э8: relay-узел (натив passthrough) не энкодит и сам IDR не сделает — при подключении
  // нового ребёнка просит keyframe у корня. Релеим прямо вещателю (он форсит IDR глобально).
  function onRequestKeyframe(id) {
    const p = peers.get(id);
    if (!p || !p.streamId) return;
    const t = mgr.trees.get(p.streamId);
    if (!t || !t.broadcasterId) return;
    // Rate-limit на дерево: relay-узлы лимитируют себя по 1с каждый, но N узлов дают
    // до N IDR/с корню (у него на этом пути лимита нет) — IDR-шторм пробивает слабые
    // линки, порождая новые PLI (спираль). Корень и так держит GOP 4с как страховку.
    const now = Date.now();
    if (t.lastKfForwardAt && now - t.lastKfForwardAt < KF_FORWARD_MIN_MS) return;
    t.lastKfForwardAt = now;
    send(t.broadcasterId, { t: 'request-keyframe', streamId: p.streamId });
  }

  function onLeave(id, reason = 'leave') {
    const p = peers.get(id);
    if (!p || !p.streamId) { peers.delete(id); return; }
    peers.delete(id);
    tlog(`[${p.streamId}] leave ${id} (${p.identity}${p.role === 'broadcaster' ? ', ВЕЩАТЕЛЬ' : ''}${p.virtual ? ', VIRTUAL' : ''}) причина: ${reason}; детей: ${p.children.length}`);
    const oldParentId = p.parent;
    const pendingTree = mgr.trees.get(p.streamId);
    if (pendingTree && pendingTree.vrelayPending) pendingTree.vrelayPending.delete(id); // Э9: ушедший не ждёт vrelay
    const { reparented, dropped, broadcasterLost } = mgr.leave(p.streamId, id);
    if (broadcasterLost) {
      tlog(`[${p.streamId}] дерево обрушено (ушёл вещатель), зрителей сброшено: ${dropped.length}`);
      dropped.forEach((peerId) => {
        send(peerId, { t: 'drop-peer', streamId: p.streamId, peerId: id });
        // Конец вещания — терминальный сигнал и в watch-сокет: drop-peer ловят только
        // зрители глубины 1 (у остальных parentId — id relay-узла, не вещателя), а
        // discovery-stream-end зритель мог пропустить (окно реконнекта).
        send(peerId, { t: 'stream-end', streamId: p.streamId, identity: p.identity });
        // Э9: виртуалу при обрушении дерева нужен явный release — drop-peer по каждому его
        // ребёнку сервер не шлёт, и без release он ждал бы своего idle-таймаута впустую.
        const dp = peers.get(peerId);
        if (dp && dp.virtual) send(peerId, { t: 'vrelay-release', streamId: p.streamId });
      });
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
      else if (msg.t === 'leave') onLeave(id, 'явный leave');
      else if (msg.t === 'hello') onHello(id, msg);
      else if (msg.t === 'stats') onStats(id, msg);
      else if (msg.t === 'request-reparent') onRequestReparent(id, msg);
      else if (msg.t === 'request-keyframe') onRequestKeyframe(id);
      else if (msg.t === 'vrelay-hello') onVrelayHello(id, msg);
    });
    // code 1006 = грязный обрыв TCP (без close-фрейма): краш клиента, потеря сети,
    // heartbeat-terminate (см. hbTimer — он логирует свой terminate отдельно).
    ws.on('close', (code) => onLeave(id, `ws close code=${code}`));
    send(id, { t: 'welcome', id, iceServers: iceServersFor(ws.__uid) });
  });

  // Э8 ABR: раз в тик пересчитываем целевой битрейт каждого дерева и шлём корню, если сменился.
  const abrTimer = setInterval(() => {
    for (const streamId of mgr.trees.keys()) {
      const cmd = mgr.abrTick(streamId);
      if (cmd) {
        tlog(`[${streamId}] ABR -> ${Math.round(cmd.bitrate / 1000)} kbps (worst loss=${(cmd.worstLoss * 100).toFixed(1)}% rtt=${Math.round(cmd.worstRtt)}ms)`);
        send(cmd.broadcasterId, { t: 'set-bitrate', streamId, bps: cmd.bitrate });
      }
    }
  }, ABR_TICK_MS);
  abrTimer.unref?.(); // не держим процесс живым только ради ABR-тика

  // Э9: дренаж виртуала — живые пиры всегда предпочтительнее серверного фолбэка.
  // R1 (мягкий): <=1 ребёнка за тик на дерево уводим на живого кандидата (авто-reparent
  // сам исключит виртуала как текущего родителя). Pinned («через сервер» руками) и
  // свежепосаженные (cooldown) не трогаются.
  // R2 (выселение): R1 никого не увёл, но живой ёмкости хватает на всех детей виртуала —
  // шлём vrelay-release: штатный mgr.leave() сам репарентит детей. Лечит дедлок «виртуал
  // занял единственный слот корня, пришедшему нативу некуда сесть, виртуал не пустеет».
  const drainTimer = setInterval(() => {
    const now = Date.now();
    for (const [streamId, t] of mgr.trees) {
      const virt = findVirtual(t);
      if (!virt || !virt.children.length) continue;
      let moved = false;
      for (const cid of [...virt.children]) {
        const child = t.nodes.get(cid);
        if (!child || child.vrelayPinned) continue;
        if (child.reparentCooldownUntil && now < child.reparentCooldownUntil) continue;
        const res = mgr.reparent(streamId, cid, null, now);
        if (res.ok) {
          child.reparentCooldownUntil = now + DRAIN_COOLDOWN_MS;
          applyReparent(streamId, cid, res);
          moved = true;
          break;
        }
      }
      if (moved) continue;
      let pinned = false;
      for (const cid of virt.children) { const c = t.nodes.get(cid); if (c && c.vrelayPinned) { pinned = true; break; } }
      if (pinned) continue;
      let free = 0;
      for (const n of t.nodes.values()) {
        if (n.virtual) continue;
        let used = 0;
        for (const cid of n.children) { const c = t.nodes.get(cid); if (c && !c.virtual) used++; } // слот виртуала освободится с его уходом
        free += Math.max(0, mgr.capacityOf(n) - used);
      }
      if (free >= virt.children.length) {
        tlog(`[${streamId}] дренаж R2: живой ёмкости хватает (${free} >= ${virt.children.length}) — vrelay-release ${virt.id}`);
        send(virt.id, { t: 'vrelay-release', streamId });
      }
    }
  }, DRAIN_TICK_MS);
  drainTimer.unref?.();

  // Heartbeat-пинг: непришедший pong за один интервал (~HEARTBEAT_MS) => terminate =>
  // ws 'close' => onLeave репарентит поддерево. Браузерный WebSocket и tokio-tungstenite
  // отвечают pong автоматически — клиентских правок не нужно. Пингуем и discovery-сокеты.
  const HEARTBEAT_MS = 10_000;
  const hbTimer = setInterval(() => {
    for (const [, p] of peers) {
      const ws = p.ws;
      if (!ws || ws.readyState !== ws.OPEN) continue;
      if (ws.isAlive === false) {
        tlog(`heartbeat timeout ${p.id} (${p.identity}${p.streamId ? `, stream ${p.streamId}` : ''}) — terminate`);
        try { ws.terminate(); } catch { /**/ }
        continue;
      }
      ws.isAlive = false;
      try { ws.ping(); } catch { /**/ }
    }
  }, HEARTBEAT_MS);
  hbTimer.unref?.();

  return { mgr, peers, wss, abrTimer, hbTimer, drainTimer };
}

module.exports = { attachTreeServer, TreeManager, MAX_DEPTH, NATIVE_CAPACITY, BROWSER_CAPACITY };
