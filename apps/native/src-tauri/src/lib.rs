// IPC bridge stub UI<->Rust; expanded в Э5 (broadcast::* — захват/энкодер/webrtc-дерево).
// pub — нужен examples/broadcast_smoke.rs (e2e-смоук без Tauri/webview/UI).
pub mod broadcast;
mod branding;
pub mod diag;
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
// Блоклист для ЭВРИСТИКИ-ФОЛБЭКА (шаг 2 detect_game). Позитивный аллоулист (games.rs) первичен;
// сюда падают только полноэкранные foreground-окна ВНЕ списка игр Windows, и тут отсекается всё, что
// на весь экран, но игрой не является. Расширен медиаплеерами/конференциями/удалёнкой/обоями —
// именно они дают полноэкранные ложняки, которые прежний узкий список пропускал.
const GAME_BLOCK: &[&str] = &[
  // наш апп / браузеры / IDE / лаунчеры / шелл
  "relayapp", "explorer", "chrome", "firefox", "msedge", "brave", "opera", "vivaldi",
  "yandex", "arc", "zen", "chromium", "librewolf", "waterfox", "thorium", "msedgewebview2",
  "code", "devenv", "rider64", "idea64", "pycharm64", "sublime_text", "discord",
  "steam", "steamwebhelper", "epicgameslauncher", "battlenet", "spotify", "telegram",
  "whatsapp", "obs64", "obs", "notepad", "cmd", "powershell", "windowsterminal", "wt",
  "taskmgr", "searchhost", "searchapp", "startmenuexperiencehost", "shellexperiencehost",
  "applicationframehost", "textinputhost", "dwm", "sihost", "systemsettings", "lockapp",
  // медиаплееры (полноэкранное видео ≠ игра)
  "vlc", "mpc-hc64", "mpc-hc", "mpc-be64", "mpv", "potplayermini64", "potplayer",
  "kodi", "plex", "plexmediaplayer", "jellyfinmediaplayer", "wmplayer", "smplayer",
  // конференции / удалёнка / стриминг рабочего стола
  "zoom", "ms-teams", "teams", "msteams", "webex", "skype", "mstsc", "parsecd", "parsec",
  "moonlight", "anydesk", "teamviewer", "rustdesk", "sunshine",
  // офис / просмотр документов
  "powerpnt", "soffice", "sumatrapdf", "acrobat", "acrord32",
  // обои / оверлеи
  "wallpaper32", "wallpaper64", "wallpaperengine", "livelywpf", "lively",
];

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

// Фолбэк-эвристика: имя exe годится в «игру», если НЕ в блоклисте.
fn allowed_game(process: &str) -> Option<String> {
  let stem = exe_stem(process);
  if stem.is_empty() || GAME_BLOCK.contains(&stem.as_str()) { None } else { Some(stem) }
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
  // Roadmap-flow-стриминга Д5: режим пресета ('smooth'|'quality'|'manual'). Пресет-режимы
  // отключают клиентскую QualityLadder (адаптация зрителей — через серверные рендишны Д4).
  preset_mode: Option<String>,
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
  quality: Option<String>,
  pinned: Option<bool>,
  available_outgoing: Option<u32>,
) -> Result<(), String> {
  let mut slot = state.0.lock().await;
  if let Some(old) = slot.take() { old.stop(); }
  diag::reset(); // см. start_broadcast
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
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
      // Дефолт плагина — 40 КБ на файл + RotationStrategy::KeepOne: это ~3 минуты
      // вещания, после чего предыдущий кусок ВЫБРАСЫВАЕТСЯ. Разбор лагов захвата под
      // игрой (строки `capture:`/`timing:` раз в 2с) требует всей сессии, а не её
      // последних минут — интересное как раз в начале, когда игра стартовала.
      // 5 МБ + KeepAll: сессия целиком, старые файлы остаются рядом.
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .max_file_size(5_000_000)
          .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
          // Дублируем те же строки в кольцевой буфер сессии (diag.rs): фронтенд сдаёт
          // их на сервер по окончании стрима/просмотра. Дефолтные Stdout/LogDir остаются.
          .target(diag::log_target())
          .build(),
      )?;
      // Самолечение ярлыков (см. branding.rs) — на отдельном потоке, не блокируя старт окна.
      std::thread::spawn(branding::fix_shortcuts);
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![ping, list_monitors, list_windows, detect_game, foreground_fullscreen, set_detectable_games, start_broadcast, set_broadcast_source, stop_broadcast, set_preview_interval, start_watch, stop_watch, watch_answer, watch_ice, watch_reparent, set_global_hotkeys, open_file, reveal_in_folder, paths_exist, diag::diag_take_log])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
