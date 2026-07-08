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

use std::collections::HashSet;
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
