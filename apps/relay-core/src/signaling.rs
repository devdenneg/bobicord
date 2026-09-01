// WS-клиент дерева (Evolution-TZ Э5/Э8) — протокол `apps/server/tree.js` на стороне
// нативного узла. Роль broadcaster (корень: offerer детям) ИЛИ viewer (relay: answerer
// родителю, offerer детям). Формат сообщений — см. tree.js.

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;
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
    /// Д3: рендишн-дерево (`streamId::quality`). Дефолт "source" (вещатель и обычный зритель).
    /// Нет поля → сервер трактует как "source" (обратная совместимость со старым бандлом).
    pub quality: String,
    /// Д1 (server-first): вещатель сигналит серверу, что стрим идёт «через сервер»
    /// (стример → сервер → зрители). Шлёт ТОЛЬКО натив-вещатель; сервер включает
    /// server-first-режим лишь при своём TREE_SERVER_FIRST=1. relay-viewer/vrelay — false.
    pub server_ingest: bool,
    /// Имя стримящегося приложения (окна) — только broadcaster, зрителям уходит в stream-live.
    pub app_name: Option<String>,
    /// Иконка приложения: PNG 32×32 base64 (без data-URI-префикса), 1-3 КБ.
    pub app_icon: Option<String>,
    /// Д4: выходное разрешение вещателя (натив знает своё) — сервер режет лестницу рендишнов
    /// сверху (без апскейла). Только broadcaster source-дерева; viewer/vrelay/рендишн-корень — 0.
    pub width: u32,
    pub height: u32,
    /// Д4: зритель закрепил (pin) качество вручную — авто-ABR его не трогает. Переживает
    /// пересоздание watch-сокета (смена качества = unwatch+watch). broadcaster/vrelay — false.
    pub pinned: bool,
}

const RECONNECT_BACKOFF_MAX_SEC: u64 = 15; // деплой рестартит сервер за секунды — догоняем быстро

/// Нет НИ ОДНОГО сообщения от сервера столько — считаем сокет полуоткрытым и реконнектимся.
/// tree.js пингует каждые 10с (HEARTBEAT_MS) и терминирует нас, если pong не пришёл, — то есть
/// на живом сокете входящий трафик обязан быть. Полуоткрытый TCP (NAT выбросил маппинг, хост
/// пропал) читателю не приходит НИКАК: `read.next()` просто висит вечно, и узел молча выпадает
/// из дерева, считая себя подключённым. 35с = 3 пропущенных пинга.
const READ_IDLE_TIMEOUT_SEC: u64 = 35;

/// Источник URL сигналинга. Токен лежит в query и может потребовать асинхронного обновления перед
/// каждой попыткой: service-JWT vrelay минтится синхронно, а нативный 15-минутный access JWT —
/// через защищённый refresh broker. Фиксировать короткий JWT на всю медиа-сессию нельзя: первый
/// реконнект после TTL навсегда получает 401.
type WsUrlFuture = Pin<Box<dyn Future<Output = Result<String, WsUrlError>> + Send>>;

/// Opaque, allow-listed URL-provider failure. It deliberately cannot carry a URL, JWT, upstream
/// body or arbitrary error message into logs. Terminal credential state ends the media session;
/// transient network/upstream state follows the normal bounded reconnect backoff.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WsUrlError {
    code: &'static str,
    terminal: bool,
}

impl WsUrlError {
    pub fn transient(code: &'static str) -> Self {
        Self { code: allowlisted_ws_url_error(code, false), terminal: false }
    }
    pub fn terminal(code: &'static str) -> Self {
        Self { code: allowlisted_ws_url_error(code, true), terminal: true }
    }
    fn code(self) -> &'static str { self.code }
    fn is_terminal(self) -> bool { self.terminal }
}

fn allowlisted_ws_url_error(code: &'static str, terminal: bool) -> &'static str {
    match code {
        "native-auth-network" | "native-auth-timeout" | "native-auth-rate-limit"
        | "native-auth-upstream" | "native-auth-session-ended"
        | "native-auth-logout-pending" | "native-auth-storage"
        | "native-auth-invalid-response" => code,
        _ if terminal => "tree-url-terminal",
        _ => "tree-url-transient",
    }
}

fn close_invalidates_access(code: u16) -> bool { code == 4001 }

#[derive(Clone)]
pub struct WsUrl {
    make: Arc<dyn Fn() -> WsUrlFuture + Send + Sync>,
    invalidate: Arc<dyn Fn(&str) + Send + Sync>,
}

impl WsUrl {
    /// URL whose credential is genuinely long-lived for the complete connection lifetime.
    pub fn fixed(url: String) -> Self {
        Self {
            make: Arc::new(move || {
                let current = url.clone();
                Box::pin(async move { Ok(current) })
            }),
            invalidate: Arc::new(|_| {}),
        }
    }

    /// URL пересобирается на каждую попытку (короткоживущий service-токен vrelay).
    pub fn dynamic(make: impl Fn() -> String + Send + Sync + 'static) -> Self {
        Self {
            make: Arc::new(move || {
                let current = make();
                Box::pin(async move { Ok(current) })
            }),
            invalidate: Arc::new(|_| {}),
        }
    }

    /// URL/credential renewal may perform protected I/O (native Credential Manager + auth API).
    pub fn dynamic_async<F, Fut>(make: F) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<String, WsUrlError>> + Send + 'static,
    {
        Self { make: Arc::new(move || Box::pin(make())), invalidate: Arc::new(|_| {}) }
    }

    /// Asynchronous provider with an exact cache invalidator. A 401 from tree signalling calls the
    /// invalidator before retry so a remotely rejected access JWT is renewed immediately.
    pub fn dynamic_async_with_invalidator<F, Fut, I>(make: F, invalidate: I) -> Self
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<String, WsUrlError>> + Send + 'static,
        I: Fn(&str) + Send + Sync + 'static,
    {
        Self { make: Arc::new(move || Box::pin(make())), invalidate: Arc::new(invalidate) }
    }

    async fn get(&self) -> Result<String, WsUrlError> { (self.make)().await }
    fn invalidate(&self, rejected_url: &str) { (self.invalidate)(rejected_url); }
}

impl From<String> for WsUrl {
    fn from(url: String) -> Self {
        Self::fixed(url)
    }
}

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
pub fn connect(ws_url: WsUrl, join: JoinParams, reconnect: bool) -> (mpsc::UnboundedSender<TreeCmd>, mpsc::UnboundedReceiver<TreeEvent>) {
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
            "quality": join.quality,
            "serverIngest": join.server_ingest,
            "identity": join.identity,
            "serverId": join.server_id,
            "appName": join.app_name,
            "appIcon": join.app_icon,
            "width": join.width,
            "height": join.height,
            "pinned": join.pinned,
        });

        let mut connects = 0u32; // сколько раз успешно джойнились (>=1 => дальше Rejoined)
        let mut backoff = 1u64;
        'outer: loop {
            let next_url = match ws_url.get().await {
                Ok(url) => url,
                Err(e) => {
                    log::warn!("tree ws credential refresh failed: {}", e.code());
                    if e.is_terminal() || !reconnect { break 'outer; }
                    if !wait_backoff(&mut cmd_rx, backoff).await { break 'outer; }
                    backoff = (backoff * 2).min(RECONNECT_BACKOFF_MAX_SEC);
                    continue;
                }
            };
            let (ws_stream, _) = match tokio_tungstenite::connect_async(&next_url).await {
                Ok(v) => v,
                Err(error) => {
                    let unauthorized = matches!(&error, tokio_tungstenite::tungstenite::Error::Http(response)
                        if response.status().as_u16() == 401)
                    ;
                    if unauthorized {
                        ws_url.invalidate(&next_url);
                    }
                    // Never format the transport error itself: HTTP/TLS implementations may embed
                    // the request URI, including its access JWT, or an arbitrary upstream body.
                    log::warn!("tree ws connect failed: {}", if unauthorized { "unauthorized" } else { "transport" });
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
            // Дедлайн тишины: сбрасывается ЛЮБЫМ входящим кадром (ping сервера в том числе).
            let mut idle_deadline = tokio::time::Instant::now() + Duration::from_secs(READ_IDLE_TIMEOUT_SEC);
            loop {
                tokio::select! {
                    _ = tokio::time::sleep_until(idle_deadline) => {
                        log::warn!("tree ws: тишина {READ_IDLE_TIMEOUT_SEC}с ({stream_id}) — сокет полуоткрыт, реконнект");
                        break;
                    }
                    incoming = read.next() => {
                        idle_deadline = tokio::time::Instant::now() + Duration::from_secs(READ_IDLE_TIMEOUT_SEC);
                        match incoming {
                            Some(Ok(Message::Text(txt))) => {
                                if let Ok(v) = serde_json::from_str::<Value>(&txt) {
                                    if let Some(evt) = parse_event(&v, &stream_id) {
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
                            Some(Ok(Message::Close(frame))) => {
                                // 4001 is exact auth-session revocation. Invalidate only the access
                                // used by this socket; a delayed close from token A must not erase a
                                // newer token B already shared by another watch/broadcast. 4003 is
                                // membership/server authorization and must not touch global auth.
                                if frame.as_ref().is_some_and(|close| close_invalidates_access(u16::from(close.code))) {
                                    ws_url.invalidate(&next_url);
                                }
                                break;
                            }
                            None => break,
                            Some(Err(_)) => {
                                // As above, transport errors are deliberately opaque because some
                                // backend error strings include the full authenticated request URI.
                                log::warn!("tree ws transport error");
                                break;
                            }
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

fn parse_event(v: &Value, stream_id: &str) -> Option<TreeEvent> {
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
        // Гвардим по streamId: сервер шлёт discovery stream-end broadcast'ом по ВСЕМУ серверу
        // (broadcastToServer) — конец ЛЮБОГО стрима прилетал и в наш relay-сокет и рвал активный
        // watch чужим streamId (баг: «выключение одного стрима реконнектит другой»). Реагируем
        // только на конец СВОЕГО стрима; нет поля (старый сервер) — принимаем как раньше.
        "stream-end" => match v.get("streamId").and_then(|x| x.as_str()) {
            Some(sid) if sid != stream_id => None,
            _ => Some(TreeEvent::StreamEnd),
        },
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Регрессия инцидента 2026-07-30: URL сигналинга собирался ОДИН раз на старте сессии,
    /// поэтому реконнект позже TTL токена (у vrelay 5 минут) вечно получал 401. `dynamic`
    /// обязан звать фабрику на КАЖДОЕ обращение — иначе токен снова замёрзнет.
    #[tokio::test]
    async fn dynamic_url_rebuilt_on_every_attempt() {
        let calls = Arc::new(AtomicU32::new(0));
        let seen = calls.clone();
        let url = WsUrl::dynamic(move || {
            let n = seen.fetch_add(1, Ordering::SeqCst);
            format!("wss://host/tree?token=tok{n}")
        });
        assert_eq!(url.get().await.unwrap(), "wss://host/tree?token=tok0");
        assert_eq!(url.get().await.unwrap(), "wss://host/tree?token=tok1");
        assert_eq!(url.get().await.unwrap(), "wss://host/tree?token=tok2");
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn async_url_renews_access_on_every_reconnect_attempt() {
        let calls = Arc::new(AtomicU32::new(0));
        let seen = calls.clone();
        let url = WsUrl::dynamic_async(move || {
            let n = seen.fetch_add(1, Ordering::SeqCst);
            async move { Ok(format!("wss://host/tree?token=access{n}")) }
        });
        assert_eq!(url.get().await.unwrap(), "wss://host/tree?token=access0");
        assert_eq!(url.get().await.unwrap(), "wss://host/tree?token=access1");
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn async_url_invalidation_replaces_a_rejected_cached_access() {
        let generation = Arc::new(AtomicU32::new(0));
        let read = generation.clone();
        let invalidate = generation.clone();
        let url = WsUrl::dynamic_async_with_invalidator(move || {
            let current = read.load(Ordering::SeqCst);
            async move { Ok(format!("wss://host/tree?token=access{current}")) }
        }, move |rejected| {
            assert_eq!(rejected, "wss://host/tree?token=access0");
            invalidate.fetch_add(1, Ordering::SeqCst);
        });
        assert_eq!(url.get().await.unwrap(), "wss://host/tree?token=access0");
        url.invalidate("wss://host/tree?token=access0");
        assert_eq!(url.get().await.unwrap(), "wss://host/tree?token=access1");
    }

    #[test]
    fn credential_errors_classify_terminal_and_transient_without_payloads() {
        let ended = WsUrlError::terminal("native-auth-session-ended");
        let offline = WsUrlError::transient("native-auth-network");
        assert!(ended.is_terminal());
        assert!(!offline.is_terminal());
        assert_eq!(ended.code(), "native-auth-session-ended");
        assert_eq!(WsUrlError::transient("unexpected-upstream-payload").code(), "tree-url-transient");
        assert_eq!(WsUrlError::terminal("unexpected-upstream-payload").code(), "tree-url-terminal");
    }

    #[test]
    fn only_session_revocation_close_invalidates_global_access() {
        assert!(close_invalidates_access(4001));
        assert!(!close_invalidates_access(4003));
        assert!(!close_invalidates_access(1006));
    }

    #[tokio::test]
    async fn fixed_url_is_stable() {
        let url = WsUrl::fixed("wss://host/tree?token=session".into());
        assert_eq!(url.get().await.unwrap(), url.get().await.unwrap());
        assert_eq!(url.get().await.unwrap(), "wss://host/tree?token=session");
    }
}
