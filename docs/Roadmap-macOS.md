# Оценка объёма: macOS-версия RelayApp

Статус: оценка, работа не начата. Документ фиксирует разбор кодовой базы и смету на
момент 2026-08-02. Основной рабочий документ проекта — [`Roadmap-flow-стриминга.md`](Roadmap-flow-стриминга.md);
этот его не заменяет.

## Контекст

Нативный клиент (`apps/native`, Tauri 2) существует только под Windows. Задача — оценить объём работ на Mac-версию с **полным паритетом** (зритель + вещание), таргет **arm64, macOS 13+**, Apple Developer аккаунта пока нет.

Исходное состояние: `apps/native/src-tauri/src` — **5308 строк Rust, 15 файлов, ноль `#[cfg(target_os)]`-гейтов и ноль кроссплатформенных абстракций**. Единственный cfg во всём крейте — `windows_subsystem = "windows"` в `main.rs:2`. Windows-код не изолирован, он размазан по всем модулям.

Единственная существующая граница переносимости — сиблинг-крейт `apps/relay-core` (webrtc, signaling, relay, fanout, link, probe), где в шапке `Cargo.toml` явно записано «НЕТ tauri/windows-зависимостей». Он используется и нативом, и headless-агентом vrelay.

---

## Что уже переносится без правок

| Что | Где |
|---|---|
| Всё P2P-дерево, WS-сигналинг, RTP-фанаут, TURN/STUN | `apps/relay-core/src/*` |
| Путь нативного зрителя целиком | `lib.rs:228-303` (`start_watch`/`stop_watch`/`watch_answer`/`watch_ice`/`watch_reparent`) → `relay_core::relay` |
| Вещательный WebRTC-пир | `broadcast/peer.rs` (292 стр.) |
| Счётчики | `broadcast/stats.rs` (67), `diag.rs` (93) |
| BGRA→NV12 конверсия, rayon-пул, BufferPool, `GopWatch` | `capture.rs:505-633`, `encoder.rs:379-425` — чистый CPU-код с тестами |
| Оркестрация вещания, ABR-лестница, preview-поток | бóльшая часть `broadcast/mod.rs` (883 стр.) |
| Opus (`audiopus_sys`, static C), webrtc-rs, tokio | собираются под arm64-darwin |

---

## Что придётся написать заново

| Модуль | Стр. | Windows API сейчас | macOS-замена |
|---|---|---|---|
| `broadcast/capture.rs` | 1103 (~500 Win) | WGC / `windows-capture` 2.0, HWND, `MonitorFromWindow`, `OpenProcess`, `GetTokenInformation` | **ScreenCaptureKit** (`SCShareableContent`, `SCStream`, `SCContentFilter`) |
| `broadcast/encoder.rs` | 593 (~90% Win) | Media Foundation MFT, `ICodecAPI`, `MFTEnumEx` | **VideoToolbox** `VTCompressionSession` |
| `broadcast/audio.rs` | 546 (~75% Win) | WASAPI process loopback, `IAudioClient`, Toolhelp32 | **SCK-аудио** (`SCStreamOutputType.audio`, macOS 13+) |
| `broadcast/prio.rs` | 122 (100%) | MMCSS `AvSetMmThreadCharacteristicsW` | QoS-классы + `os_workgroup_interval` |
| `hotkeys.rs` | 212 (100%) | `WH_KEYBOARD_LL`, VK-таблица | `RegisterEventHotKey` (Carbon) или `CGEventTap` |
| `hwinfo.rs` | 186 (100%) | реестр HKLM, `EnumDisplayDevicesW`, `GetSystemTimes` | `sysctl`, IOKit/Metal, `host_processor_info` |
| `broadcast/icon.rs` | 215 (~90%) | `WM_GETICON`, GDI `CreateDIBSection` | `NSRunningApplication.icon` → PNG |
| `broadcast/games.rs` | 153 (~50%) | HKCU `GameConfigStore` | `NSWorkspace.runningApplications` + bundle id |
| `branding.rs` | 123 (100%) | `IShellLinkW`, `.lnk` | **не нужен** — app bundle самоописателен, файл уходит под cfg |
| `lib.rs` | 419 | `ShellExecuteW`, `explorer /select` | `NSWorkspace.open`, `open -R` |
| `installer-hooks.nsh` | — | NSIS | не нужен |

### Два места, где Windows протёк в контракт IPC (значит и фронт)

1. `CaptureSource::Window { hwnd: isize }` (`capture.rs:167`) — `serde`-тип, приезжает из JS; `WindowInfo.hwnd` (`lib.rs:73`) уезжает в JS. На macOS это `CGWindowID` (u32). Нужен непрозрачный `id: u64`.
2. VK-коды: `hotkeys.rs:79-128` переводит JS `KeyboardEvent.code` в Win32 VK, симметричный `normKey()` живёт в `apps/web/src/util.ts`. У macOS своя таблица virtual key codes.

---

## Крупный риск, не связанный с Rust: WKWebView вместо Chromium

На Windows Tauri использует WebView2 (Chromium). На macOS — **WKWebView (WebKit)**. Весь приёмный видеокод (`apps/web/src/transport/treeVideo.ts`) и диагностика откалиброваны под Chromium:

- **`jitterBufferTarget` — Chromium-only.** `JITTER_MIN_MS`/`JITTER_MAX_MS` = 500/1000 мс и адаптив `150 + 3·rtt` (`treeVideo.ts`) на маке просто не применятся. Это прямой рычаг против фризов из инварианта 9.
- **`getStats()` в WebKit беднее.** Полей `freezeCount`, `totalFreezesDuration`, `jitterBufferDelay`/`jitterBufferTarget`, `decoderImplementation`, `powerEfficientDecoder`, `totalAssemblyTime` частично или полностью нет → отчёт `scripts/diag.mjs` по mac-зрителю будет неполным, а вердикты «вещатель не успевал / линк сыпется» опираются именно на них.
- **BWE-проба Д5** (`transport/probe.ts`) берёт `availableOutgoingBitrate` из Chromium-GCC. В Safari поддержка частичная → `available_outgoing` уйдёт 0, сервер даст консервативную ёмкость 1 (mac-зритель почти не будет ретранслятором). Работать будет, но хуже.
- **getUserMedia в WKWebView** требует `NSMicrophoneUsageDescription` в Info.plist и обработчика `requestMediaCapturePermissionFor`. Без этого голос не заведётся вообще. **Проверять спайком в первый же день.**
- H.264-декод в WebKit есть и аппаратный — с этим проблем не ждём.

---

## План по фазам

### Фаза 0. Спайки (до всякой архитектуры) — 3-4 дня

Дешёвые проверки, которые могут развернуть весь план:

1. Пустое Tauri-приложение на маке: грузим существующий `apps/web/dist`, входим в голосовой канал. Проверяем getUserMedia в WKWebView, RNNoise AudioWorklet, Web Audio-граф.
2. Тестовый `RTCPeerConnection` в WKWebView: какие поля отдаёт `getStats()`, есть ли `jitterBufferTarget`, есть ли `availableOutgoingBitrate`.
3. Минимальный `SCStream` на Rust через `objc2-screen-capture-kit`: получить кадр в NV12 напрямую (`kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange`) и аудио-семплы.
4. Минимальный `VTCompressionSession`: закодировать 10 кадров, посмотреть на формат выхода.

Результат спайков либо подтверждает оценку ниже, либо меняет её.

### Фаза 1. Кроссплатформенный каркас — 4-6 дней

Единственная фаза, выполнимая с Windows-машины.

- Ввести `src/platform/{mod.rs, windows/, macos/}` с трейтами: `Capturer`, `VideoEncoder`, `AudioCapturer`, `HwInfo`, `HotkeyHook`, `AppIcons`, `Shell`.
- Перенести весь существующий Win32-код под `#[cfg(windows)]` **без изменения поведения**, `cargo test --lib` на Windows остаётся зелёным — это контрольная точка.
- Разделить `Cargo.toml` на `[target.'cfg(windows)'.dependencies]` (`windows`, `windows-capture`, `windows-core`, `winreg`) и `[target.'cfg(target_os="macos")'.dependencies]` (`objc2`, `objc2-foundation`, `objc2-app-kit`, `objc2-screen-capture-kit`, `objc2-video-toolbox`, `objc2-core-media`, `objc2-core-video`).
- Вынести `relay`/`signaling` re-export из `broadcast/mod.rs` (там `MFStartup`/`CoInitializeEx` на строках 84-85) в отдельный модуль — иначе путь зрителя тащит Media Foundation.
- Нормализовать `CaptureSource` под непрозрачный `id: u64` + правка `apps/web/src/native.ts` и `BroadcastModal.tsx`.
- `branding.rs` и `installer-hooks.nsh` — под Windows-гейт.

### Фаза 2. Захват (ScreenCaptureKit) — 10-12 дней

Самый крупный кусок.

- `SCShareableContent` → перечисление дисплеев / окон / приложений (замена `list_monitors`/`list_windows`, `capture.rs:635-665`).
- `SCContentFilter`: дисплей целиком, отдельное окно, окно исключая наше приложение.
- `SCStream` + `SCStreamOutput`-делегат, `SCStreamConfiguration` (размер, `minimumFrameInterval`, `pixelFormat`, `queueDepth`, `showsCursor`).
- **Выигрыш:** SCK умеет отдавать NV12 напрямую → BGRA→NV12-конверсия (`bgra_to_nv12_luts`, самая тяжёлая часть CPU-пути на Windows) на маке просто не нужна. Тесты `parallel_conversion_matches_reference` остаются под Windows-гейтом.
- Горячая смена источника (`set_broadcast_source`), супервизор с ретраями (аналог `spawn_session`, `capture.rs:768-902`), детект фуллскрина (`foreground_is_fullscreen`).
- **TCC Screen Recording**: запрос разрешения, детект отказа, внятная ошибка в UI. Аналог `window_uncapturable_reason` (`capture.rs:672-696`).
- Preview-кадры для `StreamerWidget` (CVPixelBuffer → PNG).

### Фаза 3. Кодировщик (VideoToolbox) — 5-7 дней

- `VTCompressionSessionCreate` с `kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder`.
- Свойства под инварианты: `AllowFrameReordering=false` (инвариант 4, без B-кадров), `RealTime=true`, `ProfileLevel=H264_Main_AutoLevel`, `MaxKeyFrameInterval=60` + `MaxKeyFrameIntervalDuration=2` (GOP 2 с), `AverageBitRate` + `DataRateLimits`.
- **Главная ловушка:** VideoToolbox отдаёт AVCC (length-prefixed NAL), а RTP H.264-payloader в webrtc-rs ждёт Annex-B. Нужна конверсия длина→start-code **и** извлечение SPS/PPS из `CMFormatDescription` с инъекцией перед каждым IDR — иначе зритель не декодирует поток вообще.
- CBR: у VideoToolbox нет настоящего CBR как у MFT — приближается `AverageBitRate` + `DataRateLimits([bytes, seconds])`. Влияет на ровность потока к vrelay.
- Динамическая смена битрейта (ABR из `mod.rs`), принудительный keyframe (`kVTEncodeFrameOptionKey_ForceKeyFrame`).
- `GopWatch` (`encoder.rs:379-425`) переносится как есть — он портируемый и здесь так же нужен: «свойство принято» ≠ «применено», ровно те же грабли, что с MFT.

### Фаза 4. Аудио (SCK) — 4-5 дней

- `SCStreamConfiguration.capturesAudio = true` (macOS 13+), выход `SCStreamOutputType.audio` → `CMSampleBuffer` PCM.
- **Инвариант 6** («захват не содержит вывод самого RelayApp») на macOS решается чище, чем на Windows: `SCContentFilter(display:excludingApplications:exceptingWindows:)` — исключаем себя; либо фильтр только по приложению-игре — прямой аналог `AudioSource::IncludeProcess(pid)`.
- Ресемпл/микс в 48 кГц стерео i16 — `Mixer` и `bytes_to_i16_stereo` (`audio.rs:170-244`) переносятся как есть.
- Хардкод `msedgewebview2.exe` (`audio.rs:396`) заменяется на bundle id нашего приложения.

### Фаза 5. Остальные подсистемы — 7-9 дней

| Что | Дней |
|---|---|
| Приоритеты потоков: QoS `USER_INTERACTIVE` + `os_workgroup_interval` для capture/encode/audio/rayon | 1 |
| Хоткеи: `RegisterEventHotKey` (без TCC-разрешения) + таблица `KeyboardEvent.code` → mac VK | 2-3 |
| `hwinfo`: `sysctl` (`machdep.cpu.brand_string`, `hw.ncpu`, `hw.memsize`), GPU через Metal, `host_processor_info` для CPU-нагрузки | 1-2 |
| Детект игр + иконки: `NSWorkspace`, bundle id, `NSRunningApplication.icon` → PNG; Discord-список фильтруется по `os: "darwin"` | 2-3 |
| Shell: `open_external_url`, `open_file`, `reveal_in_folder`, `paths_exist` | 0.5 |
| Окно-карточка уведомления (`notif.html`), позиционирование, дока-бейдж вместо `setOverlayIcon` (Windows-only Tauri API) | 1-2 |

### Фаза 6. Совместимость с WKWebView — 4-6 дней

- Info.plist: `NSMicrophoneUsageDescription`, `NSCameraUsageDescription`; entitlements для микрофона и JIT.
- Фолбэки в `treeVideo.ts` там, где `jitterBufferTarget` отсутствует (фича-детект, не платформо-детект).
- `diag.ts`: не слать поля, которых WebKit не отдаёт; `scripts/diag.mjs` — терпимо печатать пропуски вместо нулей.
- `probe.ts`: честный `available_outgoing = 0` при отсутствии `availableOutgoingBitrate`, без фейков.
- Прогнать вручную все веб-фичи (RNNoise-граф, звук по каналам, чат, уведомления) под WebKit.

### Фаза 7. Сборка, подпись, обновление — 4-5 дней + $99/год

- Новый джоб в `.github/workflows/build-windows.yml` (или отдельный `build-macos.yml`) на `macos-14`, таргет `aarch64-apple-darwin`. Учесть общий `concurrency: relayapp-production` с `deploy.yml`.
- `bundle.macOS.minimumSystemVersion: "13.0"`, иконка `icons/icon.icns` (уже лежит на диске).
- **Подпись и нотаризация — блокер, не косметика.** Без Developer ID Gatekeeper не даст запустить скачанное приложение, а TCC-грант Screen Recording привязан к подписи бинаря: у неподписанных сборок он слетает при **каждом** ребилде — разработка фазы 2 без сертификата будет мучительной. Нужны секреты: `.p12` + пароль, `APPLE_ID`, app-specific password, `TEAM_ID`, `xcrun notarytool` + `stapler`.
- **Апдейтер:** сейчас `latest.json` собирается Windows-пайплайном целиком и атомарно подменяется (`build-windows.yml`, шаг promote). Два джоба на один файл = гонка. Чистое решение — шаблон `{{target}}` в `endpoints` (`tauri.conf.json`): каждая платформа кладёт свой файл. Анти-роллбэк-гард `desktop-release-sequence` тоже становится пер-платформенным.
- Артефакты обновления на macOS — `.app.tar.gz` + `.sig`, для первой установки `.dmg`. Ключ minisign общий, менять не нужно.
- Фронт: `api.appLatest()` (`apps/web/src/api.ts:287-295`) читает захардкоженный `d.platforms['windows-x86_64'].url` — нужен детект платформы; `DownloadFab.tsx` — тоже.

### Фаза 8. Живое тестирование — 5-7 дней

Реальное железо обязательно: TCC-потоки разрешений, поведение при отзыве доступа, вещание игры в фуллскрине, эхо/петля аудио, задержка < 2 с (инвариант 9), сквозной прогон mac-вещатель → vrelay → Windows-зритель и обратно, снятие диага и проверка, что `scripts/diag.mjs` его читает.

---

## Итоговая оценка

| Фаза | Дней |
|---|---|
| 0. Спайки | 3-4 |
| 1. Каркас | 4-6 |
| 2. Захват (SCK) | 10-12 |
| 3. Кодировщик (VideoToolbox) | 5-7 |
| 4. Аудио | 4-5 |
| 5. Остальные подсистемы | 7-9 |
| 6. WKWebView | 4-6 |
| 7. Сборка/подпись/апдейтер | 4-5 |
| 8. Живое тестирование | 5-7 |
| **Итого** | **46-61 рабочий день ≈ 9-12 недель одним разработчиком** |

Из них **~55% (фазы 2-4) — вещание**. Если бы паритет не требовался, зритель+голос+чат уложились бы в ~2 недели: путь `start_watch` уже кроссплатформенный.

### Что нужно завести до старта

1. **Mac на arm64 для разработки** — CI-раннера недостаточно, фазы 2/4/8 требуют живого железа с реальным звуком и играми.
2. **Apple Developer Program, $99/год** — не только для раздачи, но и чтобы TCC-грант не слетал каждую сборку.
3. Решить, где Mac-сборка берёт минуты CI: `macos-14` на приватном репозитории тарифицируется с множителем ×10.

---

## Проверка результата

- `cargo check` и `cargo test --lib` зелёные **на обеих платформах** (главный признак, что фаза 1 не сломала Windows).
- `cargo test --lib` на Windows после фазы 1 даёт тот же набор пройденных тестов, что до неё.
- Mac-вещатель → vrelay → Windows-зритель: картинка и звук есть, задержка < 2 с, `npm run diag -- report` не выносит вердикт «вещатель не успевал».
- Windows-вещатель → vrelay → Mac-зритель: то же в обратную сторону.
- Голос между Mac и Windows в обе стороны, изоляция по каналам и deafen работают.
- Скачанный `.dmg` запускается на чистом маке без обхода Gatekeeper; авто-обновление находит новую версию и перезапускается.
- Стрим игры в фуллскрине: захват не отваливается, в звуке нет вывода самого RelayApp (инвариант 6).
