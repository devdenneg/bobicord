// dev-смоук реконнекта сигналинга: viewer с reconnect=true против локального tree-сервера.
// Запуск: cargo run --example reconnect_smoke -- "ws://127.0.0.1:3000/tree?token=<jwt>"
// Сценарий: подключиться -> убить сервер -> увидеть «реконнект через Nс» -> поднять сервер
// -> увидеть «переподключение #N — реджойн» и свежий join в логе сервера.
use std::time::Duration;

use relay_core::relay::{self, RelayConfig};

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info,webrtc=warn,webrtc_ice=warn,webrtc_mdns=error")).init();
    let ws_url = std::env::args().nth(1).expect("аргумент: ws-url с ?token=");
    let handle = relay::start(None, RelayConfig {
        stream_id: "st-reconnect".into(),
        ws_url,
        identity: "rc-test".into(),
        server_id: "srv1".into(),
        max_children: 2,
        virtual_relay: false,
        available_outgoing: 8_000_000,
        idle_exit: None,
        reconnect: true,
    });
    tokio::time::sleep(Duration::from_secs(45)).await;
    handle.stop();
    tokio::time::sleep(Duration::from_secs(1)).await;
}
