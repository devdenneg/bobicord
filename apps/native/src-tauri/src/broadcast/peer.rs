// Менеджер webrtc-rs пиров для прямых детей дерева (Evolution-TZ Э5).
// Один энкодированный видео-трек (H.264) и один аудио-трек (Opus) — общие,
// добавляются в каждое новое RTCPeerConnection (webrtc-rs фанаутит запись в
// трек на все привязанные RTCRtpSender). Корень всегда SDP-offerer (см.
// apps/web/src/transport/treeVideo.ts — родитель держит медиа, ребёнок отвечает).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc::UnboundedSender;
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
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType};
use webrtc::stats::StatsReportType;
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use super::signaling::TreeCmd;

/// Качество линка к пиру из RTCP RR (Evolution-TZ Э8 ABR + best-peer). `get_stats()` даёт
/// `RemoteInboundRTP` — взгляд отправителя на приём удалённой стороны. webrtc-rs уже
/// нормализует: `fraction_lost` = raw/255 (доля 0..1), `round_trip_time` — в МИЛЛИСЕКУНДАХ
/// (не секундах, см. interceptor/stats/interceptor.rs). Берём худшее по видео+аудио (один
/// сетевой путь) — консервативно для ABR. `None`, пока не пришёл первый RR (нет RemoteInboundRTP).
pub async fn read_link_stats(pc: &RTCPeerConnection) -> Option<(f64, f64)> {
    let report = pc.get_stats().await;
    let mut loss = 0.0_f64;
    let mut rtt = 0.0_f64;
    let mut seen = false;
    for stat in report.reports.values() {
        if let StatsReportType::RemoteInboundRTP(r) = stat {
            seen = true;
            if r.fraction_lost.is_finite() { loss = loss.max(r.fraction_lost); }
            if let Some(t) = r.round_trip_time { if t.is_finite() { rtt = rtt.max(t); } }
        }
    }
    seen.then_some((loss, rtt))
}

/// H.264 baseline, packetization-mode=1, без B-кадров (инвариант CLAUDE.md 4) —
/// та же профильная строка, что фиксирует `MF_MT_MPEG2_PROFILE` энкодера.
const H264_FMTP: &str = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f";

pub struct PeerManager {
    api: API,
    ice_servers: Vec<RTCIceServer>,
    children: HashMap<String, Arc<RTCPeerConnection>>,
    pub video_track: Arc<TrackLocalStaticSample>,
    pub audio_track: Arc<TrackLocalStaticSample>,
    cmd_tx: UnboundedSender<TreeCmd>,
    force_keyframe: Arc<AtomicBool>,
}

impl PeerManager {
    pub fn new(stream_id: &str, cmd_tx: UnboundedSender<TreeCmd>, force_keyframe: Arc<AtomicBool>) -> Result<Self, String> {
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

        let video_track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability { mime_type: MIME_TYPE_H264.to_owned(), clock_rate: 90000, ..Default::default() },
            "video".to_owned(),
            stream_id.to_owned(),
        ));
        let audio_track = Arc::new(TrackLocalStaticSample::new(
            RTCRtpCodecCapability { mime_type: MIME_TYPE_OPUS.to_owned(), clock_rate: 48000, channels: 2, ..Default::default() },
            "audio".to_owned(),
            stream_id.to_owned(),
        ));

        Ok(Self {
            api,
            ice_servers: vec![RTCIceServer { urls: vec!["stun:stun.l.google.com:19302".to_owned()], ..Default::default() }],
            children: HashMap::new(),
            video_track,
            audio_track,
            cmd_tx,
            force_keyframe,
        })
    }

    pub fn set_ice_servers(&mut self, servers: &[Value]) {
        let parsed: Vec<RTCIceServer> = servers.iter().filter_map(parse_ice_server).collect();
        if !parsed.is_empty() {
            self.ice_servers = parsed;
        }
    }

    pub async fn on_assign_child(&mut self, child_id: String) {
        let config = RTCConfiguration { ice_servers: self.ice_servers.clone(), ..Default::default() };
        let pc = match self.api.new_peer_connection(config).await {
            Ok(pc) => Arc::new(pc),
            Err(e) => { log::error!("peer: new_peer_connection: {e}"); return; }
        };

        if let Err(e) = pc.add_track(self.video_track.clone() as Arc<dyn TrackLocal + Send + Sync>).await {
            log::error!("peer: add_track video: {e}");
        }
        if let Err(e) = pc.add_track(self.audio_track.clone() as Arc<dyn TrackLocal + Send + Sync>).await {
            log::error!("peer: add_track audio: {e}");
        }

        let cmd_tx = self.cmd_tx.clone();
        let child_for_ice = child_id.clone();
        pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
            let cmd_tx = cmd_tx.clone();
            let child_id = child_for_ice.clone();
            Box::pin(async move {
                if let Some(cand) = c {
                    if let Ok(init) = cand.to_json() {
                        if let Ok(val) = serde_json::to_value(&init) {
                            let _ = cmd_tx.send(TreeCmd::Ice { to: child_id, candidate: val });
                        }
                    }
                }
            })
        }));

        let child_for_state = child_id.clone();
        let force_keyframe_for_state = self.force_keyframe.clone();
        pc.on_peer_connection_state_change(Box::new(move |s| {
            log::info!("peer {child_for_state}: state {s:?}");
            // Форсим IDR здесь, а не сразу после offer: SRTP/DTLS этого конкретного
            // ребёнка ещё не готовы в момент offer (это сотни мс вперёд) — общий
            // видео-трек фанаутится всем детям сразу, и IDR, отправленный до готовности
            // транспорта именно этого ребёнка, до него физически не долетает (сендер
            // молча роняет пакеты для ещё не установленного соединения). Без периодического
            // GOP на энкодере (полагаемся только на форс) ребёнок так и остаётся без
            // единого декодируемого кадра — чёрный экран навсегда, пока не форсанёт кто-то
            // другой. Ждём Connected — тогда транспорт точно жив.
            if s == RTCPeerConnectionState::Connected {
                force_keyframe_for_state.store(true, Ordering::Relaxed);
            }
            Box::pin(async {})
        }));

        match pc.create_offer(None).await {
            Ok(offer) => {
                if let Err(e) = pc.set_local_description(offer.clone()).await {
                    log::error!("peer: set_local_description: {e}");
                    return;
                }
                let _ = self.cmd_tx.send(TreeCmd::Offer { to: child_id.clone(), sdp: offer.sdp });
            }
            Err(e) => { log::error!("peer: create_offer: {e}"); return; }
        }

        self.children.insert(child_id, pc);
    }

    pub async fn on_sdp_answer(&mut self, from: String, sdp: String) {
        if let Some(pc) = self.children.get(&from) {
            match RTCSessionDescription::answer(sdp) {
                Ok(desc) => { if let Err(e) = pc.set_remote_description(desc).await { log::error!("peer: set_remote_description: {e}"); } }
                Err(e) => log::error!("peer: bad answer sdp: {e}"),
            }
        }
    }

    pub async fn on_ice(&mut self, from: String, candidate: Value) {
        if let Some(pc) = self.children.get(&from) {
            match serde_json::from_value::<RTCIceCandidateInit>(candidate) {
                Ok(init) => { if let Err(e) = pc.add_ice_candidate(init).await { log::warn!("peer: add_ice_candidate: {e}"); } }
                Err(e) => log::warn!("peer: bad ice candidate: {e}"),
            }
        }
    }

    pub async fn on_drop_peer(&mut self, peer_id: String) {
        if let Some(pc) = self.children.remove(&peer_id) {
            let _ = pc.close().await;
        }
    }

    pub async fn close_all(&mut self) {
        for (_, pc) in self.children.drain() {
            let _ = pc.close().await;
        }
    }

    /// Явный 'leave' серверу (Э5) — без него teardown зрителей зависел от
    /// implicit-дропа `cmd_tx` (ws закрывался только когда PeerManager сам
    /// дропнется в конце `run_signaling_loop`), из-за чего сервер узнавал об уходе
    /// вещателя с задержкой, а <video> у зрителей мог зависнуть на последнем кадре.
    pub fn send_leave(&self) {
        let _ = self.cmd_tx.send(TreeCmd::Leave);
    }

    pub fn child_count(&self) -> usize { self.children.len() }
    pub fn child_ids(&self) -> Vec<String> { self.children.keys().cloned().collect() }

    /// `(child_id, loss 0..1, rtt_ms)` по каждому прямому ребёнку — отчёт серверу для ABR
    /// и best-peer скоринга. Дети без RR (соединение ещё поднимается) пропускаются.
    pub async fn link_stats(&self) -> Vec<(String, f64, f64)> {
        let mut out = Vec::with_capacity(self.children.len());
        for (id, pc) in &self.children {
            if let Some((loss, rtt)) = read_link_stats(pc).await {
                out.push((id.clone(), loss, rtt));
            }
        }
        out
    }

    pub fn send_stats(&self, to_child: Vec<Value>, available_outgoing: u32) -> Result<(), String> {
        self.cmd_tx.send(TreeCmd::Stats { to_child, available_outgoing }).map_err(|e| e.to_string())
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
