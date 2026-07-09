// Менеджер webrtc-rs пиров для прямых детей дерева (Evolution-TZ Э5).
// Один энкодированный видео-трек (H.264) и один аудио-трек (Opus) — общие,
// добавляются в каждое новое RTCPeerConnection (webrtc-rs фанаутит запись в
// трек на все привязанные RTCRtpSender). Корень всегда SDP-offerer (см.
// apps/web/src/transport/treeVideo.ts — родитель держит медиа, ребёнок отвечает).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
use webrtc::rtcp::payload_feedbacks::full_intra_request::FullIntraRequest;
use webrtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType};
use webrtc::track::track_local::track_local_static_sample::TrackLocalStaticSample;
use webrtc::track::track_local::TrackLocal;

use super::signaling::TreeCmd;
use super::stats::StatsHandle;
// Общие хелперы (read_link_stats/now_ms/parse_ice_server/H264_FMTP) вынесены в relay-core
// (link.rs) — общий код с relay-ядром и headless-агентом. Реэкспорт сохраняет старые пути.
pub use relay_core::link::{now_ms, read_link_stats};
use relay_core::link::{parse_ice_server, H264_FMTP};

pub struct PeerManager {
    api: API,
    ice_servers: Vec<RTCIceServer>,
    children: HashMap<String, Arc<RTCPeerConnection>>,
    pub video_track: Arc<TrackLocalStaticSample>,
    pub audio_track: Arc<TrackLocalStaticSample>,
    cmd_tx: UnboundedSender<TreeCmd>,
    force_keyframe: Arc<AtomicBool>,
    /// Момент последнего форса IDR по PLI (мс от эпохи) — rate-limit против шторма
    /// PLI от N детей (без него каждый зритель с потерями держал бы сплошные IDR).
    last_pli_ms: Arc<AtomicU64>,
    stats: StatsHandle,
}

impl PeerManager {
    pub fn new(stream_id: &str, cmd_tx: UnboundedSender<TreeCmd>, force_keyframe: Arc<AtomicBool>, stats: StatsHandle) -> Result<Self, String> {
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
            last_pli_ms: Arc::new(AtomicU64::new(0)),
            stats,
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

        match pc.add_track(self.video_track.clone() as Arc<dyn TrackLocal + Send + Sync>).await {
            Ok(sender) => {
                // Читаем RTCP от ребёнка: PLI/FIR = «потерял keyframe, дай IDR». Без этого
                // потеря пакета в P-кадре фризит зрителя до следующего события навсегда.
                // Форсим IDR через общий force_keyframe (энкодер заберёт на след. кадре),
                // rate-limit 1с на весь корень — против шторма PLI от многих детей.
                let fk = self.force_keyframe.clone();
                let last_pli = self.last_pli_ms.clone();
                let child_dbg = child_id.clone();
                let pli_stats = self.stats.clone();
                tokio::spawn(async move {
                    while let Ok((pkts, _)) = sender.read_rtcp().await {
                        let want_idr = pkts.iter().any(|p| {
                            let a = p.as_any();
                            a.downcast_ref::<PictureLossIndication>().is_some()
                                || a.downcast_ref::<FullIntraRequest>().is_some()
                        });
                        if want_idr {
                            // Считаем ДО rate-limit: подавленные запросы — тоже потери,
                            // и именно их шторм отличает «сеть сыпется» от «один зритель
                            // подключился». Иначе счётчик упирался бы в 1/с.
                            pli_stats.pli_count.fetch_add(1, Ordering::Relaxed);
                            let now = now_ms();
                            let prev = last_pli.load(Ordering::Relaxed);
                            if now.saturating_sub(prev) >= 1000 {
                                last_pli.store(now, Ordering::Relaxed);
                                fk.store(true, Ordering::Relaxed);
                                log::debug!("peer {child_dbg}: PLI -> force IDR");
                            }
                        }
                    }
                    // read_rtcp вернул Err (ErrClosedPipe при закрытии PC) — задача завершается.
                });
            }
            Err(e) => log::error!("peer: add_track video: {e}"),
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

        if let Some(old) = self.children.insert(child_id, pc) {
            // Повторный assign того же id без предшествующего leave — старый PC иначе
            // утекал бы (висящий сендер + RTCP-таск). Закрываем в фоне.
            tokio::spawn(async move { let _ = old.close().await; });
        }
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

    /// Чистка мёртвых child-PC (Failed/Closed). После реджойна сигналинга (рестарт
    /// сервера) старые дети не получат drop-peer — их новые инкарнации под новыми
    /// peer-id; старый PC умирает сам, когда зритель пересоздал соединение.
    pub async fn sweep_dead(&mut self) {
        let dead: Vec<String> = self.children.iter()
            .filter(|(_, pc)| matches!(pc.connection_state(), RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed))
            .map(|(id, _)| id.clone()).collect();
        for id in dead {
            if let Some(pc) = self.children.remove(&id) {
                log::info!("peer {id}: мёртвый PC (failed/closed) — чищу");
                let _ = pc.close().await;
            }
        }
    }

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
