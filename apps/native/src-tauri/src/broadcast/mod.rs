// Оркестратор нативного вещателя (Evolution-TZ Э5): захват -> H.264-энкодер ->
// webrtc-rs корень дерева. Захват и энкодер — на отдельных OS-потоках (COM/MFT
// блокирующие вызовы, нельзя гонять на tokio-воркере); сигналинг и
// RTCPeerConnection'ы — в tokio-задаче на runtime вызывающей стороны (Tauri).

pub mod audio;
pub mod capture;
pub mod encoder;
pub mod games;
pub mod icon;
pub mod peer;
pub mod prio;
// relay-ядро и WS-сигналинг дерева вынесены в кросс-платформенный крейт relay-core
// (Э9: общий код с headless-агентом vrelay). Реэкспорт сохраняет старые пути
// broadcast::relay::* / broadcast::signaling::* для lib.rs и этого модуля.
pub use relay_core::{relay, signaling};
pub mod stats;

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Нижняя полка ABR (Evolution-TZ Э8): ниже неё качество бессмысленно, лучше рвать
/// зрителя репарентом. Верхняя полка — выбранный вещателем битрейт (config.bitrate_bps).
const BITRATE_FLOOR: u32 = 800_000;

/// Лестница качества (Э8, стабильность > качество): когда ABR роняет битрейт, одним
/// снижением битрейта при полном fps/разрешении картинка разваливается (800 кбит/с на
/// 1080p60 — каша, а IDR-спайки пробивают слабый линк => потери => PLI => ещё IDR).
/// Режем сначала FPS (ниже LADDER_FPS_BPS — cap 30), затем разрешение (ниже
/// LADDER_RES_BPS — cap 1280x720): 720p30 на том же битрейте смотрибельны и дают
/// энкодеру запас. Всё на стороне вещателя (инвариант 7): capture перечитывает цели
/// на лету (QualityTargets), энкодер пересоздаётся на смене fps/размера кадра.
const LADDER_FPS_BPS: u32 = 2_500_000;
const LADDER_RES_BPS: u32 = 1_400_000;
/// Подъём ступени только с запасом (анти-флаппинг): ABR пробует вверх по +8%/тик и
/// у порога без гистерезиса лестница дёргала бы пересоздание MFT каждые пару секунд.
const LADDER_UP_FACTOR: f64 = 1.15;

/// Состояние лестницы. step: 0 = полное качество, 1 = 30 fps, 2 = 720p30.
struct QualityLadder {
    user_fps: u32,
    user_w: u32,
    user_h: u32,
    targets: capture::QualityTargets,
    step: u8,
}

impl QualityLadder {
    fn step_for(&self, bps: u32) -> u8 {
        let up = |t: u32| (t as f64 * LADDER_UP_FACTOR) as u32;
        match self.step {
            0 => if bps < LADDER_RES_BPS { 2 } else if bps < LADDER_FPS_BPS { 1 } else { 0 },
            1 => if bps < LADDER_RES_BPS { 2 } else if bps >= up(LADDER_FPS_BPS) { 0 } else { 1 },
            _ => if bps >= up(LADDER_FPS_BPS) { 0 } else if bps >= up(LADDER_RES_BPS) { 1 } else { 2 },
        }
    }

    /// Применяет ступень под новую цель битрейта (вызывается на каждом set-bitrate;
    /// no-op, пока ступень не сменилась). Пишет живые цели — захват подхватит на
    /// следующем кадре, энкодер пересоздастся по своим resize/fps-путям.
    fn apply(&mut self, bps: u32) {
        let next = self.step_for(bps);
        if next == self.step { return; }
        self.step = next;
        let (f, w, h) = match next {
            0 => (self.user_fps, self.user_w, self.user_h),
            1 => (self.user_fps.min(30), self.user_w, self.user_h),
            _ => (self.user_fps.min(30), self.user_w.min(1280), self.user_h.min(720)),
        };
        self.targets.fps.store(f, Ordering::Relaxed);
        self.targets.max_width.store(w, Ordering::Relaxed);
        self.targets.max_height.store(h, Ordering::Relaxed);
        log::info!("ladder: ступень {next} при цели {:.1} Мбит/с -> {f} fps, max {w}x{h}", bps as f64 / 1e6);
    }
}

use bytes::Bytes;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use webrtc::media::Sample;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use windows::Win32::Media::MediaFoundation::{MFShutdown, MFStartup, MFSTARTUP_FULL, MFSTARTUP_NOSOCKET, MF_VERSION};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

pub use audio::AudioSource;
pub use capture::CaptureSource;

use self::prio::{ensure_thread_mmcss, MmTask};
use self::signaling::TreeEvent;
use self::stats::{SharedStats, StatsHandle};

/// Конфиг стрима (Э5.1) — задаётся из UI перед стартом вместо прежних жёстких
/// констант; `max_width`/`max_height` — верхняя граница (без апскейла, см.
/// capture::scaled_dims), фактическое разрешение зависит от источника.
pub struct StreamConfig {
    pub max_width: u32,
    pub max_height: u32,
    pub fps: u32,
    /// Э8: при auto_bitrate=true — потолок ABR (сервер адаптирует вниз под худший линк);
    /// при false — фиксированный битрейт (сервер не шлёт set-bitrate, см. join.abr).
    pub bitrate_bps: u32,
    /// Э8 ABR: включить авто-адаптацию битрейта под сеть дерева.
    pub auto_bitrate: bool,
    /// По умолчанию `ExcludeSelfViaInclude` — авто: INCLUDE-клиент на каждый не-наш
    /// аудио-процесс, микс (надёжно «всё кроме RelayApp», см. audio.rs).
    /// `IncludeProcess(pid)` — ручной override на один процесс.
    pub audio_source: AudioSource,
    /// Э8: лимит прямых детей корня в дереве (задаётся вещателем в UI). Overflow-зрители
    /// уходят глубже через relay-узлы. Ёмкость объявляется серверу в join (см. signaling).
    pub max_direct_children: u32,
    /// Roadmap-flow-стриминга Д5: применять ли клиентскую QualityLadder на set-bitrate.
    /// В пресет-режиме (Плавность/Качество) и в server-first+CBR лестница НЕ нужна — адаптация
    /// зрителей идёт через серверные рендишны (Д4). Включена только в ручном авто-битрейте
    /// (presetMode == 'manual' && auto_bitrate). Целевой битрейт от set-bitrate применяется
    /// к CBR-энкодеру всегда — гейт снимает лишь смену fps/разрешения лестницей.
    pub ladder_enabled: bool,
}

pub struct BroadcastHandle {
    enc_stop: Arc<AtomicBool>,
    shutdown_tx: mpsc::UnboundedSender<Option<String>>,
    /// Только энкодерный поток. Захват и аудио джойнятся через свои супервайзеры
    /// (у них своя жизнь сессий — смена источника на лету, Э5.3).
    threads: Vec<std::thread::JoinHandle<()>>,
    /// Держит канал захвата и переключает под ним WGC-сессии (смена монитора/окна
    /// без пересоздания дерева/треков).
    cap_sup: Arc<std::sync::Mutex<capture::CaptureSupervisor>>,
    /// Держит аудио-трек и переключает под ним WASAPI-сессии (звук следует за источником).
    audio_sup: Arc<std::sync::Mutex<AudioSupervisor>>,
    /// Форс IDR после свитча — чтобы новый контент декодировался у зрителей сразу.
    force_keyframe: Arc<AtomicBool>,
    /// Подпись источника для дебаг-панели; обновляется при смене источника на лету.
    source_label: Arc<std::sync::Mutex<String>>,
    /// Снимается run_signaling_loop сам, в конце (и при штатном стопе, и при
    /// фатальном отказе энкодера/захвата) — до её появления `stop_broadcast`
    /// с фронта был единственным способом снять "уже вещаем" с Tauri-состояния
    /// после самостоятельной смерти потока, а он вызывается асинхронно и
    /// fire-and-forget (см. ServerView.tsx onBroadcastStopped) — пользователь
    /// успевал кликнуть "начать трансляцию" раньше, чем стейт реально очистится,
    /// и получал спурьезный "уже вещаем" (отсюда "нужно стартануть раз 5").
    alive: Arc<AtomicBool>,
}

impl BroadcastHandle {
    pub fn is_alive(&self) -> bool { self.alive.load(Ordering::Relaxed) }

    /// Смена источника видео (и звука) на лету без пересоздания дерева/треков (Э5.3).
    /// Валидация нового источника — синхронно внутри `switch`; при ошибке текущая
    /// трансляция продолжается на старом источнике.
    pub async fn set_source(&self, source: CaptureSource, audio: AudioSource) -> Result<(), String> {
        let cs = self.cap_sup.clone();
        // spawn_blocking: switch джойнит поток старой WGC-сессии — нельзя на tokio-воркере.
        tokio::task::spawn_blocking(move || cs.lock().unwrap().switch(source))
            .await
            .map_err(|e| format!("switch join: {e}"))??;
        let a = self.audio_sup.clone();
        let _ = tokio::task::spawn_blocking(move || a.lock().unwrap().switch(audio)).await;
        *self.source_label.lock().unwrap() = describe_source(&source);
        self.force_keyframe.store(true, Ordering::Relaxed);
        Ok(())
    }

    pub async fn stop(mut self) {
        {
            let cs = self.cap_sup.clone();
            let _ = tokio::task::spawn_blocking(move || cs.lock().unwrap().stop()).await;
        }
        {
            let a = self.audio_sup.clone();
            let _ = tokio::task::spawn_blocking(move || a.lock().unwrap().stop()).await;
        }
        self.enc_stop.store(true, Ordering::Relaxed);
        let _ = self.shutdown_tx.send(None); // штатный стоп по кнопке — без причины
        for t in self.threads.drain(..) {
            let _ = tokio::task::spawn_blocking(move || t.join()).await;
        }
    }
}

/// Одна WASAPI-сессия захвата звука в отдельном потоке (COM/WASAPI блокирующие —
/// не гонять на tokio-воркере). Пишет в переданный трек. См. AudioSupervisor.
fn spawn_audio_session(
    source: AudioSource,
    track: Arc<TrackLocalStaticSample>,
    rt: tokio::runtime::Handle,
) -> (std::thread::JoinHandle<()>, Arc<AtomicBool>) {
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    let handle = std::thread::spawn(move || {
        // Звук лёгкий по CPU, но чувствителен к джиттеру: пропущенный 20мс-тик слышен.
        // Под фуллскрин-игрой поток с NORMAL-приоритетом такие тики теряет. См. prio.rs.
        ensure_thread_mmcss(MmTask::ProAudio);
        // RELAYAPP_DISABLE_AUDIO=1 — аварийный выключатель для отладки видео-пути
        // отдельно от звука; по умолчанию звук игры/системы идёт в стрим (см. audio.rs).
        if std::env::var("RELAYAPP_DISABLE_AUDIO").is_ok() {
            log::warn!("audio: отключено через RELAYAPP_DISABLE_AUDIO");
            while !stop2.load(Ordering::Relaxed) { std::thread::sleep(Duration::from_millis(100)); }
            return;
        }
        unsafe { let _ = CoInitializeEx(None, COINIT_MULTITHREADED); }
        let frame_dur = Duration::from_millis(20);
        let result = audio::run_capture_loop(stop2, source, |chunk| {
            let sample = Sample { data: Bytes::from(chunk.data), duration: frame_dur, ..Default::default() };
            let track = track.clone();
            rt.block_on(async { let _ = track.write_sample(&sample).await; });
        });
        if let Err(e) = result {
            log::error!("audio: capture loop failed: {e}");
        }
        log::info!("audio thread stopped");
    });
    (handle, stop)
}

/// Держит аудио-трек на всю трансляцию и переключает под ним WASAPI-сессии — звук
/// следует за источником видео (монитор -> ExcludeSelf, окно -> его PID) и меняется
/// при смене источника на лету, не трогая трек/дерево.
struct AudioSupervisor {
    track: Arc<TrackLocalStaticSample>,
    rt: tokio::runtime::Handle,
    cur: Option<(std::thread::JoinHandle<()>, Arc<AtomicBool>)>,
}

impl AudioSupervisor {
    fn start(&mut self, source: AudioSource) {
        self.cur = Some(spawn_audio_session(source, self.track.clone(), self.rt.clone()));
    }
    fn stop_current(&mut self) {
        if let Some((handle, stop)) = self.cur.take() {
            stop.store(true, Ordering::Relaxed);
            let _ = handle.join();
        }
    }
    fn switch(&mut self, source: AudioSource) {
        self.stop_current();
        self.start(source);
    }
    fn stop(&mut self) {
        self.stop_current();
    }
}

fn describe_source(source: &CaptureSource) -> String {
    match source {
        CaptureSource::Monitor { index } => format!("Монитор {index}"),
        CaptureSource::Window { hwnd } => {
            let title = capture::window_title(*hwnd);
            if title.is_empty() { "Окно".to_owned() } else { format!("Окно: {title}") }
        }
    }
}

/// Запускается из async Tauri-команды (уже внутри tokio-runtime — используем
/// его `Handle` для записи сэмплов из энкодерного потока). `app: None` — режим
/// e2e-смоука (examples/broadcast_smoke.rs), где нет запущенного Tauri-приложения
/// и эмитить дебаг-события во фронтенд некому.
pub async fn start(
    app: Option<AppHandle>,
    stream_id: String,
    ws_url: String,
    identity: String,
    server_id: String,
    source: CaptureSource,
    config: StreamConfig,
) -> Result<BroadcastHandle, String> {
    let StreamConfig { max_width, max_height, fps, bitrate_bps, auto_bitrate, audio_source, max_direct_children, ladder_enabled } = config;
    // Разделяемая подпись источника — обновляется при смене источника на лету (set_source).
    let source_label = Arc::new(std::sync::Mutex::new(describe_source(&source)));
    // ABR (Э8): живая цель битрейта. Стартует с выбранного пользователем значения (оно же —
    // потолок ceiling), сервер шлёт вниз set-bitrate под худший линк дерева. Читается
    // энкодер-потоком, пишется signaling-циклом. bitrate_bps остаётся потолком для clamp.
    let target_bitrate = Arc::new(AtomicU32::new(bitrate_bps));
    let stats: StatsHandle = Arc::new(SharedStats::default());
    // Создаём здесь (не в конце функции, как раньше) — encoder_thread должен уметь
    // сам инициировать остановку всей трансляции при фатальной ошибке (MFStartup,
    // отказ энкодера на 0x0-кадре и т.п.): раньше поток просто тихо `break`-ился,
    // сигналинг оставался жить, а Tauri-состояние вещания зависало навсегда
    // ("уже вещаем" на повторном старте) — фронтенд о смерти потока не узнавал.
    let (shutdown_tx, shutdown_rx) = mpsc::unbounded_channel();

    // Захват через супервайзер: он держит канал, под которым можно менять WGC-сессии
    // (монитор/окно) на лету — энкодер и WebRTC-треки этого не замечают (Э5.3).
    // buf_pool — оборотный пул NV12-буферов: захват берёт, энкодер возвращает после
    // encode(). Без него на каждый кадр аллоцировалось ~3 МБ (1080p) прямо в колбэке WGC.
    let (mut cap_sup, cap_rx, buf_pool) = capture::CaptureSupervisor::new(max_width, max_height, fps, stats.clone(), shutdown_tx.clone());
    // Живые цели качества (ABR-лестница): пишет сигналинг-цикл, читают capture (на кадре)
    // и энкодер-поток (смена fps => пересоздание MFT с корректным rate-control).
    let quality_targets = cap_sup.targets();
    cap_sup.start(source)?; // синхронная валидация источника — ошибка уйдёт caller'у сразу
    let cap_sup = Arc::new(std::sync::Mutex::new(cap_sup));

    let force_keyframe = Arc::new(AtomicBool::new(true));
    // Метаданные приложения для зрителей (иконка + имя окна). Только для захвата окна;
    // при захвате монитора приложение неопределимо (None — зритель покажет generic-глиф).
    let (app_name, app_icon) = match source {
        CaptureSource::Window { hwnd } => {
            let (proc, pid) = capture::window_process_and_pid(hwnd);
            let name = if proc.to_lowercase().ends_with(".exe") { proc[..proc.len() - 4].to_string() } else { proc };
            (if name.is_empty() { None } else { Some(name) }, icon::window_icon_png_base64(hwnd, pid))
        }
        CaptureSource::Monitor { .. } => (None, None),
    };
    let join = signaling::JoinParams {
        stream_id: stream_id.clone(), identity, server_id,
        role: "broadcaster", native: true, max_children: max_direct_children,
        max_bitrate: bitrate_bps, // потолок ABR = выбранный пользователем битрейт
        abr: auto_bitrate,
        virtual_relay: false,
        // Д3: натив-вещатель всегда в source-дереве (`::source`). Рендишны — серверный транскод (vrelay).
        quality: "source".to_string(),
        // Д1 (server-first): натив всегда сигналит «вещаю через сервер». Сервер сам решает
        // по своему TREE_SERVER_FIRST, включать ли режим; старый сервер поле проигнорирует.
        server_ingest: true,
        app_name, app_icon,
        // Д4: выходное разрешение — сервер режет лестницу рендишнов сверху (без апскейла).
        width: max_width, height: max_height,
        pinned: false, // вещатель не «зритель с пином»
    };
    // reconnect=true: деплой рестартит сервер — вещание переживает обрыв WS (реджойн),
    // энкод/захват не прерываются, зрители переджойнятся сами.
    let (cmd_tx, evt_rx) = signaling::connect(ws_url, join, true);

    let mgr = peer::PeerManager::new(&stream_id, cmd_tx.clone(), force_keyframe.clone(), stats.clone())?;
    let video_track = mgr.video_track.clone();
    let audio_track = mgr.audio_track.clone();

    let enc_stop = Arc::new(AtomicBool::new(false));
    let enc_stop2 = enc_stop.clone();
    let rt_handle = tokio::runtime::Handle::current();
    let force_keyframe_enc = force_keyframe.clone();
    let stats_enc = stats.clone();
    let shutdown_tx_enc = shutdown_tx.clone();
    let target_bitrate_enc = target_bitrate.clone();
    let eff_fps_enc = quality_targets.fps.clone();

    let encoder_thread = std::thread::spawn(move || {
        // Тот же класс MMCSS, что и у захвата: под фуллскрин-игрой этот поток должен
        // успевать забирать кадр из bounded(2), иначе захват их роняет. См. prio.rs.
        ensure_thread_mmcss(MmTask::Games);
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL | MFSTARTUP_NOSOCKET) {
                log::error!("encoder: MFStartup failed: {e}");
                let _ = shutdown_tx_enc.send(Some(format!("не удалось инициализировать Media Foundation: {e}")));
                return;
            }
        }
        // Энкодер создаём лениво, на первом реальном кадре: фактический размер
        // зависит от источника (окно почти никогда не равно max_width/max_height,
        // scaled_dims не апскейлит). При смене размера (ресайз окна, DPI, снаппинг)
        // MFT нельзя переинициализировать на лету — пересоздаём H264Encoder целиком
        // (см. ниже), а не дропаем кадры навсегда: раньше после первого же ресайза
        // энкодер замирал на старом разрешении и все дальнейшие кадры молча
        // отбрасывались (зритель видел "1920x1044" и рваный fps — фактически
        // почти все кадры терялись после первого ресайза окна).
        let mut fps_window_start = Instant::now();
        let mut fps_window_count = 0u32;
        // (энкодер, ширина, высота, fps его инициализации) — fps живой (ABR-лестница),
        // на его смене MFT пересоздаётся: CBR-бюджет на кадр у MFT завязан на frame rate,
        // кормить 30 fps энкодеру, настроенному на 60, значит отдавать кадрам половину бит.
        let mut enc: Option<(encoder::H264Encoder, u32, u32, u32)> = None;
        // Реальное время между кадрами (а не номинальный frame_dur) — иначе RTP-таймстемпы
        // расходятся с фактическим темпом захвата (WGC отдаёт кадры неравномерно), и
        // зритель видит рваный fps даже когда энкодер стабильно поспевает.
        let mut prev_captured_at: Option<Instant> = None;
        // Живое перетаскивание рамки окна отдаёт десятки разных промежуточных
        // размеров в секунду — пересоздавать аппаратный MFT на каждый из них
        // (полный Activate/SetInputType/SetOutputType хардварного энкодера)
        // валило NVENC/AMF-сессию и роняло поток. Ждём, пока размер не
        // стабилизируется на RESIZE_DEBOUNCE, и только тогда пересоздаём энкодер.
        const RESIZE_DEBOUNCE: Duration = Duration::from_millis(400);
        let mut pending_resize: Option<(u32, u32, Instant)> = None;
        while !enc_stop2.load(Ordering::Relaxed) {
            let frame = match cap_rx.recv_timeout(Duration::from_millis(500)) {
                Ok(f) => f,
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                    // Захват умер сам (окно закрыли, WGC-сессия оборвалась и т.п.) —
                    // без этого сигнала сигналинг остался бы жить, а состояние вещания
                    // зависло бы навсегда ("уже вещаем" на повторном старте).
                    log::warn!("encoder: capture channel disconnected, stopping broadcast");
                    let _ = shutdown_tx_enc.send(Some("захват прервался (окно/монитор пропали)".into()));
                    break;
                }
            };
            let cur_fps = eff_fps_enc.load(Ordering::Relaxed).max(1);
            let frame_dur = Duration::from_secs_f64(1.0 / cur_fps as f64);
            // ABR-лестница сменила целевой fps — пересоздаём MFT (см. комментарий у enc).
            // Без дебаунса: ступени лестницы редкие (гистерезис в QualityLadder), в отличие
            // от живого ресайза окна ниже.
            if matches!(&enc, Some((_, _, _, efps)) if *efps != cur_fps) {
                log::info!("encoder: ladder fps -> {cur_fps}, переинициализация MFT");
                enc = None;
                pending_resize = None;
            }
            if let Some((_, w, h, _)) = &enc {
                if frame.width != *w || frame.height != *h {
                    let stable = match pending_resize {
                        Some((pw, ph, at)) if pw == frame.width && ph == frame.height => at.elapsed() >= RESIZE_DEBOUNCE,
                        _ => false,
                    };
                    if stable {
                        log::info!("encoder: source resize {w}x{h} -> {}x{}, переинициализация MFT", frame.width, frame.height);
                        enc = None;
                        pending_resize = None;
                    } else {
                        if !matches!(pending_resize, Some((pw, ph, _)) if pw == frame.width && ph == frame.height) {
                            pending_resize = Some((frame.width, frame.height, Instant::now()));
                        }
                        // размер ещё "гуляет" — не трогаем энкодер, кадр дропаем (буфер в пул)
                        buf_pool.put(frame.data);
                        continue;
                    }
                } else {
                    pending_resize = None; // источник вернулся к размеру энкодера
                }
            }
            if enc.is_none() {
                // Окно может отдать первый кадр 0x0 (сворачивается/ещё не отрисовано) —
                // MFT такое не примет, просто ждём кадр с реальным размером вместо
                // немедленного фатального отказа.
                if frame.width == 0 || frame.height == 0 {
                    log::debug!("encoder: skip 0x0 frame (source not ready yet)");
                    buf_pool.put(frame.data);
                    continue;
                }
                // Берём живую цель, не замороженный bitrate_bps: после ресайза окна MFT
                // пересоздаётся и должен подхватить уже адаптированный ABR-битрейт.
                let start_bitrate = target_bitrate_enc.load(Ordering::Relaxed);
                match encoder::H264Encoder::new(frame.width, frame.height, cur_fps, start_bitrate, force_keyframe_enc.clone()) {
                    Ok(e) => { force_keyframe_enc.store(true, Ordering::Relaxed); enc = Some((e, frame.width, frame.height, cur_fps)); }
                    Err(e) => {
                        log::error!("encoder: init failed: {e}");
                        let _ = shutdown_tx_enc.send(Some(format!("не удалось создать H264-энкодер: {e}")));
                        break;
                    }
                }
            }
            let (encoder_ref, _enc_w, _enc_h, _enc_fps) = enc.as_mut().expect("initialized above");
            // ABR: подхватываем цель, присланную сервером (set_bitrate — no-op на неизменной).
            encoder_ref.set_bitrate(target_bitrate_enc.load(Ordering::Relaxed));
            let real_dur = match prev_captured_at {
                Some(prev) => frame.captured_at.saturating_duration_since(prev).clamp(frame_dur / 4, Duration::from_secs(2)),
                None => frame_dur,
            };
            prev_captured_at = Some(frame.captured_at);
            let enc_start = Instant::now();
            let encoded = encoder_ref.encode(&frame);
            let encode_ns = enc_start.elapsed().as_nanos() as u64;
            // Буфер отработал: кадр скопирован в MFT-сэмпл внутри encode(). Возвращаем в
            // оборот ДО write_sample, чтобы захват не ждал пока мы толкаем байты в трек.
            buf_pool.put(frame.data);
            let mut write_ns = 0u64;
            match encoded {
                Ok(chunks) => {
                    for c in chunks {
                        stats_enc.encoded_frames.fetch_add(1, Ordering::Relaxed);
                        stats_enc.encoded_bytes.fetch_add(c.data.len() as u64, Ordering::Relaxed);
                        if c.is_keyframe { stats_enc.keyframes.fetch_add(1, Ordering::Relaxed); }
                        let sample = Sample { data: Bytes::from(c.data), duration: real_dur, ..Default::default() };
                        let track = video_track.clone();
                        let w_start = Instant::now();
                        rt_handle.block_on(async { let _ = track.write_sample(&sample).await; });
                        write_ns += w_start.elapsed().as_nanos() as u64;
                        fps_window_count += 1;
                    }
                }
                Err(e) => log::warn!("encoder: encode error: {e}"),
            }
            stats_enc.encode_ns.fetch_add(encode_ns, Ordering::Relaxed);
            stats_enc.encode_max_ns.fetch_max(encode_ns, Ordering::Relaxed);
            stats_enc.write_ns.fetch_add(write_ns, Ordering::Relaxed);
            stats_enc.encode_samples.fetch_add(1, Ordering::Relaxed);
            let elapsed = fps_window_start.elapsed();
            if elapsed.as_secs() >= 2 {
                log::info!("encoder: {:.1} fps sent to track", fps_window_count as f64 / elapsed.as_secs_f64());
                fps_window_count = 0;
                fps_window_start = Instant::now();
            }
        }
        log::info!("encoder thread stopped");
        // MFStartup — счётчик ссылок на весь MF-плейтформ процесса; без парного
        // MFShutdown платформа (и, судя по всему, состояние аппаратного MFT-активатора)
        // не освобождается между сессиями вещания в рамках одного процесса — второй
        // старт в том же запуске приложения ловил рабочий, но "грязный" энкодер и падал
        // почти сразу. drop(enc) — ДО shutdown: транспорт (COM Release внутри Drop
        // H264Encoder) должен уйти раньше, чем платформа встанет.
        drop(enc);
        unsafe { let _ = MFShutdown(); CoUninitialize(); }
    });

    // Аудио через супервайзер: держит трек, под ним меняются WASAPI-сессии (звук
    // следует за источником и переключается на лету вместе с видео).
    let mut audio_sup = AudioSupervisor {
        track: audio_track,
        rt: tokio::runtime::Handle::current(),
        cur: None,
    };
    audio_sup.start(audio_source);
    let audio_sup = Arc::new(std::sync::Mutex::new(audio_sup));

    let alive = Arc::new(AtomicBool::new(true));
    let alive_loop = alive.clone();
    let meta = DebugMeta { stream_id, source_label: source_label.clone(), target_bitrate_bps: bitrate_bps };
    let ladder = QualityLadder { user_fps: fps, user_w: max_width, user_h: max_height, targets: quality_targets, step: 0 };
    tokio::spawn(run_signaling_loop(mgr, evt_rx, shutdown_rx, app, stats, meta, alive_loop, force_keyframe.clone(), target_bitrate, ladder, ladder_enabled));

    Ok(BroadcastHandle {
        enc_stop,
        shutdown_tx,
        threads: vec![encoder_thread],
        cap_sup,
        audio_sup,
        force_keyframe,
        source_label,
        alive,
    })
}

struct DebugMeta {
    stream_id: String,
    source_label: Arc<std::sync::Mutex<String>>,
    target_bitrate_bps: u32,
}

/// Снимок для дебаг-панели во фронтенде (Э5.1) — эмитится Tauri-событием
/// `relay-broadcast-stats` каждый тик; поля camelCase под конвенцию JS-стороны.
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DebugSnapshot {
    stream_id: String,
    source: String,
    width: u32,
    height: u32,
    target_fps: u32,
    capture_fps: f64,
    encoder_fps: f64,
    dropped_frames: u64,
    bitrate_target_bps: u32,
    bitrate_actual_bps: f64,
    children: usize,
}

async fn run_signaling_loop(
    mut mgr: peer::PeerManager,
    mut evt_rx: mpsc::UnboundedReceiver<TreeEvent>,
    mut shutdown_rx: mpsc::UnboundedReceiver<Option<String>>,
    app: Option<AppHandle>,
    stats: StatsHandle,
    meta: DebugMeta,
    alive: Arc<AtomicBool>,
    force_keyframe: Arc<AtomicBool>,
    target_bitrate: Arc<AtomicU32>,
    mut ladder: QualityLadder,
    ladder_enabled: bool,
) {
    let mut stats_tick = tokio::time::interval(Duration::from_secs(2));
    let mut prev_at = Instant::now();
    let (mut prev_cap, mut prev_enc, mut prev_bytes) = (0u64, 0u64, 0u64);
    // capture_drops кумулятивен и уходил только в DebugSnapshot (дебаг-панель). В логе
    // его не было вовсе — по файлу нельзя было сказать, ронял ли захват кадры. Дельта
    // за окно попадает в строку `timing:` рядом с секциями, которые её объясняют.
    let mut prev_drops = 0u64;
    // Причина самостоятельной остановки — раньше фронт узнавал только "трансляция
    // умерла", без "почему", и молча откатывался в форму настроек (см. StopInfo ниже).
    // Присваивается только на выходных ветках (break), поэтому без инициализатора —
    // иначе `None` был бы мёртвым присваиванием (warning unused_assignments).
    let stop_reason: Option<String>;
    loop {
        tokio::select! {
            evt = evt_rx.recv() => {
                match evt {
                    Some(TreeEvent::Welcome { ice_servers }) => mgr.set_ice_servers(&ice_servers),
                    Some(TreeEvent::AssignChild { child_id }) => mgr.on_assign_child(child_id).await,
                    Some(TreeEvent::SdpAnswer { from, sdp }) => mgr.on_sdp_answer(from, sdp).await,
                    Some(TreeEvent::Ice { from, candidate }) => mgr.on_ice(from, candidate).await,
                    Some(TreeEvent::DropPeer { peer_id }) => mgr.on_drop_peer(peer_id).await,
                    // Э8: relay-узел ниже по дереву просит IDR для нового зрителя — форсим.
                    // Считаем в pli_count: запрос пришёл СИГНАЛИНГОМ, а не RTCP, и peer.rs его
                    // не увидит. Без этого `net: ... PLI +0` читалось как «IDR никто не просил»,
                    // хотя зрители из глубины дерева могли слать их пачками через vrelay.
                    Some(TreeEvent::RequestKeyframe) => {
                        stats.pli_count.fetch_add(1, Ordering::Relaxed);
                        force_keyframe.store(true, Ordering::Relaxed);
                    }
                    // Э8 ABR: сервер прислал целевой битрейт под худший линк дерева. Clamp
                    // в [FLOOR, потолок] — сервер уже клампит, но не доверяем сети вслепую.
                    Some(TreeEvent::SetBitrate { bps }) => {
                        let clamped = bps.clamp(BITRATE_FLOOR, meta.target_bitrate_bps);
                        // Логируем только реальную смену цели: сервер шлёт set-bitrate каждый
                        // тик. Просадка цели = сервер увидел худший линк в дереве — коррелирует
                        // с фризами у зрителей, но `encoder: bitrate ->` показывал бы её лишь
                        // когда ICodecAPI принял значение (не в пресет-режиме).
                        let prev = target_bitrate.swap(clamped, Ordering::Relaxed);
                        if prev != clamped {
                            log::info!("net: сервер снизил цель {:.1} -> {:.1} Мбит/с", prev as f64 / 1e6, clamped as f64 / 1e6);
                        }
                        // Лестница качества: битрейт упал — режем fps/разрешение вслед
                        // (стабильность важнее чёткости; см. QualityLadder). Д5: в пресет-режиме
                        // (Плавность/Качество) и server-first+CBR лестница отключена — адаптация
                        // зрителей идёт через серверные рендишны (Д4), а не сменой fps/разрешения
                        // на вещателе. Целевой битрейт (CBR) выше уже применён — гейтим только лестницу.
                        if ladder_enabled { ladder.apply(clamped); }
                    }
                    // Рестарт сервера пережит: реджойнились свежим корнем, старое дерево
                    // сервер потерял — зрители переджойнятся и придут свежими assign-child.
                    // Старые child-PC стримят дальше (P2P), пока зритель не пересоздастся;
                    // трупы дочистит sweep в stats-тике.
                    Some(TreeEvent::Rejoined) => log::warn!("broadcast: сигналинг реджойнился — жду переподключение зрителей"),
                    // Корень не имеет родителя — эти события к нему не относятся.
                    // Release (Э9) адресован виртуальному relay, StreamEnd — зрителям;
                    // корню-вещателю ни то, ни другое не приходит.
                    Some(TreeEvent::AssignParent { .. }) | Some(TreeEvent::SdpOffer { .. }) | Some(TreeEvent::Topology { .. }) | Some(TreeEvent::Release) | Some(TreeEvent::StreamEnd) => {}
                    Some(TreeEvent::Closed) | None => {
                        stop_reason = Some("сигнальный канал с сервером оборвался".into());
                        break;
                    }
                }
            }
            _ = stats_tick.tick() => {
                let now = Instant::now();
                let dt = now.duration_since(prev_at).as_secs_f64().max(0.001);
                let cap = stats.capture_frames.load(Ordering::Relaxed);
                let enc = stats.encoded_frames.load(Ordering::Relaxed);
                let bytes = stats.encoded_bytes.load(Ordering::Relaxed);
                let snapshot = DebugSnapshot {
                    stream_id: meta.stream_id.clone(),
                    source: meta.source_label.lock().unwrap().clone(),
                    width: stats.out_width.load(Ordering::Relaxed),
                    height: stats.out_height.load(Ordering::Relaxed),
                    // Живая цель (ABR-лестница), не пользовательский максимум — чтобы
                    // дебаг-панель показывала фактический режим (напр. 30 при цели 60).
                    target_fps: ladder.targets.fps.load(Ordering::Relaxed),
                    capture_fps: (cap - prev_cap) as f64 / dt,
                    encoder_fps: (enc - prev_enc) as f64 / dt,
                    dropped_frames: stats.capture_drops.load(Ordering::Relaxed),
                    bitrate_target_bps: target_bitrate.load(Ordering::Relaxed),
                    bitrate_actual_bps: (bytes - prev_bytes) as f64 * 8.0 / dt,
                    children: mgr.child_count(),
                };
                prev_at = now; prev_cap = cap; prev_enc = enc; prev_bytes = bytes;
                if let Some(app) = &app { let _ = app.emit("relay-broadcast-stats", &snapshot); }

                // Тайминги секций горячего пути за окно. Читать так: бюджет кадра = 1000/fps мс
                // (16.6 при 60). cb ≈ readback + convert; если cb близок к бюджету — упираемся
                // в CPU-конверсию, и низкий capture_fps НЕ значит «источник мало презентит».
                // Если cb мал, а capture_fps низкий — источник действительно мало отдаёт.
                // Растущий dropped_frames при малом cb — отстаёт энкодер (смотри encode/write).
                let cb_n = stats.cb_samples.swap(0, Ordering::Relaxed);
                let (cb_avg, cb_max) = SharedStats::take_window(&stats.cb_ns, &stats.cb_max_ns, cb_n);
                let readback_avg = stats.readback_ns.swap(0, Ordering::Relaxed) as f64 / cb_n.max(1) as f64 / 1e6;
                let convert_avg = stats.convert_ns.swap(0, Ordering::Relaxed) as f64 / cb_n.max(1) as f64 / 1e6;
                let enc_n = stats.encode_samples.swap(0, Ordering::Relaxed);
                let (enc_avg, enc_max) = SharedStats::take_window(&stats.encode_ns, &stats.encode_max_ns, enc_n);
                let write_avg = stats.write_ns.swap(0, Ordering::Relaxed) as f64 / enc_n.max(1) as f64 / 1e6;
                let drops = snapshot.dropped_frames;
                let drops_delta = drops.saturating_sub(prev_drops);
                prev_drops = drops;
                if cb_n > 0 || enc_n > 0 {
                    log::info!(
                        "timing: cb {cb_avg:.1}/{cb_max:.1} мс (avg/max) = readback {readback_avg:.1} + convert {convert_avg:.1} | encode {enc_avg:.1}/{enc_max:.1} | write {write_avg:.1} | drops +{drops_delta} (всего {drops})"
                    );
                }

                mgr.sweep_dead().await; // трупы child-PC (после реджойна drop-peer не придёт)
                // Э8 ABR: реальные loss/rtt по каждому детскому линку (RTCP RR через get_stats) —
                // сервер агрегирует worst-link по дереву и решает целевой битрейт. Раньше слали нули.
                let cur_target = target_bitrate.load(Ordering::Relaxed);
                let links = mgr.link_stats().await;

                // Сетевая половина картины. Захват/энкодер могут показывать идеальные цифры,
                // пока зрители фризят: потеря пакета вниз по дереву -> декодер ждёт IDR ->
                // «подвисло на секунду». Единственные улики — loss/rtt по линку и поток PLI.
                // Раньше loss/rtt уходили только серверу, а PLI логировался на debug (при
                // LevelFilter::Info — молча). По файлу лога отличить «сеть сыпется» от
                // «вещатель не успевает» было нечем.
                let pli = stats.pli_count.swap(0, Ordering::Relaxed);
                let keyframes = stats.keyframes.swap(0, Ordering::Relaxed);
                let links_str = if links.is_empty() {
                    "нет RR".to_string()
                } else {
                    links.iter()
                        .map(|(id, loss, rtt)| format!("{id} loss={:.1}% rtt={rtt:.0}мс", loss * 100.0))
                        .collect::<Vec<_>>()
                        .join(", ")
                };
                log::info!(
                    "net: детей {} | {links_str} | битрейт {:.1}/{:.1} Мбит (факт/цель) | PLI +{pli} | IDR +{keyframes}",
                    snapshot.children,
                    snapshot.bitrate_actual_bps / 1e6,
                    cur_target as f64 / 1e6,
                );

                let to_child: Vec<serde_json::Value> = links.into_iter()
                    .map(|(id, loss, rtt)| json!({ "id": id, "bitrate": cur_target, "rtt": rtt, "loss": loss }))
                    .collect();
                let _ = mgr.send_stats(to_child, cur_target);
            }
            reason = shutdown_rx.recv() => {
                stop_reason = reason.flatten();
                mgr.send_leave();
                mgr.close_all().await;
                break;
            }
        }
    }
    mgr.close_all().await;
    alive.store(false, Ordering::Relaxed);
    if let Some(app) = &app {
        let info = StopInfo { stream_id: meta.stream_id.clone(), reason: stop_reason };
        let _ = app.emit("relay-broadcast-stopped", &info);
    }
}

#[derive(serde::Serialize)]
struct StopInfo {
    #[serde(rename = "streamId")]
    stream_id: String,
    /// `None` — штатный стоп по кнопке; `Some(...)` — трансляция умерла сама
    /// (см. места `shutdown_tx.send(Some(...))` ниже), фронт показывает причину
    /// вместо молчаливого отката в форму настроек.
    reason: Option<String>,
}

pub fn list_monitors() -> Vec<(usize, String)> {
    capture::list_monitors()
}

pub fn list_windows() -> Vec<(isize, String, String, u32)> {
    capture::list_windows()
}
