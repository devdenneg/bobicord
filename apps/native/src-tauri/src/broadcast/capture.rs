// Захват экрана (Evolution-TZ Э5): Windows Graphics Capture через `windows-capture`,
// с приведением к NV12 и мастшабированием в выходное разрешение — на GPU-хосте,
// но здесь CPU-путь (см. заметку у convert_and_scale). Кодирование — в encoder.rs
// (инвариант CLAUDE.md 7: масштабирование/кодирование на стороне вещателя).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

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
    /// Целевой FPS — для программного пейсинга в on_frame_arrived (WGC отдаёт
    /// коарс-поток чуть выше цели, точный каденс держим здесь). См. spawn_capture.
    pub target_fps: u32,
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
    /// Дедлайн-аккумулятор пейсинга: `target_period` = 1/target_fps, `next_deadline`
    /// = момент, к которому ждём следующий принятый кадр. Ниже цели пропускаем всё
    /// (источник медленнее — дропать нечего), режем только реальный овершут над целью
    /// (WGC на 120/144/164 Гц). Прежний порог «время с прошлого принятого» ошибочно
    /// дропал бурстовые кадры даже под целью (raw 31 -> accepted 24 на Доте).
    target_period: Duration,
    next_deadline: Option<Instant>,
    /// Таблицы соответствия выходной пиксель -> исходный: `col_lut[x]` — байтовый
    /// сдвиг колонки внутри исходной строки (x*src_w/out_w * 4), `row_lut[y]` —
    /// индекс исходной строки (y*src_h/out_h). Считаются один раз на разрешение —
    /// убирают 64-битное умножение+деление из горячего цикла конвертации (это и
    /// был потолок ~38 fps на 1080p: ~5М делений/кадр). `lut_key` — (src_w,src_h,
    /// out_w,out_h), под которые построены таблицы.
    col_lut: Vec<u32>,
    row_lut: Vec<u32>,
    lut_key: (u32, u32, u32, u32),
    /// Сырые вызовы on_frame_arrived (до гейта) за окно = темп отдачи WGC (`raw` в
    /// логе). Отделяет «источник мало презентит» от «гейт режет» при разборе fps.
    raw_window_count: u32,
}

impl ScreenCapture {
    /// Пересобирает LUT-таблицы, если сменилось разрешение источника/выхода
    /// (ресайз окна, DPI). В стабильном случае — no-op (сверка ключа).
    fn ensure_luts(&mut self, src_w: u32, src_h: u32, out_w: u32, out_h: u32) {
        let key = (src_w, src_h, out_w, out_h);
        if self.lut_key == key && !self.col_lut.is_empty() {
            return;
        }
        self.col_lut = (0..out_w)
            .map(|x| (x as u64 * src_w as u64 / out_w as u64) as u32 * 4)
            .collect();
        self.row_lut = (0..out_h)
            .map(|y| (y as u64 * src_h as u64 / out_h as u64) as u32)
            .collect();
        self.lut_key = key;
    }
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
            target_period: Duration::from_secs_f64(1.0 / ctx.flags.target_fps.max(1) as f64),
            next_deadline: None,
            col_lut: Vec::new(),
            row_lut: Vec::new(),
            lut_key: (0, 0, 0, 0),
            raw_window_count: 0,
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

        // Диагностика: сырые вызовы (до гейта) = темп отдачи WGC.
        self.raw_window_count += 1;

        // Программный пейсинг дедлайн-аккумулятором: дропаем кадр, только если он
        // пришёл РАНЬШЕ следующего дедлайна (реальный овершут над целью — WGC на
        // 120/144/164 Гц). Если источник медленнее цели, дедлайн всегда в прошлом —
        // пропускаем всё, ничего не теряя. Дроп ДО конвертации BGRA->NV12 экономит CPU.
        // slack (период/8) позволяет принять кадр чуть раньше дедлайна, чтобы не
        // сдвигать приём на следующий презент источника (иначе бился бы с каденсом).
        let now = Instant::now();
        let slack = self.target_period / 8;
        match self.next_deadline {
            None => self.next_deadline = Some(now + self.target_period),
            Some(dl) => {
                if now + slack < dl {
                    return Ok(()); // раньше дедлайна — овершут, дропаем
                }
                // Приняли: сдвигаем дедлайн на период. Если уже отстали (источник
                // медленнее цели) — привязываем к now, чтобы гейт не «догонял» долг
                // пакетным приёмом и не резал последующие бурсты.
                let next = dl + self.target_period;
                self.next_deadline = Some(if next <= now { now + self.target_period } else { next });
            }
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
        self.ensure_luts(src_w, src_h, out_w, out_h);
        bgra_to_nv12_luts(raw, row_pitch, out_w, out_h, &self.col_lut, &self.row_lut, &mut self.scratch);

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
            let secs = elapsed.as_secs_f64();
            let accepted = self.fps_window_count as f64 / secs;
            let raw = self.raw_window_count as f64 / secs;
            // accepted = fps, ушедший в трек; raw = темп отдачи WGC. raw≈accepted и оба
            // низкие -> источник мало презентит (кап не наш). raw>>accepted -> гейт режет
            // овершут над целью (норма на 120/144 Гц).
            log::info!("capture: accepted={accepted:.1} raw={raw:.1} fps ({out_w}x{out_h})");
            self.fps_window_count = 0;
            self.raw_window_count = 0;
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

/// BGRA8 (с учётом row_pitch) -> NV12, ближайший сосед через LUT-таблицы
/// (`col_lut`/`row_lut` см. ScreenCapture::ensure_luts) — без деления в цикле.
/// Формулы BT.601 (studio range), стандартные целочисленные коэффициенты.
/// Y-плоскость (доминирующая по стоимости) считается параллельно по бэндам строк
/// через `std::thread::scope`: раньше однопоточная скалярная конвертация с делением
/// на пиксель упиралась в ~38 fps на 1080p. Хрома (1/4 объёма) — однопоточно.
///
/// Замечание: `windows-capture` отдаёт кадр уже как ID3D11Texture2D
/// (`frame.as_raw_texture()`), то есть теоретически возможен zero-copy путь
/// GPU-кадр -> DXGI-буфер MFT без обратного чтения в CPU. Здесь CPU-путь (проще,
/// latency-бюджет ≤3с позволяет) — GPU zero-copy отдельная оптимизация, не блокер.
fn bgra_to_nv12_luts(
    src: &[u8],
    row_pitch: u32,
    out_w: u32,
    out_h: u32,
    col_lut: &[u32],
    row_lut: &[u32],
    dst: &mut [u8],
) {
    let out_w = out_w as usize;
    let out_h = out_h as usize;
    let pitch = row_pitch as usize;
    let y_size = out_w * out_h;
    let (y_plane, uv_plane) = dst.split_at_mut(y_size);

    // Число бэндов — по ядрам, но не больше числа строк; кап 12 против лишнего
    // дробления. Каждый бэнд пишет непересекающийся диапазон строк Y.
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let bands = cores.clamp(1, 12).min(out_h.max(1));
    let rows_per_band = out_h.div_ceil(bands);
    std::thread::scope(|s| {
        for (b, y_chunk) in y_plane.chunks_mut(rows_per_band * out_w).enumerate() {
            let row0 = b * rows_per_band;
            s.spawn(move || {
                let rows = y_chunk.len() / out_w;
                for ry in 0..rows {
                    let base = row_lut[row0 + ry] as usize * pitch;
                    let out_base = ry * out_w;
                    for x in 0..out_w {
                        let off = base + col_lut[x] as usize;
                        let r = src[off + 2] as i32;
                        let g = src[off + 1] as i32;
                        let bl = src[off] as i32;
                        let yv = ((66 * r + 129 * g + 25 * bl + 128) >> 8) + 16;
                        y_chunk[out_base + x] = yv.clamp(0, 255) as u8;
                    }
                }
            });
        }
    });

    for y in (0..out_h).step_by(2) {
        let base = row_lut[y] as usize * pitch;
        let uv_row = (y / 2) * out_w;
        for x in (0..out_w).step_by(2) {
            let off = base + col_lut[x] as usize;
            let r = src[off + 2] as i32;
            let g = src[off + 1] as i32;
            let bl = src[off] as i32;
            let u = ((-38 * r - 74 * g + 112 * bl + 128) >> 8) + 128;
            let v = ((112 * r - 94 * g - 18 * bl + 128) >> 8) + 128;
            let idx = uv_row + x;
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
/// `Window::is_valid`), с заголовком, именем процесса и его PID — заголовок+имя
/// для UI выбора источника видео, PID — для выбора источника аудио (Э5.2:
/// process-loopback INCLUDE на процесс игры вместо ненадёжного EXCLUDE себя).
pub fn list_windows() -> Vec<(isize, String, String, u32)> {
    Window::enumerate()
        .map(|ws| {
            ws.into_iter()
                .filter_map(|w| {
                    let title = w.title().ok()?;
                    if title.trim().is_empty() {
                        return None;
                    }
                    let process = w.process_name().unwrap_or_default();
                    let pid = w.process_id().unwrap_or(0);
                    Some((w.as_raw_hwnd() as isize, title, process, pid))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Синхронная проверка источника до спавна потока — чтобы неверный индекс/протухший
/// HWND вернулись caller'у сразу как Err, а не молча уронили сессию.
fn validate_source(source: &CaptureSource) -> Result<(), String> {
    match source {
        CaptureSource::Monitor { index } => {
            Monitor::from_index(*index).map_err(|e| format!("monitor {index}: {e}"))?;
        }
        CaptureSource::Window { hwnd } => {
            Window::from_raw_hwnd(*hwnd as *mut std::ffi::c_void)
                .title()
                .map_err(|e| format!("window: {e}"))?;
        }
    }
    Ok(())
}

/// Одна WGC-сессия захвата выбранного источника в отдельном потоке (Capture::start
/// блокирующий, требует свой COM-апартамент — не гонять на tokio-воркере). Питает
/// переданный `tx` (клон канала супервайзера — сам канал переживает смену сессии).
/// Если сессия завершилась НЕ по нашему `stop` (окно закрыли, все попытки старта
/// провалились), шлёт `shutdown_tx` — иначе после развязки канала от жизни сессии
/// (см. CaptureSupervisor) энкодер не узнал бы о смерти источника.
fn spawn_session(
    source: CaptureSource,
    tx: Sender<Nv12Frame>,
    max_width: u32,
    max_height: u32,
    target_fps: u32,
    stats: StatsHandle,
    shutdown_tx: tokio::sync::mpsc::UnboundedSender<Option<String>>,
) -> (std::thread::JoinHandle<()>, Arc<AtomicBool>) {
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();

    let handle = std::thread::spawn(move || {
        // Троттл WGC ставим коарс — на 0.5×периода цели, а не ровно на период.
        // Раньше min_interval == 1/target_fps бился по фазе с vblank монитора:
        // когда порог совпадал с периодом обновления (60 fps на 60 Гц = 16.67 мс),
        // джиттер ронял пограничные тики и отдача схлопывалась вдвое (60->30, 30->27).
        // 0.5×периода гарантированно ниже периода vblank при target_fps <= refresh,
        // так что WGC отдаёт как минимум с частотой цели без биения; точный каденс
        // подрезает программный гейт в on_frame_arrived. RTP-сэмплы в mod.rs
        // размечены реальным интервалом между `captured_at`, синхру это не трогает.
        // Создание WGC capture-item ("convert item to GraphicsCaptureItem") иногда
        // падает транзиентно сразу после выбора источника (окно ещё «устаканивается»,
        // гонка DPI/композитора) — HWND валиден в проверке выше, но start падает и
        // раньше это мгновенно убивало трансляцию (тост «окно/монитор пропали»).
        // Повторяем старт несколько раз с паузой, прежде чем сдаться: в логах тот же
        // источник поднимался после пары неудач. min_interval/flags пересобираем
        // каждую попытку (Settings::new забирает их по значению).
        const START_ATTEMPTS: u32 = 5;
        let mut last_err = String::new();
        // true = сессия завершилась штатно по нашему `stop` (свитч/стоп), не сама.
        let mut clean_stop = false;
        for attempt in 1..=START_ATTEMPTS {
            if stop2.load(Ordering::Relaxed) {
                clean_stop = true;
                break; // остановили до успешного старта
            }
            let min_interval = MinimumUpdateIntervalSettings::Custom(
                std::time::Duration::from_secs_f64(0.5 / target_fps.max(1) as f64),
            );
            let flags = CaptureFlags {
                tx: tx.clone(),
                stop: stop2.clone(),
                max_width,
                max_height,
                target_fps,
                stats: stats.clone(),
            };
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
            match result {
                // Ok = сессия отработала и штатно завершилась. Если это мы попросили
                // (stop взведён — свитч/стоп) — чисто; иначе источник пропал сам
                // (окно закрыли) — надо уведомить оркестратор.
                Ok(()) => {
                    clean_stop = stop2.load(Ordering::Relaxed);
                    break;
                }
                Err(e) => {
                    last_err = e;
                    log::warn!("capture: попытка старта {attempt}/{START_ATTEMPTS} не удалась: {last_err}");
                    if attempt < START_ATTEMPTS && !stop2.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(200));
                    }
                }
            }
        }
        if !clean_stop && !stop2.load(Ordering::Relaxed) {
            if !last_err.is_empty() {
                log::error!("capture: старт не удался после {START_ATTEMPTS} попыток: {last_err}");
            }
            let _ = shutdown_tx.send(Some("захват прервался (окно/монитор пропали)".into()));
        }
    });

    (handle, stop)
}

/// Держит один живой канал `Nv12Frame` на всю трансляцию и переключает под ним
/// WGC-сессии (смена монитора/окна на лету, Э5.3). Ключ: `tx` удерживается здесь,
/// а каждой сессии выдаётся клон — завершение сессии при свитче НЕ дисконнектит
/// канал, энкодер просто ждёт первый кадр новой сессии (recv_timeout), не убивая
/// трансляцию и не трогая WebRTC-треки/дерево.
pub struct CaptureSupervisor {
    tx: Sender<Nv12Frame>,
    max_width: u32,
    max_height: u32,
    target_fps: u32,
    stats: StatsHandle,
    shutdown_tx: tokio::sync::mpsc::UnboundedSender<Option<String>>,
    cur: Option<(std::thread::JoinHandle<()>, Arc<AtomicBool>)>,
}

impl CaptureSupervisor {
    /// Создаёт канал (bounded(2) — как раньше: отставший энкодер роняет кадр, а не
    /// копит задержку) и возвращает приёмник для энкодерного потока.
    pub fn new(
        max_width: u32,
        max_height: u32,
        target_fps: u32,
        stats: StatsHandle,
        shutdown_tx: tokio::sync::mpsc::UnboundedSender<Option<String>>,
    ) -> (Self, crossbeam_channel::Receiver<Nv12Frame>) {
        let (tx, rx) = crossbeam_channel::bounded(2);
        (
            Self { tx, max_width, max_height, target_fps, stats, shutdown_tx, cur: None },
            rx,
        )
    }

    /// Запускает сессию для источника. Ошибка валидации возвращается синхронно
    /// (текущая сессия, если была, не трогается — вызывать после stop_current).
    pub fn start(&mut self, source: CaptureSource) -> Result<(), String> {
        validate_source(&source)?;
        let session = spawn_session(
            source,
            self.tx.clone(),
            self.max_width,
            self.max_height,
            self.target_fps,
            self.stats.clone(),
            self.shutdown_tx.clone(),
        );
        self.cur = Some(session);
        Ok(())
    }

    fn stop_current(&mut self) {
        if let Some((handle, stop)) = self.cur.take() {
            stop.store(true, Ordering::Relaxed);
            let _ = handle.join();
        }
    }

    /// Смена источника на лету: валидируем новый ДО остановки текущего (при
    /// ошибке текущая сессия продолжает жить), затем гасим старую и стартуем новую.
    pub fn switch(&mut self, source: CaptureSource) -> Result<(), String> {
        validate_source(&source)?;
        self.stop_current();
        self.start(source)
    }

    /// Полный останов: гасит текущую сессию и джойнит её поток. `tx` дропается
    /// вместе с супервайзером (энкодер получит Disconnected как бэкап к enc_stop).
    pub fn stop(&mut self) {
        self.stop_current();
    }
}
