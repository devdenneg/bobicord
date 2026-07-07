// IPC bridge stub UI<->Rust; expanded в Э5 (broadcast::* — захват/энкодер/webrtc-дерево).
// pub — нужен examples/broadcast_smoke.rs (e2e-смоук без Tauri/webview/UI).
pub mod broadcast;
mod branding;
mod hotkeys;

use tokio::sync::Mutex;

#[tauri::command]
fn ping() -> &'static str {
  "pong"
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
#[tauri::command]
fn detect_game() -> Option<GameInfo> {
  let (hwnd, title, process, pid) = broadcast::capture::foreground_game()?;
  let exe = process.to_lowercase();
  let stem = exe.strip_suffix(".exe").unwrap_or(exe.as_str());
  const BLOCK: &[&str] = &[
    "relayapp", "explorer", "chrome", "firefox", "msedge", "brave", "opera", "vivaldi",
    "yandex", "code", "devenv", "rider64", "idea64", "pycharm64", "sublime_text", "discord",
    "steam", "steamwebhelper", "epicgameslauncher", "spotify", "telegram", "whatsapp",
    "obs64", "obs", "notepad", "cmd", "powershell", "windowsterminal", "wt", "taskmgr",
    "searchhost", "searchapp", "startmenuexperiencehost", "shellexperiencehost",
    "applicationframehost", "textinputhost", "dwm", "sihost", "systemsettings", "lockapp",
  ];
  if stem.is_empty() || BLOCK.contains(&stem) {
    return None;
  }
  let t = title.trim();
  let name: String = if t.is_empty() {
    let mut c = stem.chars();
    match c.next() { Some(f) => f.to_uppercase().collect::<String>() + c.as_str(), None => String::new() }
  } else {
    t.chars().take(48).collect()
  };
  Some(GameInfo { name, icon: broadcast::icon::window_icon_png_base64(hwnd, pid) })
}

struct BroadcastState(Mutex<Option<broadcast::BroadcastHandle>>);
struct WatchState(Mutex<Option<broadcast::relay::RelayHandle>>);

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
) -> Result<(), String> {
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
  let config = broadcast::StreamConfig {
    max_width: max_width.clamp(320, 3840),
    max_height: max_height.clamp(180, 2160),
    fps: fps.clamp(5, 60),
    bitrate_bps: bitrate_bps.clamp(500_000, 20_000_000),
    auto_bitrate: auto_bitrate.unwrap_or(true),
    audio_source: match audio_target_pid {
      Some(pid) => broadcast::AudioSource::IncludeProcess(pid),
      None => broadcast::AudioSource::ExcludeSelfViaInclude,
    },
    max_direct_children: max_direct_children.unwrap_or(4).clamp(1, 10),
  };
  let handle = broadcast::start(Some(app), stream_id, ws_url, identity, server_id, source, config).await?;
  *slot = Some(handle);
  Ok(())
}

// Э8: нативный relay-viewer. Rust держит upstream к родителю в дереве, ретранслирует детям
// (passthrough) и показывает поток в этом webview через IPC (события relay-watch-offer/-ice,
// команды watch_answer/watch_ice). Один активный watch за раз (как и broadcast).
#[tauri::command]
async fn start_watch(
  app: tauri::AppHandle,
  state: tauri::State<'_, WatchState>,
  stream_id: String,
  ws_url: String,
  identity: String,
  server_id: String,
  max_children: Option<u32>,
) -> Result<(), String> {
  let mut slot = state.0.lock().await;
  if let Some(old) = slot.take() { old.stop(); }
  // UiSink: relay-ядро (relay-core) не знает про Tauri — события webview (relay-watch-offer/
  // -ice, relay-topology) уходят через колбэк-обёртку над app.emit.
  let ui: broadcast::relay::UiSink = {
    use tauri::Emitter;
    std::sync::Arc::new(move |evt: &str, payload: serde_json::Value| { let _ = app.emit(evt, payload); })
  };
  let handle = broadcast::relay::start(Some(ui), broadcast::relay::RelayConfig {
    stream_id, ws_url, identity, server_id,
    max_children: max_children.unwrap_or(4).clamp(0, 10),
    virtual_relay: false,
    available_outgoing: 8_000_000,
    idle_exit: None, // натив смотрит стрим сам — уходим только по Stop
    reconnect: true, // рестарт сервера (деплой) не рвёт просмотр
  });
  *slot = Some(handle);
  Ok(())
}

#[tauri::command]
async fn stop_watch(state: tauri::State<'_, WatchState>) -> Result<(), String> {
  if let Some(h) = state.0.lock().await.take() { h.stop(); }
  Ok(())
}

// Ответ webview на локальный offer relay-показа (см. relay-watch-offer).
#[tauri::command]
async fn watch_answer(state: tauri::State<'_, WatchState>, sdp: String) -> Result<(), String> {
  if let Some(h) = state.0.lock().await.as_ref() { h.webview_answer(sdp); }
  Ok(())
}

#[tauri::command]
async fn watch_ice(state: tauri::State<'_, WatchState>, candidate: serde_json::Value) -> Result<(), String> {
  if let Some(h) = state.0.lock().await.as_ref() { h.webview_ice(candidate); }
  Ok(())
}

// Э8: ручной выбор пира зрителем из UI дерева (target=Some) или авто-миграция (target=None).
#[tauri::command]
async fn watch_reparent(state: tauri::State<'_, WatchState>, target: Option<String>) -> Result<(), String> {
  if let Some(h) = state.0.lock().await.as_ref() { h.request_reparent(target); }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_notification::init())
    .manage(BroadcastState(Mutex::new(None)))
    .manage(WatchState(Mutex::new(None)))
    .setup(|app| {
      // Раньше висело за cfg!(debug_assertions) — в релизном билде (то, что реально
      // ставят и тестируют) log::info!/warn!/error! по всему broadcast:: были
      // молчаливым no-op: логгер вообще не регистрировался. Из "5 попыток стартовать"
      // и "падает через секунду" нельзя было понять причину без пересборки в dev-режиме.
      // Теперь плагин всегда активен — пишет в app_log_dir (см. tauri::path::app_log_dir,
      // обычно %LOCALAPPDATA%\com.relayapp.desktop\logs\*.log) плюс stdout, если запущен
      // из консоли.
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .build(),
      )?;
      // Самолечение ярлыков (см. branding.rs) — на отдельном потоке, не блокируя старт окна.
      std::thread::spawn(branding::fix_shortcuts);
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![ping, list_monitors, list_windows, detect_game, start_broadcast, set_broadcast_source, stop_broadcast, start_watch, stop_watch, watch_answer, watch_ice, watch_reparent, set_global_hotkeys])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
