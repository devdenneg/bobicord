// relay-core: кросс-платформенное ядро relay-viewer P2P-дерева (Evolution-TZ Э8/Э9).
// signaling — WS-клиент протокола tree.js; relay — passthrough-ретранслятор (upstream
// answerer + фанаут детям); link — общие хелперы webrtc (stats, ICE, fmtp).
pub mod link;
pub mod relay;
pub mod signaling;
// Roadmap-flow-стриминга Д2: серверный транскод рендишнов (RTP→ffmpeg→RTP) — только для
// vrelay (virtual_relay:true), нативный passthrough-узел его никогда не активирует.
pub mod transcode;
// Roadmap-flow-стриминга Д5: probe-приёмник замера upload вещателя (PC-answerer, дропает трек).
pub mod probe;
