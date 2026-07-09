// Relay-viewer (Evolution-TZ Э8/Э9): держит upstream-соединение к родителю в дереве,
// принимает H.264/Opus RTP и БЕЗ транскода (passthrough) фанаутит его:
//  - прямым детям в дереве (downstream PC, мы offerer) — многоуровневый ретрим;
//  - локальному UI хоста (через UiSink, в нативе — Tauri IPC) — для показа пользователю.
// Так натив = приоритетный passthrough-relay (инвариант 4 сохранён — нет перекодирования).
// Браузер (treeVideo.ts) — строго лист, не ретранслирует (Д0). Headless-агент (apps/relay, Э9)
// использует то же ядро с ui=None и idle_exit.
//
// Keyframe: relay сам IDR не генерит (не энкодит) — при подключении нового ребёнка просит
// keyframe у корня через сервер (request-keyframe -> tree.js -> broadcaster force IDR).
//
// Roadmap-flow-стриминга Д2: ОПЦИОНАЛЬНАЯ транскод-ветка — ТОЛЬКО для vrelay-рендишнов.
// source-фанаут остаётся passthrough (инвариант не нарушён для нативного узла); при активной
// рендишн-сессии видео-RTP от родителя ДУБЛИРУЕТСЯ в локальный ffmpeg (transcode.rs), а его
// выход раздаётся отдельной рендишн-сессией (start_rendition_root). Нативный клиент рендишны
// не поднимает никогда (их дёргает только vrelay-агент через ctrl).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Notify};
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_H264, MIME_TYPE_OPUS};
use webrtc::api::{APIBuilder, API};
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType};
use webrtc::rtp_transceiver::rtp_receiver::RTCRtpReceiver;
use webrtc::rtp_transceiver::RTCRtpTransceiver;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::{TrackLocal, TrackLocalWriter};
use webrtc::track::track_remote::TrackRemote;

use crate::link::{now_ms, parse_ice_server, read_link_stats, H264_FMTP};
use crate::signaling::{self, JoinParams, TreeCmd, TreeEvent};
use crate::transcode::{self, Feed, Transcode};

/// Сток UI-событий хоста: (event, payload). В нативе — обёртка над `AppHandle::emit`
/// (события relay-watch-offer/-ice/relay-topology для webview); None — headless, локальный
/// показ не поднимается.
pub type UiSink = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// Конфиг запуска relay-viewer.
pub struct RelayConfig {
    pub stream_id: String,
    pub ws_url: String,
    pub identity: String,
    pub server_id: String,
    pub max_children: u32,
    /// Э9: серверный виртуальный fallback-relay (уходит в join как "virtual": true).
    pub virtual_relay: bool,
    /// Д3: рендишн-дерево (`streamId::quality`). viewer/vrelay-ingest — "source"; рендишн-корень
    /// (start_rendition_root) — имя рендишна ("480" и т.п.), тогда его дерево = `stream_id::quality`.
    pub quality: String,
    /// Д4: зритель закрепил качество вручную (pin) — авто-ABR его не трогает. viewer-only;
    /// vrelay-ingest/рендишн-корень — false.
    pub pinned: bool,
    /// Что репортить серверу как availableOutgoing в stats (скоринг best-peer).
    pub available_outgoing: u32,
    /// Some(d): выйти из дерева, если нет живых детей дольше d (headless-агент). Живость —
    /// по состоянию PC, не по наличию в map: при обрушении дерева (ушёл вещатель) сервер
    /// не шлёт drop-peer на каждого ребёнка, map остаётся непустым. None — натив (webview
    /// смотрит стрим, уходим только по Stop).
    pub idle_exit: Option<Duration>,
    /// Переживать обрыв WS (деплой/рестарт сервера): реконнект + реджойн, см. signaling.
    /// true у натива (вещатель/relay-viewer), false у vrelay-сессий (агент переактивируется).
    pub reconnect: bool,
}

/// Управляющие сообщения в relay-цикл от хоста (в нативе — Tauri-команды: сигналинг
/// локального webview PC приходит из JS через invoke; остановка — из stop_watch).
/// Ответ на StartRendition: транскод-трек видео (H.264 рендишн) + passthrough audio-трек
/// источника (Opus не транскодируется). vrelay отдаёт их в start_rendition_root.
type RenditionTracks = (Arc<TrackLocalStaticRTP>, Arc<TrackLocalStaticRTP>);

pub enum RelayControl {
    WebviewAnswer { sdp: String },
    WebviewIce { candidate: Value },
    RequestReparent { target: Option<String> },
    /// Д2: поднять транскод-рендишн на ЭТОЙ (ingest) сессии. Ответ — рендишн-треки для
    /// отдельной рендишн-сессии. Только для vrelay (нативный узел эти ctrl не шлёт).
    StartRendition { rendition: String, bitrate: u32, reply: oneshot::Sender<Result<RenditionTracks, String>> },
    /// Д2: погасить транскод-рендишн.
    StopRendition { rendition: String },
    Stop,
}

#[derive(Clone)]
pub struct RelayHandle {
    ctrl_tx: mpsc::UnboundedSender<RelayControl>,
    finished: Arc<Notify>,
}

impl RelayHandle {
    pub fn control(&self) -> mpsc::UnboundedSender<RelayControl> { self.ctrl_tx.clone() }
    pub fn webview_answer(&self, sdp: String) { let _ = self.ctrl_tx.send(RelayControl::WebviewAnswer { sdp }); }
    pub fn webview_ice(&self, candidate: Value) { let _ = self.ctrl_tx.send(RelayControl::WebviewIce { candidate }); }
    pub fn request_reparent(&self, target: Option<String>) { let _ = self.ctrl_tx.send(RelayControl::RequestReparent { target }); }
    pub fn stop(&self) { let _ = self.ctrl_tx.send(RelayControl::Stop); }
    /// Д2: просит ingest-сессию поднять транскод-рендишн, ждёт его треки (или ошибку —
    /// нет источника/лимит транскодов). Используется vrelay-агентом.
    pub async fn start_rendition(&self, rendition: String, bitrate: u32) -> Result<RenditionTracks, String> {
        let (reply, rx) = oneshot::channel();
        self.ctrl_tx.send(RelayControl::StartRendition { rendition, bitrate, reply })
            .map_err(|_| "relay-сессия закрыта".to_string())?;
        rx.await.map_err(|_| "relay-сессия закрыта до ответа".to_string())?
    }
    pub fn stop_rendition(&self, rendition: String) { let _ = self.ctrl_tx.send(RelayControl::StopRendition { rendition }); }
    /// Завершение relay-цикла (leave отправлен, PC закрыты). Один ожидающий: notify_one
    /// хранит один пермит, так что notified() сработает и если цикл кончился раньше await.
    pub fn finished(&self) -> Arc<Notify> { self.finished.clone() }
}

struct RelayManager {
    api: API,
    ice_servers: Vec<RTCIceServer>,
    video_track: Arc<TrackLocalStaticRTP>,
    audio_track: Arc<TrackLocalStaticRTP>,
    upstream: Option<Arc<RTCPeerConnection>>,
    parent_id: Option<String>,
    children: HashMap<String, Arc<RTCPeerConnection>>,
    webview: Option<Arc<RTCPeerConnection>>,
    cmd_tx: mpsc::UnboundedSender<TreeCmd>,
    ui: Option<UiSink>,
    stream_id: String,
    /// Момент последнего RequestKeyframe по PLI (мс) — rate-limit против шторма PLI детей.
    last_kf_ms: Arc<AtomicU64>,
    /// Состояние upstream-PC (к родителю): 0=unknown,1=connected,2=disconnected,3=failed,4=closed.
    /// Watchdog в stats_tick по нему решает про авто-reparent (ICE упал, а WS ещё жив).
    upstream_state: Arc<AtomicU8>,
    /// Момент последней смены upstream_state (мс) — чтобы отмерить длительность Disconnected.
    upstream_since_ms: Arc<AtomicU64>,
    /// Д2: активные транскод-рендишны (rendition -> Transcode). Только vrelay-ingest сессия.
    renditions: HashMap<String, Transcode>,
    /// Д2: входы транскодов (rendition -> Feed) — читает on_track-цикл, дублируя видео-RTP
    /// в ffmpeg. Shared Arc: on_track-задачи спавнятся при каждом (ре)коннекте к родителю.
    video_feeds: Arc<Mutex<HashMap<String, Arc<Feed>>>>,
    /// Быстрый гейт для горячего пути on_track: 0 = ни одного рендишна, лок не берём.
    feed_count: Arc<AtomicUsize>,
}

// Кодировка upstream_state.
const UP_CONNECTED: u8 = 1;
const UP_DISCONNECTED: u8 = 2;
const UP_FAILED: u8 = 3;

impl RelayManager {
    /// `injected` (Д2 рендишн-корень): готовые треки (транскод-видео + passthrough-audio)
    /// вместо новых — фанаут рендишна берёт медиа из ffmpeg, а не из upstream.
    fn new(stream_id: String, cmd_tx: mpsc::UnboundedSender<TreeCmd>, ui: Option<UiSink>, injected: Option<RenditionTracks>) -> Result<Self, String> {
        let mut m = MediaEngine::default();
        m.register_codec(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_H264.to_owned(),
                    clock_rate: 90000,
                    channels: 0,
                    sdp_fmtp_line: H264_FMTP.to_owned(),
                    rtcp_feedback: vec![],
                },
                payload_type: 102,
                ..Default::default()
            },
            RTPCodecType::Video,
        ).map_err(|e| e.to_string())?;
        m.register_codec(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_OPUS.to_owned(),
                    clock_rate: 48000,
                    channels: 2,
                    sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
                    rtcp_feedback: vec![],
                },
                payload_type: 111,
                ..Default::default()
            },
            RTPCodecType::Audio,
        ).map_err(|e| e.to_string())?;

        let registry = register_default_interceptors(Registry::new(), &mut m).map_err(|e| e.to_string())?;
        let api = APIBuilder::new().with_media_engine(m).with_interceptor_registry(registry).build();

        let (video_track, audio_track) = match injected {
            Some((v, a)) => (v, a),
            None => (
                Arc::new(TrackLocalStaticRTP::new(
                    RTCRtpCodecCapability { mime_type: MIME_TYPE_H264.to_owned(), clock_rate: 90000, sdp_fmtp_line: H264_FMTP.to_owned(), ..Default::default() },
                    "video".to_owned(),
                    stream_id.clone(),
                )),
                Arc::new(TrackLocalStaticRTP::new(
                    RTCRtpCodecCapability { mime_type: MIME_TYPE_OPUS.to_owned(), clock_rate: 48000, channels: 2, ..Default::default() },
                    "audio".to_owned(),
                    stream_id.clone(),
                )),
            ),
        };

        Ok(Self {
            api,
            ice_servers: vec![RTCIceServer { urls: vec!["stun:stun.l.google.com:19302".to_owned()], ..Default::default() }],
            video_track,
            audio_track,
            upstream: None,
            parent_id: None,
            children: HashMap::new(),
            webview: None,
            cmd_tx,
            ui,
            stream_id,
            last_kf_ms: Arc::new(AtomicU64::new(0)),
            upstream_state: Arc::new(AtomicU8::new(0)),
            upstream_since_ms: Arc::new(AtomicU64::new(0)),
            renditions: HashMap::new(),
            video_feeds: Arc::new(Mutex::new(HashMap::new())),
            feed_count: Arc::new(AtomicUsize::new(0)),
        })
    }

    /// Д2: поднять транскод-рендишн на этой (ingest) сессии. Дублирует входное видео в
    /// ffmpeg, возвращает рендишн-видео-трек + passthrough audio-трек источника для
    /// отдельной рендишн-сессии. Идемпотентна по имени рендишна.
    async fn start_rendition(&mut self, rendition: String, bitrate: u32) -> Result<RenditionTracks, String> {
        if self.renditions.contains_key(&rendition) {
            return Err(format!("рендишн {rendition} уже активен"));
        }
        let rtrack = Arc::new(TrackLocalStaticRTP::new(
            transcode::h264_cap(),
            "video".to_owned(),
            format!("{}::{}", self.stream_id, rendition),
        ));
        let (tc, feed) = Transcode::start(&rendition, bitrate, rtrack.clone()).await?;
        self.video_feeds.lock().unwrap().insert(rendition.clone(), Arc::new(feed));
        self.feed_count.store(self.video_feeds.lock().unwrap().len(), Ordering::Relaxed);
        self.renditions.insert(rendition.clone(), tc);
        // Без IDR от источника ffmpeg не начнёт декодировать — просим keyframe у корня
        // (tree.js форвардит вещателю). Rate-limit на дереве прикроет от шторма.
        let _ = self.cmd_tx.send(TreeCmd::RequestKeyframe);
        log::info!("relay: рендишн {rendition} поднят (транскод активен)");
        Ok((rtrack, self.audio_track.clone()))
    }

    /// Д2: погасить транскод-рендишн (kill ffmpeg, снять feed).
    async fn stop_rendition(&mut self, rendition: &str) {
        self.video_feeds.lock().unwrap().remove(rendition);
        self.feed_count.store(self.video_feeds.lock().unwrap().len(), Ordering::Relaxed);
        if let Some(tc) = self.renditions.remove(rendition) {
            tc.stop();
            log::info!("relay: рендишн {rendition} снят");
        }
    }

    fn set_ice_servers(&mut self, servers: &[Value]) {
        let parsed: Vec<RTCIceServer> = servers.iter().filter_map(parse_ice_server).collect();
        if !parsed.is_empty() { self.ice_servers = parsed; }
    }

    fn config(&self) -> RTCConfiguration {
        RTCConfiguration { ice_servers: self.ice_servers.clone(), ..Default::default() }
    }

    // ---- upstream (к родителю; мы answerer) ----
    async fn on_parent_offer(&mut self, from: String, sdp: String) {
        if self.parent_id.as_deref() != Some(from.as_str()) { return; }
        // старый upstream (если был reparent) закрываем
        if let Some(old) = self.upstream.take() { let _ = old.close().await; }
        let pc = match self.api.new_peer_connection(self.config()).await {
            Ok(pc) => Arc::new(pc),
            Err(e) => { log::error!("relay: upstream new_peer_connection: {e}"); return; }
        };

        // Принятые треки от родителя форвардим БЕЗ транскода в локальные RTP-треки —
        // те уже привязаны к downstream PC (дети + webview) и фанаутятся туда.
        let video_local = self.video_track.clone();
        let audio_local = self.audio_track.clone();
        // Д2: горячий путь дублирования видео-RTP в транскод(ы). feed_count — быстрый гейт
        // (0 = ни одного рендишна → лок не берём, passthrough как раньше, инвариант цел).
        let video_feeds = self.video_feeds.clone();
        let feed_count = self.feed_count.clone();
        pc.on_track(Box::new(move |track: Arc<TrackRemote>, _r: Arc<RTCRtpReceiver>, _t: Arc<RTCRtpTransceiver>| {
            let video_local = video_local.clone();
            let audio_local = audio_local.clone();
            let video_feeds = video_feeds.clone();
            let feed_count = feed_count.clone();
            Box::pin(async move {
                let is_video = track.kind() == RTPCodecType::Video;
                tokio::spawn(async move {
                    loop {
                        match track.read_rtp().await {
                            Ok((packet, _)) => {
                                let res = if is_video { video_local.write_rtp(&packet).await } else { audio_local.write_rtp(&packet).await };
                                if let Err(e) = res {
                                    // ErrClosedPipe = ни одного связанного sender (нет детей/webview) — не ошибка
                                    if webrtc::Error::ErrClosedPipe.to_string() != e.to_string() {
                                        log::debug!("relay: write_rtp: {e}");
                                    }
                                }
                                // Д2: побочная ветка транскода — не мешает passthrough выше.
                                if is_video && feed_count.load(Ordering::Relaxed) > 0 {
                                    for f in video_feeds.lock().unwrap().values() { f.send_video(&packet); }
                                }
                            }
                            Err(_) => break, // upstream закрылся
                        }
                    }
                });
            })
        }));

        let cmd_tx = self.cmd_tx.clone();
        let parent = from.clone();
        let stream_id = self.stream_id.clone();
        pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
            let cmd_tx = cmd_tx.clone();
            let parent = parent.clone();
            let _sid = stream_id.clone();
            Box::pin(async move {
                if let Some(cand) = c {
                    if let Ok(init) = cand.to_json() {
                        if let Ok(val) = serde_json::to_value(&init) {
                            let _ = cmd_tx.send(TreeCmd::Ice { to: parent, candidate: val });
                        }
                    }
                }
            })
        }));

        // Следим за состоянием upstream: если ICE упал (Failed/долгий Disconnected), а WS
        // ещё жив, сервер не узнает об обрыве — зритель фризит навсегда. Watchdog в
        // stats_tick прочитает это и попросит reparent. Мы answerer, restart_ice не применим.
        self.upstream_state.store(0, Ordering::Relaxed);
        self.upstream_since_ms.store(now_ms(), Ordering::Relaxed);
        let up_state = self.upstream_state.clone();
        let up_since = self.upstream_since_ms.clone();
        pc.on_peer_connection_state_change(Box::new(move |s| {
            let code = match s {
                RTCPeerConnectionState::Connected => UP_CONNECTED,
                RTCPeerConnectionState::Disconnected => UP_DISCONNECTED,
                RTCPeerConnectionState::Failed => UP_FAILED,
                RTCPeerConnectionState::Closed => 4,
                _ => 0,
            };
            up_state.store(code, Ordering::Relaxed);
            up_since.store(now_ms(), Ordering::Relaxed);
            Box::pin(async {})
        }));

        if let Err(e) = pc.set_remote_description(match RTCSessionDescription::offer(sdp) { Ok(d) => d, Err(e) => { log::error!("relay: bad parent offer: {e}"); return; } }).await {
            log::error!("relay: upstream set_remote: {e}"); return;
        }
        match pc.create_answer(None).await {
            Ok(answer) => {
                if let Err(e) = pc.set_local_description(answer.clone()).await { log::error!("relay: upstream set_local: {e}"); return; }
                let _ = self.cmd_tx.send(TreeCmd::Answer { to: from, sdp: answer.sdp });
            }
            Err(e) => { log::error!("relay: create_answer: {e}"); return; }
        }
        self.upstream = Some(pc);
    }

    // ---- downstream (offerer): общий код для ребёнка и webview ----
    async fn make_downstream(&self) -> Option<Arc<RTCPeerConnection>> {
        let pc = match self.api.new_peer_connection(self.config()).await {
            Ok(pc) => Arc::new(pc),
            Err(e) => { log::error!("relay: downstream new_peer_connection: {e}"); return None; }
        };
        match pc.add_track(self.video_track.clone() as Arc<dyn TrackLocal + Send + Sync>).await {
            Ok(sender) => {
                // PLI/FIR от downstream-зрителя = «дай keyframe». Мы passthrough, сами IDR не
                // генерим — форвардим запрос корню (сервер релеит request-keyframe -> корень
                // форсит IDR). Rate-limit 1с на relay — против шторма PLI от многих детей.
                let cmd_tx = self.cmd_tx.clone();
                let last_kf = self.last_kf_ms.clone();
                tokio::spawn(async move {
                    while let Ok((pkts, _)) = sender.read_rtcp().await {
                        let want_idr = pkts.iter().any(|p| {
                            let a = p.as_any();
                            a.downcast_ref::<PictureLossIndication>().is_some()
                                || a.downcast_ref::<FullIntraRequest>().is_some()
                        });
                        if want_idr {
                            let now = now_ms();
                            if now.saturating_sub(last_kf.load(Ordering::Relaxed)) >= 1000 {
                                last_kf.store(now, Ordering::Relaxed);
                                let _ = cmd_tx.send(TreeCmd::RequestKeyframe);
                            }
                        }
                    }
                });
            }
            Err(e) => log::error!("relay: add video: {e}"),
        }
        if let Err(e) = pc.add_track(self.audio_track.clone() as Arc<dyn TrackLocal + Send + Sync>).await { log::error!("relay: add audio: {e}"); }
        Some(pc)
    }

    async fn on_assign_child(&mut self, child_id: String) {
        let pc = match self.make_downstream().await { Some(pc) => pc, None => return };
        // Просим keyframe у корня только когда транспорт ребёнка встал (Connected), а не
        // сразу при create_offer: IDR, отправленный до готовности DTLS/ICE ребёнка, до него
        // не долетает (сендер роняет пакеты для неустановленного соединения) — раньше это
        // давало чёрный экран новому зрителю через relay до следующего случайного IDR.
        let kf_tx = self.cmd_tx.clone();
        pc.on_peer_connection_state_change(Box::new(move |s| {
            if s == RTCPeerConnectionState::Connected {
                let _ = kf_tx.send(TreeCmd::RequestKeyframe);
            }
            Box::pin(async {})
        }));
        let cmd_tx = self.cmd_tx.clone();
        let child = child_id.clone();
        pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
            let cmd_tx = cmd_tx.clone();
            let child = child.clone();
            Box::pin(async move {
                if let Some(cand) = c {
                    if let Ok(init) = cand.to_json() {
                        if let Ok(val) = serde_json::to_value(&init) {
                            let _ = cmd_tx.send(TreeCmd::Ice { to: child, candidate: val });
                        }
                    }
                }
            })
        }));
        match pc.create_offer(None).await {
            Ok(offer) => {
                if let Err(e) = pc.set_local_description(offer.clone()).await { log::error!("relay: child set_local: {e}"); return; }
                let _ = self.cmd_tx.send(TreeCmd::Offer { to: child_id.clone(), sdp: offer.sdp });
            }
            Err(e) => { log::error!("relay: child create_offer: {e}"); return; }
        }
        if let Some(old) = self.children.insert(child_id, pc) {
            // Повторный assign того же id без leave — старый PC иначе утёк бы.
            tokio::spawn(async move { let _ = old.close().await; });
        }
        // Keyframe теперь просим из on_peer_connection_state_change (Connected), не здесь.
    }

    async fn on_child_answer(&mut self, from: String, sdp: String) {
        if let Some(pc) = self.children.get(&from) {
            if let Ok(desc) = RTCSessionDescription::answer(sdp) {
                if let Err(e) = pc.set_remote_description(desc).await { log::error!("relay: child set_remote: {e}"); }
            }
        }
    }

    async fn on_ice(&mut self, from: String, candidate: Value) {
        let init: RTCIceCandidateInit = match serde_json::from_value(candidate) { Ok(v) => v, Err(_) => return };
        if self.parent_id.as_deref() == Some(from.as_str()) {
            if let Some(pc) = &self.upstream { let _ = pc.add_ice_candidate(init).await; }
        } else if let Some(pc) = self.children.get(&from) {
            let _ = pc.add_ice_candidate(init).await;
        }
    }

    async fn on_drop_peer(&mut self, peer_id: String) {
        if let Some(pc) = self.children.remove(&peer_id) { let _ = pc.close().await; }
        // если ушёл родитель — сервер пришлёт assign-parent с новым (или конец стрима)
    }

    async fn on_assign_parent(&mut self, parent_id: Option<String>) {
        self.parent_id = parent_id;
        // upstream пересоздастся, когда новый родитель пришлёт offer (on_parent_offer)
        if let Some(old) = self.upstream.take() { let _ = old.close().await; }
    }

    /// Живые downstream-дети (транспорт не умер). Для idle-exit headless-агента: map может
    /// держать трупы (обрушение дерева не шлёт drop-peer каждому ребёнку).
    fn live_children(&self) -> usize {
        self.children.values().filter(|pc| matches!(
            pc.connection_state(),
            RTCPeerConnectionState::New | RTCPeerConnectionState::Connecting | RTCPeerConnectionState::Connected
        )).count()
    }

    /// Чистка мёртвых child-PC (Failed/Closed). После реджойна (рестарт сервера) старые
    /// дети никогда не получат drop-peer — их новые инкарнации живут под новыми peer-id,
    /// а старый PC умирает сам, когда ребёнок пересоздал соединение. Disconnected не
    /// трогаем — может восстановиться.
    async fn sweep_dead_children(&mut self) {
        let dead: Vec<String> = self.children.iter()
            .filter(|(_, pc)| matches!(pc.connection_state(), RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed))
            .map(|(id, _)| id.clone()).collect();
        for id in dead {
            if let Some(pc) = self.children.remove(&id) {
                log::info!("relay: ребёнок {id} мёртв (failed/closed) — чищу PC");
                let _ = pc.close().await;
            }
        }
    }

    // ---- webview (локальный показ через UiSink; мы offerer). Headless (ui=None) — не поднимаем. ----
    async fn start_webview(&mut self) {
        if self.ui.is_none() || self.webview.is_some() { return; }
        let pc = match self.make_downstream().await { Some(pc) => pc, None => return };
        // Локальный показ тоже должен получить IDR когда встанет транспорт (иначе чёрный
        // экран у самого вещателя-ретранслятора до следующего случайного keyframe).
        let kf_tx = self.cmd_tx.clone();
        pc.on_peer_connection_state_change(Box::new(move |s| {
            if s == RTCPeerConnectionState::Connected {
                let _ = kf_tx.send(TreeCmd::RequestKeyframe);
            }
            Box::pin(async {})
        }));
        let ui = self.ui.clone();
        let sid = self.stream_id.clone();
        pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
            let ui = ui.clone();
            let sid = sid.clone();
            Box::pin(async move {
                if let (Some(cand), Some(ui)) = (c, ui) {
                    if let Ok(init) = cand.to_json() {
                        if let Ok(val) = serde_json::to_value(&init) {
                            ui("relay-watch-ice", json!({ "streamId": sid, "candidate": val }));
                        }
                    }
                }
            })
        }));
        match pc.create_offer(None).await {
            Ok(offer) => {
                if let Err(e) = pc.set_local_description(offer.clone()).await { log::error!("relay: webview set_local: {e}"); return; }
                if let Some(ui) = &self.ui {
                    ui("relay-watch-offer", json!({ "streamId": self.stream_id, "sdp": offer.sdp }));
                }
            }
            Err(e) => { log::error!("relay: webview create_offer: {e}"); return; }
        }
        self.webview = Some(pc);
    }

    async fn on_webview_answer(&mut self, sdp: String) {
        if let Some(pc) = &self.webview {
            if let Ok(desc) = RTCSessionDescription::answer(sdp) {
                if let Err(e) = pc.set_remote_description(desc).await { log::error!("relay: webview set_remote: {e}"); }
            }
        }
    }

    async fn on_webview_ice(&mut self, candidate: Value) {
        if let Some(pc) = &self.webview {
            if let Ok(init) = serde_json::from_value::<RTCIceCandidateInit>(candidate) { let _ = pc.add_ice_candidate(init).await; }
        }
    }

    async fn close_all(&mut self) {
        if let Some(pc) = self.upstream.take() { let _ = pc.close().await; }
        if let Some(pc) = self.webview.take() { let _ = pc.close().await; }
        for (_, pc) in self.children.drain() { let _ = pc.close().await; }
        // Д2: гасим ffmpeg-транскоды (kill), иначе зомби-процессы на VPS.
        self.video_feeds.lock().unwrap().clear();
        self.feed_count.store(0, Ordering::Relaxed);
        for (_, tc) in self.renditions.drain() { tc.stop(); }
    }
}

/// Запускает relay-viewer: подключается к дереву как `role:viewer, native:true`, поднимает
/// локальный показ (только при ui=Some), ретранслирует детям. Возвращает RelayHandle для
/// управления (сигналинг webview из JS, стоп, ожидание завершения).
pub fn start(ui: Option<UiSink>, cfg: RelayConfig) -> RelayHandle {
    let RelayConfig { stream_id, ws_url, identity, server_id, max_children, virtual_relay, quality, pinned, available_outgoing, idle_exit, reconnect } = cfg;
    let (ctrl_tx, mut ctrl_rx) = mpsc::unbounded_channel::<RelayControl>();
    let finished = Arc::new(Notify::new());
    let fin = finished.clone();

    let join = JoinParams { stream_id: stream_id.clone(), identity, server_id, role: "viewer", native: true, max_children, max_bitrate: 0, abr: false, virtual_relay, quality, server_ingest: false, app_name: None, app_icon: None, width: 0, height: 0, pinned };
    let (cmd_tx, mut evt_rx) = signaling::connect(ws_url, join, reconnect);

    tokio::spawn(async move {
        let mut mgr = match RelayManager::new(stream_id, cmd_tx, ui, None) {
            Ok(m) => m,
            Err(e) => { log::error!("relay: init: {e}"); fin.notify_one(); return; }
        };
        // Локальный показ поднимаем сразу — offer уедет в webview, тот ответит через ctrl.
        mgr.start_webview().await;

        let mut stats_tick = tokio::time::interval(Duration::from_secs(2));
        // Cooldown авто-reparent по обрыву upstream (не чаще 10с — совпадает с серверным).
        let mut last_reparent_ms: u64 = 0;
        // idle-exit: отсчёт с запуска (grace на первый assign-child = сам таймаут).
        let mut idle_since_ms: u64 = now_ms();
        // Терминальный сирота (только натив, idle_exit=None): без родителя дольше таймаута =
        // стрим кончился, а stream-end мы не получили (гонка/реконнект) — иначе upstream/webview
        // PC и повисший кадр жили бы вечно: on_drop_peer для родителя no-op, watchdog лишь
        // репарентит, а teardown ждёт stop_watch из webview, который тоже мог пропустить конец.
        let mut orphan_since_ms: Option<u64> = None;
        const ORPHAN_EXIT_MS: u64 = 20_000;
        // true после break = конец стрима, а не явный Stop — сообщаем webview, чтобы он снёс watch.
        let mut watch_ended = false;
        loop {
            tokio::select! {
                evt = evt_rx.recv() => {
                    match evt {
                        Some(TreeEvent::Welcome { ice_servers }) => mgr.set_ice_servers(&ice_servers),
                        Some(TreeEvent::AssignParent { parent_id }) => {
                            orphan_since_ms = if parent_id.is_none() { Some(now_ms()) } else { None };
                            mgr.on_assign_parent(parent_id).await;
                        }
                        Some(TreeEvent::AssignChild { child_id }) => mgr.on_assign_child(child_id).await,
                        Some(TreeEvent::SdpOffer { from, sdp }) => mgr.on_parent_offer(from, sdp).await,
                        Some(TreeEvent::SdpAnswer { from, sdp }) => mgr.on_child_answer(from, sdp).await,
                        Some(TreeEvent::Ice { from, candidate }) => mgr.on_ice(from, candidate).await,
                        Some(TreeEvent::DropPeer { peer_id }) => {
                            // Дропнут наш родитель: либо следом придёт assign-parent (reparent),
                            // либо это конец стрима — отсчитываем сиротский таймаут.
                            if mgr.parent_id.as_deref() == Some(peer_id.as_str()) && orphan_since_ms.is_none() {
                                orphan_since_ms = Some(now_ms());
                            }
                            mgr.on_drop_peer(peer_id).await;
                        }
                        Some(TreeEvent::RequestKeyframe) => { /* relay не энкодит — игнор */ }
                        Some(TreeEvent::SetBitrate { .. }) => { /* relay не энкодит — битрейт задаёт корень */ }
                        Some(TreeEvent::Topology { payload }) => { if let Some(ui) = &mgr.ui { ui("relay-topology", payload); } }
                        Some(TreeEvent::Release) => { log::info!("relay: vrelay-release от сервера — выходим"); watch_ended = true; break; }
                        Some(TreeEvent::StreamEnd) => { log::info!("relay: stream-end от сервера — конец вещания, teardown"); watch_ended = true; break; }
                        // Рестарт сервера пережит: мы реджойнились свежим узлом, сервер сам
                        // пришлёт assign-parent (settleOrphans) — upstream пересоздастся. Старые
                        // child-PC живут, пока дети не пересоздадут соединения (sweep дочистит).
                        Some(TreeEvent::Rejoined) => log::warn!("relay: сигналинг реджойнился — жду свежий assign-parent"),
                        Some(TreeEvent::Closed) | None => break,
                    }
                }
                ctrl = ctrl_rx.recv() => {
                    match ctrl {
                        Some(RelayControl::WebviewAnswer { sdp }) => mgr.on_webview_answer(sdp).await,
                        Some(RelayControl::WebviewIce { candidate }) => mgr.on_webview_ice(candidate).await,
                        Some(RelayControl::RequestReparent { target }) => { let _ = mgr.cmd_tx.send(TreeCmd::RequestReparent { target }); }
                        // Д2: транскод-рендишн на ingest-сессии (только vrelay дёргает).
                        Some(RelayControl::StartRendition { rendition, bitrate, reply }) => {
                            let res = mgr.start_rendition(rendition, bitrate).await;
                            let _ = reply.send(res);
                        }
                        Some(RelayControl::StopRendition { rendition }) => mgr.stop_rendition(&rendition).await,
                        Some(RelayControl::Stop) | None => break,
                    }
                }
                _ = stats_tick.tick() => {
                    mgr.sweep_dead_children().await;
                    // Watchdog upstream: ICE упал (Failed сразу / Disconnected дольше 6с), а WS
                    // жив — сервер не знает об обрыве, зритель фризит. Просим reparent (мы
                    // answerer, restart_ice не применим — сервер даст нового/того же родителя).
                    if mgr.upstream.is_some() {
                        let st = mgr.upstream_state.load(Ordering::Relaxed);
                        let now = now_ms();
                        let since = mgr.upstream_since_ms.load(Ordering::Relaxed);
                        let bad = st == UP_FAILED || (st == UP_DISCONNECTED && now.saturating_sub(since) >= 6000);
                        if bad && now.saturating_sub(last_reparent_ms) >= 10_000 {
                            last_reparent_ms = now;
                            log::warn!("relay: upstream state={st} — авто-reparent");
                            let _ = mgr.cmd_tx.send(TreeCmd::RequestReparent { target: None });
                        }
                    }
                    // Терминальный сирота (натив): родителя нет дольше ORPHAN_EXIT_MS — дерево
                    // умерло (settleOrphans/vrelay дали бы родителя за секунды). Выходим и
                    // сообщаем webview. Headless-агента не касается — у него idle_exit/Release.
                    if idle_exit.is_none() {
                        if let Some(t) = orphan_since_ms {
                            if now_ms().saturating_sub(t) >= ORPHAN_EXIT_MS {
                                log::warn!("relay: без родителя {}с — считаю стрим законченным, teardown", ORPHAN_EXIT_MS / 1000);
                                watch_ended = true;
                                break;
                            }
                        }
                    }
                    // Idle-exit (headless): нет живых детей дольше таймаута — покидаем дерево,
                    // агент вернётся по следующему vrelay-activate.
                    if let Some(d) = idle_exit {
                        if mgr.live_children() > 0 {
                            idle_since_ms = now_ms();
                        } else if now_ms().saturating_sub(idle_since_ms) >= d.as_millis() as u64 {
                            log::info!("relay: нет живых детей {}с — idle-exit", d.as_secs());
                            break;
                        }
                    }
                    // Э8: реальные loss/rtt по каждому детскому линку (RTCP RR через get_stats) —
                    // сервер агрегирует worst-link по дереву (ABR-битрейт вещателю) и кормит ими
                    // best-peer скоринг репарента. Раньше слали нули (заглушка).
                    let out = if max_children > 0 { available_outgoing } else { 0 };
                    let mut to_child: Vec<Value> = Vec::with_capacity(mgr.children.len());
                    for (id, pc) in &mgr.children {
                        if let Some((loss, rtt)) = read_link_stats(pc).await {
                            to_child.push(json!({ "id": id, "bitrate": 0, "rtt": rtt, "loss": loss }));
                        }
                    }
                    let _ = mgr.cmd_tx.send(TreeCmd::Stats { to_child, available_outgoing: out });
                }
            }
        }
        let _ = mgr.cmd_tx.send(TreeCmd::Leave);
        mgr.close_all().await;
        // Конец стрима определил Rust (stream-end/сирота), а не webview: говорим ему снести
        // watch (nativeUnwatch → delVideo), иначе <video> остаётся с повисшим кадром.
        if watch_ended {
            if let Some(ui) = &mgr.ui { ui("relay-watch-ended", json!({ "streamId": mgr.stream_id })); }
        }
        fin.notify_one();
    });

    RelayHandle { ctrl_tx, finished }
}

/// Roadmap-flow-стриминга Д2 (dev-путь): рендишн-КОРЕНЬ — джойнится в дерево
/// `streamId::rendition` (Д3: base `stream_id` + `quality`=rendition, сервер клеит ключ)
/// как broadcaster (virtual:true) и фанаутит уже готовые треки
/// (транскод-видео + passthrough-audio источника) прямым зрителям. Медиа НЕ из upstream, а
/// из ffmpeg ingest-сессии (треки переданы извне). Отдельный слим-цикл: у корня нет
/// родителя/webview/ABR/watchdog — только фанаут детям. Полноценные рендишн-деревья с
/// реестром/гашением — Д3/Д4; здесь минимум, чтобы глазами увидеть транскод-картинку.
pub fn start_rendition_root(cfg: RelayConfig, video: Arc<TrackLocalStaticRTP>, audio: Arc<TrackLocalStaticRTP>) -> RelayHandle {
    let RelayConfig { stream_id, ws_url, identity, server_id, max_children, virtual_relay, quality, pinned: _, available_outgoing: _, idle_exit: _, reconnect } = cfg;
    let (ctrl_tx, mut ctrl_rx) = mpsc::unbounded_channel::<RelayControl>();
    let finished = Arc::new(Notify::new());
    let fin = finished.clone();

    // role=broadcaster → tree.js делает узел корнем дерева streamId::rendition. native:true
    // (иначе capacityOf=0). ВАЖНО: virtual:false — рендишн-корень НЕ виртуал-узел: с
    // virtual:true tree.js в ensureVirtualAttached сделал бы его собственным родителем/ребёнком
    // (self-loop, findVirtual==broadcaster). Как обычный натив-broadcaster он проходит мимо
    // всей virtual-логики (ensureVirtualAttached/drainTimer/findVirtual). virtual_relay из cfg
    // игнорируем осознанно.
    let _ = virtual_relay;
    let join = JoinParams { stream_id: stream_id.clone(), identity, server_id, role: "broadcaster", native: true, max_children, max_bitrate: 0, abr: false, virtual_relay: false, quality, server_ingest: false, app_name: None, app_icon: None, width: 0, height: 0, pinned: false };
    let (cmd_tx, mut evt_rx) = signaling::connect(ws_url, join, reconnect);

    tokio::spawn(async move {
        let mut mgr = match RelayManager::new(stream_id.clone(), cmd_tx, None, Some((video, audio))) {
            Ok(m) => m,
            Err(e) => { log::error!("relay: рендишн-корень init: {e}"); fin.notify_one(); return; }
        };
        log::info!("relay: рендишн-корень {stream_id} поднят (фанаут транскода зрителям)");
        let mut stats_tick = tokio::time::interval(Duration::from_secs(2));
        loop {
            tokio::select! {
                evt = evt_rx.recv() => {
                    match evt {
                        Some(TreeEvent::Welcome { ice_servers }) => mgr.set_ice_servers(&ice_servers),
                        Some(TreeEvent::AssignChild { child_id }) => mgr.on_assign_child(child_id).await,
                        Some(TreeEvent::SdpAnswer { from, sdp }) => mgr.on_child_answer(from, sdp).await,
                        Some(TreeEvent::Ice { from, candidate }) => mgr.on_ice(from, candidate).await,
                        Some(TreeEvent::DropPeer { peer_id }) => mgr.on_drop_peer(peer_id).await,
                        // Корень рендишна не имеет родителя; keyframe для рендишна даёт GOP
                        // ffmpeg (2с) — форсить IDR нечем (мы не в source-дереве).
                        Some(TreeEvent::RequestKeyframe) | Some(TreeEvent::SetBitrate { .. })
                        | Some(TreeEvent::AssignParent { .. }) | Some(TreeEvent::SdpOffer { .. })
                        | Some(TreeEvent::Topology { .. }) => {}
                        Some(TreeEvent::Release) => { log::info!("relay: рендишн-корень {stream_id} — release"); break; }
                        Some(TreeEvent::StreamEnd) => { log::info!("relay: рендишн-корень {stream_id} — stream-end"); break; }
                        Some(TreeEvent::Rejoined) => log::warn!("relay: рендишн-корень {stream_id} реджойн"),
                        Some(TreeEvent::Closed) | None => break,
                    }
                }
                ctrl = ctrl_rx.recv() => {
                    match ctrl {
                        Some(RelayControl::Stop) | None => break,
                        _ => {} // рендишн-корню прочие ctrl не адресованы
                    }
                }
                _ = stats_tick.tick() => {
                    mgr.sweep_dead_children().await;
                    // Д4: рендишн-корень репортит per-child loss/rtt — сервер по ним ведёт
                    // пер-зрительский ABR для зрителей в рендишн-деревьях (подъём вверх при
                    // восстановлении линка требует свежей статы и здесь, не только в source).
                    let mut to_child: Vec<Value> = Vec::with_capacity(mgr.children.len());
                    for (id, pc) in &mgr.children {
                        if let Some((loss, rtt)) = read_link_stats(pc).await {
                            to_child.push(json!({ "id": id, "bitrate": 0, "rtt": rtt, "loss": loss }));
                        }
                    }
                    let _ = mgr.cmd_tx.send(TreeCmd::Stats { to_child, available_outgoing: 0 });
                }
            }
        }
        let _ = mgr.cmd_tx.send(TreeCmd::Leave);
        mgr.close_all().await;
        fin.notify_one();
    });

    RelayHandle { ctrl_tx, finished }
}
