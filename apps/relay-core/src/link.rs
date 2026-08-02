// Общие webrtc-хелперы дерева (вынесены из натива, apps/native broadcast/peer.rs):
// используются и relay-ядром (этот крейт), и broadcaster-корнем в нативе.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use webrtc::api::setting_engine::SettingEngine;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::RTCPeerConnection;
use webrtc::stats::StatsReportType;

/// H.264 baseline, packetization-mode=1, без B-кадров (инвариант CLAUDE.md 4) —
/// та же профильная строка, что фиксирует `MF_MT_MPEG2_PROFILE` энкодера натива.
pub const H264_FMTP: &str = "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f";

/// Окно anti-replay SRTP в ПАКЕТАХ. Дефолт webrtc-rs — 64
/// (`DEFAULT_SESSION_SRTP_REPLAY_PROTECTION_WINDOW`), и это ломало ретрансмит: при 6 Мбит
/// поток идёт ~630 пакетов/с, то есть 64 пакета ≈ 100мс. NACK-ответ возвращается позже
/// (Generator 50мс + rtt), и `WrappedSlidingWindowDetector::check` бракует его веткой
/// «too old» ДО депакетайзера — с записью `srtp ssrc=… index=…: duplicated`. Пакет так и
/// не доезжает, Generator просит снова, ответ снова опаздывает → петля.
///
/// Замер прода (разбор стрима artem161 2026-08-02, нативный зритель, окна по 2с):
/// принято 746 пакетов (3.2 Мбит — вдвое ниже нормы) при 2480 отброшенных как «дубль».
/// Провод тащил ~3× медиарейта, полезный поток просел вдвое, зритель фризил до GOP-IDR (4с).
/// Прежние заходы (GapHealer, Generator 100→50мс, буфер 350/500/600мс) чинили «ретрансмит
/// не успевает» — а он успевал и молча выбрасывался здесь же, поэтому все замеры показывали
/// «дыра не залечена».
///
/// 8192 = размер кэша `nack::Responder` (log2_size 13) и окна `nack::Generator`: дальше
/// повторять всё равно нечего. Внутри своего дерева anti-replay смысла не несёт — DTLS-SRTP
/// уже аутентифицирует каждый пакет, а настоящий дубль дедуплицирует джиттер-буфер по seq.
const SRTP_REPLAY_WINDOW: usize = 8192;

/// `SettingEngine` для ЛЮБОГО PC дерева (relay-ингест, probe-приёмник, корень-вещатель):
/// поднятое окно anti-replay (см. `SRTP_REPLAY_WINDOW`). Ставится и на send-only PC —
/// там оно ни на что не влияет, но развилок «где включено, где нет» не остаётся.
pub fn tree_setting_engine() -> SettingEngine {
    let mut se = SettingEngine::default();
    se.set_srtp_replay_protection_window(SRTP_REPLAY_WINDOW);
    se
}

/// Текущее время в мс — для rate-limit'ов (грубая метка, монотонность не критична).
pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

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

/// Разбор ICE-сервера из welcome-сообщения tree.js ({urls, username?, credential?}).
pub fn parse_ice_server(v: &Value) -> Option<RTCIceServer> {
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
