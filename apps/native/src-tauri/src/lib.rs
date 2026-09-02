// IPC bridge stub UI<->Rust; expanded в Э5 (broadcast::* — захват/энкодер/webrtc-дерево).
// pub — нужен examples/broadcast_smoke.rs (e2e-смоук без Tauri/webview/UI).
pub mod broadcast;
mod branding;
pub mod diag;
mod hotkeys;
mod hwinfo;
mod native_auth;

use std::collections::HashMap;
use tauri::Manager;
use tokio::sync::Mutex;
use windows::core::{w, PCWSTR};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

#[tauri::command]
fn ping() -> &'static str {
  "pong"
}

// Open web links through the operating system instead of navigating the app webview.
// Validate again at the IPC boundary because renderer-side checks are not a security boundary.
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
  let normalized = url.trim();
  let lower = normalized.to_ascii_lowercase();
  if normalized.len() > 8192
    || normalized.chars().any(|c| c.is_control() || c.is_whitespace())
    || !(lower.starts_with("https://") || lower.starts_with("http://"))
  {
    return Err("unsupported external URL".into());
  }
  let authority = normalized
    .split_once("://")
    .map(|(_, rest)| rest)
    .unwrap_or("")
    .split(|c| c == '/' || c == '?' || c == '#')
    .next()
    .unwrap_or("");
  if authority.is_empty() || authority.contains('@') {
    return Err("invalid external URL".into());
  }
  // ShellExecuteW resolves the registered HTTP(S) handler, so the URL opens in the
  // user's default browser. explorer.exe is not a URL-launching API and can instead
  // open a regular File Explorer window on some Windows configurations.
  let wide_url: Vec<u16> = normalized.encode_utf16().chain(std::iter::once(0)).collect();
  let result = unsafe {
    ShellExecuteW(
      None,
      w!("open"),
      PCWSTR(wide_url.as_ptr()),
      PCWSTR::null(),
      PCWSTR::null(),
      SW_SHOWNORMAL,
    )
  };
  let code = result.0 as isize;
  if code > 32 {
    Ok(())
  } else {
    Err(format!("failed to open external URL (ShellExecuteW code {code})"))
  }
}

#[derive(serde::Serialize)]
struct MonitorInfo { index: usize, name: String }

#[tauri::command]
fn list_monitors() -> Vec<MonitorInfo> {
  broadcast::list_monitors().into_iter().map(|(index, name)| MonitorInfo { index, name }).collect()
}

#[derive(serde::Serialize)]
struct WindowInfo { hwnd: isize, title: String, process: String, pid: u32, icon: Option<String> }

#[tauri::command]
fn list_windows() -> Vec<WindowInfo> {
  // Иконка приложения (PNG base64) для каждого окна — показывается в пикере источника.
  // WM_GETICON/иконка класса быстрые; медленный фолбэк на exe (SHGetFileInfo) редок.
  broadcast::list_windows().into_iter()
    .map(|(hwnd, title, process, pid)| WindowInfo { hwnd, title, process, pid, icon: broadcast::icon::window_icon_png_base64(hwnd, pid) })
    .collect()
}

#[derive(serde::Serialize)]
struct GameInfo { name: String, icon: Option<String> }

// Детект игры (Discord-style «играет в X»): foreground-фуллскрин-окно, не из блоклиста.
// Имя — заголовок окна (у игр обычно человекочитаемый), фолбэк — имя exe. Иконка — PNG base64
// (переиспользуем icon.rs, тот же путь, что для стрим-пикера). Только метаданные окна/exe: НЕ
// читаем память игры и не инжектим → безопасно для анти-читов.
fn game_info_from(hwnd: isize, title: &str, stem: &str, pid: u32) -> GameInfo {
  let t = title.trim();
  let name: String = if t.is_empty() {
    let mut c = stem.chars();
    match c.next() { Some(f) => f.to_uppercase().collect::<String>() + c.as_str(), None => String::new() }
  } else {
    t.chars().take(48).collect()
  };
  GameInfo { name, icon: broadcast::icon::window_icon_png_base64(hwnd, pid) }
}

// Имя без расширения (для человекочитаемого фолбэка имени, если title пуст).
fn exe_stem(process: &str) -> String {
  let e = process.to_lowercase();
  e.strip_suffix(".exe").unwrap_or(e.as_str()).to_string()
}

// Веб фетчит /api/detectable-games (сервер дистиллирует список Discord) и передаёт сюда — главный
// позитивный аллоулист для детекта (тысячи игр, точно, без ложных срабатываний фуллскрин-эвристики).
#[tauri::command]
fn set_detectable_games(games: Vec<broadcast::games::GameEntry>) {
  broadcast::games::set_detectable(games);
}

// Детект игры (Discord-style «играет в X») — ДВА позитивных аллоулиста, без фуллскрин-эвристики:
//   1) Discord detectable-list — запущенный процесс сматчен по суффиксу пути exe (games.rs, тысячи игр).
//   2) GameConfigStore — полный путь exe окна ∈ списке игр, реально запускавшихся на этой машине (Windows).
// Фуллскрин-фолбэк УБРАН: ловил не-игры (полноэкранное видео/приложения) → «лишние программы».
// Только метаданные окна/exe/процесса: НЕ читаем память игры и не инжектим → безопасно для анти-читов.
#[tauri::command]
fn detect_game() -> Option<GameInfo> {
  let me_pid = std::process::id(); // свой процесс — окна/процессы RelayApp игрой не считаем

  // 1) Discord-аллоулист: любой ЗАПУЩЕННЫЙ процесс = известная игра. Ловит в любом режиме (окно/фуллскрин/фон).
  if let Some((name, pid)) = broadcast::games::match_running_game(me_pid) {
    // нет иконки (не извлеклась / генерик Windows) → игру не показываем нигде (решение пользователя)
    return broadcast::icon::window_icon_png_base64(0, pid)
      .map(|icon| GameInfo { name: name.chars().take(48).collect(), icon: Some(icon) });
  }

  // 2) GameConfigStore: окно, чей полный путь exe Windows сама признала игрой. foreground первым
  //    (если смотрим именно на игру), затем все окна (фоновая/alt-tab игра из списка).
  let allow = broadcast::games::game_exe_allowlist();
  if !allow.is_empty() {
    let mut cands: Vec<(isize, String, String, u32)> = Vec::new();
    if let Some(fg) = broadcast::capture::foreground_window() { cands.push(fg); }
    cands.extend(broadcast::capture::all_windows());
    let mut checked: std::collections::HashMap<u32, bool> = std::collections::HashMap::new();
    for (hwnd, title, process, pid) in cands {
      if pid == me_pid { continue; }
      let is_game = *checked.entry(pid).or_insert_with(|| {
        broadcast::capture::process_full_path(pid).map_or(false, |p| allow.contains(&p.to_lowercase()))
      });
      if is_game {
        let gi = game_info_from(hwnd, &title, &exe_stem(&process), pid);
        if gi.icon.is_some() { return Some(gi); }
        continue; // генерик/пустая иконка — этого кандидата пропускаем, ищем окно с настоящей иконкой
      }
    }
  }
  None
}

// Foreground-приложение фуллскрин (игра)? notify не показывает окно-карточку поверх — иначе Windows
// свернёт exclusive-fullscreen игру. Звук уведомления при этом всё равно играет (см. notify.ts).
#[tauri::command]
fn foreground_fullscreen() -> bool {
  broadcast::capture::foreground_is_fullscreen()
}

struct BroadcastState(Mutex<Option<broadcast::BroadcastHandle>>);
// Грид: до WATCH_MAX (кап держит JS engine) одновременных watch-слотов, ключ — stream_id.
// Раньше был один Option-слот (один просмотр за раз); теперь каждый стрим грида — свой RelayHandle,
// а команды answer/ice/reparent маршрутизируются по stream_id (relay-core уже тегирует свои webview-события).
struct NativeWatchSlot {
  generation: u64,
  handle: broadcast::relay::RelayHandle,
}

#[derive(Default)]
struct NativeWatchRegistry {
  slots: HashMap<String, NativeWatchSlot>,
  // Per-stream tombstone/owner fence. A stop which wins while start_watch is awaiting auth must
  // still reject that delayed start instead of letting it resurrect a Rust relay slot afterwards.
  latest_generation: HashMap<String, u64>,
}

struct WatchState(Mutex<NativeWatchRegistry>);

#[derive(Clone, Copy)]
enum NativeWatchStartStatus {
  Started,
  Unauthorized,
  SignalingClosed,
  Failed,
}

fn emit_native_watch_status(
  app: &tauri::AppHandle,
  stream_id: &str,
  generation: u64,
  status: NativeWatchStartStatus,
) {
  use tauri::Emitter;
  // Exhaustive local enums are the only source of wire strings. Never forward a native auth error,
  // URL, token or other transport detail through this renderer-facing event.
  let (outcome, code) = match status {
    NativeWatchStartStatus::Started => ("started", "none"),
    NativeWatchStartStatus::Unauthorized => ("failed", "signaling_unauthorized"),
    NativeWatchStartStatus::SignalingClosed => ("failed", "signaling_closed"),
    NativeWatchStartStatus::Failed => ("failed", "native_start_failed"),
  };
  let _ = app.emit("relay-watch-status", serde_json::json!({
    "streamId": stream_id,
    "generation": generation,
    "stage": "watch_native_start",
    "outcome": outcome,
    "code": code,
  }));
}

fn native_watch_generation_is_newer(
  registry: &NativeWatchRegistry,
  stream_id: &str,
  generation: u64,
) -> bool {
  generation > registry.latest_generation.get(stream_id).copied().unwrap_or(0)
}

fn claim_native_watch_generation(
  registry: &mut NativeWatchRegistry,
  stream_id: &str,
  generation: u64,
) -> bool {
  if !native_watch_generation_is_newer(registry, stream_id, generation) { return false; }
  registry.latest_generation.insert(stream_id.to_string(), generation);
  true
}

fn fence_native_watch_generation(
  registry: &mut NativeWatchRegistry,
  stream_id: &str,
  generation: u64,
) {
  let latest = registry.latest_generation.entry(stream_id.to_string()).or_insert(0);
  *latest = (*latest).max(generation);
}

fn validated_native_tree_url(raw: &str) -> Result<(reqwest::Url, String), String> {
  let mut url = reqwest::Url::parse(raw).map_err(|_| "Некорректный адрес медиасервера".to_string())?;
  let host = url.host_str().unwrap_or("");
  // Keep production stricter than URL-parser equivalence. In particular an explicitly supplied
  // default port, encoded path or alternative spelling must not silently become an auth-capable
  // origin after normalization.
  let raw_base = raw.split_once('?').map_or(raw, |(base, _)| base);
  let prod = raw_base == "wss://reelay.online/tree"
    && url.scheme() == "wss" && host == "reelay.online" && url.port().is_none();
  #[cfg(debug_assertions)]
  let debug_loopback = url.scheme() == "ws"
    && matches!(host, "127.0.0.1" | "localhost") && url.port().is_some();
  #[cfg(not(debug_assertions))]
  let debug_loopback = false;
  if (!prod && !debug_loopback)
    || url.path() != "/tree" || url.username() != "" || url.password().is_some()
    || url.fragment().is_some()
  {
    return Err("Адрес медиасервера не разрешён".into());
  }
  let query: Vec<(String, String)> = url.query_pairs()
    .map(|(key, value)| (key.into_owned(), value.into_owned())).collect();
  if query.len() != 1 || query[0].0 != "token" || query[0].1.is_empty() {
    return Err("Некорректная авторизация медиасервера".into());
  }
  let token = query[0].1.clone();
  url.set_query(None);
  Ok((url, token))
}

fn tree_url_with_token(base: &reqwest::Url, token: &str) -> String {
  let mut url = base.clone();
  url.query_pairs_mut().append_pair("token", token);
  url.to_string()
}

fn native_tree_url_error(error: &native_auth::NativeAuthError) -> broadcast::signaling::WsUrlError {
  let (code, terminal) = error.tree_refresh_failure();
  if terminal {
    broadcast::signaling::WsUrlError::terminal(code)
  } else {
    broadcast::signaling::WsUrlError::transient(code)
  }
}

async fn native_tree_ws_url(
  app: tauri::AppHandle,
  renderer_url: String,
) -> Result<broadcast::signaling::WsUrl, String> {
  let (base, _renderer_token) = validated_native_tree_url(&renderer_url)?;
  // Eager refresh/cache check makes a terminal logout/revocation visible to the initiating UI
  // instead of starting capture/watch and failing later in a background reconnect loop.
  let initial_token = app.state::<native_auth::NativeAuthState>()
    .refresh_tree_access_token().await
    .map_err(|error| {
      let (_, terminal) = error.tree_refresh_failure();
      // Opaque, allow-listed IPC markers: do not serialize NativeAuthError (which may contain an
      // upstream message/details) into an ordinary media command error.
      if terminal { "TREE_AUTH_TERMINAL".to_string() }
      else { "TREE_AUTH_TRANSIENT".to_string() }
    })?;
  let initial_url = tree_url_with_token(&base, &initial_token);
  let first = std::sync::Arc::new(std::sync::Mutex::new(Some(initial_url)));
  let first_get = first.clone();
  let get_app = app.clone();
  let get_base = base.clone();
  let invalidate_app = app;
  Ok(broadcast::signaling::WsUrl::dynamic_async_with_invalidator(move || {
    let first_get = first_get.clone();
    let get_app = get_app.clone();
    let get_base = get_base.clone();
    async move {
      // The eager URL is consumed exactly once. Later attempts share NativeAuthState's cache and
      // rotate only inside its 30-second expiry skew, never once per watch/reconnect.
      let initial = {
        let mut first = first_get.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        first.take()
      };
      if let Some(url) = initial {
        return Ok(url);
      }
      let token = get_app.state::<native_auth::NativeAuthState>()
        .refresh_tree_access_token().await.map_err(|error| native_tree_url_error(&error))?;
      Ok(tree_url_with_token(&get_base, &token))
    }
  }, move |rejected_url| {
    // Parse through the same exact-origin allow-list, then compare-and-clear only that access JWT.
    if let Ok((_base, rejected_token)) = validated_native_tree_url(rejected_url) {
      invalidate_app.state::<native_auth::NativeAuthState>()
        .invalidate_rejected_tree_access(&rejected_token);
    }
  }))
}

#[cfg(test)]
mod native_tree_auth_tests {
  use super::{
    claim_native_watch_generation, fence_native_watch_generation,
    native_watch_generation_is_newer, tree_url_with_token, validated_native_tree_url,
    NativeWatchRegistry,
  };

  #[test]
  fn production_tree_origin_is_exact_and_renderer_token_is_discarded() {
    let (base, renderer_token) = validated_native_tree_url(
      "wss://reelay.online/tree?token=renderer-old",
    ).unwrap();
    assert_eq!(renderer_token, "renderer-old");
    assert_eq!(base.as_str(), "wss://reelay.online/tree");

    let refreshed = tree_url_with_token(&base, "fresh access/+?=");
    let parsed = reqwest::Url::parse(&refreshed).unwrap();
    let pairs: Vec<_> = parsed.query_pairs().collect();
    assert_eq!(pairs.len(), 1);
    assert_eq!(pairs[0].0, "token");
    assert_eq!(pairs[0].1, "fresh access/+?=");
    assert!(!refreshed.contains("renderer-old"));
  }

  #[test]
  fn production_tree_origin_rejects_every_credential_smuggling_variant() {
    for rejected in [
      "ws://reelay.online/tree?token=x",
      "wss://reelay.online:443/tree?token=x",
      "wss://reelay.online.evil/tree?token=x",
      "wss://user@reelay.online/tree?token=x",
      "wss://reelay.online/tree/?token=x",
      "wss://reelay.online/%74ree?token=x",
      "wss://reelay.online/tree#fragment?token=x",
      "wss://reelay.online/tree",
      "wss://reelay.online/tree?token=",
      "wss://reelay.online/tree?token=x&extra=y",
      "wss://reelay.online/tree?token=x&token=y",
    ] {
      assert!(validated_native_tree_url(rejected).is_err(), "unexpectedly allowed {rejected}");
    }
  }

  #[cfg(debug_assertions)]
  #[test]
  fn debug_tree_origin_allows_only_explicit_loopback_port_and_exact_path() {
    assert!(validated_native_tree_url("ws://127.0.0.1:4000/tree?token=x").is_ok());
    assert!(validated_native_tree_url("ws://localhost:4000/tree?token=x").is_ok());
    assert!(validated_native_tree_url("ws://127.0.0.1/tree?token=x").is_err());
    assert!(validated_native_tree_url("ws://0.0.0.0:4000/tree?token=x").is_err());
    assert!(validated_native_tree_url("ws://localhost:4000/tree/extra?token=x").is_err());
  }

  #[test]
  fn cancelled_or_out_of_order_native_watch_start_cannot_resurrect_a_slot() {
    let mut registry = NativeWatchRegistry::default();
    assert!(native_watch_generation_is_newer(&registry, "stream", 1));

    // stop(1) wins while start(1) is awaiting auth: the delayed completion must be rejected.
    fence_native_watch_generation(&mut registry, "stream", 1);
    assert!(!claim_native_watch_generation(&mut registry, "stream", 1));

    // A newer quality/watch owner may start, and neither the old completion nor old stop can move
    // its generation fence backwards.
    assert!(claim_native_watch_generation(&mut registry, "stream", 2));
    fence_native_watch_generation(&mut registry, "stream", 1);
    assert!(!claim_native_watch_generation(&mut registry, "stream", 1));
    assert!(!claim_native_watch_generation(&mut registry, "stream", 2));
    assert!(claim_native_watch_generation(&mut registry, "stream", 3));
  }
}

#[tauri::command]
async fn start_broadcast(
  app: tauri::AppHandle,
  state: tauri::State<'_, BroadcastState>,
  stream_id: String,
  ws_url: String,
  identity: String,
  server_id: String,
  source: broadcast::CaptureSource,
  max_width: u32,
  max_height: u32,
  fps: u32,
  bitrate_bps: u32,
  auto_bitrate: Option<bool>,
  audio_target_pid: Option<u32>,
  max_direct_children: Option<u32>,
  // Roadmap-flow-стриминга Д5: режим пресета ('smooth'|'quality'|'manual'). Пресет-режимы
  // отключают клиентскую QualityLadder (адаптация зрителей — через серверные рендишны Д4).
  preset_mode: Option<String>,
) -> Result<(), String> {
  let signalling = native_tree_ws_url(app.clone(), ws_url).await?;
  let mut slot = state.0.lock().await;
  if let Some(h) = slot.as_ref() {
    if h.is_alive() {
      return Err("уже вещаем".into());
    }
    // Предыдущая трансляция умерла сама (фатальный отказ энкодера/захвата) —
    // фронт узнаёт об этом асинхронно и чистит стейт fire-and-forget
    // (см. ServerView.tsx onBroadcastStopped), так что здесь можем догнать её
    // раньше, чем тот вызов долетит: подчищаем зомби-хэндл сами, не отказываем.
    if let Some(old) = slot.take() {
      old.stop().await;
    }
  }
  // Лог этой сессии — с нуля: хвост предыдущей только раздувает выгрузку на сервер.
  diag::reset();
  let auto = auto_bitrate.unwrap_or(true);
  // Д5: лестница качества (смена fps/разрешения на set-bitrate) — ТОЛЬКО в ручном авто-битрейте.
  // Пресет-режимы ('smooth'/'quality') и server-first+CBR гасят её: адаптация зрителей идёт
  // через серверные рендишны (Д4). Гейт роадмапа: !manual ИЛИ !abr → выключить.
  let manual = preset_mode.as_deref().unwrap_or("manual") == "manual";
  let config = broadcast::StreamConfig {
    max_width: max_width.clamp(320, 3840),
    max_height: max_height.clamp(180, 2160),
    fps: fps.clamp(5, 60),
    bitrate_bps: bitrate_bps.clamp(500_000, 20_000_000),
    auto_bitrate: auto,
    audio_source: match audio_target_pid {
      Some(pid) => broadcast::AudioSource::IncludeProcess(pid),
      None => broadcast::AudioSource::ExcludeSelfViaInclude,
    },
    max_direct_children: max_direct_children.unwrap_or(4).clamp(1, 10),
    ladder_enabled: manual && auto,
  };
  let handle = broadcast::start(Some(app), stream_id, signalling, identity, server_id, source, config).await?;
  *slot = Some(handle);
  Ok(())
}

// Э8: нативный relay-viewer. Rust держит upstream к родителю в дереве, ретранслирует детям
// (passthrough) и показывает поток в этом webview через IPC (события relay-watch-offer/-ice,
// команды watch_answer/watch_ice). Грид: до WATCH_MAX watch-слотов разом (ключ stream_id, кап в JS engine).
#[tauri::command]
async fn start_watch(
  app: tauri::AppHandle,
  state: tauri::State<'_, WatchState>,
  stream_id: String,
  generation: u64,
  ws_url: String,
  identity: String,
  server_id: String,
  max_children: Option<u32>,
  quality: Option<String>,
  pinned: Option<bool>,
  available_outgoing: Option<u32>,
) -> Result<(), String> {
  if generation == 0 { return Err("Некорректное поколение просмотра".into()); }
  {
    let registry = state.0.lock().await;
    if !native_watch_generation_is_newer(&registry, &stream_id, generation) {
      return Ok(()); // cancelled/replaced before this command reached the auth gate
    }
  }
  emit_native_watch_status(&app, &stream_id, generation, NativeWatchStartStatus::Started);
  let signalling = match native_tree_ws_url(app.clone(), ws_url).await {
    Ok(signalling) => signalling,
    Err(error) => {
      let status = match error.as_str() {
        "TREE_AUTH_TERMINAL" => NativeWatchStartStatus::Unauthorized,
        "TREE_AUTH_TRANSIENT" => NativeWatchStartStatus::SignalingClosed,
        _ => NativeWatchStartStatus::Failed,
      };
      emit_native_watch_status(&app, &stream_id, generation, status);
      return Err(error);
    }
  };
  let key = stream_id.clone();
  let mut registry = state.0.lock().await;
  if !claim_native_watch_generation(&mut registry, &key, generation) {
    return Ok(()); // stop/newer start won while protected refresh was in flight
  }
  // Ре-watch того же стрима (смена качества/реконнект) — гасим прежний слот этого же ключа,
  // ЧУЖИЕ слоты грида не трогаем.
  if let Some(old) = registry.slots.remove(&key) { old.handle.stop(); }
  // Буфер диага один на процесс — сбрасываем только на ПЕРВЫЙ watch грида, иначе открытие
  // второй плитки затёрло бы лог первой (см. start_broadcast).
  if registry.slots.is_empty() { diag::reset(); }
  // UiSink: relay-ядро (relay-core) не знает про Tauri — события webview (relay-watch-offer/
  // -ice, relay-topology) уходят через колбэк-обёртку над app.emit.
  let ui_app = app;
  let ui: broadcast::relay::UiSink = {
    use tauri::Emitter;
    std::sync::Arc::new(move |evt: &str, mut payload: serde_json::Value| {
      if let Some(object) = payload.as_object_mut() {
        object.insert("generation".into(), serde_json::Value::from(generation));
      }
      let _ = ui_app.emit(evt, payload);
    })
  };
  let handle = broadcast::relay::start(Some(ui), broadcast::relay::RelayConfig {
    stream_id, identity, server_id,
    // Every reconnect resolves a shared, cached short-lived access JWT through NativeAuthState.
    ws_url: signalling,
    max_children: max_children.unwrap_or(4).clamp(0, 10),
    virtual_relay: false,
    // Д3: рендишн, который смотрит зритель (`streamId::quality`). Дефолт "source" — старый
    // JS-бандл без поля = source (обратная совместимость).
    quality: quality.unwrap_or_else(|| "source".into()),
    // Д4: ручной выбор качества (pin) — сервер не двигает такого зрителя авто-ABR.
    pinned: pinned.unwrap_or(false),
    // Roadmap-flow-стриминга Д6: реальный upload зрителя (из Д5-probe-кэша webview, передан из
    // JS). БОЛЬШЕ НЕ фейковые 8 Мбит: webrtc-rs BWE незрел (webrtc-ice 0.17 отдаёт
    // available_outgoing_bitrate=0.0), поэтому источник истины — Chromium-GCC-probe из webview.
    // 0 = не измерен → сервер даёт консервативную ёмкость 1 (не раздуваем ветвление на фейке).
    available_outgoing: available_outgoing.unwrap_or(0),
    idle_exit: None, // натив смотрит стрим сам — уходим только по Stop
    reconnect: true, // рестарт сервера (деплой) не рвёт просмотр
  });
  registry.slots.insert(key, NativeWatchSlot { generation, handle });
  Ok(())
}

#[tauri::command]
async fn stop_watch(
  state: tauri::State<'_, WatchState>,
  stream_id: String,
  generation: Option<u64>,
) -> Result<(), String> {
  let mut registry = state.0.lock().await;
  let requested = generation.unwrap_or_else(|| {
    registry.slots.get(&stream_id).map(|slot| slot.generation).unwrap_or(1)
  });
  fence_native_watch_generation(&mut registry, &stream_id, requested);
  if registry.slots.get(&stream_id).is_some_and(|slot| slot.generation == requested) {
    if let Some(slot) = registry.slots.remove(&stream_id) { slot.handle.stop(); }
  }
  Ok(())
}

// Ответ webview на локальный offer relay-показа (см. relay-watch-offer). Маршрут по stream_id —
// у грида несколько активных relay-слотов, answer относится к конкретному.
#[tauri::command]
async fn watch_answer(state: tauri::State<'_, WatchState>, stream_id: String, generation: u64, sdp: String) -> Result<(), String> {
  if let Some(slot) = state.0.lock().await.slots.get(&stream_id).filter(|slot| slot.generation == generation) {
    slot.handle.webview_answer(sdp);
  }
  Ok(())
}

#[tauri::command]
async fn watch_ice(state: tauri::State<'_, WatchState>, stream_id: String, generation: u64, candidate: serde_json::Value) -> Result<(), String> {
  if let Some(slot) = state.0.lock().await.slots.get(&stream_id).filter(|slot| slot.generation == generation) {
    slot.handle.webview_ice(candidate);
  }
  Ok(())
}

// Э8: ручной выбор пира зрителем из UI дерева (target=Some) или авто-миграция (target=None).
#[tauri::command]
async fn watch_reparent(state: tauri::State<'_, WatchState>, stream_id: String, generation: u64, target: Option<String>) -> Result<(), String> {
  if let Some(slot) = state.0.lock().await.slots.get(&stream_id).filter(|slot| slot.generation == generation) {
    slot.handle.request_reparent(target);
  }
  Ok(())
}

// Э5.3: смена источника видео (и звука) на лету — без остановки трансляции, дерево
// зрителей и WebRTC-треки живут дальше. audio_target_pid маппится как в start_broadcast.
#[tauri::command]
async fn set_broadcast_source(
  state: tauri::State<'_, BroadcastState>,
  source: broadcast::CaptureSource,
  audio_target_pid: Option<u32>,
) -> Result<(), String> {
  let slot = state.0.lock().await;
  let h = slot.as_ref().ok_or("не вещаем")?;
  h.set_source(source, match audio_target_pid {
    Some(pid) => broadcast::AudioSource::IncludeProcess(pid),
    None => broadcast::AudioSource::ExcludeSelfViaInclude,
  }).await
}

// Настройки -> «Настройка клавиш»: (пере)регистрирует глобальный WH_KEYBOARD_LL-хук с
// актуальными биндами. Вызывается фронтом при старте и на каждое изменение keybinds/
// disableGlobalHotkeys (см. App.tsx). enabled=false — хук матчит пустые комбо, мут
// глобально не срабатывает (in-app хендлер берёт клавиши на себя, пока окно в фокусе).
#[tauri::command]
async fn set_global_hotkeys(app: tauri::AppHandle, mute_mic: Vec<String>, deafen: Vec<String>, enabled: bool) -> Result<(), String> {
  hotkeys::set_hotkeys(app, mute_mic, deafen, enabled);
  Ok(())
}

#[tauri::command]
async fn stop_broadcast(state: tauri::State<'_, BroadcastState>) -> Result<(), String> {
  let handle = state.0.lock().await.take();
  if let Some(h) = handle {
    h.stop().await;
  }
  Ok(())
}

// Интервал превью-тумбнейла (мс, 0 = выкл) для виджета вещателя. Пишет в общий atomic
// (capture-сессии читают на кадре). No-op, если не вещаем. Виджет: 3000 (развёрнут),
// 1000 (hover), 0 (свёрнут/размонтирован) — тумбнейл не считается зря.
#[tauri::command]
async fn set_preview_interval(state: tauri::State<'_, BroadcastState>, ms: u32) -> Result<(), String> {
  if let Some(h) = state.0.lock().await.as_ref() { h.set_preview_interval(ms); }
  Ok(())
}

// Журнал "Загрузки": открыть/показать в папке/проверить наличие ранее сохранённого вложения.
// Через explorer.exe (не Win32 ShellExecuteW/tauri-plugin-shell) — без новых зависимостей и
// без ACL-прав (std::process::Command не гейтится capabilities). explorer.exe <path> открывает
// файл ассоциированной программой (то же, что двойной клик), explorer.exe /select,<path>
// выделяет файл в проводнике — оба варианта не ждём (spawn, не output/wait): код возврата
// explorer часто ненулевой даже при успехе, ориентируемся только на факт запуска процесса.

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
  std::process::Command::new("explorer").arg(&path).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
  std::process::Command::new("explorer").args(["/select,", &path]).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn paths_exist(paths: Vec<String>) -> Vec<bool> {
  paths.iter().map(|p| std::path::Path::new(p).exists()).collect()
}

// Первый запуск: главное окно создаётся из tauri.conf.json в ЛОГИЧЕСКИХ px (1280×800). На дисплеях
// с масштабом 125–150% это 1600×1000+ ФИЗИЧЕСКИХ — окно не влезает в рабочую область монитора и его
// низ уходит под панель задач («окно ниже экрана», приходится вправлять вручную). Подгоняем размер
// под rcWork (рабочая область без панели задач) и центрируем; если размер уже помещается — лишь
// вправляем позицию целиком внутрь рабочей области, иначе окно не трогаем. Позиция не персистится
// (нет tauri-plugin-window-state), поэтому это безопасно на каждом запуске — своего выбора у юзера нет.
#[cfg(windows)]
fn fit_window_to_work_area(window: &tauri::WebviewWindow) {
  use windows::Win32::Foundation::{HWND, RECT};
  use windows::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
  };
  let Ok(hwnd_raw) = window.hwnd() else { return };
  let Ok(outer) = window.outer_size() else { return };
  let pos = window.outer_position().unwrap_or_default();
  unsafe {
    // Свой HWND из указателя (не переиспользуем tauri-шный тип — версия крейта windows может отличаться).
    let hwnd = HWND(hwnd_raw.0 as *mut std::ffi::c_void);
    let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    if !GetMonitorInfoW(mon, &mut mi).as_bool() {
      return;
    }
    let RECT { left, top, right, bottom } = mi.rcWork; // рабочая область в ФИЗИЧЕСКИХ px, координаты экрана
    let work_w = (right - left).max(1);
    let work_h = (bottom - top).max(1);
    let margin = 16; // небольшой зазор от краёв рабочей области
    let max_w = (work_w - margin * 2).max(1) as u32;
    let max_h = (work_h - margin * 2).max(1) as u32;
    let final_w = outer.width.min(max_w);
    let final_h = outer.height.min(max_h);
    let resized = final_w != outer.width || final_h != outer.height;
    if resized {
      let _ = window.set_size(tauri::PhysicalSize::new(final_w, final_h));
    }
    let (nx, ny) = if resized {
      // после ресайза центрируем в рабочей области
      (left + (work_w - final_w as i32) / 2, top + (work_h - final_h as i32) / 2)
    } else {
      // размер помещается — только вправляем окно целиком внутрь рабочей области, если оно вылезло
      (
        pos.x.clamp(left, (right - final_w as i32).max(left)),
        pos.y.clamp(top, (bottom - final_h as i32).max(top)),
      )
    };
    if resized || nx != pos.x || ny != pos.y {
      let _ = window.set_position(tauri::PhysicalPosition::new(nx, ny));
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    // Полноэкранная игра НЕ сворачивает наше окно, поэтому document.hidden в webview остаётся false и
    // visibilitychange не приходит вовсе: фронт продолжал крутить анимации и rAF-циклы, отбирая кадры
    // у игры на переднем плане. Единственный надёжный сигнал в этой ситуации — потеря фокуса окна;
    // на window.blur внутри WebView2 полагаться нельзя, поэтому сообщаем о нём явно.
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::Focused(focused) = event {
        use tauri::Emitter;
        let _ = window.emit("relay-window-focus", *focused);
      }
    })
    .manage(BroadcastState(Mutex::new(None)))
    .manage(WatchState(Mutex::new(NativeWatchRegistry::default())))
    .manage(native_auth::NativeAuthState::new().expect("failed to initialize native auth broker"))
    .setup(|app| {
      // Раньше висело за cfg!(debug_assertions) — в релизном билде (то, что реально
      // ставят и тестируют) log::info!/warn!/error! по всему broadcast:: были
      // молчаливым no-op: логгер вообще не регистрировался. Из "5 попыток стартовать"
      // и "падает через секунду" нельзя было понять причину без пересборки в dev-режиме.
      // Теперь плагин всегда активен — пишет в app_log_dir (см. tauri::path::app_log_dir,
      // обычно %LOCALAPPDATA%\com.relayapp.desktop\logs\*.log) плюс stdout, если запущен
      // из консоли.
      // Дефолт плагина — 40 КБ на файл + RotationStrategy::KeepOne: это ~3 минуты
      // вещания, после чего предыдущий кусок ВЫБРАСЫВАЕТСЯ. Разбор лагов захвата под
      // игрой (строки `capture:`/`timing:` раз в 2с) требует всей сессии, а не её
      // последних минут — интересное как раз в начале, когда игра стартовала.
      // 5 МБ + KeepAll: сессия целиком, старые файлы остаются рядом.
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          // webrtc_srtp::session печатает КАЖДЫЙ отбракованный пакет на INFO
          // (`srtp ssrc=… index=…: duplicated`) — до 620 строк/с на лоссовом линке.
          // Кольцевой буфер diag (20k строк / 2 МБ) выжирался за 20 секунд: в сессии
          // зрителя artem161 от 2026-08-02 из 6346 строк 6302 были этим спамом, и окно
          // лога составило 26с из 1238с просмотра — форензики по нативному зрителю не
          // оставалось вовсе. Причину дублей чинит link::tree_setting_engine, но и после
          // неё поштучный лог отбраковки на INFO не нужен.
          .level_for("webrtc_srtp", log::LevelFilter::Warn)
          .max_file_size(5_000_000)
          .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
          // Дублируем те же строки в кольцевой буфер сессии (diag.rs): фронтенд сдаёт
          // их на сервер по окончании стрима/просмотра. Дефолтные Stdout/LogDir остаются.
          .target(diag::log_target())
          .build(),
      )?;
      // Первый запуск на HiDPI: окно из конфига не влезает в рабочую область → низ под панелью задач.
      // Подгоняем и центрируем по монитору окна (см. fit_window_to_work_area). До первой отрисовки.
      #[cfg(windows)]
      {
        use tauri::Manager;
        if let Some(win) = app.get_webview_window("main") {
          fit_window_to_work_area(&win);
        }
      }
      // Самолечение ярлыков (см. branding.rs) — на отдельном потоке, не блокируя старт окна.
      std::thread::spawn(branding::fix_shortcuts);
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![ping, open_external_url, list_monitors, list_windows, detect_game, foreground_fullscreen, set_detectable_games, start_broadcast, set_broadcast_source, stop_broadcast, set_preview_interval, start_watch, stop_watch, watch_answer, watch_ice, watch_reparent, set_global_hotkeys, open_file, reveal_in_folder, paths_exist, diag::diag_take_log, hwinfo::diag_hw, native_auth::native_auth_resume, native_auth::native_auth_refresh, native_auth::native_auth_login, native_auth::native_auth_register_verify, native_auth::native_auth_email_verify, native_auth::native_auth_password_change, native_auth::native_auth_begin_logout, native_auth::native_auth_drain_logout])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
