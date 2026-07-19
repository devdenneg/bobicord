//! Изолированный source-fanout: один downstream не может затормозить остальных.
//!
//! `TrackLocalStaticRTP::write_rtp` обходит все bindings общего track последовательно.
//! Поэтому shared track превращал backpressure одного PeerConnection в общую очередь:
//! при её переполнении одинаковые RTP-пакеты теряли все зрители. Здесь у каждого
//! downstream собственные tracks, очереди и writer-задачи. Ingest только быстро
//! раскладывает `Arc<Packet>` по очередям и никогда не ждёт сеть конкретного зрителя.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::Notify;
use webrtc::api::media_engine::{MIME_TYPE_H264, MIME_TYPE_OPUS};
use webrtc::rtp::packet::Packet;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocalWriter;

use crate::link::{now_ms, H264_FMTP};

// 500мс защищают от короткого scheduler/socket-затыка, но не превращают live в запись.
// Byte-cap обязан вмещать крупный source-IDR целиком: случайно порезанный IDR хуже
// контролируемого ожидания следующего keyframe. 8МБ не меняют качество и всё ещё дают
// жёсткий memory bound даже для 4K; обычный поток раньше ограничит временное окно.
const VIDEO_MAX_TICKS: u32 = 45_000; // 500мс @ 90кГц
const VIDEO_MAX_BYTES: usize = 8 * 1024 * 1024;
const VIDEO_MAX_PACKETS: usize = 8_192;

// Аудио важнее держать свежим, чем копить: при перегрузе удаляем только самые старые
// пакеты ЭТОГО downstream. 120мс @ 48кГц.
const AUDIO_MAX_TICKS: u32 = 5_760;
const AUDIO_MAX_BYTES: usize = 128 * 1024;
const AUDIO_MAX_PACKETS: usize = 128;

const KEYFRAME_REQUEST_MIN_MS: u64 = 1_000;
const OVERFLOW_LOG_MIN_MS: u64 = 2_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum H264PacketClass {
    Other,
    Config,
    KeyframeStart,
}

/// Понимает single NAL, STAP-A и FU-A — три вида payload, которые реально даёт H.264
/// packetizer WebRTC. При resync сохраняем SPS/PPS и открываем поток только с начала IDR.
fn h264_packet_class(payload: &[u8]) -> H264PacketClass {
    let Some(&first) = payload.first() else {
        return H264PacketClass::Other;
    };
    match first & 0x1f {
        5 => H264PacketClass::KeyframeStart,
        7 | 8 => H264PacketClass::Config,
        24 => {
            // STAP-A: [header][size:u16][NAL]...
            let mut i = 1usize;
            let mut config = false;
            while i + 2 <= payload.len() {
                let n = u16::from_be_bytes([payload[i], payload[i + 1]]) as usize;
                i += 2;
                if n == 0 || i + n > payload.len() {
                    break;
                }
                match payload[i] & 0x1f {
                    5 => return H264PacketClass::KeyframeStart,
                    7 | 8 => config = true,
                    _ => {}
                }
                i += n;
            }
            if config { H264PacketClass::Config } else { H264PacketClass::Other }
        }
        28 if payload.len() >= 2 => {
            let start = payload[1] & 0x80 != 0;
            match payload[1] & 0x1f {
                5 if start => H264PacketClass::KeyframeStart,
                7 | 8 if start => H264PacketClass::Config,
                _ => H264PacketClass::Other,
            }
        }
        _ => H264PacketClass::Other,
    }
}

#[derive(Clone, Copy)]
struct QueueLimits {
    max_ticks: u32,
    max_bytes: usize,
    max_packets: usize,
}

impl QueueLimits {
    const VIDEO: Self = Self {
        max_ticks: VIDEO_MAX_TICKS,
        max_bytes: VIDEO_MAX_BYTES,
        max_packets: VIDEO_MAX_PACKETS,
    };
    const AUDIO: Self = Self {
        max_ticks: AUDIO_MAX_TICKS,
        max_bytes: AUDIO_MAX_BYTES,
        max_packets: AUDIO_MAX_PACKETS,
    };
}

#[derive(Default)]
struct QueueState {
    packets: VecDeque<QueuedPacket>,
    bytes: usize,
    /// После повреждения кадра P/B-пакеты бессмысленны: ждём SPS/PPS + начало IDR.
    desynced: bool,
    /// Очередь адресно выкинула пакеты. Следующий реально отправленный packet должен
    /// продолжить sequence конкретного viewer без NACK-дыры по намеренно удалённому хвосту.
    next_resets_seq: bool,
}

struct QueuedPacket {
    packet: Arc<Packet>,
    reset_seq: bool,
}

impl QueueState {
    fn duration_ticks_with(&self, packet: &Packet) -> u32 {
        let Some(first) = self.packets.front() else {
            return 0;
        };
        let d = packet.header.timestamp.wrapping_sub(first.packet.header.timestamp);
        if d < 0x8000_0000 { d } else { 0 }
    }

    fn would_overflow(&self, packet: &Packet, limits: QueueLimits) -> bool {
        self.packets.len() >= limits.max_packets
            || self.bytes.saturating_add(packet.payload.len()) > limits.max_bytes
            || self.duration_ticks_with(packet) > limits.max_ticks
    }

    fn push(&mut self, packet: Arc<Packet>) {
        self.bytes = self.bytes.saturating_add(packet.payload.len());
        let reset_seq = self.next_resets_seq;
        self.next_resets_seq = false;
        self.packets.push_back(QueuedPacket { packet, reset_seq });
    }

    fn pop(&mut self) -> Option<QueuedPacket> {
        let packet = self.packets.pop_front()?;
        self.bytes = self.bytes.saturating_sub(packet.packet.payload.len());
        Some(packet)
    }

    fn clear(&mut self) -> usize {
        let dropped = self.packets.len();
        self.packets.clear();
        self.bytes = 0;
        dropped
    }
}

#[derive(Default, Debug, Clone, Copy)]
struct PushResult {
    dropped: u64,
    request_keyframe: bool,
    overflowed: bool,
}

struct PacketQueue {
    state: Mutex<QueueState>,
    notify: Notify,
    closed: AtomicBool,
    limits: QueueLimits,
    video: bool,
}

impl PacketQueue {
    fn video() -> Self {
        Self::new(QueueLimits::VIDEO, true)
    }

    fn audio() -> Self {
        Self::new(QueueLimits::AUDIO, false)
    }

    fn new(limits: QueueLimits, video: bool) -> Self {
        Self {
            state: Mutex::new(QueueState::default()),
            notify: Notify::new(),
            closed: AtomicBool::new(false),
            limits,
            video,
        }
    }

    fn push(&self, packet: Arc<Packet>) -> PushResult {
        if self.closed.load(Ordering::Relaxed) {
            return PushResult::default();
        }
        let mut state = self.state.lock().unwrap();
        // close() мог выиграть гонку между быстрым pre-check и взятием mutex.
        if self.closed.load(Ordering::Relaxed) {
            return PushResult::default();
        }
        let mut result = PushResult::default();

        if self.video {
            let class = h264_packet_class(&packet.payload);
            if state.desynced {
                match class {
                    H264PacketClass::Config => {
                        // SPS/PPS малы и нужны будущему IDR. Старые config заменяем, если
                        // кто-то прислал аномально длинную серию без keyframe.
                        if state.would_overflow(&packet, self.limits) {
                            result.dropped += state.clear() as u64;
                            result.overflowed = true;
                            state.next_resets_seq = true;
                        }
                        state.push(packet);
                        self.notify.notify_one();
                    }
                    H264PacketClass::KeyframeStart => {
                        if state.would_overflow(&packet, self.limits) {
                            result.dropped += state.clear() as u64;
                            result.overflowed = true;
                            state.next_resets_seq = true;
                        }
                        state.push(packet);
                        state.desynced = false;
                        self.notify.notify_one();
                    }
                    H264PacketClass::Other => {
                        result.dropped = 1;
                        result.request_keyframe = true;
                        // Config мог уже уйти writer'у. IDR после пропущенных P/B обязан
                        // ещё раз закрыть намеренную sequence-дыру этого viewer.
                        state.next_resets_seq = true;
                    }
                }
                return result;
            }

            if state.would_overflow(&packet, self.limits) {
                result.overflowed = true;
                result.dropped = state.clear() as u64;
                state.desynced = true;
                state.next_resets_seq = true;
                // Если граница переполнения совпала с началом нового IDR, старый хвост
                // можно выбросить и сразу начать чистую декодируемую эпоху.
                if class == H264PacketClass::KeyframeStart {
                    state.push(packet);
                    state.desynced = false;
                } else {
                    result.dropped += 1;
                    result.request_keyframe = true;
                }
                self.notify.notify_one();
                return result;
            }
            state.push(packet);
        } else {
            // Аудио не ждёт keyframe: держим freshest tail, удаляя старое только у
            // конкретного медленного downstream.
            let mut removed = false;
            while state.would_overflow(&packet, self.limits) && !state.packets.is_empty() {
                state.pop();
                result.dropped += 1;
                result.overflowed = true;
                removed = true;
            }
            if removed {
                if let Some(first) = state.packets.front_mut() {
                    first.reset_seq = true;
                } else {
                    state.next_resets_seq = true;
                }
            }
            state.push(packet);
        }
        self.notify.notify_one();
        result
    }

    async fn recv(&self) -> Option<QueuedPacket> {
        loop {
            // Регистрируем waiter ДО проверки состояния, чтобы push между проверкой и
            // await не потерял пробуждение.
            let notified = self.notify.notified();
            {
                let mut state = self.state.lock().unwrap();
                if let Some(packet) = state.pop() {
                    return Some(packet);
                }
                if self.closed.load(Ordering::Relaxed) {
                    return None;
                }
            }
            notified.await;
        }
    }

    fn len(&self) -> usize {
        self.state.lock().unwrap().packets.len()
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        self.state.lock().unwrap().clear();
        // У очереди ровно один writer. notify_one хранит permit, даже если close попал
        // между проверкой closed и фактической регистрацией Notified future.
        self.notify.notify_one();
    }
}

struct Subscriber {
    id: String,
    video: Arc<PacketQueue>,
    audio: Arc<PacketQueue>,
    drops: AtomicU64,
    write_errors: AtomicU64,
    max_write_ms: AtomicU64,
    last_overflow_log_ms: AtomicU64,
}

impl Subscriber {
    fn close(&self) {
        self.video.close();
        self.audio.close();
    }
}

pub(crate) struct DownstreamTracks {
    pub video: Arc<TrackLocalStaticRTP>,
    pub audio: Arc<TrackLocalStaticRTP>,
    id: String,
    subscriber: Arc<Subscriber>,
}

/// SFU-style fanout для source-потока. Рендишн-корни пока остаются на совместимом
/// injected/shared пути; обычные source children и локальный webview полностью изолированы.
pub(crate) struct FanoutHub {
    stream_id: String,
    subscribers: Mutex<HashMap<String, Arc<Subscriber>>>,
    request_keyframe: Arc<dyn Fn() + Send + Sync>,
    last_keyframe_request_ms: AtomicU64,
}

impl FanoutHub {
    pub fn new(stream_id: String, request_keyframe: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self {
            stream_id,
            subscribers: Mutex::new(HashMap::new()),
            request_keyframe,
            last_keyframe_request_ms: AtomicU64::new(0),
        }
    }

    /// Создаёт tracks и writer-задачи, но пока не публикует в них RTP. Это позволяет
    /// настроить offer транзакционно: ошибка нового PC не выбивает уже работающий PC
    /// с тем же child-id.
    pub fn prepare(&self, id: String) -> DownstreamTracks {
        let video = Arc::new(TrackLocalStaticRTP::new(
            RTCRtpCodecCapability { mime_type: MIME_TYPE_H264.to_owned(), clock_rate: 90_000, sdp_fmtp_line: H264_FMTP.to_owned(), ..Default::default() },
            "video".to_owned(),
            self.stream_id.clone(),
        ));
        let audio = Arc::new(TrackLocalStaticRTP::new(
            RTCRtpCodecCapability { mime_type: MIME_TYPE_OPUS.to_owned(), clock_rate: 48_000, channels: 2, ..Default::default() },
            "audio".to_owned(),
            self.stream_id.clone(),
        ));
        let sub = Arc::new(Subscriber {
            id: id.clone(),
            video: Arc::new(PacketQueue::video()),
            audio: Arc::new(PacketQueue::audio()),
            drops: AtomicU64::new(0),
            write_errors: AtomicU64::new(0),
            max_write_ms: AtomicU64::new(0),
            last_overflow_log_ms: AtomicU64::new(0),
        });
        tokio::spawn(writer_loop(sub.clone(), sub.video.clone(), video.clone(), "video"));
        tokio::spawn(writer_loop(sub.clone(), sub.audio.clone(), audio.clone(), "audio"));
        DownstreamTracks {
            video,
            audio,
            id,
            subscriber: sub,
        }
    }

    /// Подменяет прежний subscriber только после успешной настройки нового downstream.
    pub fn activate(&self, tracks: &DownstreamTracks) {
        let old = self
            .subscribers
            .lock()
            .unwrap()
            .insert(tracks.id.clone(), tracks.subscriber.clone());
        if let Some(old) = old {
            old.close();
        }
    }

    pub fn discard(&self, tracks: &DownstreamTracks) {
        tracks.subscriber.close();
    }

    pub fn remove(&self, id: &str) {
        if let Some(sub) = self.subscribers.lock().unwrap().remove(id) {
            sub.close();
        }
    }

    pub fn clear(&self) {
        let subscribers: Vec<_> = self.subscribers.lock().unwrap().drain().map(|(_, s)| s).collect();
        for sub in subscribers {
            sub.close();
        }
    }

    /// Возвращает число отброшенных per-viewer копий пакетов (не общих ingest-пакетов).
    pub fn publish(&self, packet: Packet, video: bool) -> u64 {
        let packet = Arc::new(packet);
        let subscribers: Vec<_> = self.subscribers.lock().unwrap().values().cloned().collect();
        let mut dropped = 0u64;
        let mut request_keyframe = false;
        for sub in subscribers {
            let result = if video { sub.video.push(packet.clone()) } else { sub.audio.push(packet.clone()) };
            if result.dropped > 0 {
                sub.drops.fetch_add(result.dropped, Ordering::Relaxed);
                dropped = dropped.saturating_add(result.dropped);
            }
            request_keyframe |= result.request_keyframe;
            if result.overflowed {
                let now = now_ms();
                let prev = sub.last_overflow_log_ms.load(Ordering::Relaxed);
                if now.saturating_sub(prev) >= OVERFLOW_LOG_MIN_MS
                    && sub.last_overflow_log_ms.compare_exchange(prev, now, Ordering::Relaxed, Ordering::Relaxed).is_ok()
                {
                    log::warn!(
                        "fanout {} child={} {} overflow: dropped={} queue={} — изолировано от остальных",
                        self.stream_id,
                        sub.id,
                        if video { "video" } else { "audio" },
                        result.dropped,
                        if video { sub.video.len() } else { sub.audio.len() },
                    );
                }
            }
        }
        if request_keyframe {
            let now = now_ms();
            let prev = self.last_keyframe_request_ms.load(Ordering::Relaxed);
            if now.saturating_sub(prev) >= KEYFRAME_REQUEST_MIN_MS
                && self.last_keyframe_request_ms.compare_exchange(prev, now, Ordering::Relaxed, Ordering::Relaxed).is_ok()
            {
                (self.request_keyframe)();
            }
        }
        dropped
    }

    /// Адресная сводка вызывается существующим 2с stats-тиком relay-цикла.
    pub fn log_health(&self) {
        let subscribers: Vec<_> = self.subscribers.lock().unwrap().values().cloned().collect();
        for sub in subscribers {
            let drops = sub.drops.swap(0, Ordering::Relaxed);
            let errors = sub.write_errors.swap(0, Ordering::Relaxed);
            let write_ms = sub.max_write_ms.swap(0, Ordering::Relaxed);
            if drops > 0 || errors > 0 || write_ms >= 50 {
                log::info!(
                    "fanout {} child={}: drops={} errors={} max_write={}ms queues video={} audio={}",
                    self.stream_id, sub.id, drops, errors, write_ms, sub.video.len(), sub.audio.len(),
                );
            }
        }
    }
}

#[derive(Default)]
struct SequenceRewriter {
    last_seq: Option<u16>,
    seq_offset: u16,
    pending_reset: bool,
}

impl SequenceRewriter {
    fn rewrite(&mut self, queued: &QueuedPacket) -> Packet {
        let mut packet = (*queued.packet).clone();
        self.pending_reset |= queued.reset_seq;
        if self.pending_reset {
            if let Some(last) = self.last_seq {
                self.seq_offset = last
                    .wrapping_add(1)
                    .wrapping_sub(packet.header.sequence_number);
            }
        }
        packet.header.sequence_number = packet
            .header
            .sequence_number
            .wrapping_add(self.seq_offset);
        packet
    }

    /// Ошибка write не двигает sequence: следующий пакет снова закроет намеренную дыру.
    fn on_sent(&mut self, sequence_number: u16) {
        self.last_seq = Some(sequence_number);
        self.pending_reset = false;
    }

    fn on_write_error(&mut self) {
        // Пакет уже вынут из очереди, но до track не дошёл. Следующая успешная запись
        // должна продолжить sequence этого viewer, а не создавать заведомую NACK-дыру.
        self.pending_reset = true;
    }
}

async fn writer_loop(
    sub: Arc<Subscriber>,
    queue: Arc<PacketQueue>,
    track: Arc<TrackLocalStaticRTP>,
    kind: &'static str,
) {
    let mut sequence = SequenceRewriter::default();
    while let Some(queued) = queue.recv().await {
        let packet = sequence.rewrite(&queued);
        let started = Instant::now();
        if let Err(e) = track.write_rtp(&packet).await {
            sequence.on_write_error();
            // Закрытие PC гоняется с очисткой очереди; ErrClosedPipe на хвосте штатен.
            if webrtc::Error::ErrClosedPipe.to_string() != e.to_string() {
                sub.write_errors.fetch_add(1, Ordering::Relaxed);
                log::debug!("fanout child={} {kind} write_rtp: {e}", sub.id);
            }
        } else {
            sequence.on_sent(packet.header.sequence_number);
        }
        sub.max_write_ms.fetch_max(
            started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            Ordering::Relaxed,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use webrtc::rtp::header::Header;

    fn packet(seq: u16, ts: u32, payload: &[u8]) -> Arc<Packet> {
        Arc::new(Packet {
            header: Header {
                sequence_number: seq,
                timestamp: ts,
                ..Default::default()
            },
            payload: payload.to_vec().into(),
        })
    }

    #[test]
    fn detects_single_fu_and_stap_keyframes() {
        assert_eq!(h264_packet_class(&[0x65]), H264PacketClass::KeyframeStart);
        assert_eq!(h264_packet_class(&[0x7c, 0x85]), H264PacketClass::KeyframeStart); // FU-A start IDR
        assert_eq!(h264_packet_class(&[0x7c, 0x05]), H264PacketClass::Other); // FU-A continuation
        assert_eq!(h264_packet_class(&[24, 0, 1, 0x67, 0, 1, 0x65]), H264PacketClass::KeyframeStart);
        assert_eq!(h264_packet_class(&[0x67]), H264PacketClass::Config);
    }

    #[test]
    fn video_overflow_resyncs_only_on_keyframe() {
        let q = PacketQueue::new(QueueLimits { max_ticks: 90, max_bytes: 10_000, max_packets: 8 }, true);
        assert_eq!(q.push(packet(1, 0, &[0x41])).dropped, 0);
        let overflow = q.push(packet(2, 180, &[0x41]));
        assert!(overflow.overflowed && overflow.request_keyframe);
        assert_eq!(q.len(), 0);
        assert_eq!(q.push(packet(3, 180, &[0x41])).dropped, 1); // P-frame бесполезен
        assert_eq!(q.push(packet(4, 180, &[0x67])).dropped, 0); // SPS сохраняем
        assert_eq!(q.push(packet(5, 180, &[0x65])).dropped, 0); // IDR возвращает sync
        assert_eq!(q.push(packet(6, 180, &[0x41])).dropped, 0);
        assert_eq!(q.len(), 3);
    }

    #[test]
    fn keyframe_at_overflow_boundary_starts_clean_queue() {
        let q = PacketQueue::new(QueueLimits { max_ticks: 90, max_bytes: 10_000, max_packets: 8 }, true);
        q.push(packet(1, 0, &[0x41]));
        let result = q.push(packet(2, 180, &[0x65]));
        assert!(result.overflowed);
        assert!(!result.request_keyframe);
        assert_eq!(q.len(), 1);
    }

    #[test]
    fn audio_drops_oldest_and_keeps_fresh_tail() {
        let q = PacketQueue::new(QueueLimits { max_ticks: 100, max_bytes: 10_000, max_packets: 8 }, false);
        q.push(packet(1, 0, &[1]));
        q.push(packet(2, 60, &[2]));
        let result = q.push(packet(3, 180, &[3]));
        assert_eq!(result.dropped, 2);
        assert_eq!(q.len(), 1);
        let state = q.state.lock().unwrap();
        let first = state.packets.front().unwrap();
        assert_eq!(first.packet.header.sequence_number, 3);
        assert!(first.reset_seq);
    }

    #[test]
    fn dropped_video_packets_do_not_create_viewer_sequence_gap() {
        let q = PacketQueue::new(
            QueueLimits { max_ticks: 90, max_bytes: 10_000, max_packets: 8 },
            true,
        );
        let mut sequence = SequenceRewriter::default();

        q.push(packet(10, 0, &[0x41]));
        let first = q.state.lock().unwrap().pop().unwrap();
        let first = sequence.rewrite(&first);
        assert_eq!(first.header.sequence_number, 10);
        sequence.on_sent(first.header.sequence_number);

        q.push(packet(11, 0, &[0x41]));
        assert!(q.push(packet(12, 180, &[0x41])).overflowed);
        q.push(packet(13, 180, &[0x67]));

        let config = q.state.lock().unwrap().pop().unwrap();
        assert!(config.reset_seq);
        let config = sequence.rewrite(&config);
        assert_eq!(config.header.sequence_number, 11);
        sequence.on_sent(config.header.sequence_number);

        assert_eq!(q.push(packet(14, 180, &[0x41])).dropped, 1);
        q.push(packet(15, 180, &[0x65]));
        let keyframe = q.state.lock().unwrap().pop().unwrap();
        assert!(keyframe.reset_seq);
        let keyframe = sequence.rewrite(&keyframe);
        assert_eq!(keyframe.header.sequence_number, 12);
    }

    #[test]
    fn write_error_does_not_create_viewer_sequence_gap() {
        let mut sequence = SequenceRewriter::default();
        let first = QueuedPacket { packet: packet(20, 0, &[1]), reset_seq: false };
        let first = sequence.rewrite(&first);
        sequence.on_sent(first.header.sequence_number);

        let failed = QueuedPacket { packet: packet(21, 1, &[2]), reset_seq: false };
        let failed = sequence.rewrite(&failed);
        assert_eq!(failed.header.sequence_number, 21);
        sequence.on_write_error();

        let next = QueuedPacket { packet: packet(22, 2, &[3]), reset_seq: false };
        let next = sequence.rewrite(&next);
        assert_eq!(next.header.sequence_number, 21);
    }

    #[test]
    fn independent_queues_do_not_share_overflow_state() {
        let slow = PacketQueue::new(QueueLimits { max_ticks: 90, max_bytes: 10_000, max_packets: 8 }, true);
        let healthy = PacketQueue::new(QueueLimits { max_ticks: 900, max_bytes: 10_000, max_packets: 8 }, true);
        slow.push(packet(1, 0, &[0x41]));
        healthy.push(packet(1, 0, &[0x41]));
        assert!(slow.push(packet(2, 180, &[0x41])).overflowed);
        assert!(!healthy.push(packet(2, 180, &[0x41])).overflowed);
        assert_eq!(slow.len(), 0);
        assert_eq!(healthy.len(), 2);
    }

    #[tokio::test]
    async fn prepared_replacement_is_transactional() {
        let hub = FanoutHub::new("stream".to_owned(), Arc::new(|| {}));
        let first = hub.prepare("child".to_owned());
        assert!(hub.subscribers.lock().unwrap().is_empty());

        hub.activate(&first);
        let active = hub.subscribers.lock().unwrap().get("child").unwrap().clone();
        let replacement = hub.prepare("child".to_owned());
        let still_active = hub.subscribers.lock().unwrap().get("child").unwrap().clone();
        assert!(Arc::ptr_eq(&active, &still_active));

        hub.discard(&replacement);
        let after_discard = hub.subscribers.lock().unwrap().get("child").unwrap().clone();
        assert!(Arc::ptr_eq(&active, &after_discard));
        hub.clear();
    }

    #[tokio::test]
    async fn close_wakes_empty_queue_receiver() {
        let queue = Arc::new(PacketQueue::video());
        let receiver = {
            let queue = queue.clone();
            tokio::spawn(async move { queue.recv().await })
        };
        tokio::task::yield_now().await;
        queue.close();
        let result = tokio::time::timeout(std::time::Duration::from_millis(100), receiver)
            .await
            .expect("receiver завис после close")
            .expect("receiver task упал");
        assert!(result.is_none());
    }
}
