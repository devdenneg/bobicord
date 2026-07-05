// Захват звука игры/системы через WASAPI process loopback, EXCLUDE-режим
// (CLAUDE.md инвариант 6): исключаем собственный процесс (и его дерево) из
// захватываемого микса, чтобы голос из войса и чужие стримы не попадали в
// исходящий видеопоток (иначе эхо/петля). Микрофон сюда не подключается вовсе
// (инвариант 5) — это отдельный, WASAPI render-loopback путь.
//
// ИЗВЕСТНЫЙ БАГ (не пофикшен, изолирован): `activate_process_loopback_exclude_self()`
// стабильно валит процесс STATUS_HEAP_CORRUPTION вскоре после успешного
// ActivateAudioInterfaceAsync/GetActivateResult (воспроизводится через
// `cargo run --example audio_smoke`, крэш переживает даже явные `drop(op)`/`drop(handler)`
// до возврата — похоже на повреждение, отложенно детектящееся на следующей heap-операции,
// а не на сам вызов). Проверено и ИСКЛЮЧЕНО как причина: отсутствие CoInitializeEx у
// вызывающего потока (нашёл и починил отдельный баг в тестовом харнессе, не в этом файле);
// IAgileObject — `#[implement]` уже агильный по умолчанию (windows-implement 0.60.2,
// `agile: true` в ImplementAttributes), добавление отдельного `IAgileObject` в список
// интерфейсов не компилируется и не нужно. Пайплайн видео (Э5 AC) не зависит от этого —
// поток отключён по умолчанию в mod.rs (`RELAYAPP_ENABLE_AUDIO=1` чтобы включить и отлаживать).
// Следующий шаг отладки: WinDbg/Application Verifier на реальном месте порчи, либо
// переписать PROPVARIANT/BLOB-конструирование через сырые байты вместо вложенных union.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use windows::core::{implement, Interface, Ref, Result as WinResult, HRESULT};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX,
};
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Com::BLOB;
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject, INFINITE};
use windows::Win32::System::Variant::VT_BLOB;

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct CompletionHandler {
    event: HANDLE,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for CompletionHandler_Impl {
    fn ActivateCompleted(&self, _op: Ref<IActivateAudioInterfaceAsyncOperation>) -> WinResult<()> {
        unsafe { let _ = SetEvent(self.event); }
        Ok(())
    }
}

/// Активирует process-loopback IAudioClient, исключая наш собственный PID
/// (и дочерние процессы) из захватываемого микса.
unsafe fn activate_process_loopback_exclude_self() -> WinResult<IAudioClient> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: std::process::id(),
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };

    let mut prop = PROPVARIANT::default();
    prop.Anonymous.Anonymous = std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
        vt: VT_BLOB,
        wReserved1: 0,
        wReserved2: 0,
        wReserved3: 0,
        Anonymous: PROPVARIANT_0_0_0 {
            blob: BLOB {
                cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                pBlobData: &mut params as *mut _ as *mut u8,
            },
        },
    });

    let event = CreateEventW(None, true, false, None)?;
    let handler: IActivateAudioInterfaceCompletionHandler = CompletionHandler { event }.into();

    let op = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&prop as *const _), &handler)?;

    WaitForSingleObject(event, INFINITE);
    let _ = CloseHandle(event);

    let mut hr = HRESULT(0);
    let mut iface: Option<windows::core::IUnknown> = None;
    op.GetActivateResult(&mut hr, &mut iface)?;
    hr.ok()?;
    iface.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?.cast::<IAudioClient>()
}

/// `wBitsPerSample==32` в engine mix-формате на практике всегда IEEE float
/// (WASAPI shared-mode), `==16` — PCM int. Без разбора WAVEFORMATEXTENSIBLE.SubFormat.
fn is_float_format(fmt: &WAVEFORMATEX) -> bool {
    fmt.wBitsPerSample == 32
}

fn bytes_to_i16_stereo(raw: &[u8], fmt: &WAVEFORMATEX) -> Vec<i16> {
    let channels = fmt.nChannels as usize;
    let bytes_per_sample = (fmt.wBitsPerSample / 8) as usize;
    let float = is_float_format(fmt);
    let frame_count = raw.len() / (bytes_per_sample * channels.max(1));
    let mut out = Vec::with_capacity(frame_count * 2);
    for i in 0..frame_count {
        let base = i * bytes_per_sample * channels;
        let mut lr = [0i16; 2];
        for ch in 0..2.min(channels) {
            let off = base + ch * bytes_per_sample;
            let s = if float {
                let f = f32::from_le_bytes(raw[off..off + 4].try_into().unwrap());
                (f.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
            } else {
                i16::from_le_bytes(raw[off..off + 2].try_into().unwrap())
            };
            lr[ch] = s;
        }
        if channels == 1 { lr[1] = lr[0]; }
        out.push(lr[0]);
        out.push(lr[1]);
    }
    out
}

/// Линейная передискретизация interleaved-стерео i16 в 48кГц — большинство
/// WASAPI-движков и так отдают 48000, это резервный путь на случай другого mix-формата.
fn resample_stereo(input: &[i16], src_rate: u32, dst_rate: u32) -> Vec<i16> {
    if src_rate == dst_rate || input.is_empty() { return input.to_vec(); }
    let src_frames = input.len() / 2;
    let dst_frames = (src_frames as u64 * dst_rate as u64 / src_rate as u64) as usize;
    let mut out = Vec::with_capacity(dst_frames * 2);
    for i in 0..dst_frames {
        let src_pos = i as f64 * src_rate as f64 / dst_rate as f64;
        let idx = src_pos as usize;
        let idx = idx.min(src_frames.saturating_sub(1));
        out.push(input[idx * 2]);
        out.push(input[idx * 2 + 1]);
    }
    out
}

pub struct OpusChunk {
    pub data: Vec<u8>,
}

/// Захватывает системный звук (без нашего процесса) в отдельном потоке, кодирует
/// в Opus 48kHz/stereo/20ms-фреймами, зовёт `on_chunk` на каждый готовый пакет.
/// Поток блокирующий (WASAPI + COM) — не гонять на tokio-воркере.
pub fn run_capture_loop(stop: Arc<AtomicBool>, mut on_chunk: impl FnMut(OpusChunk)) -> Result<(), String> {
    const FRAME_SAMPLES: usize = 960; // 20ms @ 48kHz

    unsafe {
        eprintln!("[audio] activating...");
        let client = activate_process_loopback_exclude_self().map_err(|e| format!("activate loopback: {e}"))?;
        eprintln!("[audio] activated, GetMixFormat...");
        let fmt_ptr = client.GetMixFormat().map_err(|e| format!("GetMixFormat: {e}"))?;
        let fmt = *fmt_ptr;
        let src_rate = fmt.nSamplesPerSec;
        let (ch, hz, bits, cbsz) = (fmt.nChannels, fmt.nSamplesPerSec, fmt.wBitsPerSample, fmt.cbSize);
        eprintln!("[audio] mix format: {ch}ch {hz}Hz {bits}bit cbSize={cbsz}");

        client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 10_000_000, 0, fmt_ptr, None)
            .map_err(|e| format!("IAudioClient::Initialize: {e}"))?;
        eprintln!("[audio] initialized, GetService...");
        let capture_client: IAudioCaptureClient = client.GetService().map_err(|e| format!("GetService: {e}"))?;
        eprintln!("[audio] got capture client, Start...");
        client.Start().map_err(|e| format!("IAudioClient::Start: {e}"))?;
        eprintln!("[audio] started, creating opus encoder...");

        let encoder = audiopus::coder::Encoder::new(
            audiopus::SampleRate::Hz48000,
            audiopus::Channels::Stereo,
            audiopus::Application::Audio,
        ).map_err(|e| format!("opus encoder: {e}"))?;
        eprintln!("[audio] opus encoder ready, entering capture loop");

        let mut pcm_buf: Vec<i16> = Vec::new();
        let mut opus_out = vec![0u8; 4000];

        while !stop.load(Ordering::Relaxed) {
            let packet_len = match capture_client.GetNextPacketSize() {
                Ok(n) => n,
                Err(_) => break,
            };
            if packet_len == 0 {
                std::thread::sleep(std::time::Duration::from_millis(5));
                continue;
            }
            let mut data_ptr: *mut u8 = std::ptr::null_mut();
            let mut frames: u32 = 0;
            let mut flags: u32 = 0;
            if capture_client.GetBuffer(&mut data_ptr, &mut frames, &mut flags, None, None).is_err() {
                break;
            }
            let bytes_per_frame = (fmt.nChannels as usize) * (fmt.wBitsPerSample as usize / 8);
            let silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
            let stereo_i16 = if silent || data_ptr.is_null() {
                vec![0i16; frames as usize * 2]
            } else {
                let raw = std::slice::from_raw_parts(data_ptr, frames as usize * bytes_per_frame);
                bytes_to_i16_stereo(raw, &fmt)
            };
            let _ = capture_client.ReleaseBuffer(frames);

            let resampled = resample_stereo(&stereo_i16, src_rate, 48000);
            pcm_buf.extend_from_slice(&resampled);

            while pcm_buf.len() >= FRAME_SAMPLES * 2 {
                let frame: Vec<i16> = pcm_buf.drain(0..FRAME_SAMPLES * 2).collect();
                match encoder.encode(&frame, &mut opus_out) {
                    Ok(len) => on_chunk(OpusChunk { data: opus_out[..len].to_vec() }),
                    Err(e) => log::warn!("opus encode error: {e}"),
                }
            }
        }

        let _ = client.Stop();
    }
    Ok(())
}
