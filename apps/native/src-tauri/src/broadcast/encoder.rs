// Аппаратный H.264-энкодер через Media Foundation (Evolution-TZ Э5).
// Драйвер сырого IMFTransform: MFTEnumEx с MFT_ENUM_FLAG_HARDWARE находит
// вендорский MFT (NVENC/AMF/QuickSync — какой есть на машине), настраивается
// low-latency без B-кадров (инвариант CLAUDE.md: совместимость натив<->браузер,
// без B-кадров). Выход — Annex-B NAL'ы (H.264 MFT контракт).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use windows::core::{Interface, Result as WinResult};
use windows::Win32::Media::MediaFoundation::*;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::System::Variant::VARIANT;

use super::capture::Nv12Frame;

/// Период принудительного IDR, секунды. Страховка от потерянного keyframe: основной путь
/// восстановления — PLI от зрителя (peer.rs форсит IDR), но если PLI потерялся, без
/// периодического GOP зритель фризит навсегда. 4с: при 4.5 Мбит IDR ~200-300 КБ, редкий
/// спайк терпим. Чаще (1-2с) — залпы по ~170 пакетов подряд раздувают jitter у зрителя и
/// дают фризы 200-600 мс БЕЗ единой потери пакета (ловилось живьём, диаг 2026-07-10).
const GOP_SECONDS: u32 = 4;

pub struct EncodedFrame {
    pub data: Vec<u8>,
    pub is_keyframe: bool,
    /// IDR по нашему запросу (force_keyframe: PLI/tree-сигналинг/реинит MFT), а не плановый GOP.
    /// Диаг: разделяет шторм от петли PLI и энкодер, печущий IDR сам (дефолтный GOP=fps).
    pub forced: bool,
}

pub struct H264Encoder {
    transform: IMFTransform,
    event_gen: IMFMediaEventGenerator,
    is_async: bool,
    need_input: u32,
    codec_api: Option<ICodecAPI>,
    fps: u32,
    start: Instant,
    output_provides_samples: bool,
    output_sample_size: u32,
    force_keyframe: Arc<AtomicBool>,
    /// Форс запрошен, но IDR ещё не вышел (async MFT кодирует с задержкой конвейера) —
    /// снимается на первом же вышедшем keyframe, помечая его forced. Так форс-IDR
    /// атрибутируется точно, даже когда выходит через кадр-два после запроса.
    pending_forced: bool,
    /// Текущий целевой средний битрейт — чтобы `set_bitrate` пропускал no-op (ABR шлёт
    /// цель каждый тик, но реально меняется она редко). Меняется на лету через ICodecAPI
    /// без пересоздания MFT.
    current_bitrate: u32,
    /// Меряет фактический интервал IDR на выходе — см. `GopWatch`.
    gop: GopWatch,
}

unsafe impl Send for H264Encoder {}

impl H264Encoder {
    /// `bitrate_bps` — целевой средний битрейт; вызывать из потока, где уже
    /// сделан `CoInitializeEx`+`MFStartup` (см. spawn_encoder).
    pub fn new(width: u32, height: u32, fps: u32, bitrate_bps: u32, force_keyframe: Arc<AtomicBool>) -> Result<Self, String> {
        unsafe {
            let (transform, mft_label) = find_hardware_h264_encoder().map_err(|e| format!("no hardware H264 encoder: {e}"))?;
            log::info!("encoder: MFT «{mft_label}» {width}x{height}@{fps}, {:.1} Мбит/с", bitrate_bps as f64 / 1_000_000.0);

            // Аппаратные MFT (NVENC/AMF/QuickSync) почти всегда асинхронные — их нельзя
            // гонять голым ProcessInput/ProcessOutput без анлока и без ожидания
            // METransformNeedInput/METransformHaveOutput (иначе undefined behavior —
            // именно так ловили heap corruption на первом смоук-тесте). Синхронный MFT
            // просто не выставит MF_TRANSFORM_ASYNC=1, и мы едем по старому пути.
            let attrs = transform.GetAttributes().map_err(|e| format!("GetAttributes: {e}"))?;
            let is_async = attrs.GetUINT32(&MF_TRANSFORM_ASYNC).unwrap_or(0) != 0;
            if is_async {
                attrs.SetUINT32(&MF_TRANSFORM_ASYNC_UNLOCK, 1).map_err(|e| format!("ASYNC_UNLOCK: {e}"))?;
            }
            let event_gen: IMFMediaEventGenerator = transform.cast().map_err(|e| e.to_string())?;

            let output_type = MFCreateMediaType().map_err(|e| e.to_string())?;
            output_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
            output_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(|e| e.to_string())?;
            output_type.SetUINT32(&MF_MT_AVG_BITRATE, bitrate_bps).map_err(|e| e.to_string())?;
            output_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(|e| e.to_string())?;
            set_attr_size(&output_type, &MF_MT_FRAME_SIZE, width, height).map_err(|e| e.to_string())?;
            set_attr_ratio(&output_type, &MF_MT_FRAME_RATE, fps, 1).map_err(|e| e.to_string())?;
            set_attr_ratio(&output_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1).map_err(|e| e.to_string())?;
            // GOP задаём АТРИБУТОМ ВЫХОДНОГО ТИПА, до SetOutputType. Аппаратные MFT читают
            // конфигурацию в момент SetOutputType; `CODECAPI_AVEncMPVGOPSize`, выставленный
            // ПОСЛЕ, они молча игнорируют — энкодер оставался на дефолтном GOP=fps,
            // то есть выдавал IDR раз в секунду вместо раза в 4с (подтверждено `IDR +2` за
            // 2с-окно при `PLI +0` в net-логе вещателя).
            let want_spacing = fps.saturating_mul(GOP_SECONDS).max(1);
            output_type
                .SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, want_spacing)
                .map_err(|e| e.to_string())?;

            // ICodecAPI берём ДО SetOutputType и дублируем GOP здесь же: часть MFT читает
            // AVEncMPVGOPSize при применении выходного типа, а выставленный после — игнорирует.
            // Раньше вызов стоял после SetOutputType и был мёртвым (диаг 2026-07-25: spacing
            // «принят: 240», а IDR всё равно 0.99/с при форсе 3%, то есть печёт сам энкодер).
            let codec_api: Option<ICodecAPI> = transform.cast().ok();
            if let Some(api) = &codec_api {
                let _ = api.SetValue(&CODECAPI_AVEncMPVGOPSize, &VARIANT::from(want_spacing));
            }

            // Профиль: Main, фолбэк на Baseline. Baseline у части MFT форсит IDR раз в секунду
            // независимо от запрошенного spacing — это второй подозреваемый в шторме. B-кадры
            // остаются выключенными (AVEncMPVDefaultBPictureCount=0), поэтому инвариант 4
            // (H.264 low-latency без B-кадров, совместимость натив<->браузер<->сервер) цел:
            // Main без B-кадров декодируется теми же приёмниками, что и Baseline.
            let mut profile_used = "Main";
            output_type.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Main.0 as u32).map_err(|e| e.to_string())?;
            if let Err(e) = transform.SetOutputType(0, &output_type, 0) {
                log::warn!("encoder: «{mft_label}» отказал на Main ({e}) — фолбэк на Baseline");
                output_type.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base.0 as u32).map_err(|e| e.to_string())?;
                transform
                    .SetOutputType(0, &output_type, 0)
                    .map_err(|e| format!("SetOutputType на «{mft_label}»: {e}"))?;
                profile_used = "Baseline";
            }

            // Contingency-улика (диаг 2026-07-10): читаем фактический spacing из ПРИНЯТОГО
            // выходного типа. ВНИМАНИЕ: «принят» тут НЕ значит «применён» — MFT возвращает
            // наш же атрибут и при этом кодирует с GOP=fps (диаг 2026-07-25). Настоящую
            // проверку делает измерение интервала IDR в encode() ниже.
            match transform.GetOutputCurrentType(0) {
                Ok(cur) => {
                    let got = cur.GetUINT32(&MF_MT_MAX_KEYFRAME_SPACING).unwrap_or(0);
                    if got == want_spacing {
                        log::info!("encoder: профиль {profile_used}, keyframe-spacing заявлен {got} кадров (GOP {GOP_SECONDS}с @ {fps}fps)");
                    } else {
                        log::warn!("encoder: профиль {profile_used}, keyframe-spacing НЕ принят: факт {got}, запрошен {want_spacing} — ждём IDR=GOP=fps (шторм)");
                    }
                }
                Err(e) => log::warn!("encoder: GetOutputCurrentType для проверки spacing: {e}"),
            }

            let input_type = MFCreateMediaType().map_err(|e| e.to_string())?;
            input_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
            input_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(|e| e.to_string())?;
            input_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(|e| e.to_string())?;
            set_attr_size(&input_type, &MF_MT_FRAME_SIZE, width, height).map_err(|e| e.to_string())?;
            set_attr_ratio(&input_type, &MF_MT_FRAME_RATE, fps, 1).map_err(|e| e.to_string())?;
            set_attr_ratio(&input_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1).map_err(|e| e.to_string())?;
            transform.SetInputType(0, &input_type, 0).map_err(|e| format!("SetInputType на «{mft_label}»: {e}"))?;

            if let Some(api) = &codec_api {
                let _ = api.SetValue(&CODECAPI_AVLowLatencyMode, &VARIANT::from(true));
                let _ = api.SetValue(&CODECAPI_AVEncCommonRealTime, &VARIANT::from(true));
                let _ = api.SetValue(&CODECAPI_AVEncMPVDefaultBPictureCount, &VARIANT::from(0i32));
                let _ = api.SetValue(&CODECAPI_AVEncCommonLowLatency, &VARIANT::from(true));
                let _ = api.SetValue(&CODECAPI_AVEncCommonQualityVsSpeed, &VARIANT::from(100u32));
                // CBR вместо дефолтного VBR — статичный битрейт (не плавает с содержимым сцены),
                // предсказуемая нагрузка на дерево/TURN.
                let _ = api.SetValue(&CODECAPI_AVEncCommonRateControlMode, &VARIANT::from(eAVEncCommonRateControlMode_CBR.0));
                // Roadmap-flow-стриминга Д5: HRD-буфер ≈ 1× битрейт (1с VBV) для low-latency CBR —
                // ограничивает разброс размера кадров (без него CBR-энкодер может копить крупные
                // спайки, пробивающие слабый линк зрителя). Часть MFT (NVENC/AMF/QSV) свойство
                // игнорирует или не поддерживает — не критично, полагаемся на CBR-контроль (let _ =).
                let _ = api.SetValue(&CODECAPI_AVEncCommonBufferSize, &VARIANT::from(bitrate_bps));
                // Третий пояс GOP: софтверные MFT читают ICodecAPI в рантайме, им «после
                // SetOutputType» не мешает. Основные попытки — выше, ДО применения типа.
                let _ = api.SetValue(&CODECAPI_AVEncMPVGOPSize, &VARIANT::from(want_spacing));
            }

            let stream_info = transform.GetOutputStreamInfo(0).map_err(|e| format!("GetOutputStreamInfo: {e}"))?;
            let provides = (stream_info.dwFlags & (MFT_OUTPUT_STREAM_PROVIDES_SAMPLES.0 as u32 | MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES.0 as u32)) != 0;

            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0).map_err(|e| e.to_string())?;
            transform.ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0).map_err(|e| e.to_string())?;

            Ok(Self {
                transform,
                event_gen,
                is_async,
                need_input: 0,
                codec_api,
                fps,
                start: Instant::now(),
                output_provides_samples: provides,
                output_sample_size: stream_info.cbSize,
                force_keyframe,
                pending_forced: false,
                current_bitrate: bitrate_bps,
                gop: GopWatch::new(want_spacing, fps),
            })
        }
    }

    /// ABR (Evolution-TZ Э8): смена целевого битрейта на живом MFT без пересоздания —
    /// `CODECAPI_AVEncCommonMeanBitRate` уважается аппаратными энкодерами (NVENC/AMF/QSV)
    /// во время кодирования (тот же путь ICodecAPI::SetValue, что и force-keyframe ниже).
    /// CBR-режим сохраняется — меняется только целевая полка. No-op на неизменной цели.
    pub fn set_bitrate(&mut self, bps: u32) {
        if bps == self.current_bitrate { return; }
        match &self.codec_api {
            Some(api) => match unsafe { api.SetValue(&CODECAPI_AVEncCommonMeanBitRate, &VARIANT::from(bps)) } {
                Ok(()) => { self.current_bitrate = bps; log::info!("encoder: bitrate -> {:.1} Мбит/с", bps as f64 / 1_000_000.0); }
                Err(e) => log::warn!("encoder: set_bitrate {bps} failed: {e}"),
            },
            None => log::debug!("encoder: нет ICodecAPI — рантайм-смена битрейта недоступна"),
        }
    }

    pub fn encode(&mut self, frame: &Nv12Frame) -> Result<Vec<EncodedFrame>, String> {
        unsafe {
            if self.force_keyframe.swap(false, Ordering::Relaxed) {
                if let Some(api) = &self.codec_api {
                    let _ = api.SetValue(&CODECAPI_AVEncVideoForceKeyFrame, &VARIANT::from(true));
                }
                self.pending_forced = true; // следующий вышедший IDR — форсированный
            }

            let mut out = Vec::new();

            if self.is_async {
                // Асинхронный MFT: нельзя звать ProcessInput без предварительного
                // METransformNeedInput, ни ProcessOutput без METransformHaveOutput —
                // иначе неопределённое поведение (реальная причина heap corruption
                // на первом прогоне этого энкодера). Сначала выгребаем все уже
                // готовые события неблокирующе...
                self.pump_events(&mut out)?;
                // ...затем, если кредита на вход ещё нет, коротко ждём его (обычно
                // он уже есть после первого кадра — MFT сам поддерживает конвейер).
                // Шаг поллинга 500мкс, а не 1мкс: кредита нет ровно тогда, когда MFT
                // не поспевает, то есть под перегрузкой CPU — и тогда прежний спин
                // (sleep 1мкс + GetEvent в цикле) выжигал целое ядро, отбирая его у
                // захвата и у игры, ухудшая ровно ту ситуацию, которую пережидал.
                // 500мкс на бюджет кадра 16.6мс (60fps) — шум; спин уходит в ноль.
                // Блокирующий GetEvent(0) был бы честнее (нулевой CPU), но у него нет
                // таймаута: залипший MFT подвесил бы поток навсегда, без пути к остановке.
                // Бюджет ожидания (200мс) считаем по дедлайну, а не по числу итераций.
                const POLL_STEP: Duration = Duration::from_micros(500);
                let deadline = Instant::now() + Duration::from_millis(200);
                while self.need_input == 0 && Instant::now() < deadline {
                    std::thread::sleep(POLL_STEP);
                    self.pump_events(&mut out)?;
                }
                if self.need_input == 0 {
                    log::debug!("encoder: no NeedInput credit after 200ms, dropping frame");
                    return Ok(out);
                }
                self.need_input -= 1;
            }

            let len = frame.data.len() as u32;
            let buffer = MFCreateMemoryBuffer(len).map_err(|e| e.to_string())?;
            {
                let mut ptr: *mut u8 = std::ptr::null_mut();
                buffer.Lock(&mut ptr, None, None).map_err(|e| e.to_string())?;
                std::ptr::copy_nonoverlapping(frame.data.as_ptr(), ptr, frame.data.len());
                let _ = buffer.Unlock();
            }
            buffer.SetCurrentLength(len).map_err(|e| e.to_string())?;

            let sample = MFCreateSample().map_err(|e| e.to_string())?;
            sample.AddBuffer(&buffer).map_err(|e| e.to_string())?;
            let ts_100ns = self.start.elapsed().as_nanos() as i64 / 100;
            sample.SetSampleTime(ts_100ns).map_err(|e| e.to_string())?;
            sample.SetSampleDuration(10_000_000i64 / self.fps as i64).map_err(|e| e.to_string())?;

            match self.transform.ProcessInput(0, &sample, 0) {
                Ok(()) => {}
                Err(e) if e.code() == MF_E_NOTACCEPTING && !self.is_async => {
                    // Отстаём (только для sync-MFT — там это ожидаемый сигнал "сначала забери выход").
                    let _ = self.drain_sync(&mut out);
                    self.transform.ProcessInput(0, &sample, 0).map_err(|e| format!("ProcessInput: {e}"))?;
                }
                Err(e) => return Err(format!("ProcessInput: {e}")),
            }

            if self.is_async {
                self.pump_events(&mut out)?;
            } else {
                self.drain_sync(&mut out)?;
            }
            Ok(out)
        }
    }

    /// Неблокирующе выгребает все накопленные события async-MFT: METransformNeedInput
    /// увеличивает кредит на вход, METransformHaveOutput тут же забирается через
    /// ProcessOutput (единственный легальный момент для этого вызова у async-MFT).
    unsafe fn pump_events(&mut self, out: &mut Vec<EncodedFrame>) -> Result<(), String> {
        loop {
            let evt = match self.event_gen.GetEvent(MF_EVENT_FLAG_NO_WAIT) {
                Ok(e) => e,
                Err(_) => break, // MF_E_NO_EVENTS_AVAILABLE — событий пока нет
            };
            let ty = evt.GetType().unwrap_or(0);
            if ty == METransformNeedInput.0 as u32 {
                self.need_input += 1;
            } else if ty == METransformHaveOutput.0 as u32 {
                self.pull_output(out)?;
            }
            // остальные типы событий (METransformDrainComplete и т.п.) не используем
        }
        Ok(())
    }

    /// Синхронный MFT (редкость на практике для H.264, но на всякий случай): тут
    /// разрешено звать ProcessOutput в цикле без событий, до MF_E_TRANSFORM_NEED_MORE_INPUT.
    unsafe fn drain_sync(&mut self, out: &mut Vec<EncodedFrame>) -> Result<(), String> {
        loop {
            match self.pull_output(out) {
                Ok(true) => continue,
                Ok(false) => break,
                Err(e) => return Err(e),
            }
        }
        Ok(())
    }

    /// Один вызов ProcessOutput. Возвращает Ok(true), если был выход (стоит звать
    /// ещё раз в sync-режиме), Ok(false) на MF_E_TRANSFORM_NEED_MORE_INPUT.
    unsafe fn pull_output(&mut self, out: &mut Vec<EncodedFrame>) -> Result<bool, String> {
        let mut own_sample: Option<IMFSample> = None;
        if !self.output_provides_samples {
            let sample = MFCreateSample().map_err(|e| e.to_string())?;
            let mem_buf = MFCreateMemoryBuffer(self.output_sample_size.max(1)).map_err(|e| e.to_string())?;
            sample.AddBuffer(&mem_buf).map_err(|e| e.to_string())?;
            own_sample = Some(sample);
        }
        let mut buffer_desc = MFT_OUTPUT_DATA_BUFFER {
            dwStreamID: 0,
            pSample: std::mem::ManuallyDrop::new(own_sample),
            dwStatus: 0,
            pEvents: std::mem::ManuallyDrop::new(None),
        };

        let mut status: u32 = 0;
        let buffers = std::slice::from_mut(&mut buffer_desc);
        let hr = self.transform.ProcessOutput(0, buffers, &mut status);
        let got_sample = std::mem::ManuallyDrop::into_inner(buffer_desc.pSample);

        match hr {
            Ok(()) => {
                if let Some(sample) = got_sample {
                    if let Ok(contig) = sample.ConvertToContiguousBuffer() {
                        let mut ptr: *mut u8 = std::ptr::null_mut();
                        let mut len: u32 = 0;
                        if contig.Lock(&mut ptr, None, Some(&mut len)).is_ok() {
                            let data = std::slice::from_raw_parts(ptr, len as usize).to_vec();
                            let _ = contig.Unlock();
                            let is_key = sample.GetUINT32(&MFSampleExtension_CleanPoint).unwrap_or(0) != 0;
                            // Форс-запрос ловит первый вышедший IDR; периодические GOP-IDR идут
                            // с pending_forced=false.
                            let forced = is_key && self.pending_forced;
                            if forced { self.pending_forced = false; }
                            if let Some(w) = self.gop.on_frame(is_key, forced) { log::warn!("{w}"); }
                            out.push(EncodedFrame { data, is_keyframe: is_key, forced });
                        }
                    }
                }
                Ok(true)
            }
            Err(e) if e.code() == MF_E_TRANSFORM_NEED_MORE_INPUT => Ok(false),
            Err(e) if e.code() == MF_E_TRANSFORM_STREAM_CHANGE => Ok(true),
            Err(e) => Err(format!("ProcessOutput: {e}")),
        }
    }
}

/// Измеритель ФАКТИЧЕСКОГО интервала IDR. Заявленный `MF_MT_MAX_KEYFRAME_SPACING` ничего
/// не доказывает: MFT возвращает наш же атрибут через `GetOutputCurrentType` и при этом
/// кодирует с GOP=fps (диаг 2026-07-25 — «принят: 240» при 0.99 IDR/с и форсе 3%).
/// Единственная честная проверка — считать кадры между keyframe на выходе.
#[derive(Debug)]
struct GopWatch {
    want_spacing: u32,
    fps: u32,
    frames_since_key: u32,
    short_spans: u32,
    warned: bool,
}

impl GopWatch {
    fn new(want_spacing: u32, fps: u32) -> Self {
        Self { want_spacing, fps, frames_since_key: 0, short_spans: 0, warned: false }
    }

    /// Возвращает текст предупреждения РОВНО ОДИН РАЗ за сессию — при трёх подряд коротких
    /// интервалах. Форсированные keyframe (PLI/tree-сигналинг/реинит MFT) законно рвут GOP:
    /// они только перезапускают счётчик, интервал по ним не засчитывается. Один раз — чтобы
    /// не залить лог: шторм это ~1 keyframe в секунду.
    fn on_frame(&mut self, is_key: bool, forced: bool) -> Option<String> {
        if !is_key {
            self.frames_since_key = self.frames_since_key.saturating_add(1);
            return None;
        }
        // +1: сам keyframe закрывает период. Без него интервал занижался на кадр (60 кадров
        // GOP читались как 59) и «IDR/с» в предупреждении не совпадал с net-логом.
        let span = self.frames_since_key + 1;
        self.frames_since_key = 0;
        if forced || self.warned || span <= 1 { return None; }
        if span * 2 >= self.want_spacing {
            self.short_spans = 0;
            return None;
        }
        self.short_spans += 1;
        if self.short_spans < 3 { return None; }
        self.warned = true;
        Some(format!(
            "encoder: MFT игнорирует GOP — фактический интервал IDR {span} кадров вместо {} ({:.2} IDR/с при {} fps). Каждый IDR ~200-300 КБ: залповые бёрсты у зрителей.",
            self.want_spacing,
            self.fps as f64 / span.max(1) as f64,
            self.fps,
        ))
    }
}

impl Drop for H264Encoder {
    fn drop(&mut self) {
        unsafe {
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
            let _ = self.transform.ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
        }
    }
}

/// `MFSetAttributeSize`/`MFSetAttributeRatio` — inline-макросы в mfapi.h, у
/// windows-rs как реальных экспортов нет (не DLL-символы). Пакуем вручную,
/// как это делает сам макрос: (high << 32) | low в один UINT64.
unsafe fn set_attr_size(attrs: &IMFMediaType, key: &windows::core::GUID, width: u32, height: u32) -> WinResult<()> {
    attrs.SetUINT64(key, ((width as u64) << 32) | (height as u64))
}
unsafe fn set_attr_ratio(attrs: &IMFMediaType, key: &windows::core::GUID, num: u32, den: u32) -> WinResult<()> {
    attrs.SetUINT64(key, ((num as u64) << 32) | (den as u64))
}

/// Требует ли кандидат подключённого D3D-девайса. Такой MFT (обычно Intel
/// QuickSync-подобный) без `IMFDXGIDeviceManager` — а мы его не создаём, весь
/// пайплайн на CPU-памяти, см. capture.rs — откажет на `SetOutputType` с
/// `MF_E_UNSUPPORTED_D3D_TYPE` (0xC00D6D76).
unsafe fn is_d3d_aware(a: &IMFActivate) -> bool {
    a.GetUINT32(&MF_SA_D3D11_AWARE).unwrap_or(0) != 0 || a.GetUINT32(&MF_SA_D3D_AWARE).unwrap_or(0) != 0
}

/// Имя MFT для логов: без него «init failed» не говорит, КАКОЙ энкодер отказал,
/// а вендорский и софтверный ломаются по-разному.
unsafe fn activate_label(a: &IMFActivate) -> String {
    let mut buf = windows::core::PWSTR::null();
    let mut len: u32 = 0;
    if a.GetAllocatedString(&MFT_FRIENDLY_NAME_Attribute, &mut buf, &mut len).is_ok() && !buf.is_null() {
        let s = buf.to_string().unwrap_or_else(|_| "<нечитаемое имя>".into());
        CoTaskMemFree(Some(buf.as_ptr() as *const core::ffi::c_void));
        return s;
    }
    "<без имени>".into()
}

/// Перечисляет MFT по флагам и активирует первый подходящий.
/// `allow_d3d_aware=false` отбрасывает кандидатов, которым нужен D3D-manager.
unsafe fn pick_h264_encoder(flags: MFT_ENUM_FLAG, allow_d3d_aware: bool) -> Option<(IMFTransform, String)> {
    let input_info = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
    let output_info = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };

    let mut activates_ptr: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count: u32 = 0;
    if let Err(e) = MFTEnumEx(
        MFT_CATEGORY_VIDEO_ENCODER,
        flags | MFT_ENUM_FLAG_SORTANDFILTER,
        Some(&input_info),
        Some(&output_info),
        &mut activates_ptr,
        &mut count,
    ) {
        log::warn!("encoder: MFTEnumEx(flags={:#x}): {e}", flags.0);
        return None;
    }
    if activates_ptr.is_null() || count == 0 {
        if !activates_ptr.is_null() { CoTaskMemFree(Some(activates_ptr as *const core::ffi::c_void)); }
        return None;
    }

    let activates = std::slice::from_raw_parts(activates_ptr, count as usize);
    let mut picked: Option<(IMFTransform, String)> = None;
    let mut picked_index: Option<usize> = None;
    for (i, act) in activates.iter().enumerate() {
        if let Some(a) = act {
            if !allow_d3d_aware && is_d3d_aware(a) { continue; }
            let label = activate_label(a);
            // ActivateObject аппаратного MFT отказывает, пока предыдущий инстанс
            // (переиниt после ресайза окна / перезапуск вещания) ещё не отпущен
            // драйвером — это и есть окно, в котором мы раньше сваливались в
            // D3D-aware фолбэк и получали 0xC00D6D76.
            match a.ActivateObject::<IMFTransform>() {
                Ok(t) => { picked = Some((t, label)); picked_index = Some(i); break; }
                Err(e) => log::warn!("encoder: ActivateObject «{label}»: {e}"),
            }
        }
    }
    // ShutdownObject() уничтожает нижележащий MFT — звать его только для
    // НЕиспользованных activate'ов. Для того, чей IMFTransform мы забираем
    // и возвращаем вызывающему, это привело бы к MF_E_SHUTDOWN на первом же
    // GetEvent (реальная причина heap corruption на первом прогоне).
    for (i, act) in activates.iter().enumerate() {
        if Some(i) == picked_index { continue; }
        if let Some(a) = act { let _ = a.ShutdownObject(); }
    }
    CoTaskMemFree(Some(activates_ptr as *const core::ffi::c_void));
    picked
}

/// Порядок выбора: аппаратный без D3D-manager -> СОФТВЕРНЫЙ -> аппаратный
/// D3D-aware последней надеждой. Софтверный (Microsoft H264 Encoder MFT) берёт
/// system-memory сэмплы, поэтому 0xC00D6D76 на нём структурно невозможен: он
/// стоит ВЫШЕ D3D-aware, иначе именно тот подхватывался в фолбэке и рвал
/// вещание насмерть (диаг 2026-07-25: 22 обрыва у leva/kiprol).
unsafe fn find_hardware_h264_encoder() -> WinResult<(IMFTransform, String)> {
    if let Some(p) = pick_h264_encoder(MFT_ENUM_FLAG_HARDWARE, false) { return Ok(p); }
    if let Some((t, l)) = pick_h264_encoder(MFT_ENUM_FLAG_SYNCMFT | MFT_ENUM_FLAG_ASYNCMFT | MFT_ENUM_FLAG_LOCALMFT, false) {
        log::warn!("encoder: аппаратный MFT недоступен, софтверный фолбэк «{l}» (CPU-нагрузка выше)");
        return Ok((t, l));
    }
    if let Some((t, l)) = pick_h264_encoder(MFT_ENUM_FLAG_HARDWARE, true) {
        log::warn!("encoder: только D3D-aware MFT «{l}» — без DXGI-manager вероятен MF_E_UNSUPPORTED_D3D_TYPE");
        return Ok((t, l));
    }
    Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))
}

#[cfg(test)]
mod tests {
    use super::GopWatch;

    /// Гоняет `n` кадров: keyframe на каждом `span`-м, остальные — inter.
    fn run(w: &mut GopWatch, span: u32, keys: u32) -> Vec<String> {
        let mut out = Vec::new();
        for _ in 0..keys {
            for _ in 1..span {
                if let Some(m) = w.on_frame(false, false) { out.push(m); }
            }
            if let Some(m) = w.on_frame(true, false) { out.push(m); }
        }
        out
    }

    #[test]
    fn honest_gop_stays_quiet() {
        // Запрошено 240 кадров, MFT честно даёт 240 — ни одного предупреждения.
        let mut w = GopWatch::new(240, 60);
        assert!(run(&mut w, 240, 5).is_empty());
    }

    #[test]
    fn gop_ignored_warns_once() {
        // Запрошено 240, фактически IDR каждые 60 кадров (GOP=fps) — ровно одно
        // предупреждение и только после ТРЁХ коротких интервалов подряд.
        let mut w = GopWatch::new(240, 60);
        let msgs = run(&mut w, 60, 10);
        assert_eq!(msgs.len(), 1, "ждём один warn за сессию, получили {msgs:?}");
        assert!(msgs[0].contains("60 кадров вместо 240"), "{}", msgs[0]);
        assert!(msgs[0].contains("1.00 IDR/с"), "{}", msgs[0]);
    }

    #[test]
    fn forced_keyframes_do_not_accuse_mft() {
        // PLI-шторм: keyframe каждые 10 кадров, но все форсированные. Это НАША работа,
        // а не игнор GOP — детектор молчит (иначе мы бы чинили не то место).
        let mut w = GopWatch::new(240, 60);
        for _ in 0..20 {
            for _ in 1..10 {
                assert!(w.on_frame(false, false).is_none());
            }
            assert!(w.on_frame(true, true).is_none());
        }
    }

    #[test]
    fn short_span_streak_must_be_consecutive() {
        // Два коротких интервала, затем честный — счётчик сбрасывается, warn не выходит.
        let mut w = GopWatch::new(240, 60);
        assert!(run(&mut w, 60, 2).is_empty());
        assert!(run(&mut w, 240, 1).is_empty());
        assert!(run(&mut w, 60, 2).is_empty());
    }
}
