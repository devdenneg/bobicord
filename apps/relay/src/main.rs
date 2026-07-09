// vrelay — headless-агент виртуального серверного fallback-relay (Evolution-TZ Э9).
//
// Схема: постоянный control-WS к tree-сигналингу (vrelay-hello с ёмкостью, pong на
// heartbeat-ping, reconnect с backoff). Сервер шлёт vrelay-activate {streamId, serverId},
// когда дереву нужен фолбэк (сироты без живых кандидатов или ручной запрос зрителя) —
// агент поднимает relay-core сессию (свой WS, join как viewer с virtual:true, passthrough
// RTP детям). Сессия сама уходит по idle (нет живых детей) или по vrelay-release
// (дренаж/обрушение дерева) — агент чистит её из карты и готов к повторной активации.
//
// Auth: /tree проверяет session-JWT (HS256, SESSION_SECRET) без DB-lookup — минтим сами
// с uid 'virtual-relay'; только этому uid сервер верит флаг virtual (tree.js).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tokio_tungstenite::tungstenite::Message;

use relay_core::relay::{self, RelayConfig, RelayHandle};

const VRELAY_UID: &str = "virtual-relay"; // должен совпадать с VRELAY_UID в tree.js

struct Cfg {
    session_secret: String,
    ws_url: String,
    max_children: u32,
    idle: Duration,
    max_streams: usize,
    available_outgoing: u32,
}

impl Cfg {
    fn from_env() -> Result<Self, String> {
        let session_secret = std::env::var("SESSION_SECRET").map_err(|_| "SESSION_SECRET не задан".to_string())?;
        let ws_url = std::env::var("TREE_WS_URL").unwrap_or_else(|_| "ws://127.0.0.1:3000/tree".into());
        let max_children: u32 = std::env::var("VRELAY_MAX_CHILDREN").ok().and_then(|v| v.parse().ok()).unwrap_or(8);
        let idle_sec: u64 = std::env::var("VRELAY_IDLE_SEC").ok().and_then(|v| v.parse().ok()).unwrap_or(60);
        let max_streams: usize = std::env::var("VRELAY_MAX_STREAMS").ok().and_then(|v| v.parse().ok()).unwrap_or(8);
        let out_mbps: u32 = std::env::var("VRELAY_OUT_MBPS").ok().and_then(|v| v.parse().ok()).unwrap_or(50);
        Ok(Self {
            session_secret,
            ws_url,
            max_children,
            idle: Duration::from_secs(idle_sec),
            max_streams,
            available_outgoing: out_mbps.saturating_mul(1_000_000),
        })
    }
}

#[derive(Serialize)]
struct Claims { id: String, exp: usize }

/// Session-JWT с uid агента. Свежий на каждое подключение (exp сутки — с запасом
/// больше жизни любого коннекта; сервер проверяет exp на handshake, не после).
fn mint_token(secret: &str) -> String {
    use jsonwebtoken::{encode, EncodingKey, Header};
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as usize;
    let claims = Claims { id: VRELAY_UID.into(), exp: now + 24 * 3600 };
    encode(&Header::default(), &claims, &EncodingKey::from_secret(secret.as_bytes()))
        .expect("HS256-подпись JWT не может упасть на валидном секрете")
}

type Streams = Arc<Mutex<HashMap<String, RelayHandle>>>;

/// Одна жизнь control-соединения: hello -> цикл (pong на ping, vrelay-activate -> сессия).
/// Возврат = соединение умерло (вызывающий реконнектится с backoff).
async fn run_control(cfg: &Arc<Cfg>, streams: &Streams) -> Result<(), String> {
    let url = format!("{}?token={}", cfg.ws_url, mint_token(&cfg.session_secret));
    let (ws, _) = tokio_tungstenite::connect_async(&url).await.map_err(|e| e.to_string())?;
    let (mut write, mut read) = ws.split();
    let hello = json!({ "t": "vrelay-hello", "capacity": cfg.max_children });
    write.send(Message::Text(hello.to_string().into())).await.map_err(|e| e.to_string())?;
    log::info!("control: подключён к {} (ёмкость {})", cfg.ws_url, cfg.max_children);

    while let Some(m) = read.next().await {
        match m {
            Ok(Message::Ping(d)) => {
                // Heartbeat tree.js: без явного pong сервер терминирует сокет за ~10с.
                let _ = write.send(Message::Pong(d)).await;
            }
            Ok(Message::Text(txt)) => {
                let Ok(v) = serde_json::from_str::<Value>(&txt) else { continue };
                // vrelay-activate (Э9): fallback-сессия — гаснет по idle, без реконнекта.
                // vrelay-ingest (Д1 server-first): ПОСТОЯННЫЙ медиаузел — без idle-exit,
                // переживает обрыв WS (реконнект+реджойн). Завершается по vrelay-release/stream-end.
                let (kind, persistent) = match v.get("t").and_then(|x| x.as_str()) {
                    Some("vrelay-activate") => ("activate", false),
                    Some("vrelay-ingest") => ("ingest", true),
                    _ => continue,
                };
                let Some(stream_id) = v.get("streamId").and_then(|x| x.as_str()) else { continue };
                let server_id = v.get("serverId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                log::info!("control: {kind} {stream_id}");
                activate(cfg, streams, stream_id, server_id, persistent).await;
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }
    Ok(())
}

/// Поднимает relay-сессию для дерева, если её ещё нет и лимит не выбран.
/// `persistent` (Д1 ingest): постоянный медиаузел — без idle-exit, с реконнектом WS.
/// Иначе (Э9 activate): fallback-сессия — гаснет по idle, без реконнекта (агент
/// переактивируется по следующему vrelay-activate).
async fn activate(cfg: &Arc<Cfg>, streams: &Streams, stream_id: &str, server_id: String, persistent: bool) {
    let mut map = streams.lock().await;
    if map.contains_key(stream_id) { return; } // уже ретранслируем это дерево
    if map.len() >= cfg.max_streams {
        log::warn!("stream {stream_id}: отказ — лимит VRELAY_MAX_STREAMS={} выбран", cfg.max_streams);
        return;
    }
    log::info!("stream {stream_id}: активация{} (серверов в работе: {})", if persistent { " (ingest, постоянная)" } else { "" }, map.len());
    let handle = relay::start(None, RelayConfig {
        stream_id: stream_id.to_string(),
        ws_url: format!("{}?token={}", cfg.ws_url, mint_token(&cfg.session_secret)),
        identity: "server".into(),
        server_id,
        max_children: cfg.max_children,
        virtual_relay: true,
        available_outgoing: cfg.available_outgoing,
        // Д1 ingest: постоянный узел не гаснет по простою — только по vrelay-release/stream-end
        // (уход вещателя). Э9 activate: гаснет по idle, агент переактивируется.
        idle_exit: if persistent { None } else { Some(cfg.idle) },
        reconnect: persistent, // ingest переживает деплой (реконнект+реджойн); activate гаснет с WS
    });
    let fin = handle.finished();
    map.insert(stream_id.to_string(), handle);
    drop(map);
    // Сессия кончилась (idle-exit / vrelay-release / обрыв WS) — чистим карту, повторная
    // активация того же дерева снова пройдёт.
    let streams = streams.clone();
    let sid = stream_id.to_string();
    tokio::spawn(async move {
        fin.notified().await;
        streams.lock().await.remove(&sid);
        log::info!("stream {sid}: сессия завершена");
    });
}

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let cfg = match Cfg::from_env() {
        Ok(c) => Arc::new(c),
        Err(e) => { eprintln!("vrelay: {e}"); std::process::exit(1); }
    };
    let streams: Streams = Arc::new(Mutex::new(HashMap::new()));

    let mut backoff = 1u64;
    loop {
        let res = run_control(&cfg, &streams).await;
        match &res {
            Ok(()) => { backoff = 1; log::warn!("control: соединение закрыто — реконнект через {backoff}с"); }
            Err(e) => log::warn!("control: {e} — реконнект через {backoff}с"),
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(backoff)) => {}
            _ = tokio::signal::ctrl_c() => {
                log::info!("SIGINT — останавливаю {} сессий", streams.lock().await.len());
                for (_, h) in streams.lock().await.drain() { h.stop(); }
                return;
            }
        }
        backoff = (backoff * 2).min(30);
    }
}
