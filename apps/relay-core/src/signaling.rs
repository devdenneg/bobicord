// WS-клиент дерева (Evolution-TZ Э5/Э8) — протокол `apps/server/tree.js` на стороне
// нативного узла. Роль broadcaster (корень: offerer детям) ИЛИ viewer (relay: answerer
// родителю, offerer детям). Формат сообщений — см. tree.js.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone)]
pub enum TreeEvent {
    Welcome { ice_servers: Vec<Value> },
    AssignParent { parent_id: Option<String> },
    AssignChild { child_id: String },
    DropPeer { peer_id: String },
    SdpOffer { from: String, sdp: String },   // от родителя (мы viewer — answerer)
    SdpAnswer { from: String, sdp: String },  // от ребёнка (мы offerer)
    Ice { from: String, candidate: Value },
    RequestKeyframe,                           // сервер просит корень форснуть IDR
    SetBitrate { bps: u32 },                   // Э8 ABR: сервер шлёт корню целевой битрейт под худший линк
    Topology { payload: Value },               // снимок дерева для UI (relay пробрасывает в webview)
    Release,                                   // Э9: сервер выселяет виртуальный relay (дренаж/обрушение дерева)
    /// Конец вещания: сервер шлёт в watch-сокеты при обрушении дерева (ушёл вещатель).
    /// Для viewer-relay терминально — teardown, не reconnect.
    StreamEnd,
    /// WS пережил обрыв (рестарт сервера при деплое / сетевой блип): переподключились и
    /// послали join заново. Сервер выдал НОВЫЙ peer-id и пустое состояние — родитель/дети
    /// придут свежими assign-*; старые PC живут (медиа P2P, течёт мимо сервера), пока их
    /// не заменят/не умрут (sweep по Failed/Closed).
    Rejoined,
    Closed,
}

pub enum TreeCmd {
    Offer { to: String, sdp: String },        // мы offerer (корень/relay → ребёнок)
    Answer { to: String, sdp: String },        // мы answerer (relay-viewer → родитель)
    Ice { to: String, candidate: Value },
    Stats { to_child: Vec<Value>, available_outgoing: u32 },
    RequestKeyframe,                           // relay просит keyframe у корня (через сервер)
    RequestReparent { target: Option<String> }, // авто-миграция (None) / ручной выбор пира (Some)
    Leave,
}

/// Параметры join: роль и ёмкость узла.
pub struct JoinParams {
    pub stream_id: String,
    pub identity: String,
    pub server_id: String,
    pub role: &'static str, // "broadcaster" | "viewer"
    pub native: bool,
    pub max_children: u32,
    /// Э8 ABR: потолок битрейта, выбранный вещателем (макс). Сервер держит цель в
    /// [FLOOR, max_bitrate]. У viewer/relay не значим (0).
    pub max_bitrate: u32,
    /// Э8 ABR: авто-адаптация включена. false → сервер не шлёт set-bitrate (статичный битрейт).
    pub abr: bool,
    /// Э9: серверный виртуальный fallback-relay. Сервер верит флагу только при
    /// JWT-uid 'virtual-relay' (tree.js) — обычные клиенты шлют false.
    pub virtual_relay: bool,
    /// Д1 (server-first): вещатель сигналит серверу, что стрим идёт «через сервер»
    /// (стример → сервер → зрители). Шлёт ТОЛЬКО натив-вещатель; сервер включает
    /// server-first-режим лишь при своём TREE_SERVER_FIRST=1. relay-viewer/vrelay — false.
    pub server_ingest: bool,
    /// Имя стримящегося приложения (окна) — только broadcaster, зрителям уходит в stream-live.
    pub app_name: Option<String>,
    /// Иконка приложения: PNG 32×32 base64 (без data-URI-префикса), 1-3 КБ.
    pub app_icon: Option<String>,
}

const RECONNECT_BACKOFF_MAX_SEC: u64 = 15; // деплой рестартит сервер за секунды — догоняем быстро

/// Ожидание перед реконнектом с дренажом команд: unbounded-канал иначе копил бы
/// Stats/Ice (слать некуда — дропаем), а Leave/дроп консьюмера должны завершать задачу.
/// false = пора выходить совсем.
async fn wait_backoff(cmd_rx: &mut mpsc::UnboundedReceiver<TreeCmd>, secs: u64) -> bool {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(secs);
    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return true,
            cmd = cmd_rx.recv() => match cmd {
                None | Some(TreeCmd::Leave) => return false,
                _ => {} // офлайн — команду некуда отправить
            }
        }
    }
}

/// Поднимает ws-соединение и держит его в отдельной tokio-задаче. Возвращает канал
/// команд (на отправку) и канал событий (на приём) — остальной код не трогает
/// сериализацию протокола напрямую.
///
/// `reconnect=true`: обрыв WS (деплой рестартит сервер, сетевой блип) НЕ фатален —
/// переподключаемся с backoff (1..15с, без лимита попыток) и шлём join заново, наверх
/// уходит `TreeEvent::Rejoined`. `Closed` тогда означает только явный Leave/дроп
/// консьюмера. `reconnect=false` — старое поведение (первый обрыв = Closed); нужен
/// vrelay-сессиям: агент сам переактивируется по vrelay-activate.
pub fn connect(ws_url: String, join: JoinParams, reconnect: bool) -> (mpsc::UnboundedSender<TreeCmd>, mpsc::UnboundedReceiver<TreeEvent>) {
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<TreeCmd>();
    let (evt_tx, evt_rx) = mpsc::unbounded_channel::<TreeEvent>();

    tokio::spawn(async move {
        let stream_id = join.stream_id.clone();
        let join_msg = json!({
            "t": "join",
            "streamId": join.stream_id,
            "role": join.role,
            "native": join.native,
            "maxChildren": join.max_children,
            "maxBitrate": join.max_bitrate,
            "abr": join.abr,
            "virtual": join.virtual_relay,
            "serverIngest": join.server_ingest,
            "identity": join.identity,
            "serverId": join.server_id,
            "appName": join.app_name,
            "appIcon": join.app_icon,
        });

        let mut connects = 0u32; // сколько раз успешно джойнились (>=1 => дальше Rejoined)
        let mut backoff = 1u64;
        'outer: loop {
            let (ws_stream, _) = match tokio_tungstenite::connect_async(&ws_url).await {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("tree ws connect failed: {e}");
                    if !reconnect { break 'outer; }
                    if !wait_backoff(&mut cmd_rx, backoff).await { break 'outer; }
                    backoff = (backoff * 2).min(RECONNECT_BACKOFF_MAX_SEC);
                    continue;
                }
            };
            let (mut write, mut read) = ws_stream.split();
            if write.send(Message::Text(join_msg.to_string().into())).await.is_err() {
                if !reconnect { break 'outer; }
                if !wait_backoff(&mut cmd_rx, backoff).await { break 'outer; }
                backoff = (backoff * 2).min(RECONNECT_BACKOFF_MAX_SEC);
                continue;
            }
            if connects > 0 {
                log::warn!("tree ws: переподключение #{connects} — реджойн {stream_id}");
                if evt_tx.send(TreeEvent::Rejoined).is_err() { break 'outer; }
            }
            connects += 1;
            backoff = 1;

            // terminal=true — уходим совсем (Leave / консьюмер пропал); false — обрыв WS.
            let mut terminal = false;
            loop {
                tokio::select! {
                    incoming = read.next() => {
                        match incoming {
                            Some(Ok(Message::Text(txt))) => {
                                if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                                    if let Some(evt) = parse_event(&v) {
                                        if evt_tx.send(evt).is_err() { terminal = true; break; }
                                    }
                                }
                            }
                            Some(Ok(Message::Ping(data))) => {
                                // Сервер шлёт heartbeat-ping (tree.js) и терминирует, если pong не
                                // пришёл. При split-стриме авто-pong tungstenite ненадёжен — отвечаем
                                // явно, иначе нативное вещание/relay рвалось бы каждые ~20с.
                                let _ = write.send(Message::Pong(data)).await;
                            }
                            Some(Ok(Message::Close(_))) | None => break,
                            Some(Err(e)) => { log::warn!("tree ws error: {e}"); break; }
                            _ => {}
                        }
                    }
                    cmd = cmd_rx.recv() => {
                        match cmd {
                            Some(TreeCmd::Offer { to, sdp }) => {
                                let msg = json!({ "t": "sdp", "streamId": stream_id, "to": to, "type": "offer", "sdp": sdp });
                                if write.send(Message::Text(msg.to_string().into())).await.is_err() { break; }
                            }
                            Some(TreeCmd::Answer { to, sdp }) => {
                                let msg = json!({ "t": "sdp", "streamId": stream_id, "to": to, "type": "answer", "sdp": sdp });
                                if write.send(Message::Text(msg.to_string().into())).await.is_err() { break; }
                            }
                            Some(TreeCmd::Ice { to, candidate }) => {
                                let msg = json!({ "t": "ice", "streamId": stream_id, "to": to, "candidate": candidate });
                                if write.send(Message::Text(msg.to_string().into())).await.is_err() { break; }
                            }
                            Some(TreeCmd::Stats { to_child, available_outgoing }) => {
                                let msg = json!({ "t": "stats", "streamId": stream_id, "toChild": to_child, "availableOutgoing": available_outgoing });
                                let _ = write.send(Message::Text(msg.to_string().into())).await;
                            }
                            Some(TreeCmd::RequestKeyframe) => {
                                let msg = json!({ "t": "request-keyframe", "streamId": stream_id });
                                let _ = write.send(Message::Text(msg.to_string().into())).await;
                            }
                            Some(TreeCmd::RequestReparent { target }) => {
                                let msg = json!({ "t": "request-reparent", "streamId": stream_id, "targetParentId": target });
                                let _ = write.send(Message::Text(msg.to_string().into())).await;
                            }
                            Some(TreeCmd::Leave) => {
                                let _ = write.send(Message::Text(json!({"t":"leave"}).to_string().into())).await;
                                terminal = true;
                                break;
                            }
                            None => { terminal = true; break; }
                        }
                    }
                }
            }
            if terminal || !reconnect { break 'outer; }
            log::warn!("tree ws оборвался ({stream_id}) — реконнект через {backoff}с (медиа-PC живут)");
            if !wait_backoff(&mut cmd_rx, backoff).await { break 'outer; }
            backoff = (backoff * 2).min(RECONNECT_BACKOFF_MAX_SEC);
        }
        let _ = evt_tx.send(TreeEvent::Closed);
    });

    (cmd_tx, evt_rx)
}

fn parse_event(v: &Value) -> Option<TreeEvent> {
    match v.get("t")?.as_str()? {
        "welcome" => Some(TreeEvent::Welcome {
            ice_servers: v.get("iceServers").and_then(|x| x.as_array()).cloned().unwrap_or_default(),
        }),
        "assign-parent" => Some(TreeEvent::AssignParent {
            parent_id: v.get("parentId").and_then(|x| x.as_str()).map(|s| s.to_string()),
        }),
        "assign-child" => Some(TreeEvent::AssignChild { child_id: v.get("childId")?.as_str()?.to_string() }),
        "drop-peer" => Some(TreeEvent::DropPeer { peer_id: v.get("peerId")?.as_str()?.to_string() }),
        "sdp" => {
            let ty = v.get("type")?.as_str()?;
            let from = v.get("from")?.as_str()?.to_string();
            let sdp = v.get("sdp")?.as_str()?.to_string();
            match ty {
                "offer" => Some(TreeEvent::SdpOffer { from, sdp }),
                "answer" => Some(TreeEvent::SdpAnswer { from, sdp }),
                _ => None,
            }
        }
        "ice" => Some(TreeEvent::Ice {
            from: v.get("from")?.as_str()?.to_string(),
            candidate: v.get("candidate")?.clone(),
        }),
        "request-keyframe" => Some(TreeEvent::RequestKeyframe),
        "set-bitrate" => Some(TreeEvent::SetBitrate { bps: v.get("bps")?.as_u64()? as u32 }),
        "tree-topology" => Some(TreeEvent::Topology { payload: v.clone() }),
        "vrelay-release" => Some(TreeEvent::Release),
        "stream-end" => Some(TreeEvent::StreamEnd),
        _ => None,
    }
}
