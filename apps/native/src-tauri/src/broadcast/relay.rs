// Нативный relay-viewer (Evolution-TZ Э8): Rust держит upstream-соединение к родителю в
// дереве, принимает H.264/Opus RTP и БЕЗ транскода (passthrough) фанаутит его:
//  - прямым детям в дереве (downstream PC, мы offerer) — многоуровневый ретрим;
//  - локальному webview этого же приложения (через Tauri IPC) — для показа пользователю.
// Так натив = приоритетный passthrough-relay (инвариант 4 сохранён — нет перекодирования),
// в отличие от браузерного транскод-relay (treeVideo.ts).
//
// Keyframe: relay сам IDR не генерит (не энкодит) — при подключении нового ребёнка просит
// keyframe у корня через сервер (request-keyframe -> tree.js -> broadcaster force IDR).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
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

use super::signaling::{self, JoinParams, TreeCmd, TreeEvent};

const H264_FMTP: &str = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f";

/// Управляющие сообщения в relay-цикл от Tauri-команд (сигналинг локального webview PC
/// приходит из JS через invoke; остановка — из stop_watch).
pub enum RelayControl {
    WebviewAnswer { sdp: String },
    WebviewIce { candidate: Value },
    RequestReparent { target: Option<String> },
    Stop,
}

pub struct RelayHandle {
    ctrl_tx: mpsc::UnboundedSender<RelayControl>,
}

impl RelayHandle {
    pub fn control(&self) -> mpsc::UnboundedSender<RelayControl> { self.ctrl_tx.clone() }
    pub fn webview_answer(&self, sdp: String) { let _ = self.ctrl_tx.send(RelayControl::WebviewAnswer { sdp }); }
    pub fn webview_ice(&self, candidate: Value) { let _ = self.ctrl_tx.send(RelayControl::WebviewIce { candidate }); }
    pub fn request_reparent(&self, target: Option<String>) { let _ = self.ctrl_tx.send(RelayControl::RequestReparent { target }); }
    pub fn stop(&self) { let _ = self.ctrl_tx.send(RelayControl::Stop); }
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
    app: Option<AppHandle>,
    stream_id: String,
    /// Момент последнего RequestKeyframe по PLI (мс) — rate-limit против шторма PLI детей.
    last_kf_ms: Arc<AtomicU64>,
    /// Состояние upstream-PC (к родителю): 0=unknown,1=connected,2=disconnected,3=failed,4=closed.
    /// Watchdog в stats_tick по нему решает про авто-reparent (ICE упал, а WS ещё жив).
    upstream_state: Arc<AtomicU8>,
    /// Момент последней смены upstream_state (мс) — чтобы отмерить длительность Disconnected.
    upstream_since_ms: Arc<AtomicU64>,
}

// Кодировка upstream_state.
const UP_CONNECTED: u8 = 1;
const UP_DISCONNECTED: u8 = 2;
const UP_FAILED: u8 = 3;

impl RelayManager {
    fn new(stream_id: String, cmd_tx: mpsc::UnboundedSender<TreeCmd>, app: Option<AppHandle>) -> Result<Self, String> {
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

        let video_track = Arc::new(TrackLocalStaticRTP::new(
            RTCRtpCodecCapability { mime_type: MIME_TYPE_H264.to_owned(), clock_rate: 90000, sdp_fmtp_line: H264_FMTP.to_owned(), ..Default::default() },
            "video".to_owned(),
            stream_id.clone(),
        ));
        let audio_track = Arc::new(TrackLocalStaticRTP::new(
            RTCRtpCodecCapability { mime_type: MIME_TYPE_OPUS.to_owned(), clock_rate: 48000, channels: 2, ..Default::default() },
            "audio".to_owned(),
            stream_id.clone(),
        ));

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
            app,
            stream_id,
            last_kf_ms: Arc::new(AtomicU64::new(0)),
            upstream_state: Arc::new(AtomicU8::new(0)),
            upstream_since_ms: Arc::new(AtomicU64::new(0)),
        })
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
        pc.on_track(Box::new(move |track: Arc<TrackRemote>, _r: Arc<RTCRtpReceiver>, _t: Arc<RTCRtpTransceiver>| {
            let video_local = video_local.clone();
            let audio_local = audio_local.clone();
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
        self.upstream_since_ms.store(super::peer::now_ms(), Ordering::Relaxed);
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
            up_since.store(super::peer::now_ms(), Ordering::Relaxed);
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
                            let now = super::peer::now_ms();
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

    // ---- webview (локальный показ через Tauri IPC; мы offerer) ----
    async fn start_webview(&mut self) {
        if self.webview.is_some() { return; }
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
        let app = self.app.clone();
        let sid = self.stream_id.clone();
        pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
            let app = app.clone();
            let sid = sid.clone();
            Box::pin(async move {
                if let (Some(cand), Some(app)) = (c, app) {
                    if let Ok(init) = cand.to_json() {
                        if let Ok(val) = serde_json::to_value(&init) {
                            let _ = app.emit("relay-watch-ice", json!({ "streamId": sid, "candidate": val }));
                        }
                    }
                }
            })
        }));
        match pc.create_offer(None).await {
            Ok(offer) => {
                if let Err(e) = pc.set_local_description(offer.clone()).await { log::error!("relay: webview set_local: {e}"); return; }
                if let Some(app) = &self.app {
                    let _ = app.emit("relay-watch-offer", json!({ "streamId": self.stream_id, "sdp": offer.sdp }));
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
    }
}

fn parse_ice_server(v: &Value) -> Option<RTCIceServer> {
    let urls: Vec<String> = match v.get("urls")? {
        Value::String(s) => vec![s.clone()],
        Value::Array(a) => a.iter().filter_map(|x| x.as_str().map(|s| s.to_owned())).collect(),
        _ => return None,
    };
    Some(RTCIceServer {
        urls,
        username: v.get("username").and_then(|x| x.as_str()).unwrap_or_default().to_owned(),
        credential: v.get("credential").and_then(|x| x.as_str()).unwrap_or_default().to_owned(),
        ..Default::default()
    })
}

/// Запускает relay-viewer: подключается к дереву как `role:viewer, native:true`, поднимает
/// локальный webview-показ, ретранслирует детям. Возвращает RelayHandle для управления
/// (сигналинг webview из JS, стоп). `app: None` — режим смоука (без Tauri-эмита событий).
pub fn start(
    app: Option<AppHandle>,
    stream_id: String,
    ws_url: String,
    identity: String,
    server_id: String,
    max_children: u32,
) -> RelayHandle {
    let (ctrl_tx, mut ctrl_rx) = mpsc::unbounded_channel::<RelayControl>();

    let join = JoinParams { stream_id: stream_id.clone(), identity, server_id, role: "viewer", native: true, max_children, max_bitrate: 0, abr: false };
    let (cmd_tx, mut evt_rx) = signaling::connect(ws_url, join);

    tokio::spawn(async move {
        let mut mgr = match RelayManager::new(stream_id, cmd_tx, app) {
            Ok(m) => m,
            Err(e) => { log::error!("relay: init: {e}"); return; }
        };
        // Локальный показ поднимаем сразу — offer уедет в webview, тот ответит через ctrl.
        mgr.start_webview().await;

        let mut stats_tick = tokio::time::interval(Duration::from_secs(2));
        // Cooldown авто-reparent по обрыву upstream (не чаще 10с — совпадает с серверным).
        let mut last_reparent_ms: u64 = 0;
        loop {
            tokio::select! {
                evt = evt_rx.recv() => {
                    match evt {
                        Some(TreeEvent::Welcome { ice_servers }) => mgr.set_ice_servers(&ice_servers),
                        Some(TreeEvent::AssignParent { parent_id }) => mgr.on_assign_parent(parent_id).await,
                        Some(TreeEvent::AssignChild { child_id }) => mgr.on_assign_child(child_id).await,
                        Some(TreeEvent::SdpOffer { from, sdp }) => mgr.on_parent_offer(from, sdp).await,
                        Some(TreeEvent::SdpAnswer { from, sdp }) => mgr.on_child_answer(from, sdp).await,
                        Some(TreeEvent::Ice { from, candidate }) => mgr.on_ice(from, candidate).await,
                        Some(TreeEvent::DropPeer { peer_id }) => mgr.on_drop_peer(peer_id).await,
                        Some(TreeEvent::RequestKeyframe) => { /* relay не энкодит — игнор */ }
                        Some(TreeEvent::SetBitrate { .. }) => { /* relay не энкодит — битрейт задаёт корень */ }
                        Some(TreeEvent::Topology { payload }) => { if let Some(app) = &mgr.app { let _ = app.emit("relay-topology", payload); } }
                        Some(TreeEvent::Closed) | None => break,
                    }
                }
                ctrl = ctrl_rx.recv() => {
                    match ctrl {
                        Some(RelayControl::WebviewAnswer { sdp }) => mgr.on_webview_answer(sdp).await,
                        Some(RelayControl::WebviewIce { candidate }) => mgr.on_webview_ice(candidate).await,
                        Some(RelayControl::RequestReparent { target }) => { let _ = mgr.cmd_tx.send(TreeCmd::RequestReparent { target }); }
                        Some(RelayControl::Stop) | None => break,
                    }
                }
                _ = stats_tick.tick() => {
                    // Watchdog upstream: ICE упал (Failed сразу / Disconnected дольше 6с), а WS
                    // жив — сервер не знает об обрыве, зритель фризит. Просим reparent (мы
                    // answerer, restart_ice не применим — сервер даст нового/того же родителя).
                    if mgr.upstream.is_some() {
                        let st = mgr.upstream_state.load(Ordering::Relaxed);
                        let now = super::peer::now_ms();
                        let since = mgr.upstream_since_ms.load(Ordering::Relaxed);
                        let bad = st == UP_FAILED || (st == UP_DISCONNECTED && now.saturating_sub(since) >= 6000);
                        if bad && now.saturating_sub(last_reparent_ms) >= 10_000 {
                            last_reparent_ms = now;
                            log::warn!("relay: upstream state={st} — авто-reparent");
                            let _ = mgr.cmd_tx.send(TreeCmd::RequestReparent { target: None });
                        }
                    }
                    // Э8: реальные loss/rtt по каждому детскому линку (RTCP RR через get_stats) —
                    // сервер агрегирует worst-link по дереву (ABR-битрейт вещателю) и кормит ими
                    // best-peer скоринг репарента. Раньше слали нули (заглушка).
                    let out = if max_children > 0 { 8_000_000 } else { 0 };
                    let mut to_child: Vec<Value> = Vec::with_capacity(mgr.children.len());
                    for (id, pc) in &mgr.children {
                        if let Some((loss, rtt)) = super::peer::read_link_stats(pc).await {
                            to_child.push(json!({ "id": id, "bitrate": 0, "rtt": rtt, "loss": loss }));
                        }
                    }
                    let _ = mgr.cmd_tx.send(TreeCmd::Stats { to_child, available_outgoing: out });
                }
            }
        }
        let _ = mgr.cmd_tx.send(TreeCmd::Leave);
        mgr.close_all().await;
    });

    RelayHandle { ctrl_tx }
}
