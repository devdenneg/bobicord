// Оркестратор нативного вещателя (Evolution-TZ Э5): захват -> H.264-энкодер ->
// webrtc-rs корень дерева. Захват и энкодер — на отдельных OS-потоках (COM/MFT
// блокирующие вызовы, нельзя гонять на tokio-воркере); сигналинг и
// RTCPeerConnection'ы — в tokio-задаче на runtime вызывающей стороны (Tauri).

pub mod audio;
pub mod capture;
pub mod encoder;
pub mod peer;
pub mod signaling;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use serde_json::json;
use tokio::sync::mpsc;
use webrtc::media::Sample;
use windows::Win32::Media::MediaFoundation::{MFStartup, MFSTARTUP_FULL, MFSTARTUP_NOSOCKET, MF_VERSION};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

use self::signaling::TreeEvent;

const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;
const FPS: u32 = 30;
const BITRATE_BPS: u32 = 6_000_000;

pub struct BroadcastHandle {
    cap_stop: Arc<AtomicBool>,
    enc_stop: Arc<AtomicBool>,
    audio_stop: Arc<AtomicBool>,
    shutdown_tx: mpsc::UnboundedSender<()>,
    threads: Vec<std::thread::JoinHandle<()>>,
}

impl BroadcastHandle {
    pub async fn stop(mut self) {
        self.cap_stop.store(true, Ordering::Relaxed);
        self.enc_stop.store(true, Ordering::Relaxed);
        self.audio_stop.store(true, Ordering::Relaxed);
        let _ = self.shutdown_tx.send(());
        for t in self.threads.drain(..) {
            let _ = tokio::task::spawn_blocking(move || t.join()).await;
        }
    }
}

/// Запускается из async Tauri-команды (уже внутри tokio-runtime — используем
/// его `Handle` для записи сэмплов из энкодерного потока).
pub async fn start(stream_id: String, ws_url: String, identity: String, monitor_index: usize) -> Result<BroadcastHandle, String> {
    let (cap_handle, cap_stop, cap_rx) = capture::spawn_capture(monitor_index, WIDTH, HEIGHT)?;

    let force_keyframe = Arc::new(AtomicBool::new(true));
    let (cmd_tx, evt_rx) = signaling::connect(ws_url, stream_id.clone(), identity);

    let mgr = peer::PeerManager::new(&stream_id, cmd_tx.clone(), force_keyframe.clone())?;
    let video_track = mgr.video_track.clone();
    let audio_track = mgr.audio_track.clone();

    let enc_stop = Arc::new(AtomicBool::new(false));
    let enc_stop2 = enc_stop.clone();
    let rt_handle = tokio::runtime::Handle::current();
    let force_keyframe_enc = force_keyframe.clone();

    let encoder_thread = std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            if let Err(e) = MFStartup(MF_VERSION, MFSTARTUP_FULL | MFSTARTUP_NOSOCKET) {
                log::error!("encoder: MFStartup failed: {e}");
                return;
            }
        }
        let mut enc = match encoder::H264Encoder::new(WIDTH, HEIGHT, FPS, BITRATE_BPS, force_keyframe_enc) {
            Ok(e) => e,
            Err(e) => { log::error!("encoder: init failed: {e}"); return; }
        };
        let frame_dur = Duration::from_secs_f64(1.0 / FPS as f64);
        while !enc_stop2.load(Ordering::Relaxed) {
            let frame = match cap_rx.recv_timeout(Duration::from_millis(500)) {
                Ok(f) => f,
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            };
            match enc.encode(&frame) {
                Ok(chunks) => {
                    for c in chunks {
                        let sample = Sample { data: Bytes::from(c.data), duration: frame_dur, ..Default::default() };
                        let track = video_track.clone();
                        rt_handle.block_on(async { let _ = track.write_sample(&sample).await; });
                    }
                }
                Err(e) => log::warn!("encoder: encode error: {e}"),
            }
        }
        log::info!("encoder thread stopped");
    });

    let audio_stop = Arc::new(AtomicBool::new(false));
    let audio_stop2 = audio_stop.clone();
    let rt_handle_audio = tokio::runtime::Handle::current();
    let _ = &audio_track;
    let audio_thread = std::thread::spawn(move || {
        // Известный баг (изолирован, не пофикшен): activate_process_loopback_exclude_self()
        // валит процесс heap corruption'ом (см. память сессии). Пока не включено по
        // умолчанию — видео-путь (основной AC Э5) не должен от этого падать.
        // Включить для отладки: RELAYAPP_ENABLE_AUDIO=1.
        if std::env::var("RELAYAPP_ENABLE_AUDIO").is_err() {
            log::warn!("audio: отключено (известный крэш в WASAPI process-loopback, см. TODO в audio.rs)");
            while !audio_stop2.load(Ordering::Relaxed) { std::thread::sleep(Duration::from_millis(100)); }
            return;
        }
        unsafe { let _ = windows::Win32::System::Com::CoInitializeEx(None, COINIT_MULTITHREADED); }
        let frame_dur = Duration::from_millis(20);
        let result = audio::run_capture_loop(audio_stop2, |chunk| {
            let sample = Sample { data: Bytes::from(chunk.data), duration: frame_dur, ..Default::default() };
            let track = audio_track.clone();
            rt_handle_audio.block_on(async { let _ = track.write_sample(&sample).await; });
        });
        if let Err(e) = result {
            log::error!("audio: capture loop failed: {e}");
        }
        log::info!("audio thread stopped");
    });

    let (shutdown_tx, shutdown_rx) = mpsc::unbounded_channel();
    tokio::spawn(run_signaling_loop(mgr, evt_rx, shutdown_rx));

    Ok(BroadcastHandle {
        cap_stop,
        enc_stop,
        audio_stop,
        shutdown_tx,
        threads: vec![cap_handle, encoder_thread, audio_thread],
    })
}

async fn run_signaling_loop(
    mut mgr: peer::PeerManager,
    mut evt_rx: mpsc::UnboundedReceiver<TreeEvent>,
    mut shutdown_rx: mpsc::UnboundedReceiver<()>,
) {
    let mut stats_tick = tokio::time::interval(Duration::from_secs(3));
    loop {
        tokio::select! {
            evt = evt_rx.recv() => {
                match evt {
                    Some(TreeEvent::Welcome { ice_servers }) => mgr.set_ice_servers(&ice_servers),
                    Some(TreeEvent::AssignChild { child_id }) => mgr.on_assign_child(child_id).await,
                    Some(TreeEvent::SdpAnswer { from, sdp }) => mgr.on_sdp_answer(from, sdp).await,
                    Some(TreeEvent::Ice { from, candidate }) => mgr.on_ice(from, candidate).await,
                    Some(TreeEvent::DropPeer { peer_id }) => mgr.on_drop_peer(peer_id).await,
                    Some(TreeEvent::Closed) | None => break,
                }
            }
            _ = stats_tick.tick() => {
                let to_child: Vec<serde_json::Value> = mgr.child_ids().into_iter()
                    .map(|id| json!({ "id": id, "bitrate": BITRATE_BPS, "rtt": 0, "loss": 0 }))
                    .collect();
                // Сервер сейчас (Э1) принимает и игнорирует stats — задел на Э8 ребаланс.
                let _ = mgr.send_stats(to_child, BITRATE_BPS);
            }
            _ = shutdown_rx.recv() => { mgr.close_all().await; break; }
        }
    }
    mgr.close_all().await;
}

pub fn list_monitors() -> Vec<(usize, String)> {
    capture::list_monitors()
}
