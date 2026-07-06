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
    Topology { payload: Value },               // снимок дерева для UI (relay пробрасывает в webview)
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
}

/// Поднимает ws-соединение и держит его в отдельной tokio-задаче. Возвращает канал
/// команд (на отправку) и канал событий (на приём) — остальной код не трогает
/// сериализацию протокола напрямую.
pub fn connect(ws_url: String, join: JoinParams) -> (mpsc::UnboundedSender<TreeCmd>, mpsc::UnboundedReceiver<TreeEvent>) {
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<TreeCmd>();
    let (evt_tx, evt_rx) = mpsc::unbounded_channel::<TreeEvent>();

    tokio::spawn(async move {
        let (ws_stream, _) = match tokio_tungstenite::connect_async(&ws_url).await {
            Ok(v) => v,
            Err(e) => {
                log::error!("tree ws connect failed: {e}");
                let _ = evt_tx.send(TreeEvent::Closed);
                return;
            }
        };
        let (mut write, mut read) = ws_stream.split();

        let stream_id = join.stream_id.clone();
        let join_msg = json!({
            "t": "join",
            "streamId": join.stream_id,
            "role": join.role,
            "native": join.native,
            "maxChildren": join.max_children,
            "identity": join.identity,
            "serverId": join.server_id,
        });
        if write.send(Message::Text(join_msg.to_string().into())).await.is_err() {
            let _ = evt_tx.send(TreeEvent::Closed);
            return;
        }

        loop {
            tokio::select! {
                incoming = read.next() => {
                    match incoming {
                        Some(Ok(Message::Text(txt))) => {
                            if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                                if let Some(evt) = parse_event(&v) {
                                    if evt_tx.send(evt).is_err() { break; }
                                }
                            }
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
                            break;
                        }
                        None => break,
                    }
                }
            }
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
        "tree-topology" => Some(TreeEvent::Topology { payload: v.clone() }),
        _ => None,
    }
}
