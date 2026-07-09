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

const MAX_DEPTH = 5;          // Roadmap-flow-стриминга Д3: считается ВНУТРИ каждого рендишн-дерева
                             // от его корня. Латентность держим не глубиной, а тем, что server-first
                             // дефолт — глубина 1-2 (vrelay раздаёт прямым зрителям). Было 4 (Э8).
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
// Roadmap-flow-стриминга Д1: в server-first-дереве виртуал (vrelay) — ПРЕДПОЧТИТЕЛЬНЫЙ
// родитель. Отрицательная стоимость (бонус) бьёт любого живого пира: «стример → сервер →
// зрители». Применяется ТОЛЬКО когда t.serverFirst (legacy сохраняет штраф VIRTUAL_COST).
const VIRTUAL_SERVER_FIRST_BONUS = 500;
const VIRTUAL_CHILDREN_CAP = Number(process.env.VRELAY_CHILDREN_CAP) || 32; // кап ёмкости виртуала
                                   // (датацентр — выше пользовательского MAX_CHILDREN_CAP); env для Д1
const DRAIN_TICK_MS = 5000;        // темп дренажа детей виртуала на живые пиры
const DRAIN_COOLDOWN_MS = 15_000;  // гистерезис: свежепосаженного под виртуала не дёргаем сразу
const VRELAY_ACTIVATE_TIMEOUT_MS = 15_000; // активация «в полёте»: не слать повторный activate, пока не истёк
const VRELAY_UID = 'virtual-relay'; // JWT-uid агента: флагу virtual в join верим только при нём
const VRELAY_TARGET = 'vrelay';    // сентинел targetParentId в request-reparent = «хочу через сервер»

// Roadmap-flow-стриминга Д1: инверсия топологии «стример → сервер → зрители». Под флагом
// TREE_SERVER_FIRST vrelay становится постоянным pinned медиаузлом (не fallback с дренажом):
// вещатель шлёт serverIngest:true, сервер шлёт агенту vrelay-ingest (постоянная сессия),
// виртуал садится прямым ребёнком корня ДО первого зрителя, дренаж/idle-exit отключены.
// Режим включается ТОЛЬКО для деревьев с serverIngest — старый клиент без поля работает по
// legacy даже при TREE_SERVER_FIRST=1 (обратная совместимость, см. Деплой-дисциплина роадмапа).
const SERVER_FIRST = process.env.TREE_SERVER_FIRST === '1';

// DEV-ТРИГГЕР Д2 (удаляется в Д8): ручной подъём/гашение ОДНОЙ транскод-рендишн-сессии на
// vrelay, чтобы глазами проверить конвейер RTP→ffmpeg→RTP до переделки деревьев (Д3/Д4).
// Гейт TREE_DEV_RENDITION=1 (по умолчанию выкл). Составной ключ streamId::rendition и
// полноценный реестр рендишнов — это Д3/Д4, здесь только «дёрнуть агента и увидеть картинку».
const DEV_RENDITION = process.env.TREE_DEV_RENDITION === '1';

function newPeerId() { return 'p_' + crypto.randomBytes(6).toString('hex'); }

// Roadmap-flow-стриминга Д3: ключ дерева = `streamId::rendition`. Деревья пер-качество —
// «обмен строго внутри одного качества» получается структурно (pickParent/reparent живут
// внутри одного Tree). Вещатель и дефолтный зритель — в `::source`; поведение неотличимо
// от «до». Аллоулист рендишнов; мусор в join.quality трактуем как 'source' (обратная
// совместимость: старый бандл без поля = source).
const RENDITIONS = new Set(['source', '1080', '720', '480', '360']);
const DEFAULT_RENDITION = 'source';
function normRendition(q) { return typeof q === 'string' && RENDITIONS.has(q) ? q : DEFAULT_RENDITION; }
function treeKey(streamId, rendition = DEFAULT_RENDITION) { return `${streamId}::${normRendition(rendition)}`; }
// streamId = LiveKit identity вида `username#nonce` — `::` в нём нет (проверено допущение),
// но Д2-рендишн-корень раньше клеил `::480` в сам streamId; lastIndexOf('::') устойчив и к
// такому случаю (отрезает только последний сегмент-рендишн).
function parseTreeKey(key) {
  const i = key.lastIndexOf('::');
  if (i < 0) return { streamId: key, rendition: DEFAULT_RENDITION };
  return { streamId: key.slice(0, i), rendition: key.slice(i + 2) };
}

// Roadmap-flow-стриминга Д4: лестница рендишнов по требованию. Порядок сверху вниз (source
// = passthrough вещателя, лучший; ниже — транскод-рендишны с падающим битрейтом/разрешением).
// Пер-зрительский ABR двигает зрителя ВНИЗ (плохой линк) / ВВЕРХ (восстановление) на СОСЕДНИЙ
// рунг этого массива, но только среди ДОСТУПНЫХ (лестница режется сверху по разрешению source).
const RUNG_ORDER = ['source', '1080', '720', '480', '360'];
// Высота рендишна (для «без апскейла»: рендишн доступен, только если его высота <= высоты source).
const RENDITION_HEIGHT = { 1080: 1080, 720: 720, 480: 480, 360: 360 };
// Дефолтный CBR-битрейт рендишна (бит/с) — совпадает с transcode.rs::rendition_default_bitrate.
// Сервер шлёт агенту presetBitrate; агент при 0 берёт свой дефолт (страховка совместимости).
const RENDITION_BITRATE = { 1080: 4_500_000, 720: 3_000_000, 480: 1_500_000, 360: 800_000 };

// Roadmap-flow-стриминга Д5: таблица пресетов вещателя (H.264/CBR). ⚠ ДУБЛИРУЕТСЯ в
// apps/web/src/presets.ts (PRESETS) — источник истины ТАМ; здесь КОПИЯ для валидации
// битрейтов рендишнов. При ЛЮБОМ изменении значений синхронизируй ОБЕ копии.
const PRESET_TABLE = [
  { width: 1920, height: 1080, fps: 60, bitrateKbps: 6000 },
  { width: 1280, height: 720,  fps: 60, bitrateKbps: 4500 },
  { width: 1920, height: 1080, fps: 30, bitrateKbps: 4500 },
  { width: 1280, height: 720,  fps: 30, bitrateKbps: 3000 },
  { width: 854,  height: 480,  fps: 30, bitrateKbps: 1500 },
  { width: 640,  height: 360,  fps: 30, bitrateKbps: 800 },
];
// Рендишны = 30fps-пресеты той же высоты (единый источник). Расхождение = баг синка таблиц.
for (const [rung, bps] of Object.entries(RENDITION_BITRATE)) {
  const preset = PRESET_TABLE.find((p) => p.fps === 30 && p.height === RENDITION_HEIGHT[rung]);
  if (preset && preset.bitrateKbps * 1000 !== bps)
    console.warn(`[tree] Д5: RENDITION_BITRATE[${rung}]=${bps} != пресет ${preset.bitrateKbps * 1000} — рассинхрон таблиц web↔tree.js`);
}
// Состояния рендишна в реестре source-дерева.
const RS_STARTING = 'starting'; // vrelay-rendition-start отправлен, ждём джойна рендишн-корня
const RS_LIVE = 'live';         // рендишн-корень заджойнился в base::rendition, раздаёт
const RS_STOPPING = 'stopping'; // vrelay-rendition-stop отправлен, дерево сносится
// Гашение рендишна без потребителей: держим RENDITION_IDLE_MS, снимаем транскод. Тик и порог —
// env-оверрайдабельны (ad-hoc-тест ускоряет гашение; прод-дефолт 30с/5с).
const RENDITION_IDLE_MS = Number(process.env.TREE_RENDITION_IDLE_MS) || 30_000;
const RENDITION_TICK_MS = Number(process.env.TREE_RENDITION_TICK_MS) || 5_000;

// Пер-зрительский ABR (Д4): прямого ребёнка серверного узла (vrelay в source-дереве или
// рендишн-корня в рендишн-дереве) с плохим линком переводим на рендишн НИЖЕ, с восстановившимся —
// ВЫШЕ. Реюз EWMA-порогов source-ABR (ABR_LOSS_*, ABR_RTT_*, ABR_BAD_TICKS, STATS_TTL_MS) —
// второй сглаживатель не заводим. Подъём медленнее спада (анти-болтанка), cooldown в диапазоне
// роадмапа 15-30с.
const ABR_GOOD_TICKS = 5;             // подряд «хороших» тиков до подъёма (спад — ABR_BAD_TICKS=2)
const ABR_VIEWER_COOLDOWN_MS = 20_000; // гистерезис между переключениями качества одного зрителя

// Roadmap-flow-стриминга Д6: супер-сидеры + авто-ретрансляция 1→2 при запасе upload.
// Прямые слоты серверного узла (vrelay в source-дереве / рендишн-корень) держим за
// СИЛЬНЕЙШИМИ по upload зрителями; слабых вытесняем в глубину, сильных из глубины поднимаем.
const D6_SWAP_HYSTERESIS = 1.25;      // сильный должен быть ≥25% лучше вытесняемого (анти-болтанка,
                                      // роадмап-риск «шумные оценки upload → болтанка»)
const D6_SWAP_COOLDOWN_MS = 30_000;   // между рокировками одного узла (реюз reparentCooldownUntil,
                                      // общий с Д4-ABR — перемещения Д4 и Д6 не дерутся за узел)
// Динамическая ёмкость (maxChildren) server-first ЗРИТЕЛЯ считается СЕРВЕРОМ из его upload
// (availableOutgoing в stats) и битрейта смотримого рендишна: ветвление 1→2 только при запасе
// upload ≥ 2× битрейта рендишна × запас. Считаем на сервере, а не на клиенте: сервер знает и
// upload зрителя (stats), и битрейт рендишна (RENDITION_BITRATE / maxBitrate вещателя), тогда
// как клиент битрейт source-рендишна (CBR вещателя) точно не знает.
const D6_UPLOAD_HEADROOM = 1.3;       // +30% запаса поверх номинала (роадмап)
// Больший вес upload в scoreParent для server-first (роадмап Д6: «outBonus — больший вес внутри
// рендишн-дерева»): при равной глубине сильный по upload выигрывает родительство явно, но вклад
// держим ниже стоимости уровня (depth*100), чтобы латентность (мелкое дерево) оставалась главной.
const OUT_BONUS_WEIGHT_SF = 4;

// Доступная лестница рендишнов source-дерева с учётом «без апскейла». width/height вещателя
// приходят в join (натив знает своё выходное разрешение). Нет данных (старый бандл) — НЕ режем
// (ffmpeg всё равно не апскейлит: scale='min(W,iw)' — выдаст не больше source; риск лишь в
// мисс-лейбле пункта меню). Всегда включает 'source'.
function availableRungs(srcTree) {
  const h = srcTree && srcTree.srcHeight ? srcTree.srcHeight : 0;
  return RUNG_ORDER.filter((r) => r === DEFAULT_RENDITION || !h || RENDITION_HEIGHT[r] <= h);
}
function renditionAvailable(srcTree, rendition) {
  return rendition === DEFAULT_RENDITION || availableRungs(srcTree).includes(rendition);
}

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
    // Roadmap-flow-стриминга Д0: браузер снова строго лист (снос Э8-relay). Жёсткий гард по
    // флагам узла, а не только BROWSER_CAPACITY=0 константа — защита от старых закэшированных
    // браузерных бандлов, которые могли ещё присылать maxChildren>0 в join.
    if (!node.native) return 0;
    if (node.symmetricNat && !this.turnEnabled) return 0; // без TURN симметричный = лист
    // Объявленная ёмкость (лимит из UI/натива) — верхняя граница ЧЕСТНОСТИ: клиент может
    // соврать upload, но не выйдет за свой же кап и жёсткий MAX_CHILDREN_CAP.
    const declared = typeof node.maxChildren === 'number' ? Math.max(0, Math.min(node.maxChildren, MAX_CHILDREN_CAP)) : NATIVE_CAPACITY;
    // Roadmap-flow-стриминга Д6: server-first ЗРИТЕЛЮ ёмкость считает СЕРВЕР из его upload
    // (dynamicCapacity). Легаси/не-зритель → dyn=null → объявленная (старое поведение).
    const dyn = this.dynamicCapacity(node);
    return dyn == null ? declared : Math.min(declared, dyn);
  }

  // Roadmap-flow-стриминга Д6: битрейт (бит/с) рендишна, который смотрит узел. Рендишн-дерево —
  // фиксированный CBR из таблицы; source — потолок вещателя (или дефолт для старого клиента).
  watchedBitrate(t, rendition) {
    if (rendition && rendition !== DEFAULT_RENDITION) return RENDITION_BITRATE[rendition] || 0;
    const bc = t && t.broadcasterId ? t.nodes.get(t.broadcasterId) : null;
    return bc && bc.maxBitrate > 0 ? bc.maxBitrate : ABR_DEFAULT_MAX;
  }

  // Roadmap-flow-стриминга Д6: динамическая ёмкость server-first ЗРИТЕЛЯ из его upload
  // (availableOutgoing) и битрейта смотримого рендишна. Возвращает null, если правило
  // неприменимо (легаси-source-дерево / не-зритель) — тогда capacityOf берёт объявленную.
  //   out >= 2×br×запас → 2 (ветвление 1→2 при доказанном запасе upload);
  //   out >= 1×br×запас → 1 (upload есть, но только на одного ребёнка);
  //   out  > 0          → 0 (ДОКАЗАННО слабый upload — детей не даём, роадмап AC);
  //   out <= 0          → 1 (upload НЕ измерен — консервативный дефолт: базовое дерево всё
  //                          равно ветвится, но не раздуваем до 2 на неизвестной/фейковой цифре).
  dynamicCapacity(node) {
    if (node.role !== 'viewer') return null;
    const t = node.treeKey ? this.trees.get(node.treeKey) : null;
    if (!t) return null;
    const rendition = node.rendition || DEFAULT_RENDITION;
    const serverFirst = rendition !== DEFAULT_RENDITION || !!t.serverFirst;
    if (!serverFirst) return null; // легаси source-дерево — прежнее поведение (объявленная ёмкость)
    const br = this.watchedBitrate(t, rendition);
    if (!br) return null;
    const out = node.availableOutgoing || 0;
    if (out <= 0) return 1;                          // не измерен → консервативный дефолт 1
    if (out >= 2 * br * D6_UPLOAD_HEADROOM) return 2; // доказанный запас → ветвление 1→2
    if (out >= br * D6_UPLOAD_HEADROOM) return 1;
    return 0;                                        // доказанно слабый → детей не получает
  }

  // Roadmap-flow-стриминга Д6: серверный узел дерева, чьи ПРЯМЫЕ слоты арбитрируем — vrelay
  // (virtual) в source-server-first-дереве или рендишн-корень (broadcaster) в рендишн-дереве.
  serverNode(key) {
    const t = this.trees.get(key);
    if (!t || !t.broadcasterId) return null;
    if (parseTreeKey(key).rendition !== DEFAULT_RENDITION) return t.nodes.get(t.broadcasterId) || null;
    if (!t.serverFirst) return null;
    for (const n of t.nodes.values()) if (n.virtual) return n;
    return null;
  }

  // Roadmap-flow-стриминга Д6: план ОДНОЙ рокировки прямого слота серверного узла (чистая
  // политика без сайд-эффектов — для теста и для arbitrateServerSlots-исполнителя). Условия:
  // прямые слоты сервера ЗАНЯТЫ и в глубине есть лист-натив с upload ≥ 1.25× худшего прямого
  // ребёнка, вне cooldown, способный ретранслировать. Жертва — слабейший прямой ЛИСТ (или
  // узел с наименьшим поддеревом), чтобы не морозить чужое поддерево. Возвращает
  // {victimId, candidateId, ...} либо null.
  planServerSlotSwap(key, now) {
    const t = this.trees.get(key);
    if (!t) return null;
    const server = this.serverNode(key);
    if (!server || !this.attachedToRoot(t, server)) return null;
    if (server.children.length < this.capacityOf(server)) return null; // свободный слот — сирота сядет сам, рокировка не нужна
    const uploadOf = (n) => n.availableOutgoing || 0;
    // Прямые дети-кандидаты на вытеснение: не серверные и не запиненные «через сервер» (свой выбор).
    const directs = server.children.map((cid) => t.nodes.get(cid)).filter((c) => c && !c.virtual && !c.vrelayPinned);
    if (!directs.length) return null;
    const worstUpload = Math.min(...directs.map(uploadOf)); // порог сравнения (роадмап: худший прямой ребёнок)
    // Жертва: приоритет ЛИСТА (без поддерева); среди листьев — слабейший upload; если листьев
    // нет — узел с наименьшим поддеревом (меньше морозим), затем слабейший upload.
    const leaves = directs.filter((c) => c.children.length === 0);
    let victim;
    if (leaves.length) victim = leaves.reduce((m, c) => (uploadOf(c) < uploadOf(m) ? c : m));
    else victim = directs.reduce((m, c) => {
      const hc = this.subtreeHeight(t, c.id), hm = this.subtreeHeight(t, m.id);
      if (hc !== hm) return hc < hm ? c : m;
      return uploadOf(c) < uploadOf(m) ? c : m;
    });
    if (victim.reparentCooldownUntil && now < victim.reparentCooldownUntil) return null; // жертва свежедёрнута — ждём
    // Кандидат: сильнейший по upload ЛИСТ-НАТИВ в глубине (браузер не ретранслирует → не в
    // relay-слот, роадмап D), ≥1.25× worstUpload, вне cooldown, реально способный отдать (cap≥1).
    let candidate = null;
    for (const n of t.nodes.values()) {
      if (n.id === t.broadcasterId || n.virtual) continue;
      if (n.parent === server.id) continue;             // уже прямой ребёнок сервера
      if (!n.native) continue;                           // браузер — только лист, не поднимаем в relay-слот
      if (n.vrelayPinned) continue;                      // сам выбрал текущего родителя
      if (n.children && n.children.length) continue;     // поднимаем ЛИСТ (не тащим поддерево вверх)
      if (n.reparentCooldownUntil && now < n.reparentCooldownUntil) continue;
      const out = uploadOf(n);
      if (out <= 0) continue;
      if (out < worstUpload * D6_SWAP_HYSTERESIS) continue; // гистерезис 25%
      if (this.capacityOf(n) < 1) continue;              // не сможет ретранслировать — рокировка бессмысленна
      if (server.depth + 1 > MAX_DEPTH) continue;         // влезает прямым ребёнком сервера
      if (!candidate || out > uploadOf(candidate)) candidate = n;
    }
    if (!candidate || candidate.id === victim.id) return null;
    return { victimId: victim.id, candidateId: candidate.id, worstUpload, victimUpload: uploadOf(victim), candidateUpload: uploadOf(candidate) };
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
  scoreParent(cand, serverFirst = false) {
    const cap = this.capacityOf(cand) || 1;
    const depthCost = cand.depth * 100;                 // мелкое дерево сильно предпочтительнее
    const loadCost = (cand.children.length / cap) * 40; // не перегружать один узел
    // Д6: в server-first upload весит больше (супер-сидеры — сильные вверх). Вклад держим ниже
    // depthCost (уровень = 100), чтобы латентность оставалась главной; при равной глубине решает upload.
    const outBonus = (Math.min(cand.availableOutgoing || 0, 20_000_000) / 1_000_000) * (serverFirst ? OUT_BONUS_WEIGHT_SF : 1); // Мбит выхода
    const lossCost = (cand.linkLoss || 0) * 50;         // потери на входящем линке кандидата
    const rttCost = (cand.linkRtt || 0) / 20;
    // Симметричный NAT как РОДИТЕЛЬ = offerer через TURN-relay: работает только при живом TURN,
    // выше задержка (двойной relay), хрупко. Штраф > стоимости уровня (250 > depth*100), чтобы
    // не-симметричный узел даже на уровень глубже предпочитался — симметричный берём в родители
    // лишь когда другого relay нет вовсе (тогда capacityOf уже гарантировал наличие TURN).
    const natCost = cand.symmetricNat ? 250 : 0;
    // Э9: виртуал (серверный fallback) проигрывает любому живому relay — см. VIRTUAL_COST.
    // Д1 (server-first): виртуал, наоборот, ПРЕДПОЧТИТЕЛЬНЕЕ любого пира — отрицательный бонус.
    const virtualCost = cand.virtual ? (serverFirst ? -VIRTUAL_SERVER_FIRST_BONUS : VIRTUAL_COST) : 0;
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
      const s = this.scoreParent(cand, !!t.serverFirst);
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
    // Э9: виртуал — ВСЕГДА прямой ребёнок вещателя (fanout-хаб на глубине 1), НЕ через pickParent.
    // pickParent зарыл бы его под зрителя со свободным слотом (у корня слот занят) → виртуал на
    // глубине 2+ ПОТОМКОМ зрителя → его же запрос «через сервер» давал бы цикл, а хаб-фанаут терялся.
    // Нет слота у корня — входим сиротой, ensureVirtualAttached выселит жертву и усадит под корень.
    let parent;
    if (node.virtual) {
      const bc = t.nodes.get(t.broadcasterId);
      parent = bc && bc.children.length < this.capacityOf(bc) ? bc : null;
    } else {
      parent = this.pickParent(t, node);
    }
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
    // Д4: узел «серверный» (транскодер/раздатчик), если это vrelay (virtual) ИЛИ корень
    // рендишн-дерева (broadcaster в base::rendition — это ffmpeg-рендишн-корень, virtual:false
    // ради обхода self-loop в ensureVirtualAttached, но для UI это «через сервер»). Клиент по
    // этому флагу решает, активно ли меню качества (родитель = сервер → активно).
    const rendition = parseTreeKey(streamId).rendition;
    return [...t.nodes.values()].map((n) => ({
      id: n.id,
      identity: n.identity,
      parentId: n.parent,
      depth: n.depth,
      children: n.children.length,
      capacity: this.capacityOf(n),
      native: !!n.native,
      virtual: !!n.virtual,
      server: !!n.virtual || (n.id === t.broadcasterId && rendition !== DEFAULT_RENDITION),
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
  tlog(`режим видео-дерева: ${SERVER_FIRST ? 'server-first (TREE_SERVER_FIRST=1) — vrelay постоянный медиаузел для стримов с serverIngest' : 'legacy (vrelay = fallback с дренажом)'}; vrelay children cap=${VIRTUAL_CHILDREN_CAP}`);

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
  // отправлена; false = агента нет (фолбэк недоступен). Аргумент — составной ключ дерева.
  function requestVrelayActivation(key) {
    // Д3: vrelay-ingest/activate — концепция ТОЛЬКО source-дерева (агент джойнится в `::source`
    // с квалити source). Рендишн-деревья (Д4) поднимает сам агент через vrelay-rendition-*, а не
    // активацией; активировать vrelay в них нельзя — он ушёл бы в чужое дерево `base::source`.
    if (parseTreeKey(key).rendition !== DEFAULT_RENDITION) return false;
    const t = mgr.trees.get(key);
    if (!t || !t.broadcasterId) return false;
    if (findVirtual(t)) return true;
    const now = Date.now();
    if (t.vrelayActivateAt && now - t.vrelayActivateAt < VRELAY_ACTIVATE_TIMEOUT_MS) return true;
    let agent = null;
    for (const p of peers.values()) if (p.isVrelayAgent && p.ws.readyState === p.ws.OPEN) { agent = p; break; }
    if (!agent) { tlog(`[${key}] фолбэк нужен, но агент vrelay не подключён`); return false; }
    const bc = t.nodes.get(t.broadcasterId);
    t.vrelayActivateAt = now;
    // Д1: server-first-дереву нужен ПОСТОЯННЫЙ медиаузел — шлём vrelay-ingest (агент поднимает
    // сессию с idle_exit:None, reconnect:true). Legacy — прежний vrelay-activate (fallback с idle).
    // streamId в сообщении — БАЗОВЫЙ id (агент джойнится в `::source` квалити по умолчанию).
    const msgType = t.serverFirst ? 'vrelay-ingest' : 'vrelay-activate';
    tlog(`[${key}] ${msgType} -> агент ${agent.id}`);
    send(agent.id, { t: msgType, streamId: bc ? bc.streamId : parseTreeKey(key).streamId, serverId: bc ? bc.serverId : null });
    return true;
  }

  // Э9: виртуал вошёл в забитое дерево (нет свободного слота нигде) и повис сиротой —
  // фолбэк не сработал бы именно тогда, когда нужен. Выселяем «жертву» из-под корня:
  // отцепляем одного не-виртуального ребёнка вещателя (drop-peer), сажаем виртуала в
  // освободившийся слот, жертва (с поддеревом) уезжает под виртуала через settleOrphans.
  // Гарантирует, что виртуал — ПРЯМОЙ ребёнок вещателя (fanout-хаб на глубине 1). Два случая:
  // (а) виртуал вошёл в забитое дерево и повис сиротой — фолбэк не сработал бы, когда нужен;
  // (б) generic pickParent/авто-reparent зарыл виртуала под обычного зрителя (у корня слот занят,
  //     у зрителя свободен) → виртуал ПОТОМОК зрителя → его же «через сервер» = цикл, хаб потерян.
  // Отцепляем виртуала откуда бы он ни висел и сажаем прямо под корень; нет слота у корня —
  // выселяем одну не-виртуальную жертву-лист (её поддерево уедет под виртуала через settleOrphans).
  function ensureVirtualAttached(key) {
    const t = mgr.trees.get(key);
    if (!t || !t.broadcasterId) return;
    const virt = findVirtual(t);
    if (!virt) return;
    const bc = t.nodes.get(t.broadcasterId);
    if (!bc) return;
    if (virt.parent === bc.id) return; // уже прямой ребёнок корня — ничего не делаем
    const sid = parseTreeKey(key).streamId; // базовый id в клиентских сообщениях (не составной ключ)

    // (б) Виртуал зарыт под зрителя — отцепляем от текущего родителя (drop-peer старому родителю),
    // делаем сиротой, дальше общий путь усаживает под корень.
    if (virt.parent) {
      const op = t.nodes.get(virt.parent);
      if (op) { op.children = op.children.filter((cid) => cid !== virt.id); send(op.id, { t: 'drop-peer', streamId: sid, peerId: virt.id }); }
      virt.parent = null; virt.depth = 0;
    }

    // Нет свободного слота у корня — выселяем жертву (предпочтительно лист, чтобы не тащить поддерево).
    let victimId = null;
    if (bc.children.length >= mgr.capacityOf(bc)) {
      for (const cid of bc.children) {
        const c = t.nodes.get(cid);
        if (!c || c.virtual) continue;
        if (victimId == null) victimId = cid;
        if (!c.children.length) { victimId = cid; break; }
      }
      if (victimId == null) return; // у корня только виртуал/пусто — слота нет, выселять некого
      const victim = t.nodes.get(victimId);
      tlog(`[${key}] виртуал ${virt.id} — у корня нет слота, выселяю жертву ${victimId} (${victim.identity})`);
      bc.children = bc.children.filter((cid) => cid !== victimId);
      victim.parent = null; victim.depth = 0;
      send(t.broadcasterId, { t: 'drop-peer', streamId: sid, peerId: victimId });
    }

    virt.parent = bc.id; virt.depth = 1; bc.children.push(virt.id);
    mgr.updateSubtreeDepth(t, virt.id);
    send(virt.id, { t: 'assign-parent', streamId: sid, parentId: bc.id });
    send(bc.id, { t: 'assign-child', streamId: sid, childId: virt.id });
    tlog(`[${key}] виртуал ${virt.id} усажен прямым ребёнком корня (depth 1)`);
    settleOrphans(key); // выселенная жертва и любые сироты сядут под виртуала (единственный слот)
    if (victimId) { const v = t.nodes.get(victimId); if (v && v.parent) mgr.updateSubtreeDepth(t, victimId); } // placeOrphans не пересчитывает глубины поддерева жертвы
    broadcastTreeInfo(key);
    broadcastTopology(key);
  }

  // Размещает зависших сирот (см. mgr.placeOrphans) и рассылает им assign-parent, их новым
  // родителям — assign-child. Дёргается после каждого изменения топологии, где могла
  // появиться ёмкость (новый узел вошёл, кто-то ушёл/переехал).
  function settleOrphans(key) {
    const placed = mgr.placeOrphans(key);
    const sid = parseTreeKey(key).streamId;
    const now = Date.now();
    for (const { node, parentId } of placed) {
      // Свежепосаженного под виртуала не дёргаем дренажом сразу (анти-болтанка).
      const t = mgr.trees.get(key);
      const parent = t && t.nodes.get(parentId);
      if (parent && parent.virtual) node.reparentCooldownUntil = now + DRAIN_COOLDOWN_MS;
      tlog(`[${key}] сирота ${node.id} (${node.identity}) -> parent ${parentId}`);
      send(node.id, { t: 'assign-parent', streamId: sid, parentId });
      send(parentId, { t: 'assign-child', streamId: sid, childId: node.id });
    }
    if (placed.length) { broadcastTreeInfo(key); broadcastTopology(key); }
    // Э9: сироты остались (кандидатов нет вовсе) — будим виртуальный fallback-relay.
    // (requestVrelayActivation сам откажет не-source-дереву — рендишн-сироты просто ждут, Д4.)
    const t = mgr.trees.get(key);
    if (t && t.broadcasterId && !findVirtual(t)) {
      for (const n of t.nodes.values()) {
        if (n.id !== t.broadcasterId && !n.parent) { requestVrelayActivation(key); break; }
      }
    }
  }

  function broadcastTreeInfo(key) {
    const info = mgr.info(key);
    if (!info) return;
    const sid = parseTreeKey(key).streamId; // базовый id клиенту (не составной ключ — не течёт в UI)
    for (const [pid, p] of peers) {
      if (p.treeKey === key) {
        send(pid, { t: 'tree-info', streamId: sid, depth: info.depth, myDepth: p.depth, children: p.children.length, health: 'ok' });
      }
    }
  }

  // Э8: полная топология дерева — зритель видит, у кого берёт стрим, и может вручную
  // выбрать другого пира (см. onRequestReparent). Шлём всем узлам этого дерева (по составному
  // ключу). streamId в сообщении — БАЗОВЫЙ: натив-топология фильтруется по payload.streamId,
  // который зритель сверяет с базовым id, переданным в watch (treeVideo topoCb).
  function broadcastTopology(key) {
    const nodes = mgr.topology(key);
    if (!nodes) return;
    const sid = parseTreeKey(key).streamId;
    for (const [pid, p] of peers) {
      if (p.treeKey === key) send(pid, { t: 'tree-topology', streamId: sid, you: pid, nodes });
    }
  }

  // Д4: найти подключённого агента vrelay (control-сокет). null = фолбэк/транскод недоступен.
  function findVrelayAgent() {
    for (const ap of peers.values()) if (ap.isVrelayAgent && ap.ws.readyState === ap.ws.OPEN) return ap;
    return null;
  }

  // Д4: доступная лестница рендишнов source-дерева (для stream-live.renditions[]).
  function renditionsOf(baseSid) {
    const srcTree = mgr.trees.get(treeKey(baseSid, DEFAULT_RENDITION));
    return srcTree ? availableRungs(srcTree) : [DEFAULT_RENDITION];
  }

  // Д4: ленивый старт рендишна. Первый потребитель непустой/несуществующей рендишн →
  // просим агента поднять транскод (vrelay-rendition-start) + шлём request-keyframe корню
  // source (ffmpeg без IDR не начнёт декодировать — ЕДИНСТВЕННЫЙ легитимный keyframe-запрос
  // из рендишн-контекста). Реестр живёт на source-дереве (оно «владеет» стримом). true =
  // рендишн есть/поднимается; false = недоступен (нет source / апскейл / нет агента).
  function ensureRendition(baseSid, rendition, preset) {
    const srcTree = mgr.trees.get(treeKey(baseSid, DEFAULT_RENDITION));
    if (!srcTree || !srcTree.broadcasterId) return false;
    if (rendition === DEFAULT_RENDITION || !RENDITIONS.has(rendition)) return false;
    if (!renditionAvailable(srcTree, rendition)) return false; // без апскейла
    if (!srcTree.renditions) srcTree.renditions = new Map();
    const now = Date.now();
    const cur = srcTree.renditions.get(rendition);
    if (cur && cur.state !== RS_STOPPING) { cur.lastConsumerAt = now; return true; }
    const agent = findVrelayAgent();
    if (!agent) { tlog(`[rendition] ${baseSid}::${rendition} нужен, но агент vrelay не подключён`); return false; }
    const presetBitrate = preset || RENDITION_BITRATE[rendition] || 0;
    srcTree.renditions.set(rendition, { state: RS_STARTING, lastConsumerAt: now, presetBitrate });
    const bc = srcTree.nodes.get(srcTree.broadcasterId);
    send(agent.id, { t: 'vrelay-rendition-start', streamId: baseSid, rendition, presetBitrate, serverId: bc ? bc.serverId : null });
    send(srcTree.broadcasterId, { t: 'request-keyframe', streamId: baseSid }); // IDR для старта ffmpeg
    tlog(`[rendition] ${baseSid}::${rendition} start -> агент ${agent.id} (preset ${Math.round(presetBitrate / 1000)} kbps)`);
    return true;
  }

  // Д4: гашение рендишна (idle 30с без потребителей / отказ агента / уход source-вещателя):
  // снимаем из реестра, просим агента убить ffmpeg+рендишн-корень (vrelay-rendition-stop),
  // остаточным потребителям (если есть) шлём rendition-unavailable — упадут на source.
  function teardownRendition(baseSid, rendition, reason) {
    const srcTree = mgr.trees.get(treeKey(baseSid, DEFAULT_RENDITION));
    const rkey = treeKey(baseSid, rendition);
    const rtree = mgr.trees.get(rkey);
    if (rtree) {
      for (const nid of rtree.nodes.keys()) {
        if (nid === rtree.broadcasterId) continue;
        send(nid, { t: 'rendition-unavailable', streamId: baseSid, rendition, reason: reason || 'stopped' });
      }
    }
    const agent = findVrelayAgent();
    if (agent) send(agent.id, { t: 'vrelay-rendition-stop', streamId: baseSid, rendition });
    if (srcTree && srcTree.renditions) srcTree.renditions.delete(rendition);
    tlog(`[rendition] ${baseSid}::${rendition} stop (${reason || 'idle'})`);
  }

  // Д4: перевод зрителя МЕЖДУ рендишн-деревьями (деревья разные → leave из старого + join в
  // новое; клиенту это assign-parent нового дерева, он пересоздаёт PC). Реюз менеджера:
  // mgr.leave репарентит детей узла в СТАРОМ дереве (натив-relay), mgr.join сажает узел в
  // новом (под рендишн-корень/vrelay или сиротой, пока корень поднимается). pinned=ручной
  // выбор (авто-ABR его не трогает). Используется onSetQuality (ручной) и perViewerAbr (авто).
  function moveNodeToRendition(baseSid, nodeId, targetRendition, opts) {
    const p = peers.get(nodeId);
    if (!p || !p.treeKey || p.role !== 'viewer') return false;
    if (parseTreeKey(p.treeKey).streamId !== baseSid) return false;
    const target = normRendition(targetRendition);
    const srcTree = mgr.trees.get(treeKey(baseSid, DEFAULT_RENDITION));
    if (!srcTree || !srcTree.broadcasterId) return false;
    if (target !== DEFAULT_RENDITION) {
      if (!renditionAvailable(srcTree, target)) { send(nodeId, { t: 'rendition-unavailable', streamId: baseSid, rendition: target, reason: 'no-upscale' }); return false; }
      if (!ensureRendition(baseSid, target)) { send(nodeId, { t: 'rendition-unavailable', streamId: baseSid, rendition: target, reason: 'unavailable' }); return false; }
    }
    const oldKey = p.treeKey;
    const newKey = treeKey(baseSid, target);
    if (oldKey === newKey) { p.qualityPinned = !!opts.pinned; return true; }
    const oldParentId = p.parent;
    const { reparented } = mgr.leave(oldKey, nodeId);
    if (oldParentId) send(oldParentId, { t: 'drop-peer', streamId: baseSid, peerId: nodeId });
    reparented.forEach((child) => {
      send(child.id, { t: 'assign-parent', streamId: baseSid, parentId: child.parent });
      if (child.parent) send(child.parent, { t: 'assign-child', streamId: baseSid, childId: child.id });
    });
    p.parent = null; p.children = []; p.depth = 0; p.reparentCooldownUntil = 0;
    p.rendition = target; p.treeKey = newKey; p.qualityPinned = !!opts.pinned;
    const { parent } = mgr.join(newKey, p);
    if (parent) {
      send(nodeId, { t: 'assign-parent', streamId: baseSid, parentId: parent.id });
      send(parent.id, { t: 'assign-child', streamId: baseSid, childId: nodeId });
    } else {
      send(nodeId, { t: 'assign-parent', streamId: baseSid, parentId: null }); // сирота: ждёт рендишн-корень
    }
    tlog(`[quality] ${p.identity} ${oldKey} -> ${newKey} (${opts.pinned ? 'pinned' : 'auto'})`);
    broadcastTreeInfo(oldKey); broadcastTopology(oldKey); settleOrphans(oldKey);
    broadcastTreeInfo(newKey); broadcastTopology(newKey); settleOrphans(newKey);
    if (target !== DEFAULT_RENDITION && srcTree.renditions) { const e = srcTree.renditions.get(target); if (e) e.lastConsumerAt = Date.now(); }
    return true;
  }

  // Д4: зритель просит сменить качество (ручной выбор в UI). rendition='auto' → снять pin +
  // на source (авто-ABR дальше адаптирует). Иначе pin на выбранный рендишн. Валидацию/лестницу/
  // ленивый старт делает moveNodeToRendition.
  function onSetQuality(id, msg) {
    const p = peers.get(id);
    if (!p || !p.treeKey || p.role !== 'viewer') return;
    const wantAuto = msg.rendition === 'auto';
    const target = wantAuto ? DEFAULT_RENDITION : normRendition(msg.rendition);
    moveNodeToRendition(p.streamId, id, target, { pinned: !wantAuto });
  }

  // Д4: агент не смог поднять рендишн (кап VRELAY_MAX_TRANSCODES / нет ingest / ffmpeg упал) —
  // снимаем рендишн из реестра, потребителям rendition-unavailable (упадут на source).
  function onVrelayRenditionFailed(id, msg) {
    const p = peers.get(id);
    if (!p || !p.isVrelayAgent) return;
    const base = msg.streamId;
    const rendition = normRendition(msg.rendition);
    if (!base || rendition === DEFAULT_RENDITION) return;
    tlog(`[rendition] ${base}::${rendition} FAILED от агента: ${msg.reason || ''}`);
    teardownRendition(base, rendition, msg.reason || 'agent-failed');
  }

  // Д4: пер-зрительский ABR. Прямому ребёнку СЕРВЕРНОГО узла (vrelay в source / рендишн-корень)
  // без пина и без детей (только листья — не рвём чужие поддеревья) с плохим линком → рендишн
  // ниже; с восстановившимся → выше. Гистерезис (BAD/GOOD-тики) + cooldown. Двигаем на СОСЕДНИЙ
  // доступный рунг. Стата берётся из stats родителя (vrelay/рендишн-корень репортят per-child
  // loss/rtt). Собираем ходы, применяем после обхода (moveNodeToRendition мутирует деревья).
  function perViewerAbr(now) {
    const moves = [];
    for (const [key, t] of mgr.trees) {
      const { streamId: base, rendition: treeRend } = parseTreeKey(key);
      const srcTree = mgr.trees.get(treeKey(base, DEFAULT_RENDITION));
      if (!srcTree || !srcTree.serverFirst) continue; // ABR-лестница — только server-first
      const rungs = availableRungs(srcTree);
      const idx = rungs.indexOf(treeRend);
      if (idx < 0) continue;
      for (const node of t.nodes.values()) {
        if (node.id === t.broadcasterId || node.qualityPinned) continue;
        if (node.children && node.children.length) continue; // листья — не тащим поддерево
        const parent = node.parent ? t.nodes.get(node.parent) : null;
        if (!parent) continue;
        const serverParent = parent.virtual || (parent.id === t.broadcasterId && treeRend !== DEFAULT_RENDITION);
        if (!serverParent) continue; // под живым пиром качество структурно, менять нечего
        if (!node.statsAt || now - node.statsAt > STATS_TTL_MS) { node.abrBad = 0; node.abrGood = 0; continue; }
        const loss = node.linkLoss || 0, rtt = node.linkRtt || 0;
        const bad = loss > ABR_LOSS_HI || rtt > ABR_RTT_HI;
        const good = loss < ABR_LOSS_LO && rtt < ABR_RTT_LO;
        if (bad) { node.abrBad = (node.abrBad || 0) + 1; node.abrGood = 0; }
        else if (good) { node.abrGood = (node.abrGood || 0) + 1; node.abrBad = 0; }
        else { node.abrBad = 0; node.abrGood = 0; }
        if (node.reparentCooldownUntil && now < node.reparentCooldownUntil) continue;
        let target = null;
        if (node.abrBad >= ABR_BAD_TICKS && idx < rungs.length - 1) target = rungs[idx + 1];
        else if (node.abrGood >= ABR_GOOD_TICKS && idx > 0) target = rungs[idx - 1];
        if (target && target !== treeRend) {
          node.abrBad = 0; node.abrGood = 0;
          tlog(`[quality] ABR ${node.identity} ${treeRend}->${target} (loss=${(loss * 100).toFixed(1)}% rtt=${Math.round(rtt)}ms)`);
          moves.push({ base, nodeId: node.id, target });
        }
      }
    }
    // moveNodeToRendition сбрасывает reparentCooldownUntil (свежее дерево) — cooldown против
    // болтанки ставим ПОСЛЕ переезда, иначе следующий тик двигал бы узел снова.
    for (const m of moves) {
      if (moveNodeToRendition(m.base, m.nodeId, m.target, { pinned: false })) {
        const p = peers.get(m.nodeId);
        if (p) p.reparentCooldownUntil = Date.now() + ABR_VIEWER_COOLDOWN_MS;
      }
    }
  }

  // Roadmap-flow-стриминга Д6: супер-сидеры. Исполнитель плана planServerSlotSwap — поднимает
  // сильного из глубины в прямой слот серверного узла, вытесняет слабого в глубину. Строго
  // ВНУТРИ одного рендишн-дерева (качество не меняется — наследование структурно, Д3). ≤1
  // рокировки на дерево за тик (анти-болтанка). Cooldown ставится на ОБА узла (общий с Д4-ABR
  // reparentCooldownUntil → перемещения Д4 и Д6 не дерутся). Возвращает число рокировок (тест).
  function arbitrateServerSlots(now) {
    let swaps = 0;
    for (const [key, t] of mgr.trees) {
      // Легаси-source-дерево (vrelay = fallback) не арбитрируем — им занимается drainTimer.
      if (parseTreeKey(key).rendition === DEFAULT_RENDITION && !t.serverFirst) continue;
      const plan = mgr.planServerSlotSwap(key, now);
      if (!plan) continue;
      const server = mgr.serverNode(key);
      const victim = t.nodes.get(plan.victimId);
      const candidate = t.nodes.get(plan.candidateId);
      if (!server || !victim || !candidate) continue;
      const sid = parseTreeKey(key).streamId;
      // Освобождаем слот: жертву делаем сиротой (drop-peer серверу — он закроет её child-PC).
      server.children = server.children.filter((cid) => cid !== victim.id);
      send(server.id, { t: 'drop-peer', streamId: sid, peerId: victim.id });
      victim.parent = null; victim.depth = 0;
      // Поднимаем кандидата в освободившийся слот серверного узла (штатный reparent).
      const res = mgr.reparent(key, candidate.id, server.id, now);
      if (!res.ok) {
        // Откат: возвращаем жертву под сервер (кандидат не влез — редко, гонка глубины).
        server.children.push(victim.id); victim.parent = server.id; victim.depth = server.depth + 1;
        send(victim.id, { t: 'assign-parent', streamId: sid, parentId: server.id });
        send(server.id, { t: 'assign-child', streamId: sid, childId: victim.id });
        continue;
      }
      candidate.vrelayPinned = false; // поднят авто-арбитражем, не ручным «через сервер»
      candidate.reparentCooldownUntil = now + D6_SWAP_COOLDOWN_MS;
      victim.reparentCooldownUntil = now + D6_SWAP_COOLDOWN_MS;
      tlog(`[${key}] Д6 супер-сидер: ↑${candidate.identity} (up=${Math.round(plan.candidateUpload / 1000)}k) в слот сервера, ↓${victim.identity} (up=${Math.round(plan.victimUpload / 1000)}k) в глубину`);
      // applyReparent шлёт сообщения кандидату/серверу/старому родителю + settleOrphans разместит
      // осиротевшую жертву (у поднятого кандидата теперь есть свободная ёмкость, cap≥1).
      applyReparent(key, candidate.id, res);
      // Жертва с поддеревом (редко — обычно вытесняем лист): пересчёт глубин её ветки после посадки.
      if (victim.parent && victim.children && victim.children.length) mgr.updateSubtreeDepth(t, victim.id);
      swaps++;
    }
    return swaps;
  }

  // Discovery-сокет (браузер/натив, никогда не joins) сообщает свой сервер здесь —
  // до этого сообщения бэклог живых стримов не шлём (см. wss.on('connection')).
  function onHello(id, msg) {
    const node = peers.get(id);
    if (!node) return;
    node.serverId = msg.serverId || null;
    // Discovery агрегирует по БАЗОВОМУ streamId: объявляем только source-деревья (рендишн-деревья —
    // деталь транспорта, свой broadcaster=рендишн-корень, в discovery не светятся). renditions[] —
    // задел Д4 (пока всегда ['source']).
    for (const [key, t] of mgr.trees) {
      if (!t.broadcasterId) continue;
      if (parseTreeKey(key).rendition !== DEFAULT_RENDITION) continue;
      const bnode = t.nodes.get(t.broadcasterId);
      if (bnode && bnode.serverId === node.serverId) send(id, { t: 'stream-live', streamId: bnode.streamId, identity: bnode.identity, initial: true, renditions: renditionsOf(bnode.streamId), appName: bnode.appName || null, appIcon: bnode.appIcon || null });
    }
  }

  function onJoin(id, msg) {
    const { streamId, role, native, identity, symmetricNat, serverId, maxChildren, maxBitrate, abr } = msg;
    if (!streamId || (role !== 'broadcaster' && role !== 'viewer')) return;
    // Д3: ключ дерева = `streamId::rendition`. Нет поля quality (старый бандл) → 'source'
    // (обратная совместимость). Мусор в quality нормализуется в 'source' (normRendition).
    // Базовый streamId уходит в клиентские сообщения/discovery; составной ключ — только для
    // менеджера/маршрутизации внутри сервера (в UI не течёт).
    const rendition = normRendition(msg.quality);
    const key = treeKey(streamId, rendition);
    const node = peers.get(id);
    node.streamId = streamId; node.rendition = rendition; node.treeKey = key;
    node.role = role; node.native = !!native; node.identity = identity || id;
    node.symmetricNat = !!symmetricNat;
    node.serverId = serverId || node.serverId || null;
    node.maxChildren = typeof maxChildren === 'number' ? maxChildren : undefined;
    // Д1 server-first: вещатель с serverIngest:true при включённом флаге переводит ДЕРЕВО в
    // режим «стример → сервер → зрители». Помечаем дерево до join'а (scoreParent/pickParent
    // читают t.serverFirst). Дефолт ёмкости корня в этом режиме = 1 (единственный слот под
    // vrelay), но ручное значение из UI уважаем. Обратная совместимость: нет serverIngest —
    // legacy даже при TREE_SERVER_FIRST=1.
    node.serverIngest = !!msg.serverIngest;
    if (SERVER_FIRST && node.serverIngest && role === 'broadcaster') {
      const tj = mgr.tree(key);
      tj.serverFirst = true;
      if (node.maxChildren === undefined) node.maxChildren = 1;
    }
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
    // Д4: ручной выбор качества (pin) переживает пересоздание watch-сокета (смена качества =
    // unwatch+watch на клиенте): pin приходит в join нового дерева. Авто-ABR pinned не трогает.
    node.qualityPinned = role === 'viewer' && !!msg.pinned;
    node.abrBad = 0; node.abrGood = 0;
    node.parent = null; node.children = []; node.depth = 0;
    const { parent } = mgr.join(key, node);
    // Д4: выходное разрешение вещателя (натив знает своё) — режем лестницу рендишнов сверху
    // (без апскейла). Реестр рендишнов живёт на source-дереве. Нет width/height (старый бандл) —
    // не режем (см. availableRungs).
    if (role === 'broadcaster' && rendition === DEFAULT_RENDITION) {
      const t = mgr.trees.get(key);
      if (t) {
        t.srcWidth = Number(msg.width) || 0;
        t.srcHeight = Number(msg.height) || 0;
        if (!t.renditions) t.renditions = new Map();
      }
    }
    // Д4: рендишн-корень (broadcaster в base::rendition) заджойнился — помечаем рендишн live
    // в реестре source-дерева (был starting с момента vrelay-rendition-start).
    if (role === 'broadcaster' && rendition !== DEFAULT_RENDITION) {
      const srcTree = mgr.trees.get(treeKey(streamId, DEFAULT_RENDITION));
      const e = srcTree && srcTree.renditions && srcTree.renditions.get(rendition);
      if (e) { e.state = RS_LIVE; tlog(`[rendition] ${streamId}::${rendition} live (корень заджойнился)`); }
    }
    tlog(`[${key}] join ${id} ${role} identity=${node.identity} native=${node.native}${node.virtual ? ' VIRTUAL' : ''} cap=${mgr.capacityOf(node)} symNat=${node.symmetricNat} -> ${role === 'broadcaster' ? 'корень' : parent ? `parent ${parent.id} (depth ${node.depth})` : 'СИРОТА (нет кандидатов)'}`);
    if (parent) {
      if (parent.virtual) node.reparentCooldownUntil = Date.now() + DRAIN_COOLDOWN_MS;
      send(id, { t: 'assign-parent', streamId, parentId: parent.id });
      send(parent.id, { t: 'assign-child', streamId, childId: id });
    } else {
      send(id, { t: 'assign-parent', streamId, parentId: null });
    }
    broadcastTreeInfo(key);
    broadcastTopology(key);
    // Новый узел мог дать ёмкость (relay-способный зритель) или это вернувшийся вещатель —
    // размещаем зависших сирот. Для вещателя это подхватывает зрителей, ждавших стрим.
    settleOrphans(key);
    // Д1 server-first: вещатель вошёл — сразу поднимаем постоянный vrelay-ingest медиаузел,
    // НЕ дожидаясь сирот (в legacy vrelay будится только при отсутствии живых кандидатов).
    // requestVrelayActivation сам выберет тип сообщения (vrelay-ingest для serverFirst) и
    // откажет не-source-дереву (рендишн-корень server-first не помечается).
    {
      const t = mgr.trees.get(key);
      if (role === 'broadcaster' && t && t.serverFirst) {
        tlog(`[${key}] server-first: поднимаю постоянный vrelay-ingest`);
        requestVrelayActivation(key);
      }
    }
    // Э9: виртуал вошёл — активация состоялась; выполняем отложенные ручные запросы
    // «через сервер» (зрители, попросившие vrelay до его джойна).
    if (node.virtual) {
      const t = mgr.trees.get(key);
      if (t) {
        t.vrelayActivateAt = 0;
        // Д1: в server-first виртуал — постоянный pinned узел (дренаж его не трогает).
        if (t.serverFirst) node.vrelayPinned = true;
        ensureVirtualAttached(key); // дерево могло быть забито — выселяем жертву из-под корня
        if (t.vrelayPending && t.vrelayPending.size) {
          const now = Date.now();
          const attached = mgr.attachedToRoot(t, node);
          for (const pid of t.vrelayPending) {
            const pn = t.nodes.get(pid);
            if (!pn) continue;
            if (!attached) { send(pid, { t: 'reparent-denied', streamId, reason: 'no-vrelay' }); continue; }
            if (pn.parent === id) { pn.vrelayPinned = true; continue; }
            const res = mgr.reparent(key, pid, id, now);
            if (res.ok) { pn.vrelayPinned = true; applyReparent(key, pid, res); }
          }
          t.vrelayPending.clear();
        }
      }
    }
    // Д4: зритель заджойнился в рендишн-дерево (`base::rendition`) — ленивый старт транскода,
    // если рендишн ещё не поднят. Зритель ждёт сиротой, пока рендишн-корень не заджойнится
    // (settleOrphans досадит). Недоступен (нет source / апскейл / нет агента) → rendition-unavailable
    // (клиент упадёт на source).
    if (role === 'viewer' && rendition !== DEFAULT_RENDITION) {
      if (!ensureRendition(streamId, rendition)) send(id, { t: 'rendition-unavailable', streamId, rendition, reason: 'unavailable' });
    }
    // Discovery объявляет базовый streamId и ТОЛЬКО для source-дерева (рендишн-корень —
    // тоже role:broadcaster, но своего base::rendition-дерева, в discovery не светится:
    // иначе дубль/мусор с identity вида `vrelay-480`). renditions[] — реальная лестница (Д4).
    if (role === 'broadcaster' && rendition === DEFAULT_RENDITION) {
      broadcastToServer(node.serverId, { t: 'stream-live', streamId, identity: node.identity, initial: false, renditions: renditionsOf(streamId), appName: node.appName || null, appIcon: node.appIcon || null });
    }
  }

  function onSignal(id, msg) {
    const p = peers.get(id);
    if (!p || !p.streamId || !msg.to) return;
    send(msg.to, { t: msg.t, streamId: p.streamId, from: id, type: msg.type, sdp: msg.sdp, candidate: msg.candidate });
  }

  // Roadmap-flow-стриминга Д5: релей preflight-probe замера upload. Как onSignal, но адресация:
  // вещатель (webview, обычный сокет) шлёт probe-* БЕЗ `to` — маршрутизируем единственному
  // vrelay-агенту, помечая `from` (агент — probe-приёмник, дропает трек). Агент отвечает с
  // явным `to` (peer-id вещателя, узнал из from) — шлём адресату. probe-start будит приёмник,
  // probe-offer/answer/ice — SDP/ICE. Не требует join (probe идёт до старта вещания).
  function onProbe(id, msg) {
    const p = peers.get(id);
    if (!p) return;
    if (p.isVrelayAgent) { // агент → вещатель (по явному to)
      if (msg.to) send(msg.to, { t: msg.t, from: id, sdp: msg.sdp, candidate: msg.candidate });
      return;
    }
    const agent = findVrelayAgent(); // вещатель → агент
    if (!agent) { send(id, { t: 'probe-unavailable', reason: 'no-agent' }); return; }
    send(agent.id, { t: msg.t, from: id, sdp: msg.sdp, candidate: msg.candidate });
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
  function applyReparent(key, nodeId, res) {
    const sid = parseTreeKey(key).streamId;
    tlog(`[${key}] reparent ${nodeId}: ${res.oldParentId || '-'} -> ${res.newParentId}`);
    if (res.oldParentId) send(res.oldParentId, { t: 'drop-peer', streamId: sid, peerId: nodeId });
    send(nodeId, { t: 'assign-parent', streamId: sid, parentId: res.newParentId });
    if (res.newParentId) send(res.newParentId, { t: 'assign-child', streamId: sid, childId: nodeId });
    broadcastTreeInfo(key);
    broadcastTopology(key);
    settleOrphans(key); // миграция могла освободить слот — подхватываем сирот
  }

  // Э9: зритель явно попросил «смотреть через сервер» (targetParentId='vrelay'). Виртуал
  // уже в дереве — обычный ручной reparent на него; нет — будим агента и запоминаем
  // запрос (исполнится в onJoin виртуала). Pin защищает от дренажа: раз выбрал сам —
  // не уводим обратно, пока сам не мигрирует.
  function onRequestVrelay(id) {
    const p = peers.get(id);
    if (!p || !p.treeKey) return;
    const key = p.treeKey;
    const t = mgr.trees.get(key);
    if (!t || !t.broadcasterId) return;
    let virt = findVirtual(t);
    const now = Date.now();
    // Всегда усаживаем виртуала прямым ребёнком корня перед reparent: он мог быть сиротой (забитое
    // дерево) ИЛИ зарыт под самого запросившего (тогда attachedToRoot=true, но reparent на него дал
    // бы цикл). ensureVirtualAttached идемпотентен — если виртуал уже под корнем, ничего не делает.
    if (virt) { ensureVirtualAttached(key); virt = findVirtual(t); }
    if (virt && mgr.attachedToRoot(t, virt)) {
      if (p.parent === virt.id) { p.vrelayPinned = true; return; }
      const res = mgr.reparent(key, id, virt.id, now);
      if (!res.ok) { send(id, { t: 'reparent-denied', streamId: p.streamId, reason: res.reason }); return; }
      p.vrelayPinned = true;
      applyReparent(key, id, res);
      return;
    }
    if (!requestVrelayActivation(key)) {
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
    if (!p || !p.treeKey) return;
    if (msg.targetParentId === VRELAY_TARGET) return onRequestVrelay(id);
    const key = p.treeKey;
    const now = Date.now();
    const res = mgr.reparent(key, id, msg.targetParentId || null, now);
    if (!res.ok) {
      // Реаттач к тому же родителю. Кейс «корень + единственный зритель»: pickParent
      // исключает текущего родителя, других кандидатов нет → no-candidate, и зритель с
      // упавшим ICE (при живом WS) фризил бы навсегда. Пересоздаём PC с тем же родителем
      // (drop-peer родителю -> assign-parent узлу -> assign-child родителю) — это свежий
      // PC = фактический ICE-restart (мы answerer, restart_ice сами инициировать не можем).
      // Топология не меняется. Cooldown как у обычной миграции — против спама.
      if (!msg.targetParentId && res.reason === 'no-candidate' && p.parent) {
        const t = mgr.trees.get(key);
        const parent = t && t.nodes.get(p.parent);
        if (parent && (!p.reparentCooldownUntil || now >= p.reparentCooldownUntil)) {
          p.reparentCooldownUntil = now + REPARENT_COOLDOWN_MS;
          tlog(`[${key}] reattach ${id} (${p.identity}) к тому же родителю ${p.parent} (ICE-restart, no-candidate)`);
          send(p.parent, { t: 'drop-peer', streamId: p.streamId, peerId: id });      // родитель закрывает старый child-PC
          send(id, { t: 'assign-parent', streamId: p.streamId, parentId: p.parent }); // узел сбрасывает upstream, ждёт offer
          send(p.parent, { t: 'assign-child', streamId: p.streamId, childId: id });   // родитель поднимает свежий PC + offer
          return;
        }
      }
      tlog(`[${key}] reparent-denied ${id} (${p.identity}) target=${msg.targetParentId || 'auto'} reason=${res.reason}`);
      send(id, { t: 'reparent-denied', streamId: p.streamId, reason: res.reason }); return;
    }
    // Pin «через сервер» живёт, пока зритель сам не мигрировал; ручной выбор виртуала
    // по его peer-id из панели дерева — тоже осознанный выбор, пиним.
    const t = mgr.trees.get(key);
    const newParent = t && t.nodes.get(res.newParentId);
    p.vrelayPinned = !!(newParent && newParent.virtual && msg.targetParentId);
    applyReparent(key, id, res);
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
    for (const [key, t] of mgr.trees) {
      if (!t.broadcasterId || findVirtual(t)) continue;
      let needs = !!(t.vrelayPending && t.vrelayPending.size);
      if (!needs) for (const n of t.nodes.values()) { if (n.id !== t.broadcasterId && !n.parent) { needs = true; break; } }
      if (needs) requestVrelayActivation(key); // сам откажет не-source-дереву
    }
  }

  // Э8: relay-узел (натив passthrough) не энкодит и сам IDR не сделает — при подключении
  // нового ребёнка просит keyframe у корня. Релеим прямо вещателю (он форсит IDR глобально).
  function onRequestKeyframe(id) {
    const p = peers.get(id);
    if (!p || !p.treeKey) return;
    const t = mgr.trees.get(p.treeKey);
    if (!t || !t.broadcasterId) return;
    // Д3: корень дерева = broadcaster ЭТОГО дерева. Для source-дерева — нативный вещатель
    // (форсит IDR). Для рендишн-дерева корень = рендишн-корень (vrelay/ffmpeg), который
    // request-keyframe игнорирует (держит свой GOP) — так PLI из рендишна НЕ уходит нативному
    // вещателю (нет IDR-шторма через деревья). Rate-limit lastKfForwardAt — на КАЖДОМ дереве свой.
    const now = Date.now();
    if (t.lastKfForwardAt && now - t.lastKfForwardAt < KF_FORWARD_MIN_MS) return;
    t.lastKfForwardAt = now;
    send(t.broadcasterId, { t: 'request-keyframe', streamId: p.streamId });
  }

  // DEV-ТРИГГЕР Д2 (удаляется в Д8): ручной подъём/гашение рендишна. Д4: адаптирован тонкой
  // обёрткой над настоящим механизмом (ensureRendition/teardownRendition) — идёт через реестр
  // рендишнов, не в обход него (иначе dev-старт не завёл бы запись реестра, а гашение по idle
  // не сработало бы). Гейт DEV_RENDITION. msg: { t:'dev-rendition', streamId, rendition?='480', stop?, presetBitrate? }.
  function onDevRendition(id, msg) {
    if (!DEV_RENDITION) return;
    const streamId = msg.streamId;
    const rendition = typeof msg.rendition === 'string' ? msg.rendition : '480';
    if (!streamId) return;
    if (msg.stop) { teardownRendition(streamId, rendition, 'dev-stop'); return; }
    if (!ensureRendition(streamId, rendition, Number(msg.presetBitrate) || 0)) tlog(`[rendition] DEV ${streamId}::${rendition} не удалось поднять`);
  }

  // Д3: уход source-вещателя = смерть ВСЕХ рендишн-деревьев этого стрима (`base::*`, кроме
  // `::source`). Иначе они повиснут (их корни-рендишн — отдельные узлы, drop-peer сами не
  // получат от source-коллапса). Сносим узлы + просим агента погасить транскод-рендишны.
  function teardownRenditionTrees(baseSid, serverId) {
    let agent = null;
    for (const ap of peers.values()) if (ap.isVrelayAgent && ap.ws.readyState === ap.ws.OPEN) { agent = ap; break; }
    for (const [key, t] of [...mgr.trees]) {
      const { streamId: base, rendition } = parseTreeKey(key);
      if (base !== baseSid || rendition === DEFAULT_RENDITION) continue;
      for (const nid of [...t.nodes.keys()]) {
        send(nid, { t: 'drop-peer', streamId: baseSid, peerId: nid });
        send(nid, { t: 'stream-end', streamId: baseSid, identity: base });
      }
      t.nodes.clear(); t.broadcasterId = null;
      mgr.trees.delete(key);
      if (agent) send(agent.id, { t: 'vrelay-rendition-stop', streamId: baseSid, rendition });
      tlog(`[${key}] снесён вслед за уходом source-вещателя ${baseSid}`);
    }
  }

  function onLeave(id, reason = 'leave') {
    const p = peers.get(id);
    if (!p || !p.treeKey) { peers.delete(id); return; }
    peers.delete(id);
    const key = p.treeKey;
    const sid = p.streamId; // базовый id в клиентских сообщениях (не составной ключ)
    tlog(`[${key}] leave ${id} (${p.identity}${p.role === 'broadcaster' ? ', ВЕЩАТЕЛЬ' : ''}${p.virtual ? ', VIRTUAL' : ''}) причина: ${reason}; детей: ${p.children.length}`);
    const oldParentId = p.parent;
    const pendingTree = mgr.trees.get(key);
    if (pendingTree && pendingTree.vrelayPending) pendingTree.vrelayPending.delete(id); // Э9: ушедший не ждёт vrelay
    const { reparented, dropped, broadcasterLost } = mgr.leave(key, id);
    if (broadcasterLost) {
      tlog(`[${key}] дерево обрушено (ушёл вещатель), зрителей сброшено: ${dropped.length}`);
      dropped.forEach((peerId) => {
        send(peerId, { t: 'drop-peer', streamId: sid, peerId: id });
        // Конец вещания — терминальный сигнал и в watch-сокет: drop-peer ловят только
        // зрители глубины 1 (у остальных parentId — id relay-узла, не вещателя), а
        // discovery-stream-end зритель мог пропустить (окно реконнекта).
        send(peerId, { t: 'stream-end', streamId: sid, identity: p.identity });
        // Э9: виртуалу при обрушении дерева нужен явный release — drop-peer по каждому его
        // ребёнку сервер не шлёт, и без release он ждал бы своего idle-таймаута впустую.
        const dp = peers.get(peerId);
        if (dp && dp.virtual) send(peerId, { t: 'vrelay-release', streamId: sid });
      });
      // Discovery-конец объявляем только для source-дерева (рендишн-корень в discovery не
      // светился — его stream-end погасил бы у зрителей ЖИВОЙ source-стрим). Заодно сносим
      // рендишн-деревья этого стрима.
      if (p.rendition === DEFAULT_RENDITION) {
        broadcastToServer(p.serverId, { t: 'stream-end', streamId: sid, identity: p.identity });
        teardownRenditionTrees(sid, p.serverId);
      }
      return;
    }
    if (oldParentId) send(oldParentId, { t: 'drop-peer', streamId: sid, peerId: id });
    reparented.forEach((child) => {
      send(child.id, { t: 'assign-parent', streamId: sid, parentId: child.parent });
      if (child.parent) send(child.parent, { t: 'assign-child', streamId: sid, childId: child.id });
    });
    broadcastTreeInfo(key);
    broadcastTopology(key);
    settleOrphans(key); // ушедший освободил ёмкость — подхватываем сирот
  }

  wss.on('connection', (ws) => {
    const id = newPeerId();
    // Heartbeat: помечаем живым, pong сбрасывает флаг. Мёртвый (полуоткрытый TCP —
    // мобильный NAT, засыпание) иначе висел бы до ОС-таймаута минутами, а всё поддерево
    // под мёртвым relay — без drop-peer/reparent.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    peers.set(id, {
      id, ws, streamId: null, treeKey: null, rendition: null, role: null, native: false, identity: id, serverId: null,
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
      else if (msg.t === 'set-quality') onSetQuality(id, msg);                       // Д4: ручной выбор качества
      else if (msg.t === 'vrelay-rendition-failed') onVrelayRenditionFailed(id, msg); // Д4: агент не поднял рендишн
      else if (msg.t === 'probe-start' || msg.t === 'probe-offer' || msg.t === 'probe-answer' || msg.t === 'probe-ice') onProbe(id, msg); // Д5: замер upload
      else if (msg.t === 'dev-rendition') onDevRendition(id, msg); // DEV-ТРИГГЕР Д2 (гейт внутри)
    });
    // code 1006 = грязный обрыв TCP (без close-фрейма): краш клиента, потеря сети,
    // heartbeat-terminate (см. hbTimer — он логирует свой terminate отдельно).
    ws.on('close', (code) => onLeave(id, `ws close code=${code}`));
    send(id, { t: 'welcome', id, iceServers: iceServersFor(ws.__uid) });
  });

  // Э8 ABR: раз в тик пересчитываем целевой битрейт каждого дерева и шлём корню, если сменился.
  const abrTimer = setInterval(() => {
    for (const key of mgr.trees.keys()) {
      // Д3: ABR/set-bitrate — только для source-дерева. Рендишн-корень = ffmpeg с фикс. GOP/CBR,
      // set-bitrate ему бессмыслен (abrTick и так вернёт null: у рендишн-корня abr:false). Гейт
      // для явности и на случай будущих рендишн-корней с abr.
      if (parseTreeKey(key).rendition !== DEFAULT_RENDITION) continue;
      const cmd = mgr.abrTick(key);
      if (cmd) {
        tlog(`[${key}] ABR -> ${Math.round(cmd.bitrate / 1000)} kbps (worst loss=${(cmd.worstLoss * 100).toFixed(1)}% rtt=${Math.round(cmd.worstRtt)}ms)`);
        send(cmd.broadcasterId, { t: 'set-bitrate', streamId: parseTreeKey(key).streamId, bps: cmd.bitrate });
      }
    }
    // Д4: пер-зрительский ABR — переводит прямых детей сервера между рендишн-деревьями по их
    // личному линку (глобальный set-bitrate выше в server-first вырождается в линки корня;
    // адаптация зрителей — здесь, чтобы один медленный зритель не тянул всех вниз).
    // perViewerAbr (Д4, качество) идёт ПЕРЕД arbitrateServerSlots (Д6, топология): оба узла
    // помечают reparentCooldownUntil при переезде и проверяют его перед своим — свежедёрнутый
    // одним не берётся другим в этом же и следующих тиках (общее поле = взаимоисключение).
    const nowT = Date.now();
    perViewerAbr(nowT);
    arbitrateServerSlots(nowT); // Д6: супер-сидеры — сильные upload в прямые слоты сервера
  }, ABR_TICK_MS);
  abrTimer.unref?.(); // не держим процесс живым только ради ABR-тика

  // Д4: гашение рендишнов без потребителей. Тик считает потребителей в каждом base::rendition
  // (узлы кроме рендишн-корня, включая сирот, ждущих корень); есть потребители → освежаем
  // lastConsumerAt, нет дольше RENDITION_IDLE_MS → teardownRendition (kill ffmpeg + снос дерева).
  const renditionTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, t] of [...mgr.trees]) {
      if (parseTreeKey(key).rendition !== DEFAULT_RENDITION) continue;
      if (!t.renditions || !t.renditions.size) continue;
      const base = parseTreeKey(key).streamId;
      for (const [rendition, entry] of [...t.renditions]) {
        const rtree = mgr.trees.get(treeKey(base, rendition));
        let consumers = 0;
        if (rtree) for (const n of rtree.nodes.values()) if (n.id !== rtree.broadcasterId) consumers++;
        if (consumers > 0) { entry.lastConsumerAt = now; continue; }
        if (now - entry.lastConsumerAt >= RENDITION_IDLE_MS) teardownRendition(base, rendition, 'idle');
      }
    }
  }, RENDITION_TICK_MS);
  renditionTimer.unref?.();

  // Э9: дренаж виртуала — живые пиры всегда предпочтительнее серверного фолбэка.
  // R1 (мягкий): <=1 ребёнка за тик на дерево уводим на живого кандидата (авто-reparent
  // сам исключит виртуала как текущего родителя). Pinned («через сервер» руками) и
  // свежепосаженные (cooldown) не трогаются.
  // R2 (выселение): R1 никого не увёл, но живой ёмкости хватает на всех детей виртуала —
  // шлём vrelay-release: штатный mgr.leave() сам репарентит детей. Лечит дедлок «виртуал
  // занял единственный слот корня, пришедшему нативу некуда сесть, виртуал не пустеет».
  const drainTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, t] of mgr.trees) {
      // Д1: в server-first vrelay — постоянный медиаузел, не дренируется и не выселяется
      // (дренаж/idle-exit только для legacy-фолбэка). Пропускаем такое дерево целиком.
      if (t.serverFirst) continue;
      const virt = findVirtual(t);
      if (!virt || !virt.children.length) continue;
      const sid = parseTreeKey(key).streamId;
      let moved = false;
      for (const cid of [...virt.children]) {
        const child = t.nodes.get(cid);
        if (!child || child.vrelayPinned) continue;
        if (child.reparentCooldownUntil && now < child.reparentCooldownUntil) continue;
        const res = mgr.reparent(key, cid, null, now);
        if (res.ok) {
          child.reparentCooldownUntil = now + DRAIN_COOLDOWN_MS;
          applyReparent(key, cid, res);
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
        tlog(`[${key}] дренаж R2: живой ёмкости хватает (${free} >= ${virt.children.length}) — vrelay-release ${virt.id}`);
        send(virt.id, { t: 'vrelay-release', streamId: sid });
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

  // Кто прямо сейчас вещает (нативный tree-стрим) в данном сервере — по активным broadcaster-пирам.
  // Для превью на главной (кто в сети и что делает). identity дерева = базовый username.
  function liveBroadcastersIn(serverId) {
    const out = new Set();
    for (const p of peers.values()) {
      // Д3: только source-вещатели (рендишн-корни — тоже role:broadcaster, но их identity
      // вида `vrelay-480` в превью не место). Дедуп по базовому username — на стрим один source.
      if (p.role === 'broadcaster' && p.rendition === DEFAULT_RENDITION && p.serverId === serverId && p.identity) out.add(String(p.identity).split('#')[0]);
    }
    return out;
  }

  return { mgr, peers, wss, abrTimer, hbTimer, drainTimer, renditionTimer, liveBroadcastersIn, arbitrateServerSlots };
}

module.exports = { attachTreeServer, TreeManager, MAX_DEPTH, NATIVE_CAPACITY, BROWSER_CAPACITY, treeKey, parseTreeKey };
