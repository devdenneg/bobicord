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
}

pub type StatsHandle = Arc<SharedStats>;
