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
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

use relay_core::probe::{self, ProbeSession};
use relay_core::relay::{self, RelayConfig, RelayHandle};
use relay_core::transcode;

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
        let out_mbps: u32 = std::env::var("VRELAY_OUT_MBPS").ok().and_then(|v| v.parse().ok()).unwrap_or(15); // замер прода: устойчивая отдача 14-20 Мбит/с (см. docker-compose.yml)
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
/// Д2 (dev): рендишн-корни, ключ `streamId::rendition`. Отдельная relay-сессия на каждый
/// поднятый транскод-рендишн (реюз ingest-транскода как источника). Полноценный реестр
/// рендишнов — Д3/Д4; здесь минимум под ручной dev-триггер.
type Renditions = Arc<Mutex<HashMap<String, RelayHandle>>>;

/// Одна жизнь control-соединения: hello -> цикл (pong на ping, vrelay-activate -> сессия).
/// Возврат = соединение умерло (вызывающий реконнектится с backoff).
async fn run_control(cfg: &Arc<Cfg>, streams: &Streams, renditions: &Renditions) -> Result<(), String> {
    let url = format!("{}?token={}", cfg.ws_url, mint_token(&cfg.session_secret));
    let (ws, _) = tokio_tungstenite::connect_async(&url).await.map_err(|e| e.to_string())?;
    let (mut write, mut read) = ws.split();
    // maxTranscodes — транскод-ёмкость агента (кап одновременных ffmpeg-рендишнов). Сервер по
    // ней гейтит рендишн-лестницу: 0 (прод, 1 vCPU) → зрителям объявляется только исходное
    // качество, меню не предлагает 720/480 (иначе выбор → сирота в дереве без корня → чёрный экран).
    let hello = json!({ "t": "vrelay-hello", "capacity": cfg.max_children, "maxTranscodes": transcode::max_transcodes() });
    write.send(Message::Text(hello.to_string().into())).await.map_err(|e| e.to_string())?;
    log::info!("control: подключён к {} (ёмкость {})", cfg.ws_url, cfg.max_children);

    // Д5: очередь исходящих (probe-answer/probe-ice формируются в probe-задачах через канал,
    // пишутся здесь — единственный владелец WS-sink). Реюз паттерна ingest-релея.
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    // Д5: активные probe-сессии по peer-id вещателя (from). Прунятся по таймауту/выходу.
    let mut probes: HashMap<String, (ProbeSession, Instant)> = HashMap::new();
    // Д5: ICE-серверы из welcome — probe-answerer их использует (host-кандидат VPS предпочтётся
    // Chromium'ом → probe идёт на публичный IP host-сети, не через TURN, как требует роадмап).
    let mut ice_servers: Vec<Value> = Vec::new();

    loop {
      tokio::select! {
        // Исходящие сообщения probe-сессий (ICE от нашего answerer'а) — пишем в WS.
        Some(out) = out_rx.recv() => {
            if write.send(Message::Text(out.into())).await.is_err() { break; }
        }
        m = read.next() => {
        let Some(m) = m else { break };
        match m {
            Ok(Message::Ping(d)) => {
                // Heartbeat tree.js: без явного pong сервер терминирует сокет за ~10с.
                let _ = write.send(Message::Pong(d)).await;
            }
            Ok(Message::Text(txt)) => {
                let Ok(v) = serde_json::from_str::<Value>(&txt) else { continue };
                let msg_t = v.get("t").and_then(|x| x.as_str());
                // Д5: ICE-серверы из welcome для probe-приёмника.
                if msg_t == Some("welcome") {
                    if let Some(arr) = v.get("iceServers").and_then(|x| x.as_array()) { ice_servers = arr.clone(); }
                    continue;
                }
                // Д5: preflight-probe замера upload вещателя. probe-start будит приёмник (ждём
                // offer), probe-offer поднимает answerer (дропает трек), probe-ice — трикл.
                if msg_t == Some("probe-start") { continue; }
                if msg_t == Some("probe-offer") {
                    probes.retain(|_, (_, born)| born.elapsed() < Duration::from_secs(20)); // прун протухших
                    let (Some(from), Some(sdp)) = (
                        v.get("from").and_then(|x| x.as_str()),
                        v.get("sdp").and_then(|x| x.as_str()),
                    ) else { continue };
                    match probe::answer(sdp.to_string(), &ice_servers, from.to_string(), out_tx.clone()).await {
                        Ok((answer_sdp, sess)) => {
                            let ans = json!({ "t": "probe-answer", "to": from, "sdp": answer_sdp });
                            if write.send(Message::Text(ans.to_string().into())).await.is_err() { break; }
                            if let Some((old, _)) = probes.insert(from.to_string(), (sess, Instant::now())) { old.close().await; }
                            log::info!("control: probe-сессия для {from}");
                        }
                        Err(e) => log::warn!("control: probe answer для {from} не удался: {e}"),
                    }
                    continue;
                }
                if msg_t == Some("probe-ice") {
                    if let (Some(from), Some(cand)) = (v.get("from").and_then(|x| x.as_str()), v.get("candidate")) {
                        if let Some((sess, _)) = probes.get(from) { sess.add_ice(cand.clone()).await; }
                    }
                    continue;
                }
                // Д2 (dev): поднять/погасить транскод-рендишн поверх активной ingest-сессии.
                if msg_t == Some("vrelay-rendition-start") || msg_t == Some("vrelay-rendition-stop") {
                    let Some(stream_id) = v.get("streamId").and_then(|x| x.as_str()) else { continue };
                    let rendition = v.get("rendition").and_then(|x| x.as_str()).unwrap_or("480").to_string();
                    let server_id = v.get("serverId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    if msg_t == Some("vrelay-rendition-start") {
                        let bitrate = v.get("presetBitrate").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
                        // Д4: отказ (кап VRELAY_MAX_TRANSCODES / нет ingest / ffmpeg не поднялся) —
                        // сообщаем серверу vrelay-rendition-failed, тот снимет рендишн и скажет
                        // зрителям (сервер главный, агент подчиняется).
                        if let Err(reason) = rendition_start(cfg, streams, renditions, stream_id, &rendition, bitrate, server_id).await {
                            let failed = json!({ "t": "vrelay-rendition-failed", "streamId": stream_id, "rendition": rendition, "reason": reason });
                            let _ = write.send(Message::Text(failed.to_string().into())).await;
                        }
                    } else {
                        rendition_stop(streams, renditions, stream_id, &rendition).await;
                    }
                    continue;
                }
                // vrelay-activate (Э9): fallback-сессия — гаснет по idle, без реконнекта.
                // vrelay-ingest (Д1 server-first): ПОСТОЯННЫЙ медиаузел — без idle-exit,
                // переживает обрыв WS (реконнект+реджойн). Завершается по vrelay-release/stream-end.
                let (kind, persistent) = match msg_t {
                    Some("vrelay-activate") => ("activate", false),
                    Some("vrelay-ingest") => ("ingest", true),
                    _ => continue,
                };
                let Some(stream_id) = v.get("streamId").and_then(|x| x.as_str()) else { continue };
                let server_id = v.get("serverId").and_then(|x| x.as_str()).unwrap_or("").to_string();
                log::info!("control: {kind} {stream_id}");
                activate(cfg, streams, renditions, stream_id, server_id, persistent).await;
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
        } // m = read.next()
      } // tokio::select!
    } // loop
    // Д5: закрываем оставшиеся probe-PC при выходе из control-цикла (обрыв WS/реконнект).
    for (_, (sess, _)) in probes.drain() { sess.close().await; }
    Ok(())
}

/// Поднимает relay-сессию для дерева, если её ещё нет и лимит не выбран.
/// `persistent` (Д1 ingest): постоянный медиаузел — без idle-exit, с реконнектом WS.
/// Иначе (Э9 activate): fallback-сессия — гаснет по idle, без реконнекта (агент
/// переактивируется по следующему vrelay-activate).
async fn activate(cfg: &Arc<Cfg>, streams: &Streams, renditions: &Renditions, stream_id: &str, server_id: String, persistent: bool) {
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
        quality: "source".into(), // Д3: vrelay-ingest садится в source-дерево (`::source`)
        pinned: false,
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
    // активация того же дерева снова пройдёт. Д2: заодно гасим все рендишн-корни этого
    // стрима (их транскоды жили на этой ingest-сессии).
    let streams = streams.clone();
    let renditions = renditions.clone();
    let sid = stream_id.to_string();
    tokio::spawn(async move {
        fin.notified().await;
        streams.lock().await.remove(&sid);
        let prefix = format!("{sid}::");
        let mut rmap = renditions.lock().await;
        let dead: Vec<String> = rmap.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
        for k in dead {
            if let Some(h) = rmap.remove(&k) { h.stop(); log::info!("rendition {k}: снят вслед за ingest-сессией"); }
        }
        drop(rmap);
        log::info!("stream {sid}: сессия завершена");
    });
}

/// Д4: поднимает транскод-рендишн на активной ingest-сессии (ЛОКАЛЬНЫЙ канал: транскод читает
/// видео-RTP уже принятой ingest-сессии, второго upstream к вещателю нет) + отдельный
/// рендишн-корень, раздающий его зрителям в дереве `streamId::rendition`. Дедуп по ключу
/// (второй зритель того же рендишна НЕ порождает второй ffmpeg). Err = отказ (кап/нет ingest).
async fn rendition_start(cfg: &Arc<Cfg>, streams: &Streams, renditions: &Renditions, stream_id: &str, rendition: &str, bitrate: u32, server_id: String) -> Result<(), String> {
    let key = format!("{stream_id}::{rendition}");
    if renditions.lock().await.contains_key(&key) {
        log::info!("rendition {key}: уже поднят"); // дедуп: второй зритель НЕ порождает второй ffmpeg
        return Ok(());
    }
    let ingest = streams.lock().await.get(stream_id).cloned();
    let Some(ingest) = ingest else {
        log::warn!("rendition {key}: нет активной ingest-сессии для {stream_id} — рендишн невозможен");
        return Err("no-ingest".into());
    };
    let bitrate = if bitrate > 0 { bitrate } else { transcode::rendition_default_bitrate(rendition) };
    let (video, audio) = match ingest.start_rendition(rendition.to_string(), bitrate).await {
        Ok(t) => t,
        Err(e) => { log::warn!("rendition {key}: транскод не поднялся: {e}"); return Err(e); }
    };
    let root = relay::start_rendition_root(RelayConfig {
        // Д3: составной ключ дерева формирует СЕРВЕР из base streamId + quality. Раньше (Д2) клеили
        // `::rendition` в сам stream_id — теперь шлём базовый id и quality=rendition отдельно, сервер
        // ставит корня в дерево `stream_id::rendition` (унифицировано с онлайн-зрителями рендишна).
        stream_id: stream_id.to_string(),
        quality: rendition.to_string(),
        ws_url: format!("{}?token={}", cfg.ws_url, mint_token(&cfg.session_secret)),
        identity: format!("vrelay-{rendition}"),
        server_id,
        max_children: cfg.max_children,
        virtual_relay: false, // рендишн-корень = обычный натив-broadcaster (см. start_rendition_root)
        pinned: false,
        available_outgoing: cfg.available_outgoing,
        idle_exit: None,
        reconnect: false, // рендишн-корень эфемерен: гасится вручную/вслед за ingest
    }, video, audio);
    let fin = root.finished();
    renditions.lock().await.insert(key.clone(), root);
    log::info!("rendition {key}: поднят (транскод {bitrate} bps + рендишн-корень)");
    // Рендишн-корень сам завершился (release/stream-end) — чистим карту и гасим транскод.
    let renditions = renditions.clone();
    let ingest2 = ingest.clone();
    let rnd = rendition.to_string();
    let key2 = key.clone();
    tokio::spawn(async move {
        fin.notified().await;
        if renditions.lock().await.remove(&key2).is_some() {
            ingest2.stop_rendition(rnd);
            log::info!("rendition {key2}: рендишн-корень завершён — транскод снят");
        }
    });
    Ok(())
}

/// Д4: гасит рендишн-корень + его транскод на ingest-сессии (по vrelay-rendition-stop).
async fn rendition_stop(streams: &Streams, renditions: &Renditions, stream_id: &str, rendition: &str) {
    let key = format!("{stream_id}::{rendition}");
    if let Some(h) = renditions.lock().await.remove(&key) {
        h.stop();
    }
    if let Some(ingest) = streams.lock().await.get(stream_id).cloned() {
        ingest.stop_rendition(rendition.to_string());
    }
    log::info!("rendition {key}: остановлен (dev)");
}

/// Парсит /proc/net/snmp — пару строк `Udp: <заголовки>` / `Udp: <значения>` — и достаёт
/// счётчик по имени столбца. Формат: две строки с префиксом `Udp:`, первая — имена, вторая —
/// числа в том же порядке. None, если столбца нет или файл иной формы. Ungated (тест идёт и
/// на dev-Windows); используется только linux-монитором ниже.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_udp_snmp(contents: &str, field: &str) -> Option<u64> {
    let mut header: Option<Vec<&str>> = None;
    for line in contents.lines() {
        let Some(rest) = line.strip_prefix("Udp:") else { continue };
        let cols: Vec<&str> = rest.split_whitespace().collect();
        match header.take() {
            None => header = Some(cols), // первая Udp:-строка — имена столбцов
            Some(names) => {
                let idx = names.iter().position(|&n| n == field)?;
                return cols.get(idx).and_then(|v| v.parse().ok());
            }
        }
    }
    None
}

/// Мониторит UdpRcvbufErrors/SndbufErrors хоста (диаг 2026-07-11: единственная улика серверных
/// дропов входящего/исходящего UDP при переполнении сокет-буфера — транскод/фанаут душат CPU).
/// vrelay в docker с network_mode: host → /proc/net/snmp = хостовые счётчики без доп. маунтов.
/// Дельта > 0 → warn; baseline раз в 5 мин как признак жизни. Только Linux (прод-VPS).
#[cfg(target_os = "linux")]
fn spawn_udp_monitor() {
    tokio::spawn(async move {
        let mut prev_rcv: Option<u64> = None;
        let mut prev_snd: Option<u64> = None;
        let mut ticks = 0u64;
        let mut interval = tokio::time::interval(Duration::from_secs(10));
        loop {
            interval.tick().await;
            let Ok(snmp) = tokio::fs::read_to_string("/proc/net/snmp").await else { continue };
            let rcv = parse_udp_snmp(&snmp, "RcvbufErrors");
            let snd = parse_udp_snmp(&snmp, "SndbufErrors");
            let d_rcv = match (prev_rcv, rcv) { (Some(p), Some(c)) => c.saturating_sub(p), _ => 0 };
            let d_snd = match (prev_snd, snd) { (Some(p), Some(c)) => c.saturating_sub(p), _ => 0 };
            prev_rcv = rcv.or(prev_rcv);
            prev_snd = snd.or(prev_snd);
            ticks += 1;
            if d_rcv > 0 || d_snd > 0 {
                log::warn!(
                    "[host] UdpRcvbufErrors +{d_rcv} (всего {}), SndbufErrors +{d_snd} (всего {}) — ядро дропает UDP: транскод/фанаут душат CPU",
                    rcv.unwrap_or(0), snd.unwrap_or(0),
                );
            } else if ticks % 30 == 0 { // раз в 5 мин
                log::info!("[host] UDP-буферы чисты (Rcvbuf {}, Sndbuf {})", rcv.unwrap_or(0), snd.unwrap_or(0));
            }
        }
    });
}

#[cfg(not(target_os = "linux"))]
fn spawn_udp_monitor() {} // dev на Windows/macOS — /proc/net/snmp нет

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let cfg = match Cfg::from_env() {
        Ok(c) => Arc::new(c),
        Err(e) => { eprintln!("vrelay: {e}"); std::process::exit(1); }
    };
    let streams: Streams = Arc::new(Mutex::new(HashMap::new()));
    let renditions: Renditions = Arc::new(Mutex::new(HashMap::new()));
    spawn_udp_monitor();

    let mut backoff = 1u64;
    loop {
        let res = run_control(&cfg, &streams, &renditions).await;
        match &res {
            Ok(()) => { backoff = 1; log::warn!("control: соединение закрыто — реконнект через {backoff}с"); }
            Err(e) => log::warn!("control: {e} — реконнект через {backoff}с"),
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(backoff)) => {}
            _ = tokio::signal::ctrl_c() => {
                log::info!("SIGINT — останавливаю {} сессий, {} рендишнов", streams.lock().await.len(), renditions.lock().await.len());
                for (_, h) in renditions.lock().await.drain() { h.stop(); }
                for (_, h) in streams.lock().await.drain() { h.stop(); }
                return;
            }
        }
        backoff = (backoff * 2).min(30);
    }
}

#[cfg(test)]
mod tests {
    use super::parse_udp_snmp;

    // Реальная форма /proc/net/snmp (усечённая): две Udp:-строки, имена и значения.
    const SNMP: &str = "\
Udp: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors IgnoredMulti
Udp: 123456 12 0 654321 66138 42 0 0
UdpLite: InDatagrams NoPorts InErrors OutDatagrams RcvbufErrors SndbufErrors InCsumErrors
UdpLite: 0 0 0 0 0 0 0";

    #[test]
    fn parses_rcvbuf_errors() {
        assert_eq!(parse_udp_snmp(SNMP, "RcvbufErrors"), Some(66138));
        assert_eq!(parse_udp_snmp(SNMP, "SndbufErrors"), Some(42));
        assert_eq!(parse_udp_snmp(SNMP, "InErrors"), Some(0));
    }

    #[test]
    fn missing_field_is_none() {
        assert_eq!(parse_udp_snmp(SNMP, "NoSuchColumn"), None);
        assert_eq!(parse_udp_snmp("", "RcvbufErrors"), None);
        // Только заголовок без значений — тоже None (position найдена, но строки значений нет).
        assert_eq!(parse_udp_snmp("Udp: RcvbufErrors\n", "RcvbufErrors"), None);
    }

    // UdpLite-строки не должны спутаться с Udp: (префикс strip точный, "Udp:" != "UdpLite:").
    #[test]
    fn udplite_not_confused() {
        let only_lite = "UdpLite: RcvbufErrors\nUdpLite: 999";
        assert_eq!(parse_udp_snmp(only_lite, "RcvbufErrors"), None);
    }
}
