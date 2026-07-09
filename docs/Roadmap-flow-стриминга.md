# Роадмап: переработка flow доставки стрима — «сервер-первый» + серверный транскод

Рабочий документ Д-серии. Исходное ТЗ: «ТЗ-таргет-flow-стриминга» (стример → сервер → дерево зрителей).
Каждый майлстоун: Тестируется при выполнение всего плана. Требуется составить план проверок. Отметки прогресса — в секциях «Выполнено / Проблемы / Решения» внутри майлстоуна.

## Целевая картина

Нативный вещатель отправляет **один поток на VPS** (ingest в vrelay-медиаузел) → vrelay раздаёт прямым зрителям → нативные зрители ретранслируют дальше (≤2 детей при запасе upload, глубина ≤5, обмен строго внутри одного качества). Транскод рендишнов **1080/720/480(/360)** — ffmpeg-процессы при vrelay, **по требованию**, source = passthrough без транскода. Браузер — строго лист. Рамки: до ~30 зрителей, e2e-задержка **< 2 с**, NAT через TURN.

## Принятые решения

1. **Транскод** — ffmpeg child-процессы под управлением Rust relay-агента (vrelay эволюционирует из fallback в постоянный медиаузел); source — passthrough.
2. **LiveKit-путь браузерного вещания** (VP8/SFU, `engine.share()`) — не трогаем, остаётся параллельным путём.
3. **Э8 браузерный транскод-relay** — удаляется, браузер снова строго лист.
4. **Замер upload вещателя** — preflight WebRTC-probe до серверного узла (~3–5 с, чтение BWE).
5. **Кодек** — H.264 low-latency без B-кадров везде (CBR-пресеты из таблицы ТЗ).
6. ТЗ отменяет инварианты CLAUDE.md №1 (видео не через сервер), №7 (сервер не транскодирует), №9 (≤3 с → <2 с) — документы обновляются в Д0.

## Сквозные проектные решения

- **Ключ дерева = `streamId::rendition`**, rendition ∈ {source, 1080, 720, 480, 360}. `TreeManager.trees` остаётся Map — меняется только ключ. «Обмен строго внутри одного качества» получается структурно: pickParent/reparent работают внутри одного Tree. Discovery объявляет базовый `streamId` + список доступных рендишнов; UI-ключ у зрителя — базовый `streamId`.
- **Фича-флаг `TREE_SERVER_FIRST`** (env сервера) + `serverIngest:true` в join вещателя. Режимы `legacy` (текущий: vrelay = fallback с дренажом) и `server-first` живут параллельно до Д8. Откат = снять env. Старые клиенты без поля работают по-старому.
- **vrelay в server-first**: в source-дереве — pinned прямой ребёнок корня (реюз `ensureVirtualAttached`, tree.js:471-514); в рендишн-деревьях — **корень** (медиа рождается в его ffmpeg). Дренаж (drainTimer) и idle-exit 60 с — только для legacy.
- **Глобальный AIMD-ABR** (abrTick, tree.js:313-353) в server-first вырождается: остаётся только на source-дереве по линкам корня. Адаптация зрителей — переводом между рендишн-деревьями (Д4). Это закрывает признанную проблему «один медленный зритель тянет всех вниз» (tree.js:19-21).
- **Keyframe пер-рендишн**: ffmpeg-энкод держит GOP 1–2 с — новый зритель ждёт ≤2 с; `request-keyframe` к вещателю — только для source-дерева и при старте рендишна. Убирает IDR-шторма через все деревья.
- **MAX_DEPTH 4→5** (tree.js:13), считается внутри каждого рендишн-дерева от его корня. Латентность держим не глубиной, а тем, что дефолт — глубина 1–2 (сервер-первый).

## Новые сообщения протокола (вводятся помайлстоунно)

| Сообщение | Направление | Майлстоун |
|---|---|---|
| `join {…, quality, serverIngest}` | клиент→сервер | Д1 (serverIngest), Д3 (quality) |
| `stream-live {…, renditions[]}` | сервер→клиенты | Д3/Д4 |
| `set-quality {streamId, rendition}` | зритель→сервер | Д4 |
| `vrelay-ingest {streamId}` | сервер→агент | Д1 |
| `vrelay-rendition-start/stop {streamId, rendition, presetBitrate}` | сервер→агент | Д2/Д4 |
| `probe-start` / `probe-offer/answer/ice` | вещатель↔сервер↔агент | Д5 |
| `stats {…, framesDroppedPct}` (опц.) | зритель→сервер | Д7 |

## Деплой-дисциплина

- Серверные правки tree.js всегда обратно-совместимы с прошлым клиентским бандлом (join без новых полей = старое поведение).
- Рискованное впереди: Д1 (постоянный серверный медиапуть) и Д2 (транскод-спайк) — до переделок протокола/UI. Провал Д2 по латентности = пересмотр движка (план Б) до Д3.
- Зависимости: Д3←Д2, Д4←Д3, Д5←Д1 (параллелится с Д3/Д4), Д6/Д7←Д4.
- Rust — только через CI (`build-windows.yml`); деплой vrelay (`deploy.yml`) рвёт живые стримы — деплоить в окна без стримов.

> Примечание: `docs/Evolution-TZ.md`, `docs/audio-capture-fix.md`, `docs/fps-fix.md` удалены в рабочей копии (незакоммичено). Решение в Д0 — дефолт: закоммитить удаление, этот файл становится главным рабочим доком (CLAUDE.md перевести на него).

---

## Д0 — Документы + браузер снова строго лист (снос Э8)

**Статус:** 🟡 код готов (`0fc2e4e`), живой AC не проверен
**Цель / механизмы ТЗ:** зафиксировать новые инварианты; «браузер — лист».

**Работы:**
- `CLAUDE.md`: переписать инварианты №1, №3, №7, №9, №10; убрать «транскод на сервере» из Non-goals; указать этот роадмап как рабочий док.
- Разрулить удалённые docs (см. примечание выше).
- `apps/web/src/transport/treeVideo.ts`: удалить relay-путь — `serveChild` (:520-553), `reportChildStats` (:301) + statsTimer, `BROWSER_RELAY_CAPACITY` (:49), `canEncodeH264` (:97); join всегда `maxChildren: 0`; упростить `assign-child`/child-ветки в `sdp`/`ice`/`drop-peer`.
- `apps/server/tree.js`: гард — `capacityOf` (:82-88) принудительно 0 для не-натив/не-виртуал узлов (защита от старых закэшированных бандлов).

**AC (смоук):** браузерный зритель смотрит tree-стрим; при 3+ зрителях браузеры не получают `assign-child`; сироты уходят в vrelay-fallback как раньше; голос/чат/LiveKit-вещание из браузера целы.
**Риски:** нагрузка на vrelay растёт уже здесь (приемлемо — Д1 делает его постоянным).

### Выполнено:
- Коммит `0fc2e4e` (не запушен).
- `CLAUDE.md`: инварианты №1 (сервер = постоянный медиаузел, не фолбэк), №3 (браузер строго лист, Э8-исключение убрано), №4/№7 (сервер транскодирует рендишны по требованию, source passthrough), №9 (цель <2с), №10 (задел на `streamId::rendition`). Non-goals: убран «транскод на сервере». Этот роадмап объявлен главным рабочим доком.
- `git rm docs/Evolution-TZ.md docs/audio-capture-fix.md docs/fps-fix.md` (решение из примечания — закоммитить удаление). Сам роадмап добавлен в историю (был untracked).
- `treeVideo.ts`: снесён Э8-relay — `serveChild`, `reportChildStats`+statsTimer, `BROWSER_RELAY_CAPACITY`, `canEncodeH264`, поля `recvVideo`/`recvAudio`/`children`/`pendingChildren` в `WatchState`. join браузера всегда `maxChildren:0`. `assign-child` → no-op-лог. `sdp`/`ice`/`drop-peer` упрощены до parent-ветки. Натив-путь и `preferH264` не тронуты.
- `tree.js`: `capacityOf` — гард `if (!node.native) return 0` после ветки `virtual`, до symmetricNat/maxChildren.
- Верификация: `npm --prefix apps/web run typecheck` EXIT 0; `node --check apps/server/tree.js` чисто; `node apps/server/tree-sim.js` зелёный (браузерные узлы `cap=0`).

### Проблемы:
- `apps/web/node_modules` был неполон (`@tauri-apps/plugin-dialog`/`-fs`/`-notification` в package.json, но не установлены) — typecheck падал ДО правок. Вылечено `npm install`, package.json/lockfile не тронуты.

### Решения:
- `assign-child` оставлен как no-op с `console.warn` (не удалён) — наблюдаемый след, если старый сервер/бандл его пришлёт.
- Гард в `capacityOf` — по флагу `node.native`, а не только через константу `BROWSER_CAPACITY=0` (защита от регрессий).

---

## Д1 — vrelay = постоянный медиаузел; инверсия топологии под флагом (passthrough)

**Статус:** 🟡 код готов, компиляция/симуляция зелёные, живой e2e не проверен
**Цель / механизмы ТЗ:** «стример → сервер → зрители» на passthrough, без транскода. Самая рискованная инфраструктурная часть (постоянный серверный медиапуть, ёмкость VPS) проверяется первой.

**Работы:**
- `apps/server/tree.js`: join вещателя с `serverIngest:true` (при `TREE_SERVER_FIRST=1`) → `t.serverFirst=true`, немедленная активация vrelay pinned (без дренажа); `scoreParent` (:129-144): для server-first `virtualCost=0` + бонус виртуалу (≈−500) — vrelay побеждает любого пира; вещатель дефолтно `maxChildren=1` (слот под vrelay); `VIRTUAL_CHILDREN_CAP` 16→32 (env).
- `apps/relay/src/main.rs`: `vrelay-ingest` = activate с `idle_exit: None`, `reconnect: true`; завершение — по `StreamEnd`/`Release`. Legacy `vrelay-activate` не трогаем.
- Натив: `JoinParams.serverIngest` (relay-core/src/signaling.rs); `BroadcastModal.tsx`: слайдер прямых пиров увести в «Дополнительно».
- `docker-compose.yml`: поднять `VRELAY_MAX_CHILDREN`, добавить `VRELAY_OUT_MBPS` в env.

**AC:** vrelay садится ребёнком корня до первого зрителя (лог tree.js); 3 зрителя (2 браузера + натив) получают parent=vrelay; уход/приход зрителей не трогает вещателя; ручные переключения (TreePeerPanel) работают; бейзлайн e2e-латентности замерен (часы в кадре).
**Риски:** исходящая полоса VPS (30×6 Мбит = 180 Мбит — замерить, задать кап); deploy.yml рвёт живой ingest; `reconnect:true` — новая ветка поведения (проверить sweep мёртвых детей relay.rs:399-409).

### Выполнено:
- `apps/server/tree.js`: флаг `SERVER_FIRST = process.env.TREE_SERVER_FIRST==='1'` (лог режима при старте `attachTreeServer`). `onJoin` вещателя парсит `serverIngest`; при `SERVER_FIRST && serverIngest && role==='broadcaster'` → `t.serverFirst=true`, дефолт `maxChildren=1` (если клиент не прислал своё). Сразу после join вещателя — `requestVrelayActivation` (без ожидания сирот). `requestVrelayActivation` шлёт `vrelay-ingest` для server-first-дерева (иначе legacy `vrelay-activate`). `scoreParent(cand, serverFirst)` — виртуалу бонус `-VIRTUAL_SERVER_FIRST_BONUS` (−500) вместо штрафа `VIRTUAL_COST`; `pickParent` пробрасывает `t.serverFirst`. Виртуал в server-first помечается `vrelayPinned=true` в onJoin. `drainTimer` пропускает server-first-деревья целиком. `VIRTUAL_CHILDREN_CAP` 16→`Number(process.env.VRELAY_CHILDREN_CAP)||32`.
- `apps/relay/src/main.rs`: новое control-сообщение `vrelay-ingest` → `activate(..., persistent:true)` с `idle_exit:None, reconnect:true`. Legacy `vrelay-activate` → `persistent:false` (без изменений семантики). `activate` параметризован `persistent`, без копипасты.
- `apps/relay-core/src/signaling.rs`: `JoinParams.server_ingest: bool`, сериализуется как `serverIngest`. Обновлены оба конструктора: `relay.rs` (viewer/vrelay → `false`), `broadcast/mod.rs` (broadcaster → `true`).
- `apps/native/.../broadcast/mod.rs`: натив-вещатель шлёт `server_ingest: true` (сервер сам решает по своему флагу).
- `apps/web/.../BroadcastModal.tsx`: слайдер «Прямых подключений» уведён под `<details>` «Дополнительно» (функциональность сохранена).
- `docker-compose.yml` + `.env.example`: `TREE_SERVER_FIRST` (дефолт 0) у token-сервиса; `VRELAY_MAX_CHILDREN` 8→32, добавлен `VRELAY_OUT_MBPS`; документирован `VRELAY_CHILDREN_CAP`.
- Верификация: `node --check tree.js` OK; `node tree-sim.js` зелёный (legacy-регрессия); ad-hoc server-first ws-тест PASS (вещатель с `serverIngest` → сервер шлёт `vrelay-ingest` не `vrelay-activate`; виртуал = прямой ребёнок корня ДО первого зрителя; первый зритель parent=виртуал; дефолт корня cap=1); `cargo check` relay-core/relay/native все EXIT 0; web `tsc --noEmit` EXIT 0.

### Проблемы:
- `apps/native/src-tauri/Cargo.lock` при локальном `cargo check` регенерировался (пре-существующий дрейф: плагины dialog/fs/notification в Cargo.toml не были в lock). Не относится к Д1 — откачен, синк лока идёт через CI (`build-windows.yml` `cargo fetch`).

### Решения:
- `serverIngest` живёт в общем `JoinParams` (relay-core делит натив-вещатель и vrelay), но шлёт его только вещатель (`true`); vrelay/relay-viewer — `false`.
- Немедленная активация переиспользует `requestVrelayActivation`/`ensureVirtualAttached` (не новый путь); тип сообщения выбирается по `t.serverFirst`.
- `reconnect:true` для ingest НЕ мешает teardown: завершение сессии идёт по событиям `Release`/`StreamEnd` (broadcasterLost шлёт `vrelay-release`) и `Stop`, а не по обрыву транспорта — reconnect влияет только на переживание блипа WS (что и нужно постоянному узлу). `Release`/`StreamEnd` в relay.rs делают `break` независимо от `reconnect`. Живой e2e (медиапуть ingest, полоса, teardown на реальном VPS) — на пользователе.

---

## Д2 — Спайк серверного транскода (одна рендишн по ручному триггеру)

**Статус:** 🟡 код готов, компиляция/симуляция зелёные; **латентность и CPU ЕЩЁ НЕ ЗАМЕРЕНЫ** (блокирующий AC — снимает пользователь на VPS с реальным вещателем, см. ниже)
**Цель / механизмы ТЗ:** снять главный технический риск — конвейер RTP→ffmpeg→RTP внутри vrelay — до переделки деревьев.

**Работы:**
- `apps/relay-core`: новый `transcode.rs` — входящий RTP от родителя дублируется в локальный UDP-сокет; ffmpeg (`-protocol_whitelist file,udp,rtp -i in.sdp`, `libx264 -preset superfast -tune zerolatency`, CBR + HRD, scale без апскейла, GOP 60 (2 с), без B-кадров) → RTP на второй локальный порт → relay-core пишет в отдельный `TrackLocalStaticRTP`. Opus — passthrough. Надзор: `tokio::process`, рестарт при падении, kill при stop, лимит `VRELAY_MAX_TRANSCODES`.
- `apps/relay/Dockerfile`: добавить ffmpeg в runtime-слой.
- Dev-триггер: `vrelay-rendition-start {streamId, rendition:'480'}` из tree.js вручную; тестовое дерево `streamId::480` с одним зрителем через dev-панель.

**Спайк обязан ответить:** добавка латентности транскода (цель ≤300 мс); CPU одного ffmpeg 720p30 на VPS; поведение при потерях на входе (слать `request-keyframe` корню при старте рендишна); стабильность RTP-plumbing webrtc-rs↔ffmpeg.

**AC:** зритель dev-путём получает живую 480p-картинку транскодом; латентность и CPU замерены и записаны сюда (в «Выполнено»); выключение рендишна не трогает source-зрителей.
**Риски (главный майлстоун проекта):** тонкости RTP через локальный UDP (порядок пакетов, нет FEC — допустимо на лупбеке); Rust только через CI — закладывать время; провал латентности → план Б (GStreamer / нативный x264-биндинг) решается ЗДЕСЬ, до Д3.

### Выполнено:
- **`apps/relay-core/src/transcode.rs` (НОВЫЙ)** — конвейер RTP→ffmpeg→RTP. `Feed` дублирует
  входной видео-RTP в локальный UDP (sync non-blocking, pt форсится 102). ffmpeg: `libx264
  -preset superfast -tune zerolatency` baseline, CBR+HRD (`nal-hrd=cbr:force-cfr=1`,
  minrate=maxrate=bufsize=битрейт), scale без апскейла (`min(iw,W)/min(ih,H)
  :force_original_aspect_ratio=decrease:force_divisible_by=2`), GOP 60, `-bf 0`, вывод
  `-f rtp ...?pkt_size=1200 -payload_type 102`. Opus НЕ транскодируется. Надзор через
  `tokio::process` (рестарт с backoff, лимит 10; `kill_on_drop` + явный kill; глобальный
  кап `VRELAY_MAX_TRANSCODES`, дефолт 2). **Измеримость:** per-frame латентность по
  marker-биту (EWMA), CPU из `/proc/<pid>/stat` (`#[cfg(linux)]`), счётчики in/out/restart —
  всё префиксом `[transcode]`, лог раз в 3с.
- **`relay.rs`** — врезка в on_track-цикл: при активном рендишне видео-RTP дублируется в feed
  (гейт `feed_count`, 0 = passthrough как раньше, инвариант source цел). `RelayManager`
  получил `renditions`/`video_feeds`; методы `start_rendition`/`stop_rendition`. Новый
  `start_rendition_root` — джойн в дерево `streamId::rendition` как broadcaster(virtual),
  фанаут транскод-видео + passthrough-audio источника. `RelayControl::Start/StopRendition`
  + `RelayHandle::start_rendition/stop_rendition` (+ derive Clone). Шапка обновлена. При
  старте рендишна — `request-keyframe` корню (без IDR ffmpeg не декодирует).
- **`apps/relay/src/main.rs`** — control `vrelay-rendition-start/stop`: реюз ingest-сессии
  как источника транскода + спавн рендишн-корня; дедуп по `streamId::rendition`; гашение
  рендишнов вслед за ingest-сессией/по release. SIGINT гасит и рендишны.
- **`apps/relay/Dockerfile`** — ffmpeg в runtime-слой (`--no-install-recommends`, чистка apt).
- **`apps/server/tree.js`** — DEV-триггер `dev-rendition` (гейт `TREE_DEV_RENDITION=1`) →
  шлёт агенту `vrelay-rendition-start/stop`. Помечен `DEV-ТРИГГЕР Д2, удаляется в Д8`.
- **`apps/relay-core/examples/transcode_smoke.rs` (НОВЫЙ)** — offline-смоук: testsrc→H.264-RTP
  → наш Feed → transcode → проверка out_pkts>0 + печать латентности. Требует ffmpeg.
- **Верификация:** `cargo check` relay-core / relay / native — все EXIT 0 (натив реэкспортит
  relay-core, компилится); `cargo check --examples` relay-core EXIT 0; `node --check tree.js`
  чисто; `node tree-sim.js` зелёный (legacy-регрессия цела). `Cargo.lock` натива не тронут
  (пре-существующий дрейф синкается в CI).
- **⚠ НЕ ЗАМЕРЕНО ЛОКАЛЬНО (блокирующий AC):** добавка латентности транскода (цель ≤300 мс),
  CPU ffmpeg 720p30, живая 480p-картинка зрителю. Нет VPS/вещателя/ffmpeg локально. Снимает
  пользователь на VPS:
  1. Деплой (в окно без стримов), env `TREE_SERVER_FIRST=1`, `TREE_DEV_RENDITION=1`.
  2. Нативный вещатель стримит → ingest-сессия поднята.
  3. Из dev-консоли послать в /tree (авторизованный WS) `{t:'dev-rendition', streamId:'<id>', rendition:'480'}`.
  4. Снять цифры: `docker compose logs token 2>&1 | grep '\[transcode\]'` (latency≈/cpu=/in_pps/out_pps/restarts).
  5. Смотреть `streamId::480` вторым зрителем (dev) — проверить живую картинку.
  6. Записать latency/CPU СЮДА; если latency >300 мс — решение о плане Б до Д3.
### Проблемы:
- Локально не собрать/не прогнать живьём: нет Rust-toolchain для natив (только CI), нет
  ffmpeg на dev-машине (smoke-пример написан, но локально не запускался), нет VPS/вещателя.
### Решения:
- **Канал rendition-команд — control-WS агента** (рядом с `vrelay-ingest`), НЕ per-stream
  tree-сессия: `rendition-start` адресован streamId с уже поднятой ingest-сессией; агент
  достаёт её `RelayHandle` из своей карты `streams` и дёргает `start_rendition` (oneshot-ответ
  с треками), затем спавнит отдельный рендишн-корень. Так «сервер→агент» и доступ к живой
  ingest-сессии совмещены без нового сокета.
- **Транскод живёт на ingest-сессии, рендишн-корень — отдельная сессия**: треки шарятся через
  `Arc<TrackLocalStaticRTP>` (транскод пишет, корень фанаутит). Audio — тот же passthrough
  Arc источника (Opus через ffmpeg НЕ идёт); A/V-рассинхрон на добавку латентности транскода
  допустим для спайка.
- **Гейт транскода — `feed_count`/`RelayConfig.virtual_relay`-путь**: нативный passthrough-узел
  рендишны не поднимает (их шлёт только vrelay-агент), горячий on_track-путь при 0 рендишнов
  берёт быстрый atomic-гейт без лока — passthrough не деградирует.
- **Keyframe при старте рендишна** — `request-keyframe` корню source-дерева (реюз механизма
  relay-core); дальше рендишн держит свой GOP 60 (2с) — новый зритель рендишна ждёт ≤2с, IDR
  форсить в рендишн-дереве нечем (мы не энкодер-источник, а ffmpeg с фиксированным GOP).

---

## Д3 — Деревья пер-качество: `streamId::rendition` (поведенчески нейтрально)

**Статус:** 🟡 код готов, компиляция/симуляция/ad-hoc-тесты зелёные; живой e2e-смоук на VPS не проверен
**Цель / механизмы ТЗ:** измерение «качество» в сигналинге и менеджере без смены пользовательского поведения (существует только `source`). «Обмен строго внутри одного качества» — структурно.

**Работы:**
- `apps/server/tree.js`: ключ `trees` → составной; `join.quality` (нет поля → `source` — обратная совместимость); discovery (`onHello`/`stream-live`) агрегирует по базовому `streamId`; `liveBroadcastersIn` — по базовому id; `MAX_DEPTH=5`.
- `apps/web/src/transport/treeVideo.ts`: `watch(streamId, quality='source')`; смена качества = unwatch+watch (teardown идемпотентен); UI-ключ — базовый streamId.
- Натив: `JoinParams.quality` (signaling.rs), `start_watch(..., quality)` (lib.rs).
- Вещатель join'ится только в `::source`.

**AC:** после деплоя поведение неотличимо от «до» (полный смоук: вещание, 2 зрителя, reparent, vrelay, ручные переключения); в логах ключи деревьев с `::source`.
**Риски:** рассинхрон версий при раскатке — сервер обязан принимать join без `quality`; проверить маршрутизацию `request-keyframe`/`stats` по составному ключу.

### Выполнено:
- **`apps/server/tree.js`** — ключ `mgr.trees` → составной `streamId::rendition`. Хелперы
  `treeKey(streamId, rendition='source')` / `parseTreeKey(key)` (lastIndexOf('::'), устойчив к
  Д2-рендишн-корню с `::` в id) экспортированы для тестов. `RENDITIONS={source,1080,720,480,360}`
  + `normRendition` (мусор/нет поля → `source`, обратная совместимость). `MAX_DEPTH` 4→5 (считается
  внутри рендишн-дерева). Узел хранит `streamId` (базовый), `rendition`, `treeKey`. Все внутренние
  функции (`requestVrelayActivation`, `ensureVirtualAttached`, `settleOrphans`, `broadcastTreeInfo`,
  `broadcastTopology`, `applyReparent`, `onRequestVrelay`, `onRequestReparent`, `onRequestKeyframe`,
  `onLeave`, `abrTimer`, `drainTimer`, `onVrelayHello`) работают по составному ключу; **клиентские
  сообщения несут БАЗОВЫЙ streamId** (составной ключ в UI не течёт). Discovery (`onHello`/`stream-live`/
  `stream-end`) агрегирует по базовому id и объявляется ТОЛЬКО для source-дерева (+ `renditions:['source']`
  задел Д4). `liveBroadcastersIn` — только source-вещатели. `requestVrelayActivation` отказывает
  не-source-дереву (vrelay-ingest — концепция source-дерева). Уход source-вещателя сносит все
  рендишн-деревья `base::*` (`teardownRenditionTrees` + `vrelay-rendition-stop` агенту).
- **`apps/web`** — `VideoTransport.watch(streamId, quality='source')` (интерфейс + Tree + LiveKit,
  где quality игнорируется). `engine.watch(identity, quality='source')` пробрасывает. `TreeVideoTransport`:
  `WatchState.quality`/`NativeWatchState.quality`, `sendWatchJoin` шлёт `quality`, re-watch на обрыве
  сохраняет качество; `nativeWatch(streamId, quality)` → `startNativeWatch(...,quality)`. `StreamMeta.renditions`
  (задел Д4) из `stream-live`. UI-ключ у зрителя остался базовым (`liveStreams`/`watches`/`nativeWatches`/`watchT`).
- **Rust** — `JoinParams.quality: String` (сериализуется `quality`), `RelayConfig.quality`. `relay::start`
  (viewer/vrelay) и `start_rendition_root` пробрасывают quality; `start_watch(..., quality: Option<String>)`
  (дефолт `source`). Натив-вещатель (`broadcast/mod.rs`) и vrelay-ingest (`main.rs activate`) — `quality:"source"`.
  **Д2-рендишн-корень унифицирован**: `main.rs rendition_start` шлёт БАЗОВЫЙ `stream_id` + `quality=rendition`
  (раньше клеил `::rendition` в сам stream_id) — сервер сам ставит корня в дерево `stream_id::rendition`.
- **`apps/server/tree-sim.js`** — под `MAX_DEPTH` (импорт из tree.js), join без quality = source (тест обр.
  совместимости); зелёный, ключи в логах `sim-stream::source`.
- **Верификация:** `node --check tree.js` OK; `node tree-sim.js` зелёный; `npm run typecheck` (web) EXIT 0;
  `cargo check` relay-core / relay / native + `cargo check --examples` relay-core — все EXIT 0 (только
  пре-существующие dead_code-warnings в native). **Ad-hoc обр. совместимости** (13/13 PASS): join БЕЗ поля
  quality → дерево `::source`, parent=broadcaster; join `quality:'source'` → то же дерево; `quality:'720'`
  → ОТДЕЛЬНОЕ дерево (структурная изоляция качеств); `assign-parent.streamId` = базовый (не составной);
  хелперы treeKey/parseTreeKey round-trip. Cargo.lock натива откачен (пре-дрейф, синк в CI).
### Проблемы:
- Локально Rust собирается (`cargo check` доступен) — компиляцию проверил, но живой медиапуть/e2e на VPS
  не гонялся (нет вещателя/ffmpeg/сервера). Поведенческая нейтральность подтверждена структурно (ad-hoc) +
  симулятором, но полный живой смоук (вещание, 2 зрителя, reparent, vrelay, ручные переключения) — на пользователе.
### Решения:
- **Составной ключ — деталь сервера, наружу течёт только базовый streamId.** Клиенты (браузер/натив)
  джойнятся базовым id + `quality`; во ВСЕХ серверных сообщениях (`assign-*`, `tree-info`, `tree-topology`,
  `drop-peer`, `stream-*`, `set-bitrate`) поле `streamId` — базовое. Критично для натив-топологии
  (`topoCb` сверяет `payload.streamId` с базовым id из watch) — иначе топология у нативного зрителя терялась.
- **Discovery объявляет только source-деревья.** Рендишн-корень — тоже `role:broadcaster`, но своего
  `base::rendition`-дерева; без гейта он породил бы дубль `stream-live` с мусорным identity (`vrelay-480`),
  а его `stream-end` погасил бы у зрителей ЖИВОЙ source-стрим. Гейт по `rendition==='source'`.
- **Keyframe пер-рендишн — структурно.** `onRequestKeyframe` шлёт корню ЭТОГО дерева: для source — нативному
  вещателю (форсит IDR), для рендишн-дерева — рендишн-корню (ffmpeg игнорирует, держит GOP). Так PLI из
  рендишна НЕ уходит нативному вещателю (нет IDR-шторма). Rate-limit `lastKfForwardAt` — на каждом дереве свой.
- **Д2-рендишн-корень адаптирован под ключ, не сломан.** Раньше он клеил `::480` в stream_id и джойнился
  в дерево-строку; теперь шлёт базовый id + quality=rendition, унифицировавшись с онлайн-зрителями рендишна
  (общий хелпер формирования ключа — на сервере). Dev-триггер `dev-rendition` работает (гейт `TREE_DEV_RENDITION`),
  `mgr.trees.get(treeKey(streamId,'source'))` для поиска source-дерева живого стрима.
- **Уход source-вещателя гасит рендишн-деревья.** `teardownRenditionTrees(base)` сносит узлы `base::*` +
  шлёт агенту `vrelay-rendition-stop` (дублирует агентову ingest-fin-очистку — belt-and-suspenders против
  повисших рендишн-деревьев с зрителями).

---

## Д4 — Рендишны по требованию + выбор качества у сервера + пер-зрительский ABR

**Статус:** 🟡 код готов, компиляция/симуляция/ad-hoc-тесты зелёные; живой e2e/латентность на VPS не проверены
**Цель / механизмы ТЗ:** лестница 1080/720/480(/360) по требованию; апскейла нет; гашение 30 с; выбор качества (ABR/ручной) ТОЛЬКО при подключении к серверу; source = passthrough.

**Работы:**
- `apps/server/tree.js`: реестр `t.renditions = Map<rendition, {state, lastConsumerAt}>`; первый `join`/`set-quality` в пустую рендишн → `vrelay-rendition-start` + `request-keyframe` корню source; 30 с без потребителей → `vrelay-rendition-stop` + снос дерева. «Без апскейла»: вещатель сообщает `width/height` в join, сервер режет лесенку сверху. Пер-зрительский ABR: прямому ребёнку vrelay с плохим линком (loss/rtt из stats vrelay) — перевод на рендишн ниже; гистерезис, cooldown 15–30 с; ручной выбор = pin.
- vrelay: **отдельная join-сессия на каждое рендишн-дерево** (реюз «одна сессия = одно дерево», main.rs:102-133); медиавход рендишн-сессии — локальный канал от ingest-сессии, не сеть.
- Web: меню качества у зрителя (Авто / Source / 1080 / 720 / 480) — активно только когда родитель = vrelay (topology отдаёт `virtual:true`); под пиром задизейблено с подсказкой «качество наследуется от родителя». Выбор → `set-quality`.
- Замер e2e на каждом рендишне (часы в кадре), цель <2 с.

**AC:** переключение 720→480→source с паузой ≤2–3 с; второй зритель рендишна не порождает второй ffmpeg (лог агента); через 30 с без потребителей ffmpeg убит (лог); авто-ABR понижает рендишн при задушенном даунлинке; e2e <2 с на source и рендишнах.
**Риски:** CPU-кап на одновременные ffmpeg (отказ «рендишн недоступен»); болтанка авто-ABR (мин. интервал переключений); два источника правды о детях vrelay — сервер главный, агент подчиняется.

### Выполнено:
- **`apps/server/tree.js` — реестр рендишнов + лестница + ABR.** `RUNG_ORDER`, `RENDITION_HEIGHT`,
  `RENDITION_BITRATE`, состояния `RS_STARTING/LIVE/STOPPING`. Реестр `t.renditions =
  Map<rendition,{state,lastConsumerAt,presetBitrate}>` на source-дереве. **Без апскейла:** вещатель
  шлёт `width/height` в join (натив — `max_width/max_height`); `availableRungs`/`renditionAvailable`
  режут лестницу сверху по высоте source (нет данных = не режем, ffmpeg всё равно не апскейлит).
  **Ленивый старт** `ensureRendition`: первый потребитель непустого рендишна → `vrelay-rendition-start`
  агенту + `request-keyframe` корню source (ffmpeg без IDR не декодирует). **Гашение** `renditionTimer`
  (5с тик, `.unref()`): 30с без потребителей → `teardownRendition` (`vrelay-rendition-stop`). **`set-quality`**
  → `onSetQuality` → `moveNodeToRendition` (leave старого дерева + join нового = assign-parent, клиент
  пересоздаёт PC; `pinned=true`). **Пер-зрительский ABR** `perViewerAbr` (в `abrTimer`): прямому
  ЛИСТУ серверного узла (vrelay/рендишн-корень) без пина по личному loss/rtt — вниз (`ABR_BAD_TICKS=2`)
  / вверх (`ABR_GOOD_TICKS=5`, медленнее — анти-болтанка) на соседний рунг; cooldown `ABR_VIEWER_COOLDOWN_MS=20с`;
  реюз `ABR_LOSS_*`/`ABR_RTT_*`/`STATS_TTL_MS`. `stream-live.renditions[]` = реальная лестница (`renditionsOf`).
  `onVrelayRenditionFailed` (агент→сервер): снятие рендишна + `rendition-unavailable` потребителям.
  `topology()` +флаг `server` (vrelay ИЛИ рендишн-корень) — клиент по нему включает меню качества.
  DEV-триггер `dev-rendition` адаптирован тонкой обёрткой над `ensureRendition`/`teardownRendition`.
- **vrelay (`apps/relay/src/main.rs` + `relay-core`).** Локальный канал ingest→рендишн (Д2) подтверждён:
  `rendition_start` реюзает ingest-сессию как источник транскода (второго upstream к вещателю нет),
  дедуп по `streamId::rendition` (второй зритель НЕ порождает второй ffmpeg). `rendition_start` теперь
  `Result` — при отказе (кап `VRELAY_MAX_TRANSCODES`/нет ingest/ffmpeg) агент шлёт серверу
  `vrelay-rendition-failed`. Рендишн-корень (`start_rendition_root`) теперь репортит per-child loss/rtt
  (`TreeCmd::Stats`) — иначе ABR не оценил бы зрителей рендишн-деревьев (подъём вверх невозможен).
  `JoinParams`/`RelayConfig` +`width`/`height`/`pinned`; натив-вещатель шлёт своё разрешение, натив-зритель
  — pin. `start_watch` (lib.rs) +`pinned`.
- **Web.** `treeVideo.ts`: `watch(streamId, quality, pinned)`, `WatchState/NativeWatchState.pinned`,
  join несёт `pinned`; `setQuality(streamId, mode)` = unwatch+watch (ключ — базовый streamId); `getQualityMode`
  (pinned→рендишн, иначе 'auto'); `rendition-unavailable` → колбэк. `native.ts::startNativeWatch(...,pinned)`.
  `videoTransport.ts`: `TreeNode.server`, методы `setQuality`/`getQualityMode`/`onRenditionUnavailable`.
  `engine.ts`: `setStreamQuality`/`getStreamQualityMode`/`getStreamRenditions`/`isStreamViaServer`;
  `onRenditionUnavailable` → тост + фолбэк на source. `ServerView.tsx`: `QualityMenu` (кнопка-шестерёнка
  в vbar) — Авто/Source/1080/720/480/360 из реальной лестницы, активно ТОЛЬКО при `isStreamViaServer`
  (родитель = сервер), под живым пиром — подсказка «качество наследуется от родителя».
- **Верификация:** `node --check tree.js` OK; `node tree-sim.js` зелёный (reparent 63мс); `cargo check`
  relay-core/relay/native + `cargo check --examples` relay-core — все EXIT 0; web `tsc --noEmit` EXIT 0.
  Cargo.lock натива откачен (пре-дрейф, синк в CI). **Ad-hoc ws-тест 16/16 PASS:** (a) join 480 →
  `vrelay-rendition-start`+`request-keyframe` корню; (b) второй зритель 480 → второго старта НЕТ;
  (c) уход обоих → через idle `vrelay-rendition-stop` (720 при живом зрителе не гасится); (d) `set-quality`
  переводит зрителя source→720; (e) source 720p → рендишн 1080 отклонён (`rendition-unavailable`);
  (f) join без quality → source, parent=vrelay; +лестница в `stream-live.renditions` (streamB без 1080).

### Проблемы:
- Живьём (реальный транскод/латентность/CPU/e2e <2с) не проверить: нет VPS/вещателя/ffmpeg локально.
  Латентность рендишнов и «часы в кадре» на каждом рунге — блокирующий AC на пользователе (см. Д2 шаги).
- **Натив + `rendition-unavailable`:** Rust не парсит это сообщение (нет IPC-проброса в webview), поэтому
  нативный зритель при отказе рендишна упадёт не мгновенным тостом, а через orphan-exit (~20с) → ре-watch.
  Смягчено тем, что UI показывает ТОЛЬКО доступные рендишны (лестница из stream-live), так что
  ladder-отказ у клиента не случается — остаётся лишь агентов CPU-cap (редко). Проброс в натив — задел.
- **Натив-зритель под server-ABR-move:** сервер двигает узел между деревьями через assign-parent (Rust
  следует на медиа-уровне, IPC не нужен), но webview-лейбл качества остаётся 'auto' (реальный рендишн
  прозрачен) — приемлемо (в режиме Авто меню и так показывает «Авто»). На WS-реконнекте (деплой) Rust
  реджойнится со своим исходным quality (source) → вернётся в source-дерево; ABR переадаптирует. Отмечено.

### Решения:
- **Смена качества = client-driven unwatch+watch** (браузер И натив, единообразно, реюз Д3, ноль нового
  натив-plumbing; роадмап «на клиенте это unwatch+watch»). pin переживает пересоздание сокета через поле
  `pinned` в join. `set-quality` реализован серверным хендлером (server-move через `moveNodeToRendition`,
  общий с ABR) для протокола + ad-hoc-теста (AC d). Пер-зрительский ABR — **server-move** (leave+join
  на сервере, assign-parent): и браузер, и натив следуют на медиа-уровне без клиентского сообщения.
- **Меню качества активно по ТОПОЛОГИИ, не по хранимому quality:** узел «серверный» (`server` в topology)
  если это vrelay ИЛИ корень рендишн-дерева (broadcaster в `base::rendition`). Так после server-ABR-move
  браузера меню остаётся корректным (хранимый quality мог протухнуть). Подсветка выбранного пункта — по
  `getQualityMode` (pinned→рендишн; auto→«Авто», реальный рендишн прозрачен, авто-двиг сервером не мешает).
- **Рендишн-корень репортит per-child stats.** Иначе зрители рендишн-деревьев без loss/rtt — ABR не смог
  бы поднять их обратно вверх при восстановлении линка (роадмап «подъём вверх с гистерезисом»).
- **ABR только для ЛИСТЬЕВ под серверным узлом** (childless): не рвём чужие поддеревья (натив-relay с детьми
  не двигаем). В server-first `reparentCooldownUntil` у таких узлов свободен (drainTimer пропускает
  server-first) — реюзаем его под ABR-cooldown без конфликта.
- **`request-keyframe` из рендишн-контекста — ЕДИНСТВЕННО легитимный** (`ensureRendition` шлёт корню source),
  как требует роадмап («keyframe пер-рендишн»); дальше рендишн держит GOP ffmpeg (2с).
- **Измеримость (замер D):** переключения качества и старт/стоп рендишнов логируются едиными grep-префиксами
  `[quality]` (смена/ABR) и `[rendition]` (start/live/stop/failed) с identity и loss/rtt — снять e2e-часы
  на VPS по ним.

---

## Д5 — Авто-пресет вещателя: probe + развилка «Плавность/Качество»

**Статус:** ⬜ не начат (зависит от Д1; параллелится с Д3/Д4)
**Цель / механизмы ТЗ:** дефолтный flow — замер upload → полезный битрейт 75% → развилка; расширенные настройки = текущий ручной режим.

**Работы:**
- Probe: webview вещателя (Chromium GCC-BWE — надёжнее незрелого BWE webrtc-rs) поднимает PC к vrelay: `probe-start` → probe-сессия-приёмник в relay-core (PC-answerer, принимает и дропает трек); webview шлёт синтетический canvas-трек 60fps с `maxBitrate` 12–15 Мбит, 4 с читает `candidate-pair.availableOutgoingBitrate`, берёт медиану последних 2 с (прогрев 1 с). Фолбэк — DataChannel-throughput. Кэш в localStorage (TTL сутки) + кнопка «повторить замер».
- `apps/web/src/components/BroadcastModal.tsx` — редизайн flow: источник → замер (спиннер 3–5 с) → `useful = 0.75×BWE` → развилка **Плавность** (60 fps, разрешение ниже) / **Качество** (30 fps, макс разрешение) → `pickPreset(usefulKbps, mode)` по таблице; «Расширенные настройки» (details) = текущие ручные контролы; `SavedConfig.presetMode: 'smooth'|'quality'|'manual'`.
- Таблица пресетов (H.264/CBR): 1080p60/6000, 720p60/4500, 1080p30/4500, 720p30/3000, 480p30/1500, 360p30/800. Без апскейла над source-разрешением. Константы — единый источник (+копия в tree.js для валидации рендишн-битрейтов).
- Натив: `encoder.rs` — убедиться в CBR-режиме MFT + HRD-буфер; `QualityLadder` (mod.rs:40-75) остаётся только для legacy/ручного авто-битрейта.

**AC:** замер согласуется со speedtest (±25%); канал ~8 Мбит: «Плавность» → 1080p60/6000, «Качество» → 1080p30/4500; ручной режим работает как раньше; стрим стартует с выбранным CBR (панель статов вещателя).
**Риски:** probe через TURN занижает оценку (probe идёт на публичный IP host-сети — проверить симметричный NAT вещателя); canvas-трек может не разогнать BWE за 4 с; холодный старт probe-сессии (+1 с).

### Выполнено:
- —
### Проблемы:
- —
### Решения:
- —

---

## Д6 — Супер-сидеры + авто-ретрансляция 1→2 при запасе upload

**Статус:** ⬜ не начат (зависит от Д4)
**Цель / механизмы ТЗ:** прямые слоты сервера — зрителям с лучшим upload, вытеснение слабых в дерево; ветвление ≤2 детей только при запасе upload; ребёнок наследует качество родителя.

**Работы:**
- Клиент-натив: `maxChildren` динамически — 2, если BWE-upload (relay.rs:587-594 уже репортит `availableOutgoing`) ≥ 2× битрейта смотримого рендишна (+30% запас), иначе 1/0; пересчёт на лету (поле в `stats`) — сервер обновляет `capacityOf`.
- `apps/server/tree.js`: `arbitrateServerSlots(t)` в тике (рядом с drainTimer) — если слоты vrelay заняты, а в глубине зритель с upload ≥ 1.25× худшего прямого ребёнка и cooldown истёк → вытеснить худшего (штатный `mgr.reparent` внутри того же рендишн-дерева), поднять сильного. ≤1 рокировки/тик. `outBonus` — больший вес внутри рендишн-дерева.
- Наследование качества — структурно (Д3); меню качества под пиром выключено (Д4).

**AC:** прямым под vrelay сидит лучший по upload; приход заметно более сильного вытесняет слабого (наблюдаемый reparent, восстановление ≤2–3 с); зритель со слабым upload детей не получает; браузеры всегда листья.
**Риски:** шумные оценки upload → болтанка (гистерезис 25% + cooldown 30 с); фриз жертвы вытеснения и её поддерева (приоритет вытеснения листьев); честность самозаявленного upload (кап `MAX_CHILDREN_CAP` остаётся).

### Выполнено:
- —
### Проблемы:
- —
### Решения:
- —

---

## Д7 — Отбраковка родителя по дропам кадров

**Статус:** ⬜ не начат (зависит от Д4)
**Цель / механизмы ТЗ:** порог 5% дропов за 3 с → поиск иного пути.

**Работы:**
- `apps/web/src/transport/treeVideo.ts`: общий детектор для обоих путей (webview-PC есть и у браузерного, и у натив-watch): таймер 1 с, дельты `inbound-rtp.framesDropped`/`framesDecoded` в окне 3 с; `dropRate > 0.05` **И** `packetsLost`-дельта > 0 (отсечь декодерные дропы слабого ПК) → `requestReparent(streamId, null)`; клиентский cooldown 10 с (серверный `REPARENT_COOLDOWN_MS` подстрахует); гейт `document.visibilityState` (скрытая вкладка дропает легитимно).
- `apps/server/tree.js`: `reason:'frame-drops'` в `request-reparent` → лог для диагностики; текущий родитель уже исключается при выборе (:233).

**AC:** душим uplink родителя-пира (clumsy/NetLimiter) → его ребёнок мигрирует за ≤10 с (лог reason=frame-drops), картинка восстанавливается; ложных миграций при свёрнутой вкладке нет.
**Риски:** `framesDropped` в Chromium включает рендерные дропы слабого ПК — второй сигнал `packetsLost` обязателен.

### Выполнено:
- —
### Проблемы:
- —
### Решения:
- —

---

## Д8 — Server-first по умолчанию + opt-in прямых подключений + чистка

**Статус:** ⬜ не начат
**Цель / механизмы ТЗ:** дефолт «всё через сервер»; прямые подключения к стримеру — opt-in; финал доков.

**Работы:**
- `TREE_SERVER_FIRST` → дефолт on; legacy-ветки (drainTimer, `VIRTUAL_COST`-штраф, idle-exit) остаются только для стримов старых клиентов, наметить снос.
- Тумблер BroadcastModal «Разрешить прямые подключения (N слотов)» → `maxChildren = 1 (vrelay) + N`; прямые слоты вещателя — по ручному запросу зрителя (TreePeerPanel) и/или супер-сидерам при включённом тумблере.
- Чистка: dev-триггеры Д2, мёртвые упоминания Э8, `tree-sim.js` под рендишн-деревья (регрессионный симулятор), coturn `external-ip` раскомментировать.
- Финал доков: CLAUDE.md «Подсистемы и уроки» дополнить транскод-граблями; отметки AC по всем Д-майлстоунам здесь.

**AC:** полный сценарий ТЗ без флагов: 5+ смешанных зрителей, e2e <2 с через сервер, NAT-кейс через TURN, переключения качества и источника; голос/чат/auth/LiveKit-путь целы.

### Выполнено:
- —
### Проблемы:
- —
### Решения:
- —
