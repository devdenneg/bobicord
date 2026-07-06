// relay-core: кросс-платформенное ядро relay-viewer P2P-дерева (Evolution-TZ Э8/Э9).
// signaling — WS-клиент протокола tree.js; relay — passthrough-ретранслятор (upstream
// answerer + фанаут детям); link — общие хелперы webrtc (stats, ICE, fmtp).
pub mod link;
pub mod relay;
pub mod signaling;
