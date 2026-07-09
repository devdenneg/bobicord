// Общий счётчик для дебаг-панели во фронтенде (Э5.1): захват/энкодер пишут
// атомарно, run_signaling_loop в mod.rs раз в тик читает дельты и шлёт Tauri-событие.
// Отдельный модуль, а не поля на BroadcastHandle — счётчики нужны трём независимым
// OS-потокам одновременно (capture/encoder/signaling), Arc<SharedStats> дешевле
// протаскивать, чем канал с бэкпрешером ради редких чисел.

use std::sync::atomic::{AtomicU32, AtomicU64};
use std::sync::Arc;

#[derive(Default)]
pub struct SharedStats {
    pub capture_frames: AtomicU64,
    pub capture_drops: AtomicU64,
    pub encoded_frames: AtomicU64,
    pub encoded_bytes: AtomicU64,
    pub out_width: AtomicU32,
    pub out_height: AtomicU32,
    /// Тайминги секций горячего пути, наносекунды. Нужны, чтобы отличить «источник мало
    /// презентит» от «мы не успеваем»: медленный колбэк on_frame_arrived тормозит саму
    /// WGC-сессию, и оба случая дают одинаково низкий `raw` в логе захвата. Суммы и
    /// счётчики — оконные: stats-тик читает их через swap(0), среднее = сумма/счётчик.
    pub cb_ns: AtomicU64,
    pub cb_max_ns: AtomicU64,
    pub readback_ns: AtomicU64,
    pub convert_ns: AtomicU64,
    /// Кадры, дошедшие до конвертации (принятые fps-гейтом) = знаменатель cb/readback/convert.
    pub cb_samples: AtomicU64,
    pub encode_ns: AtomicU64,
    pub encode_max_ns: AtomicU64,
    /// Время `write_sample` (block_on на tokio-треке) — отдельно от энкода.
    pub write_ns: AtomicU64,
    /// Знаменатель encode/write.
    pub encode_samples: AtomicU64,
    /// PLI/FIR от детей за окно = «потерял keyframe, дай IDR». Прямая улика потерь ВНИЗ
    /// по дереву: захват и энкодер при этом могут показывать идеальные цифры, а зритель
    /// фризит до следующего IDR. Считаются ВСЕ запросы, включая подавленные rate-limit'ом
    /// (1с на корень) — иначе шторм PLI выглядел бы как единичный запрос.
    pub pli_count: AtomicU64,
    /// Сколько IDR реально ушло в трек за окно (по MFSampleExtension_CleanPoint).
    /// Частые IDR без смены разрешения = мы отвечаем на PLI, т.е. пакеты теряются.
    pub keyframes: AtomicU64,
}

impl SharedStats {
    /// Забирает окно (сумму, максимум, счётчик) и обнуляет его под следующий тик.
    /// Возвращает (avg_ms, max_ms).
    pub fn take_window(sum_ns: &AtomicU64, max_ns: &AtomicU64, samples: u64) -> (f64, f64) {
        use std::sync::atomic::Ordering::Relaxed;
        let sum = sum_ns.swap(0, Relaxed);
        let max = max_ns.swap(0, Relaxed);
        let avg = if samples > 0 { sum as f64 / samples as f64 / 1e6 } else { 0.0 };
        (avg, max as f64 / 1e6)
    }
}

pub type StatsHandle = Arc<SharedStats>;
