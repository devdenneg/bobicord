# ТЗ на исполнение (Claude Code) — эволюция bobicord → RelayApp

Задание для агента-исполнителя. Инварианты и контекст — в корневом `CLAUDE.md`. Работай майлстоунами Э0→Э8 по порядку; каждый имеет критерии приёмки (AC). Приложение остаётся рабочим на каждом шаге.

---

## 0. Что делаем

Переводим раздачу экрана с LiveKit SFU на **P2P relay-дерево**, добавляем нативный Tauri-клиент для вещания. Голос/чат/auth/деплой bobicord — сохраняем.

**Разделение транспорта (целевое):**
```
LiveKit SFU:        голос (микрофон) + data-канал (чат/эмоуты/watch)
P2P relay-дерево:   видео экрана + звук игры/системы (НЕ через сервер, кроме TURN)
token-сервер (ws):  сигналинг дерева + менеджер + балансировка
coturn:             STUN/TURN
Нативный клиент:    захват/сцена/H.264/ретрансляция (вещание)
```

---

## 1. Майлстоуны

### Э0 — Изоляция видео-пути за абстракцией `VideoTransport`
**Задача.** В `apps/web/src/engine.ts` вынести весь видео-функционал (share/watch/closeWatch/addVideo/onSub-video/onRemotePub-ScreenShare) за интерфейс `VideoTransport`. Голос, presence, чат, эмоуты — не трогать. Первая реализация — текущая LiveKit-логика (`LiveKitVideoTransport`), поведение неизменно.

**Контракт (ориентир):**
```ts
interface VideoTransport {
  startBroadcast(streamId: string, source: MediaStream): Promise<void>;
  stopBroadcast(streamId: string): Promise<void>;
  watch(streamId: string): void;
  unwatch(streamId: string): void;
  getVideoTrack(key: string): MediaStreamTrack | LocalVideoTrack | RemoteTrack | undefined;
  onStreamStart(cb: (info: StreamInfo) => void): void;
  onStreamStop(cb: (streamId: string) => void): void;
  onVideoTrack(cb: (key: string, track, identity, isLocal) => void): void;
}
```
**Файлы.** `engine.ts` (+ новый `transport/livekitVideo.ts`).
**AC.** Всё работает как раньше (стрим/просмотр/watch-presence), typecheck зелёный, видео-логика в engine ходит только через `VideoTransport`.

### Э1 — Сервер дерева (сигналинг + менеджер) на token-сервере
**Задача.** В `apps/server` добавить WebSocket-эндпоинт и менеджер relay-дерева. Реестр пиров по `streamId`; назначение родитель↔ребёнок по capacity; `max_depth=4`; браузер/симметричный-NAT → лист; релей SDP/ICE; ребаланс при уходе узла; аутентификация ws по тому же session-JWT.

**Контракт ws (JSON):**
```
Client→Server: join{streamId, role:'broadcaster'|'viewer', native:bool, iceParams}
               stats{streamId, toChild:[{id,bitrate,rtt,loss}], availableOutgoing}
               sdp{streamId, to, type, sdp} | ice{streamId, to, candidate} | leave{streamId}
Server→Client: welcome{id, iceServers}
               assign-parent{streamId, parentId} | assign-child{streamId, childId}
               drop-peer{streamId, peerId}
               sdp{streamId, from, type, sdp} | ice{streamId, from, candidate}
               tree-info{streamId, depth, children, health}   // для UI «здоровье дерева»
```
**Файлы.** `apps/server/index.js` (или новый `apps/server/tree.js`), `docker-compose.yml`.
**AC.** Скрипт-имитатор N клиентов строит корректное дерево (лог структуры); глубина ≤ 4; при уходе внутреннего узла дети переназначаются < 2 c.

### Э2 — Браузерный приём из дерева (leaf) + удаление браузерного вещания
**Задача.** Вторая реализация `TreeVideoTransport` — **только приём** видео из дерева (браузер = лист, не вещает и не форвардит). **Удалить/выключить** браузерное вещание (`engine.share()` и кнопку стрима). Для проверки — **dev-only тест-паблишер** (временный харнесс, публикует тестовый H.264 в дерево; в продукт не входит). Переключение транспорта флагом окружения.
**Файлы.** `transport/treeVideo.ts`, `engine.ts`, `components/ServerView.tsx` (убрать кнопку стрима), dev-харнесс в `apps/server` или отдельном скрипте.
**AC.** Браузерный зритель принимает H.264 из дерева от тест-паблишера; LiveKit для видео не используется; кнопки стрима в вебе нет; голос/чат работают.

> **Решение (2026-07-06, после Э5).** Кнопка стрима в веб вернулась — `engine.share()` больше не dead code. Причина: у веба нет нативного захвата/энкода, а полностью убирать вещание из браузера юзер не хочет — старый LiveKit-путь (VP8, через SFU) остаётся жить **параллельно** с P2P-деревом, а не заменяется им. `engine.ts` держит оба `VideoTransport` (`liveKitT` + `treeT`) одновременно; зритель при `watch(identity)` определяет транспорт по тому, откуда объявлен стрим (`liveKitT.isRemoteBroadcasting`/`treeT.isRemoteBroadcasting`), а не билд-флагом `VITE_VIDEO_TRANSPORT` (упразднён). Native продолжает вещать только в дерево (Rust-пайплайн, Э5), браузер — только в LiveKit; один стрим никогда не идёт в оба транспорта разом (не dual-publish).

### Э3 — coturn + NAT
**Задача.** Развернуть coturn (STUN+TURN), временные креды по JWT (`use-auth-secret`, короткий TTL), IPv6. На клиенте — определение симметричного NAT → пометка листом; лимит TURN.
**Файлы.** `coturn/turnserver.conf`, `docker-compose.yml`, выдача креды в `apps/server`, `treeVideo.ts`.
**AC.** Зритель за NAT подключается к дереву; TURN-креды выдаются только авторизованным; egress coturn мониторится.

### Э4 — Каркас Tauri (обёртка веб-клиента)
**Задача.** Создать Tauri v2 проект, обернуть существующий `apps/web` в desktop-приложение (тот же UI нативно). Rust-каркас, `tauri.conf.json`, `capabilities`, разрешения на медиа в webview (getUserMedia/getDisplayMedia), IPC-мост UI↔Rust (заглушки), иконки, сборка/установщик. Видео/захват пока как в вебе.
**Файлы.** новый `apps/native/` (или `src-tauri/`).
**AC.** Desktop-приложение собирается и открывается; логин/голос/чат/просмотр работают как в браузере.

### Э5 — Нативный медиапайплайн (вещание)
**Задача.** В Rust: захват монитора (WGC/DXGI) + аудио (WASAPI), аппаратный **H.264** (NVENC/AMF/MF, low-latency), `webrtc-rs` — корень дерева, отдача прямым детям, сбор статистики → сервер. Заменяет вебвью-захват для стрима. Голос/чат — через тот же бэкенд.
**Файлы.** `apps/native/src-tauri/src/{capture,rtc}`.
**AC.** Нативный вещатель → браузерные зрители видят H.264; сквозная задержка ≤ 3 c; видео через сервер не идёт (кроме TURN).
**Статус.** Закрыт (commit `d1f7689`). **Открытый баг, диагностирован до корня** (обнаружен на реальном VPS-тесте, не блокирует AC Э5 т.к. видео/задержка не при чём, но блокирует инвариант 6 и AC Э7): зритель слышит собственный голос внутри трансляции. Мик вещателя был выключен — течёт через `audio.rs::activate_process_loopback_exclude_self()` (WASAPI EXCLUDE_TARGET_PROCESS_TREE). Дерево процессов проверено и корректно (`audio.mojom.AudioService` — реальный потомок `app.exe`) — но это не помогает: **известное архитектурное ограничение платформы**, не наш баг. WebView2 рендерит звук в отдельном audio-сабпроцессе, и process-tree-based захват (та же WASAPI process-loopback API) с этим не дружит на уровне `audiodg.exe` — подтверждено зеркальным нерешённым issue у OBS: [obsproject/obs-studio#9838](https://github.com/obsproject/obs-studio/issues/9838), ссылается на [MicrosoftEdge/WebView2Feedback#2236](https://github.com/MicrosoftEdge/WebView2Feedback/issues/2236). **EXCLUDE-self в принципе не долечить, пока голос живёт в webview** — это тупик платформы. **Фикс — не чинить EXCLUDE, а перейти на INCLUDE конкретного процесса игры** (см. Э7): таргетит только выбранный game.exe, webview-утечка вообще не участвует, обходит проблему полностью вместо патчинга.

### Э6 — Голосовой тракт: VST в нативе, Web Audio-fallback в вебе
**Статус: пропущено по решению пользователя.** VST-хост и Web Audio fallback не нужны — голос остаётся как есть, через LiveKit web SDK (вебвью), без изменений. Порядок теперь Э5 → Э7 → Э8. Пункт оставлен в файле для истории/если понадобится вернуться.

**Задача (не выполняется).** Нативный клиент: микрофон (WASAPI) → **VST/CLAP-хост** → публикация голоса через **LiveKit Rust SDK** (вебвью — только UI). Веб: fallback — Web Audio-цепочка (EQ/компрессор/гейт) без плагинов. Работает для обычного войс-чата. **Микрофон не примешивается к стриму** (инвариант 5).
**Файлы.** `apps/native/src-tauri/src/audio`, `engine.ts` (web-fallback в mic-пайплайне).
**AC.** Нативный участник слышится с VST-обработкой; браузерный — с Web Audio; оба в одном голосовом канале; мик нигде не попадает в видеопоток.

### Э7 — Нативный захват OBS-уровня
**Задача.** Захват конкретного **окна игры** (WGC, перечисление окон), **звук процесса** (WASAPI process loopback, INCLUDE/EXCLUDE — инвариант 6), веб-камера, сцена-композитор (D3D11, слои/z-order/drag-resize), пресеты качества, аудио-бас с VST.
**Файлы.** `apps/native/src-tauri/src/{capture,scene,audio}`, UI сцены.
**AC.** Захват выбранного окна + звука его процесса; в захвате нет голосов участников/служебных звуков; сцена из ≥2 источников уходит одним H.264-треком.
**Перед началом.** Открытый баг Э5 (эхо голоса зрителя через лупбэк-захват, см. выше) чинится ЗДЕСЬ, реализацией INCLUDE-режима (не отдельным патчем до Э7) — INCLUDE конкретного процесса игры вместо EXCLUDE-self полностью обходит WebView2-ограничение. Без этого AC "в захвате нет голосов участников" не выполним.

### Э8 — Мультистрим + устойчивость + многоуровневый ристрим
**Задача.** Несколько деревьев на канал (`streamId`), пикер стримов в UI, переключение без прерывания голоса; умный ребаланс (миграция детей при деградации BWE/loss), гистерезис, восстановление поддеревьев, мониторинг egress.

**Ристрим (реализовано).**
- Ёмкость узла объявляется в `join{maxChildren}`; вещатель задаёт **лимит прямых зрителей** в UI (`BroadcastModal` → `max_direct_children`), overflow-зрители уходят глубже.
- **Best-peer:** `pickParent` в `tree.js` выбирает родителя скорингом (глубина, загрузка, `availableOutgoing`, loss/rtt из `stats`), а не «первым свободным».
- **Само-управление позицией:** `request-reparent{targetParentId?}` — авто-миграция (best-peer, cooldown-гистерезис) или **ручной выбор пира зрителем** из UI-дерева (`tree-topology` рассылается смотрящим). Валидация: ёмкость, глубина, отсутствие цикла; отказ — `reparent-denied{reason}`.
- **Нативный relay-viewer** (`apps/native/.../broadcast/relay.rs`): Rust держит upstream к родителю, **passthrough** RTP (без транскода, инвариант 4) фанаутит детям и локальному webview через Tauri IPC. Keyframe новому ребёнку — через `request-keyframe` к корню.
- **Браузерный relay** (`treeVideo.ts`): транскод-фолбэк (Chromium re-encode на хоп) с малой ёмкостью — **отклонение от инварианта 3**, принято по решению пользователя ради ветвления без нативных зрителей. Натив — приоритетный passthrough.

**Файлы.** `tree.js`, `tree-sim.js`, `treeVideo.ts`, `native.ts`, `engine.ts`, `broadcast/{relay,signaling,peer,mod}.rs`, `lib.rs`, UI пикера/дерева (`ServerView.tsx`, `BroadcastModal.tsx`).
**AC.** 2+ эфира в комнате; переключение стрима не рвёт голос; нагрузочный прогон 1 стример + 19 зрителей (микс натив/браузер): дерево стабильно, глубина ≤ 4, задержка ≤ 3 c, egress в бюджете.

---

## 2. Порядок и проверка

- Идти строго Э0→Э8. Не начинать следующий, пока AC текущего не выполнены и не закоммичены.
- После каждого майлстоуна: `npm run typecheck` (web) зелёный; голос/чат/auth не сломаны; при наличии — прогнать тест-скрипт майлстоуна.
- Высокорисковые места (менеджер дерева, ребаланс, ICE/TURN) покрывать имитатором/тестами.

## 3. Смежные фичи (после ядра, не сейчас)

Оверлей курсоров и рисование, полный RBAC + гостевые акки, миграция SQLite→Supabase, snapshot доски в Storage, simulcast 540p второго дерева. Спроектированы отдельно — не трогать до завершения Э8.

---

*Evolution-TZ v1.0. Согласовано с CLAUDE.md (инварианты).*
