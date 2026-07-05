// Захват экрана (Evolution-TZ Э5): Windows Graphics Capture через `windows-capture`,
// с приведением к NV12 и мастшабированием в выходное разрешение — на GPU-хосте,
// но здесь CPU-путь (см. заметку у convert_and_scale). Кодирование — в encoder.rs
// (инвариант CLAUDE.md 7: масштабирование/кодирование на стороне вещателя).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use crossbeam_channel::Sender;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

use super::stats::StatsHandle;

/// Источник кадров: монитор целиком либо отдельное окно (Э5.1 — захват окна).
/// `Window::from_raw_hwnd` ничего не валидирует сама по себе, так что перед
/// спавном потока в `spawn_capture` делаем синхронную проверку хэндла.
#[derive(serde::Deserialize, Clone, Copy, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CaptureSource {
    Monitor { index: usize },
    Window { hwnd: isize },
}

/// Заголовок окна по HWND — для дебаг-панели (подпись источника трансляции).
pub fn window_title(hwnd: isize) -> String {
    Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void).title().unwrap_or_default()
}

/// Кадр в формате NV12 (Y-плоскость + перемежённая UV, 4:2:0) — то, что ждёт
/// H.264 MFT на входе без внутренней цветоконвертации.
pub struct Nv12Frame {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub captured_at: Instant,
}

pub struct CaptureFlags {
    pub tx: Sender<Nv12Frame>,
    pub stop: Arc<AtomicBool>,
    /// Верхняя граница выходного разрешения (например 1920x1080) — источник
    /// масштабируется вниз, если больше; апскейл никогда не делаем.
    pub max_width: u32,
    pub max_height: u32,
    pub stats: StatsHandle,
}

pub struct ScreenCapture {
    tx: Sender<Nv12Frame>,
    stop: Arc<AtomicBool>,
    max_width: u32,
    max_height: u32,
    stats: StatsHandle,
    scratch: Vec<u8>,
    fps_window_start: Instant,
    fps_window_count: u32,
}

impl GraphicsCaptureApiHandler for ScreenCapture {
    type Flags = CaptureFlags;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            tx: ctx.flags.tx,
            stop: ctx.flags.stop,
            max_width: ctx.flags.max_width,
            max_height: ctx.flags.max_height,
            stats: ctx.flags.stats,
            scratch: Vec::new(),
            fps_window_start: Instant::now(),
            fps_window_count: 0,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.stop.load(Ordering::Relaxed) {
            capture_control.stop();
            return Ok(());
        }

        let src_w = frame.width();
        let src_h = frame.height();
        let mut buf = frame.buffer()?;
        let row_pitch = buf.row_pitch();
        let raw = buf.as_raw_buffer();

        let (out_w, out_h) = scaled_dims(src_w, src_h, self.max_width, self.max_height);
        let nv12_len = (out_w * out_h * 3 / 2) as usize;
        if self.scratch.len() != nv12_len {
            self.scratch = vec![0u8; nv12_len];
        }
        bgra_to_nv12_scaled(raw, src_w, src_h, row_pitch, out_w, out_h, &mut self.scratch);

        self.stats.out_width.store(out_w, Ordering::Relaxed);
        self.stats.out_height.store(out_h, Ordering::Relaxed);

        // Канал ограничен (см. spawn_capture) — если энкодер отстаёт, лучше
        // уронить кадр, чем копить задержку (инвариант «видео <= 3с»).
        let frame_out = Nv12Frame { data: self.scratch.clone(), width: out_w, height: out_h, captured_at: Instant::now() };
        if self.tx.try_send(frame_out).is_err() {
            self.stats.capture_drops.fetch_add(1, Ordering::Relaxed);
            log::debug!("capture: drop frame, encoder busy");
        } else {
            self.stats.capture_frames.fetch_add(1, Ordering::Relaxed);
        }

        self.fps_window_count += 1;
        let elapsed = self.fps_window_start.elapsed();
        if elapsed.as_secs() >= 2 {
            let fps = self.fps_window_count as f64 / elapsed.as_secs_f64();
            log::info!("capture: {:.1} fps ({out_w}x{out_h}, source WGC frame rate)", fps);
            self.fps_window_count = 0;
            self.fps_window_start = Instant::now();
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        log::info!("capture: session closed");
        Ok(())
    }
}

fn scaled_dims(src_w: u32, src_h: u32, max_w: u32, max_h: u32) -> (u32, u32) {
    if src_w <= max_w && src_h <= max_h {
        return (src_w & !1, src_h & !1);
    }
    let scale = f64::min(max_w as f64 / src_w as f64, max_h as f64 / src_h as f64);
    let w = ((src_w as f64 * scale) as u32).max(2) & !1;
    let h = ((src_h as f64 * scale) as u32).max(2) & !1;
    (w, h)
}

/// BGRA8 (с учётом row_pitch) -> NV12, с масштабированием методом ближайшего
/// соседа. Формулы BT.601 (studio range) — стандартные целочисленные коэффициенты.
///
/// Замечание: `windows-capture` отдаёт кадр уже как ID3D11Texture2D
/// (`frame.as_raw_texture()`), то есть теоретически возможен zero-copy путь
/// GPU-кадр -> DXGI-буфер MFT без обратного чтения в CPU. Здесь взят CPU-путь
/// (проще, latency-бюджет ≤3с это позволяет) — GPU zero-copy можно сделать
/// отдельной оптимизацией, не блокирует AC Э5.
fn bgra_to_nv12_scaled(
    src: &[u8],
    src_w: u32,
    src_h: u32,
    row_pitch: u32,
    out_w: u32,
    out_h: u32,
    dst: &mut [u8],
) {
    let y_size = (out_w * out_h) as usize;
    let (y_plane, uv_plane) = dst.split_at_mut(y_size);

    let sample_bgr = |x: u32, y: u32| -> (i32, i32, i32) {
        let sx = (x as u64 * src_w as u64 / out_w as u64) as u32;
        let sy = (y as u64 * src_h as u64 / out_h as u64) as u32;
        let off = (sy * row_pitch + sx * 4) as usize;
        (src[off + 2] as i32, src[off + 1] as i32, src[off] as i32) // R,G,B
    };

    for y in 0..out_h {
        for x in 0..out_w {
            let (r, g, b) = sample_bgr(x, y);
            let yv = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
            y_plane[(y * out_w + x) as usize] = yv.clamp(0, 255) as u8;
        }
    }
    for y in (0..out_h).step_by(2) {
        for x in (0..out_w).step_by(2) {
            let (r, g, b) = sample_bgr(x, y);
            let u = ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
            let v = ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
            let idx = ((y / 2) * out_w + x) as usize;
            uv_plane[idx] = u.clamp(0, 255) as u8;
            uv_plane[idx + 1] = v.clamp(0, 255) as u8;
        }
    }
}

pub fn list_monitors() -> Vec<(usize, String)> {
    Monitor::enumerate()
        .map(|ms| {
            ms.into_iter()
                .filter_map(|m| m.index().ok().map(|i| (i, m.name().unwrap_or_default())))
                .collect()
        })
        .unwrap_or_default()
}

/// Список окон, доступных для захвата (видимые top-level, не наши же — см.
/// `Window::is_valid`), с заголовком и именем процесса для UI выбора источника.
pub fn list_windows() -> Vec<(isize, String, String)> {
    Window::enumerate()
        .map(|ws| {
            ws.into_iter()
                .filter_map(|w| {
                    let title = w.title().ok()?;
                    if title.trim().is_empty() {
                        return None;
                    }
                    let process = w.process_name().unwrap_or_default();
                    Some((w.as_raw_hwnd() as isize, title, process))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Запускает захват выбранного источника (монитор или окно) в отдельном потоке
/// (Capture::start блокирующий, требует свой COM-апартамент — не гонять на
/// tokio-воркере). Возвращает флаг остановки.
pub fn spawn_capture(
    source: CaptureSource,
    max_width: u32,
    max_height: u32,
    target_fps: u32,
    stats: StatsHandle,
) -> Result<(std::thread::JoinHandle<()>, Arc<AtomicBool>, crossbeam_channel::Receiver<Nv12Frame>), String> {
    // Синхронная проверка перед спавном потока — чтобы неверный индекс/протухший
    // HWND вернулись caller'у сразу как Err, а не молча уронили поток.
    match source {
        CaptureSource::Monitor { index } => {
            Monitor::from_index(index).map_err(|e| format!("monitor {index}: {e}"))?;
        }
        CaptureSource::Window { hwnd } => {
            Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void)
                .title()
                .map_err(|e| format!("window: {e}"))?;
        }
    }

    let (tx, rx) = crossbeam_channel::bounded(2);
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();

    let handle = std::thread::spawn(move || {
        // Без троттлинга WGC отдаёт кадры с реальной частотой обновления монитора
        // (может быть заметно выше target_fps) — лишняя нагрузка на CPU/энкодер и
        // рассинхрон с `frame_dur`, которым RTP-сэмплы размечены в mod.rs.
        let min_interval = MinimumUpdateIntervalSettings::Custom(
            std::time::Duration::from_secs_f64(1.0 / target_fps.max(1) as f64),
        );
        let flags = CaptureFlags { tx, stop: stop2, max_width, max_height, stats };
        let result = match source {
            CaptureSource::Monitor { index } => Monitor::from_index(index).map_err(|e| e.to_string()).and_then(|monitor| {
                let settings = Settings::new(
                    monitor,
                    CursorCaptureSettings::WithCursor,
                    DrawBorderSettings::WithoutBorder,
                    SecondaryWindowSettings::Default,
                    min_interval,
                    DirtyRegionSettings::Default,
                    ColorFormat::Bgra8,
                    flags,
                );
                ScreenCapture::start(settings).map_err(|e| e.to_string())
            }),
            CaptureSource::Window { hwnd } => {
                let window = Window::from_raw_hwnd(hwnd as *mut std::ffi::c_void);
                let settings = Settings::new(
                    window,
                    CursorCaptureSettings::WithCursor,
                    DrawBorderSettings::WithoutBorder,
                    SecondaryWindowSettings::Default,
                    min_interval,
                    DirtyRegionSettings::Default,
                    ColorFormat::Bgra8,
                    flags,
                );
                ScreenCapture::start(settings).map_err(|e| e.to_string())
            }
        };
        if let Err(e) = result {
            log::error!("capture: {e}");
        }
    });

    Ok((handle, stop, rx))
}
