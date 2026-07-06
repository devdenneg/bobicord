// Оркестратор нативного вещателя (Evolution-TZ Э5): захват -> H.264-энкодер ->
// webrtc-rs корень дерева. Захват и энкодер — на отдельных OS-потоках (COM/MFT
// блокирующие вызовы, нельзя гонять на tokio-воркере); сигналинг и
// RTCPeerConnection'ы — в tokio-задаче на runtime вызывающей стороны (Tauri).

pub mod audio;
pub mod capture;
pub mod encoder;
pub mod peer;
pub mod relay;
pub mod signaling;
pub mod stats;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use webrtc::media::Sample;
use windows::Win32::Media::MediaFoundation::{MFShutdown, MFStartup, MFSTARTUP_FULL, MFSTARTUP_NOSOCKET, MF_VERSION};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

pub use audio::AudioSource;
pub use capture::CaptureSource;

use self::signaling::TreeEvent;
use self::stats::{SharedStats, StatsHandle};

/// Конфиг стрима (Э5.1) — задаётся из UI перед стартом вместо прежних жёстких
/// констант; `max_width`/`max_height` — верхняя граница (без апскейла, см.
/// capture::scaled_dims), фактическое разрешение зависит от источника.
pub struct StreamConfig {
    pub max_width: u32,
    pub max_height: u32,
    pub fps: u32,
    pub bitrate_bps: u32,
    /// Э5.2: по умолчанию — исключить себя (EXCLUDE, см. историю бага в audio.rs);
    /// `IncludeProcess(pid)` — надёжнее, если известен процесс игры/окна.
    pub audio_source: AudioSource,
    /// Э8: лимит прямых детей корня в дереве (задаётся вещателем в UI). Overflow-зрители
    /// уходят глубже через relay-узлы. Ёмкость объявляется серверу в join (см. signaling).
    pub max_direct_children: u32,
}

pub struct BroadcastHandle {
    cap_stop: Arc<AtomicBool>,
    enc_stop: Arc<AtomicBool>,
    audio_stop: Arc<AtomicBool>,
    shutdown_tx: mpsc::UnboundedSender<Option<String>>,
    threads: Vec<std::thread::JoinHandle<()>>,
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

    pub async fn stop(mut self) {
        self.cap_stop.store(true, Ordering::Relaxed);
        self.enc_stop.store(true, Ordering::Relaxed);
        self.audio_stop.store(true, Ordering::Relaxed);
        let _ = self.shutdown_tx.send(None); // штатный стоп по кнопке — без причины
        for t in self.threads.drain(..) {
            let _ = tokio::task::spawn_blocking(move || t.join()).await;
        }
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
    let StreamConfig { max_width, max_height, fps, bitrate_bps, audio_source, max_direct_children } = config;
    let source_label = describe_source(&source);
    let stats: StatsHandle = Arc::new(SharedStats::default());
    // Создаём здесь (не в конце функции, как раньше) — encoder_thread должен уметь
    // сам инициировать остановку всей трансляции при фатальной ошибке (MFStartup,
    // отказ энкодера на 0x0-кадре и т.п.): раньше поток просто тихо `break`-ился,
    // сигналинг оставался жить, а Tauri-состояние вещания зависало навсегда
    // ("уже вещаем" на повторном старте) — фронтенд о смерти потока не узнавал.
    let (shutdown_tx, shutdown_rx) = mpsc::unbounded_channel();

    let (cap_handle, cap_stop, cap_rx) = capture::spawn_capture(source, max_width, max_height, fps, stats.clone())?;

    let force_keyframe = Arc::new(AtomicBool::new(true));
    let join = signaling::JoinParams {
        stream_id: stream_id.clone(), identity, server_id,
        role: "broadcaster", native: true, max_children: max_direct_children,
    };
    let (cmd_tx, evt_rx) = signaling::connect(ws_url, join);

    let mgr = peer::PeerManager::new(&stream_id, cmd_tx.clone(), force_keyframe.clone())?;
    let video_track = mgr.video_track.clone();
    let audio_track = mgr.audio_track.clone();

    let enc_stop = Arc::new(AtomicBool::new(false));
    let enc_stop2 = enc_stop.clone();
    let rt_handle = tokio::runtime::Handle::current();
    let force_keyframe_enc = force_keyframe.clone();
    let stats_enc = stats.clone();
    let shutdown_tx_enc = shutdown_tx.clone();

    let encoder_thread = std::thread::spawn(move || {
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
        let frame_dur = Duration::from_secs_f64(1.0 / fps as f64);
        let mut fps_window_start = Instant::now();
        let mut fps_window_count = 0u32;
        let mut enc: Option<(encoder::H264Encoder, u32, u32)> = None;
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
            if let Some((_, w, h)) = &enc {
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
                        continue; // размер ещё "гуляет" — не трогаем энкодер, кадр дропаем
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
                    continue;
                }
                match encoder::H264Encoder::new(frame.width, frame.height, fps, bitrate_bps, force_keyframe_enc.clone()) {
                    Ok(e) => { force_keyframe_enc.store(true, Ordering::Relaxed); enc = Some((e, frame.width, frame.height)); }
                    Err(e) => {
                        log::error!("encoder: init failed: {e}");
                        let _ = shutdown_tx_enc.send(Some(format!("не удалось создать H264-энкодер: {e}")));
                        break;
                    }
                }
            }
            let (encoder_ref, _enc_w, _enc_h) = enc.as_mut().expect("initialized above");
            let real_dur = match prev_captured_at {
                Some(prev) => frame.captured_at.saturating_duration_since(prev).clamp(frame_dur / 4, Duration::from_secs(2)),
                None => frame_dur,
            };
            prev_captured_at = Some(frame.captured_at);
            match encoder_ref.encode(&frame) {
                Ok(chunks) => {
                    for c in chunks {
                        stats_enc.encoded_frames.fetch_add(1, Ordering::Relaxed);
                        stats_enc.encoded_bytes.fetch_add(c.data.len() as u64, Ordering::Relaxed);
                        let sample = Sample { data: Bytes::from(c.data), duration: real_dur, ..Default::default() };
                        let track = video_track.clone();
                        rt_handle.block_on(async { let _ = track.write_sample(&sample).await; });
                        fps_window_count += 1;
                    }
                }
                Err(e) => log::warn!("encoder: encode error: {e}"),
            }
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

    let audio_stop = Arc::new(AtomicBool::new(false));
    let audio_stop2 = audio_stop.clone();
    let rt_handle_audio = tokio::runtime::Handle::current();
    let _ = &audio_track;
    let audio_thread = std::thread::spawn(move || {
        // RELAYAPP_DISABLE_AUDIO=1 — аварийный выключатель для отладки видео-пути
        // отдельно от звука; по умолчанию звук игры/системы идёт в стрим (см. audio.rs).
        if std::env::var("RELAYAPP_DISABLE_AUDIO").is_ok() {
            log::warn!("audio: отключено через RELAYAPP_DISABLE_AUDIO");
            while !audio_stop2.load(Ordering::Relaxed) { std::thread::sleep(Duration::from_millis(100)); }
            return;
        }
        unsafe { let _ = windows::Win32::System::Com::CoInitializeEx(None, COINIT_MULTITHREADED); }
        let frame_dur = Duration::from_millis(20);
        let result = audio::run_capture_loop(audio_stop2, audio_source, |chunk| {
            let sample = Sample { data: Bytes::from(chunk.data), duration: frame_dur, ..Default::default() };
            let track = audio_track.clone();
            rt_handle_audio.block_on(async { let _ = track.write_sample(&sample).await; });
        });
        if let Err(e) = result {
            log::error!("audio: capture loop failed: {e}");
        }
        log::info!("audio thread stopped");
    });

    let alive = Arc::new(AtomicBool::new(true));
    let alive_loop = alive.clone();
    let meta = DebugMeta { stream_id, source_label, target_fps: fps, target_bitrate_bps: bitrate_bps };
    tokio::spawn(run_signaling_loop(mgr, evt_rx, shutdown_rx, app, stats, meta, alive_loop, force_keyframe.clone()));

    Ok(BroadcastHandle {
        cap_stop,
        enc_stop,
        audio_stop,
        shutdown_tx,
        threads: vec![cap_handle, encoder_thread, audio_thread],
        alive,
    })
}

struct DebugMeta {
    stream_id: String,
    source_label: String,
    target_fps: u32,
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
) {
    let mut stats_tick = tokio::time::interval(Duration::from_secs(2));
    let mut prev_at = Instant::now();
    let (mut prev_cap, mut prev_enc, mut prev_bytes) = (0u64, 0u64, 0u64);
    // Причина самостоятельной остановки — раньше фронт узнавал только "трансляция
    // умерла", без "почему", и молча откатывался в форму настроек (см. StopInfo ниже).
    let mut stop_reason: Option<String> = None;
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
                    Some(TreeEvent::RequestKeyframe) => force_keyframe.store(true, Ordering::Relaxed),
                    // Корень не имеет родителя — эти события к нему не относятся.
                    Some(TreeEvent::AssignParent { .. }) | Some(TreeEvent::SdpOffer { .. }) | Some(TreeEvent::Topology { .. }) => {}
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
                    source: meta.source_label.clone(),
                    width: stats.out_width.load(Ordering::Relaxed),
                    height: stats.out_height.load(Ordering::Relaxed),
                    target_fps: meta.target_fps,
                    capture_fps: (cap - prev_cap) as f64 / dt,
                    encoder_fps: (enc - prev_enc) as f64 / dt,
                    dropped_frames: stats.capture_drops.load(Ordering::Relaxed),
                    bitrate_target_bps: meta.target_bitrate_bps,
                    bitrate_actual_bps: (bytes - prev_bytes) as f64 * 8.0 / dt,
                    children: mgr.child_count(),
                };
                prev_at = now; prev_cap = cap; prev_enc = enc; prev_bytes = bytes;
                if let Some(app) = &app { let _ = app.emit("relay-broadcast-stats", &snapshot); }

                let to_child: Vec<serde_json::Value> = mgr.child_ids().into_iter()
                    .map(|id| json!({ "id": id, "bitrate": meta.target_bitrate_bps, "rtt": 0, "loss": 0 }))
                    .collect();
                // Сервер сейчас (Э1) принимает и игнорирует stats — задел на Э8 ребаланс.
                let _ = mgr.send_stats(to_child, meta.target_bitrate_bps);
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
