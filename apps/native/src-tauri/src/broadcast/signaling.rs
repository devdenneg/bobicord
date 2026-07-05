// WS-клиент дерева (Evolution-TZ Э5) — реализует протокол `apps/server/tree.js`
// на стороне нативного вещателя (корень: role=broadcaster, native=true).
// Формат сообщений — см. tree.js (join/assign-child/sdp/ice/drop-peer/stats).

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

#[derive(Debug, Clone)]
pub enum TreeEvent {
    Welcome { ice_servers: Vec<Value> },
    AssignChild { child_id: String },
    DropPeer { peer_id: String },
    SdpAnswer { from: String, sdp: String },
    Ice { from: String, candidate: Value },
    Closed,
}

pub enum TreeCmd {
    Offer { to: String, sdp: String },
    Ice { to: String, candidate: Value },
    Stats { to_child: Vec<Value>, available_outgoing: u32 },
    Leave,
}

/// Поднимает ws-соединение и держит его в отдельной tokio-задаче. Возвращает
/// канал команд (на отправку) и канал событий (на приём) — остальной код
/// (`peer.rs`) не трогает сериализацию протокола напрямую.
pub fn connect(ws_url: String, stream_id: String, identity: String) -> (mpsc::UnboundedSender<TreeCmd>, mpsc::UnboundedReceiver<TreeEvent>) {
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

        let join_msg = json!({
            "t": "join",
            "streamId": stream_id,
            "role": "broadcaster",
            "native": true,
            "identity": identity,
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
                        Some(TreeCmd::Ice { to, candidate }) => {
                            let msg = json!({ "t": "ice", "streamId": stream_id, "to": to, "candidate": candidate });
                            if write.send(Message::Text(msg.to_string().into())).await.is_err() { break; }
                        }
                        Some(TreeCmd::Stats { to_child, available_outgoing }) => {
                            let msg = json!({ "t": "stats", "streamId": stream_id, "toChild": to_child, "availableOutgoing": available_outgoing });
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
        "assign-child" => Some(TreeEvent::AssignChild { child_id: v.get("childId")?.as_str()?.to_string() }),
        "drop-peer" => Some(TreeEvent::DropPeer { peer_id: v.get("peerId")?.as_str()?.to_string() }),
        "sdp" if v.get("type")?.as_str()? == "answer" => Some(TreeEvent::SdpAnswer {
            from: v.get("from")?.as_str()?.to_string(),
            sdp: v.get("sdp")?.as_str()?.to_string(),
        }),
        "ice" => Some(TreeEvent::Ice {
            from: v.get("from")?.as_str()?.to_string(),
            candidate: v.get("candidate")?.clone(),
        }),
        _ => None,
    }
}
