//! Позитивный аллоулист игр (Discord-подход, но локально и без сети): читаем
//! HKCU\System\GameConfigStore\Children\<GUID>\MatchedExeFullPath — собственный список Windows тех
//! приложений, которые Game Bar / GameDVR сопоставил с РЕАЛЬНО запускавшейся игрой на ЭТОЙ машине.
//!
//! Зачем: прежний детект был БЛОКЛИСТ («всё, чего нет в списке не-игр = игра») → ловил практически
//! каждое окно. Стиль-/геометрия-тесты не отличают игру от полноэкранного видео/презентации/RDP —
//! те тоже borderless и на весь монитор. А MatchedExeFullPath — позитивный сигнал near-zero
//! false-positive: если полный путь exe окна-кандидата есть в этом наборе, это ТОЧНО игра. Читается из
//! реестра (без сети, без чтения памяти игры → анти-чит-безопасно), кэшируется (GameConfigStore
//! меняется редко — не дёргаем реестр на каждый poll детекта, ~раз в 10с).
//!
//! Ограничение (false-negative): сюда попадают только игры, прошедшие через GameDVR/Game Bar. Никогда
//! не запускавшиеся / с выключенным GameDVR игры отсутствуют — поэтому это ПОЗИТИВНЫЙ сигнал (уверенно
//! подтверждает игру), а не единственный; за играми вне списка остаётся эвристика-фолбэк в lib.rs.

use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

// Кэш аллоулиста: реестр читаем не чаще TTL. Mutex::new(None) — const-fn, годится для static.
static CACHE: Mutex<Option<(Instant, HashSet<String>)>> = Mutex::new(None);
const TTL: Duration = Duration::from_secs(30);

/// Множество lowercased полных путей exe, которые Windows признала играми (MatchedExeFullPath).
/// Пусто, если GameConfigStore недоступен — тогда детект падает на эвристику-фолбэк (lib.rs).
pub fn game_exe_allowlist() -> HashSet<String> {
    if let Some((at, set)) = CACHE.lock().unwrap().as_ref() {
        if at.elapsed() < TTL {
            return set.clone();
        }
    }
    let set = read_gameconfigstore();
    *CACHE.lock().unwrap() = Some((Instant::now(), set.clone()));
    set
}

fn read_gameconfigstore() -> HashSet<String> {
    let mut out = HashSet::new();
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let children = match hkcu.open_subkey(r"System\GameConfigStore\Children") {
        Ok(k) => k,
        Err(_) => return out, // ключа нет (нет распознанных игр / политика) — пустой аллоулист
    };
    for name in children.enum_keys().flatten() {
        if let Ok(child) = children.open_subkey(&name) {
            // MatchedExeFullPath присутствует только у детей, реально сопоставленных с exe игры.
            // Записи из «Known Game List» без запуска этого поля не имеют и просто пропускаются.
            if let Ok(path) = child.get_value::<String, _>("MatchedExeFullPath") {
                let p = path.trim().to_lowercase();
                if !p.is_empty() {
                    out.insert(p);
                }
            }
        }
    }
    out
}

// ─────────── Discord detectable-games (главный позитивный аллоулист: тысячи игр, точно) ───────────
// Веб фетчит /api/detectable-games (сервер дистиллирует список Discord) и передаёт сюда командой
// set_detectable_games. Матчим ЗАПУЩЕННЫЕ процессы по суффиксу пути exe (как arRPC). Это первичный
// сигнал детекта — покрывает почти все игры и НЕ ловит не-игры (в отличие от фуллскрин-эвристики).

#[derive(Deserialize)]
pub struct GameEntry {
    pub name: String,
    pub exes: Vec<String>, // win32 path-suffix'ы (lowercase, '/'), напр. "bin/win64/cs2.exe"
}

struct Detectable {
    suffix_to_name: HashMap<String, String>, // суффикс пути → имя игры
    basenames: HashSet<String>,              // basename каждого exe — дешёвый пред-фильтр по ToolHelp
}
static DETECTABLE: Mutex<Option<Detectable>> = Mutex::new(None);

/// Устанавливает аллоулист Discord (из веба). Строит суффикс→имя + множество basename'ов.
pub fn set_detectable(games: Vec<GameEntry>) {
    let mut suffix_to_name: HashMap<String, String> = HashMap::new();
    let mut basenames: HashSet<String> = HashSet::new();
    for g in games {
        for exe in g.exes {
            let e = exe.trim().to_lowercase().replace('\\', "/");
            if e.is_empty() {
                continue;
            }
            if let Some(base) = e.rsplit('/').next() {
                basenames.insert(base.to_string());
            }
            suffix_to_name.entry(e).or_insert_with(|| g.name.clone());
        }
    }
    *DETECTABLE.lock().unwrap() = Some(Detectable { suffix_to_name, basenames });
}

/// Ищет среди ЗАПУЩЕННЫХ процессов игру из аллоулиста Discord. Дёшево: сначала матч по basename
/// (ToolHelp, без OpenProcess), затем у кандидатов — полный путь и суффикс-матч. (имя игры, pid) или None.
pub fn match_running_game(me_pid: u32) -> Option<(String, u32)> {
    let guard = DETECTABLE.lock().unwrap();
    let det = guard.as_ref()?;
    if det.suffix_to_name.is_empty() {
        return None;
    }
    for (pid, exe) in enum_processes() {
        if pid == me_pid || pid == 0 {
            continue;
        }
        if !det.basenames.contains(&exe.to_lowercase()) {
            continue; // не кандидат — не открываем процесс (дёшево)
        }
        let path = match crate::broadcast::capture::process_full_path(pid) {
            Some(p) => p,
            None => continue,
        };
        let p = path.to_lowercase().replace('\\', "/");
        let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty()).collect();
        // tail-суффиксы: game.exe → dir/game.exe → ... (ключ Discord любой глубины)
        for i in 1..=parts.len() {
            let suffix = parts[parts.len() - i..].join("/");
            if let Some(name) = det.suffix_to_name.get(&suffix) {
                return Some((name.clone(), pid));
            }
        }
    }
    None
}

/// Перечень запущенных процессов (pid, exe basename) через ToolHelp — дёшево, без OpenProcess.
fn enum_processes() -> Vec<(u32, String)> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    unsafe {
        let snap = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return out,
        };
        let mut pe = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut pe).is_ok() {
            loop {
                let n = pe.szExeFile.iter().position(|&c| c == 0).unwrap_or(pe.szExeFile.len());
                out.push((pe.th32ProcessID, String::from_utf16_lossy(&pe.szExeFile[..n])));
                if Process32NextW(snap, &mut pe).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}
