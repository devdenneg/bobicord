// IPC bridge stub UI<->Rust; expanded в Э5 (broadcast::* — захват/энкодер/webrtc-дерево).
// pub — нужен examples/broadcast_smoke.rs (e2e-смоук без Tauri/webview/UI).
pub mod broadcast;

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
struct WindowInfo { hwnd: isize, title: String, process: String }

#[tauri::command]
fn list_windows() -> Vec<WindowInfo> {
  broadcast::list_windows().into_iter().map(|(hwnd, title, process)| WindowInfo { hwnd, title, process }).collect()
}

struct BroadcastState(Mutex<Option<broadcast::BroadcastHandle>>);

#[tauri::command]
async fn start_broadcast(
  app: tauri::AppHandle,
  state: tauri::State<'_, BroadcastState>,
  stream_id: String,
  ws_url: String,
  identity: String,
  source: broadcast::CaptureSource,
  max_width: u32,
  max_height: u32,
  fps: u32,
  bitrate_bps: u32,
) -> Result<(), String> {
  let mut slot = state.0.lock().await;
  if slot.is_some() {
    return Err("уже вещаем".into());
  }
  let config = broadcast::StreamConfig {
    max_width: max_width.clamp(320, 3840),
    max_height: max_height.clamp(180, 2160),
    fps: fps.clamp(5, 60),
    bitrate_bps: bitrate_bps.clamp(500_000, 20_000_000),
  };
  let handle = broadcast::start(Some(app), stream_id, ws_url, identity, source, config).await?;
  *slot = Some(handle);
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
    .manage(BroadcastState(Mutex::new(None)))
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![ping, list_monitors, list_windows, start_broadcast, stop_broadcast])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
