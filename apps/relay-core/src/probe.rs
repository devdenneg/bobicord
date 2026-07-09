// Roadmap-flow-стриминга Д5: probe-приёмник для замера upload вещателя.
//
// Вещатель (webview, Chromium GCC-BWE) шлёт синтетический трек 60fps с высоким maxBitrate;
// мы — PC-answerer, принимаем трек и ДРОПАЕМ (никуда не пишем, не транскодируем). Короткоживущая
// сессия с таймаутом (не висеть, если вещатель отвалился). Отдельно от ingest/рендишн-сессий.
//
// ВАЖНО: в отличие от passthrough-relay (relay.rs, `rtcp_feedback: vec![]`), probe заводит
// ОТДЕЛЬНЫЙ MediaEngine с register_default_codecs — с transport-cc/nack/pli. Send-side GCC-BWE
// вещателя требует transport-wide feedback ОТ приёмника; без него availableOutgoingBitrate не
// разгоняется (документированный риск роадмапа) — тут даём полный набор фидбэка.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::mpsc;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::rtp_transceiver::rtp_receiver::RTCRtpReceiver;
use webrtc::rtp_transceiver::RTCRtpTransceiver;
use webrtc::track::track_remote::TrackRemote;

use crate::link::parse_ice_server;

/// Жёсткий потолок жизни probe-сессии: вещатель мог отвалиться, не прислав leave.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);

pub struct ProbeSession {
    pc: Arc<RTCPeerConnection>,
}

impl ProbeSession {
    pub async fn add_ice(&self, candidate: Value) {
        if let Ok(init) = serde_json::from_value::<RTCIceCandidateInit>(candidate) {
            let _ = self.pc.add_ice_candidate(init).await;
        }
    }
    pub async fn close(&self) { let _ = self.pc.close().await; }
}

/// Поднимает probe-answerer: setRemote(offer) → answer (возвращается вызывающему для
/// probe-answer). Принятые треки дропаются. Локальные ICE-кандидаты уходят в `out_tx`
/// готовыми строками `probe-ice{to}` (main.rs пишет их в control-WS). Через PROBE_TIMEOUT
/// PC закрывается сам.
pub async fn answer(
    offer_sdp: String,
    ice_servers: &[Value],
    to: String,
    out_tx: mpsc::UnboundedSender<String>,
) -> Result<(String, ProbeSession), String> {
    let mut m = MediaEngine::default();
    m.register_default_codecs().map_err(|e| e.to_string())?;
    let registry = register_default_interceptors(Registry::new(), &mut m).map_err(|e| e.to_string())?;
    let api = APIBuilder::new().with_media_engine(m).with_interceptor_registry(registry).build();

    let parsed: Vec<RTCIceServer> = ice_servers.iter().filter_map(parse_ice_server).collect();
    let config = RTCConfiguration {
        ice_servers: if parsed.is_empty() {
            vec![RTCIceServer { urls: vec!["stun:stun.l.google.com:19302".to_owned()], ..Default::default() }]
        } else { parsed },
        ..Default::default()
    };
    let pc = Arc::new(api.new_peer_connection(config).await.map_err(|e| e.to_string())?);

    // Принятый трек — читаем и выбрасываем (приёмник шлёт RR/TWCC для BWE вещателя, но медиа
    // никуда не пишем и не транскодируем).
    pc.on_track(Box::new(move |track: Arc<TrackRemote>, _r: Arc<RTCRtpReceiver>, _t: Arc<RTCRtpTransceiver>| {
        Box::pin(async move {
            tokio::spawn(async move {
                loop { if track.read_rtp().await.is_err() { break; } }
            });
        })
    }));

    let ice_tx = out_tx.clone();
    let to_ice = to.clone();
    pc.on_ice_candidate(Box::new(move |c: Option<RTCIceCandidate>| {
        let ice_tx = ice_tx.clone();
        let to_ice = to_ice.clone();
        Box::pin(async move {
            if let Some(cand) = c {
                if let Ok(init) = cand.to_json() {
                    if let Ok(val) = serde_json::to_value(&init) {
                        let _ = ice_tx.send(json!({ "t": "probe-ice", "to": to_ice, "candidate": val }).to_string());
                    }
                }
            }
        })
    }));

    let offer = RTCSessionDescription::offer(offer_sdp).map_err(|e| e.to_string())?;
    pc.set_remote_description(offer).await.map_err(|e| e.to_string())?;
    let answer = pc.create_answer(None).await.map_err(|e| e.to_string())?;
    pc.set_local_description(answer.clone()).await.map_err(|e| e.to_string())?;

    // Самозакрытие по таймауту (main.rs тоже прунит карту — belt-and-suspenders).
    let pc_to = pc.clone();
    tokio::spawn(async move {
        tokio::time::sleep(PROBE_TIMEOUT).await;
        let _ = pc_to.close().await;
    });

    Ok((answer.sdp, ProbeSession { pc }))
}
