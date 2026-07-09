// Кольцевой буфер лога текущей сессии стрима/просмотра.
//
// Зачем. Файл лога (tauri-plugin-log) живёт на машине пользователя: чтобы разобрать
// жалобу «картинка подвисает», его надо у человека выпросить. А главное — фризы видны
// ЗРИТЕЛЯМ, и сопоставить их с тем, что в этот момент делал вещатель, можно только имея
// оба лога с общими временными метками. Поэтому строки лога дублируются сюда, а фронтенд
// по окончании сессии забирает их (`diag_take_log`) и сдаёт на сервер вместе со своими
// семплами getStats.
//
// Сток подключается как `TargetKind::Dispatch` рядом со штатными Stdout/LogDir — то есть
// ловит ВСЁ, включая логи webrtc-rs (ICE/TURN-ошибки), а не только наши строки. Именно
// они обычно и объясняют фризы.
//
// Память ограничена с двух сторон (строки И байты): лог webrtc-rs на плохой сети умеет
// сыпать тысячи строк в секунду, а буфер живёт всю трансляцию.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_LINES: usize = 20_000;
const MAX_BYTES: usize = 2 * 1024 * 1024;

#[derive(Default)]
struct Ring {
    lines: VecDeque<String>,
    bytes: usize,
}

fn ring() -> &'static Mutex<Ring> {
    static RING: OnceLock<Mutex<Ring>> = OnceLock::new();
    RING.get_or_init(|| Mutex::new(Ring::default()))
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn push(line: String) {
    // Отравленный мьютекс (паника в другом потоке под локом) не должен ронять логгер —
    // иначе диагностика убивает приложение ровно тогда, когда она нужнее всего.
    let Ok(mut r) = ring().lock() else { return };
    r.bytes += line.len();
    r.lines.push_back(line);
    while r.lines.len() > MAX_LINES || r.bytes > MAX_BYTES {
        match r.lines.pop_front() {
            Some(old) => r.bytes -= old.len(),
            None => break,
        }
    }
}

/// Начало сессии: старый хвост не относится к ней и только раздувает выгрузку.
pub fn reset() {
    if let Ok(mut r) = ring().lock() {
        r.lines.clear();
        r.bytes = 0;
    }
}

/// Забирает накопленное и очищает буфер (сессия закончилась).
pub fn take() -> Vec<String> {
    let Ok(mut r) = ring().lock() else { return Vec::new() };
    r.bytes = 0;
    r.lines.drain(..).collect()
}

struct RingLogger;

impl log::Log for RingLogger {
    fn enabled(&self, _: &log::Metadata) -> bool { true }
    fn log(&self, record: &log::Record) {
        // Метка времени в epoch-мс: по ней строки вещателя стыкуются с семплами зрителя,
        // снятыми на другой машине (у обоих Date.now()/SystemTime от одной эпохи).
        push(format!("{} [{}][{}] {}", now_ms(), record.level(), record.target(), record.args()));
    }
    fn flush(&self) {}
}

/// Сток для `tauri_plugin_log::TargetKind::Dispatch` — подключается в lib.rs рядом с
/// Stdout/LogDir, не заменяя их.
pub fn log_target() -> tauri_plugin_log::Target {
    let dispatch = tauri_plugin_log::fern::Dispatch::new().chain(Box::new(RingLogger) as Box<dyn log::Log>);
    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Dispatch(dispatch))
}

/// Фронтенд забирает лог сессии, чтобы отправить его на сервер (`POST /api/diag/session`).
/// HTTP делает веб-сторона: там уже лежит session-JWT, дублировать авторизацию в Rust
/// незачем.
#[tauri::command]
pub fn diag_take_log() -> Vec<String> {
    take()
}
