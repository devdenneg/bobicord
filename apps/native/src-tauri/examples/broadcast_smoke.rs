// Э5 e2e-смоук: гоняет реальный нативный пайплайн (захват экрана -> MF H.264 ->
// webrtc-rs) БЕЗ Tauri/webview/UI — против apps/server/dev/native-e2e-server.js
// и браузерного apps/server/dev/tree-test-viewer.html. Не часть продукта.
//
// Запуск: cargo run --example broadcast_smoke -- "<ws_url>" [streamId]
// (ws_url печатает native-e2e-server.js при старте)

use app_lib::broadcast;

#[tokio::main]
async fn main() {
    env_logger::Builder::from_default_env().filter_level(log::LevelFilter::Info).init();

    let args: Vec<String> = std::env::args().collect();
    let ws_url = args.get(1).cloned().expect("usage: broadcast_smoke <ws_url> [streamId]");
    let stream_id = args.get(2).cloned().unwrap_or_else(|| "native-smoketest".to_string());
    let identity = stream_id.clone();

    let monitors = broadcast::list_monitors();
    println!("[smoke] monitors: {monitors:?}");
    let monitor_index = monitors.first().map(|(i, _)| *i).unwrap_or(0);
    let source = broadcast::CaptureSource::Monitor { index: monitor_index };
    let config = broadcast::StreamConfig {
        max_width: 1920, max_height: 1080, fps: 30, bitrate_bps: 6_000_000,
        auto_bitrate: true,
        audio_source: broadcast::AudioSource::ExcludeSelfViaInclude,
        max_direct_children: 4,
    };

    println!("[smoke] starting broadcast stream_id={stream_id} ws_url={ws_url} monitor={monitor_index}");
    let server_id = "smoke".to_string();
    let handle = broadcast::start(None, stream_id, ws_url, identity, server_id, source, config).await.expect("start broadcast");

    println!("[smoke] broadcasting for 300s — open tree-test-viewer.html now and click Смотреть");
    tokio::time::sleep(std::time::Duration::from_secs(300)).await;

    println!("[smoke] stopping");
    handle.stop().await;
    println!("[smoke] stopped");
}
