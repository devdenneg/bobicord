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
    /// Текущий целевой средний битрейт — чтобы `set_bitrate` пропускал no-op (ABR шлёт
    /// цель каждый тик, но реально меняется она редко). Меняется на лету через ICodecAPI
    /// без пересоздания MFT.
    current_bitrate: u32,
}

unsafe impl Send for H264Encoder {}

impl H264Encoder {
    /// `bitrate_bps` — целевой средний битрейт; вызывать из потока, где уже
    /// сделан `CoInitializeEx`+`MFStartup` (см. spawn_encoder).
    pub fn new(width: u32, height: u32, fps: u32, bitrate_bps: u32, force_keyframe: Arc<AtomicBool>) -> Result<Self, String> {
        unsafe {
            let transform = find_hardware_h264_encoder().map_err(|e| format!("no hardware H264 encoder: {e}"))?;

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
            output_type.SetUINT32(&MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_Base.0 as u32).map_err(|e| e.to_string())?;
            // GOP задаём АТРИБУТОМ ВЫХОДНОГО ТИПА, до SetOutputType. Аппаратные MFT читают
            // конфигурацию в момент SetOutputType; `CODECAPI_AVEncMPVGOPSize`, выставленный
            // ПОСЛЕ (см. ниже), они молча игнорируют — энкодер оставался на дефолтном GOP=fps,
            // то есть выдавал IDR раз в секунду вместо раза в 4с (подтверждено `IDR +2` за
            // 2с-окно при `PLI +0` в net-логе вещателя).
            output_type
                .SetUINT32(&MF_MT_MAX_KEYFRAME_SPACING, fps.saturating_mul(GOP_SECONDS).max(1))
                .map_err(|e| e.to_string())?;
            transform.SetOutputType(0, &output_type, 0).map_err(|e| format!("SetOutputType: {e}"))?;

            let input_type = MFCreateMediaType().map_err(|e| e.to_string())?;
            input_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
            input_type.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12).map_err(|e| e.to_string())?;
            input_type.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(|e| e.to_string())?;
            set_attr_size(&input_type, &MF_MT_FRAME_SIZE, width, height).map_err(|e| e.to_string())?;
            set_attr_ratio(&input_type, &MF_MT_FRAME_RATE, fps, 1).map_err(|e| e.to_string())?;
            set_attr_ratio(&input_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1).map_err(|e| e.to_string())?;
            transform.SetInputType(0, &input_type, 0).map_err(|e| format!("SetInputType: {e}"))?;

            let codec_api: Option<ICodecAPI> = transform.cast().ok();
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
                // Дубль GOP через ICodecAPI. Основной путь — MF_MT_MAX_KEYFRAME_SPACING на
                // выходном типе (выше): здесь мы уже ПОСЛЕ SetOutputType, и аппаратные MFT это
                // значение игнорируют. Оставлено для софтверных MFT, которые читают ICodecAPI
                // в рантайме; вреда нет, значение то же (let _ = — свойство опционально).
                let _ = api.SetValue(&CODECAPI_AVEncMPVGOPSize, &VARIANT::from(fps.saturating_mul(GOP_SECONDS).max(1)));
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
                current_bitrate: bitrate_bps,
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
                            out.push(EncodedFrame { data, is_keyframe: is_key });
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

unsafe fn find_hardware_h264_encoder() -> WinResult<IMFTransform> {
    let input_info = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_NV12 };
    let output_info = MFT_REGISTER_TYPE_INFO { guidMajorType: MFMediaType_Video, guidSubtype: MFVideoFormat_H264 };

    let mut activates_ptr: *mut Option<IMFActivate> = std::ptr::null_mut();
    let mut count: u32 = 0;
    MFTEnumEx(
        MFT_CATEGORY_VIDEO_ENCODER,
        MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
        Some(&input_info),
        Some(&output_info),
        &mut activates_ptr,
        &mut count,
    )?;

    let mut picked: Option<IMFTransform> = None;
    let mut picked_index: Option<usize> = None;

    if !activates_ptr.is_null() && count > 0 {
        let activates = std::slice::from_raw_parts(activates_ptr, count as usize);
        // Кандидат, требующий D3D (MF_SA_D3D11_AWARE/MF_SA_D3D_AWARE) — обычно
        // Intel QuickSync-подобный MFT — без подключённого IMFDXGIDeviceManager
        // (мы его не создаём, весь пайплайн на CPU-памяти, см. capture.rs) откажет
        // на SetOutputType/SetInputType с MF_E_UNSUPPORTED_D3D_TYPE (0xC00D6D76).
        // Пропускаем такие, берём первый MFT, который берёт system-memory сэмплы
        // (обычно NVENC-подобный) — это то, что реально проверено E2E.
        let is_d3d_aware = |a: &IMFActivate| {
            a.GetUINT32(&MF_SA_D3D11_AWARE).unwrap_or(0) != 0 || a.GetUINT32(&MF_SA_D3D_AWARE).unwrap_or(0) != 0
        };
        for (i, act) in activates.iter().enumerate() {
            if let Some(a) = act {
                if is_d3d_aware(a) { continue; }
                if let Ok(t) = a.ActivateObject::<IMFTransform>() {
                    picked = Some(t);
                    picked_index = Some(i);
                    break;
                }
            }
        }
        // Ни одного не-D3D-aware кандидата не нашлось (например, только встроенная
        // Intel-графика без дискретной) — берём первый попавшийся D3D-aware как
        // раньше; без D3D-manager он, скорее всего, тоже упадёт на SetOutputType,
        // но так хотя бы не молчим о самой аппаратной кодировке как таковой.
        if picked.is_none() {
            for (i, act) in activates.iter().enumerate() {
                if let Some(a) = act {
                    if let Ok(t) = a.ActivateObject::<IMFTransform>() {
                        picked = Some(t);
                        picked_index = Some(i);
                        break;
                    }
                }
            }
        }
        // ShutdownObject() уничтожает нижележащий MFT — звать его только для
        // НЕиспользованных activate'ов. Для того, чей IMFTransform мы забираем
        // и возвращаем вызывающему, это привело бы к MF_E_SHUTDOWN на первом же
        // GetEvent (реальная причина heap corruption на первом прогоне).
        for (i, act) in activates.iter().enumerate() {
            if Some(i) == picked_index { continue; }
            if let Some(a) = act {
                let _ = a.ShutdownObject();
            }
        }
        CoTaskMemFree(Some(activates_ptr as *const core::ffi::c_void));
    }

    let result = picked.ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
    result
}
