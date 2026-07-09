// Захват звука игры/системы через WASAPI process loopback (CLAUDE.md инвариант 6):
// в стрим уходит весь звук приложений/игр, КРОМЕ вывода самого RelayApp (голос
// войса, чужие стримы), иначе эхо/петля. Микрофон сюда не подключается вовсе
// (инвариант 5) — это отдельный путь.
//
// СТРАТЕГИЯ (почему не один EXCLUDE-клиент). Process-loopback API берёт только
// ОДИН PID+дерево. `EXCLUDE(self tree)` промахивается, когда аудио-подпроцесс
// WebView2 (голос войса) не в дереве нашего процесса — на части машин так и есть,
// голос эхом уходил в стрим. `INCLUDE(pid игры)` надёжно режет чужое, но даёт
// тишину, когда звук игры родится в соседнем процессе (лаунчер/движок/античит).
// Здесь: перечисляем активные render-аудиосессии, вычитаем НАШИ процессы
// (`self_pid_set`), и на КАЖДЫЙ оставшийся PID поднимаем отдельный INCLUDE-loopback
// клиент, микшируя их PCM (`Mixer`). Не зависит от топологии WebView2 и не требует
// выбора процесса юзером. Периодическое переперечисление (~1с) ловит игры,
// зазвучавшие после старта. `IncludeProcess(pid)` остаётся ручным override.
//
// ИСТОРИЯ БАГА (пофикшен): `activate` валил процесс STATUS_HEAP_CORRUPTION вскоре
// после успешного GetActivateResult. Причина — синхронизация с completion-хендлером
// через сырой Win32 `HANDLE` (CreateEventW/SetEvent/WaitForSingleObject/CloseHandle):
// CloseHandle звался сразу после разблокировки ожидающего потока, гоняясь с
// завершением самого callback-вызова (`ActivateCompleted`) на thread-pool потоке.
// Сверено с рабочей реализацией того же API в `wasapi-rs` (HEnquist/wasapi-rs) —
// синхронизация через `Arc<(Mutex<bool>, Condvar)>` (никаких Win32-хендлов).
// Заодно: `PROPVARIANT`/`AUDIOCLIENT_ACTIVATION_PARAMS` явно `Pin`+`ManuallyDrop`.
use std::collections::{HashMap, HashSet, VecDeque};
use std::mem::ManuallyDrop;
use std::ops::Deref;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use windows::core::{implement, Interface, Ref, Result as WinResult, PWSTR, HRESULT};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{
    eConsole, eRender, ActivateAudioInterfaceAsync, AudioSessionStateActive,
    IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
    IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator, MMDeviceEnumerator,
    AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX,
};
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, BLOB, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::System::Variant::VT_BLOB;

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: usize = 2;
const FRAME_SAMPLES: usize = 960; // 20ms @ 48kHz (на канал)
const FRAME_INTERLEAVED: usize = FRAME_SAMPLES * CHANNELS; // 1920 (Opus-кадр стерео)

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct CompletionHandler(Arc<(Mutex<bool>, Condvar)>);

impl IActivateAudioInterfaceCompletionHandler_Impl for CompletionHandler_Impl {
    fn ActivateCompleted(&self, _op: Ref<IActivateAudioInterfaceAsyncOperation>) -> WinResult<()> {
        let (lock, cvar) = &*self.0;
        let mut done = lock.lock().unwrap();
        *done = true;
        drop(done);
        cvar.notify_one();
        Ok(())
    }
}

/// Источник аудио. `ExcludeSelfViaInclude` (дефолт) — авто: перечислить все не-наши
/// render-сессии, INCLUDE каждую, микшировать. `IncludeProcess(pid)` — ручной
/// override на один процесс (одиночный клиент, без enumeration/self-фильтра).
#[derive(Clone, Copy)]
pub enum AudioSource {
    ExcludeSelfViaInclude,
    IncludeProcess(u32),
}

/// Активирует process-loopback IAudioClient в INCLUDE-режиме на указанный процесс
/// (и его дерево). Мы никогда не используем EXCLUDE-режим — вместо «исключить себя»
/// поднимаем по INCLUDE-клиенту на каждый не-наш процесс (см. заголовок файла).
unsafe fn activate_include_loopback(pid: u32) -> WinResult<IAudioClient> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    let pinned_params = Pin::new(&mut params);

    let raw_prop = PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: std::ptr::from_mut(pinned_params.get_mut()).cast(),
                    },
                },
            }),
        },
    };
    let activation_prop = ManuallyDrop::new(raw_prop);
    let pinned_prop = Pin::new(activation_prop.deref());
    let activation_params = Some(std::ptr::from_ref(pinned_prop.get_ref()));

    let setup = Arc::new((Mutex::new(false), Condvar::new()));
    let handler: IActivateAudioInterfaceCompletionHandler = CompletionHandler(setup.clone()).into();

    let op = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        &IAudioClient::IID,
        activation_params,
        &handler,
    )?;

    let (lock, cvar) = &*setup;
    let mut done = lock.lock().unwrap();
    while !*done {
        done = cvar.wait(done).unwrap();
    }
    drop(done);

    let mut hr = HRESULT(0);
    let mut iface: Option<windows::core::IUnknown> = None;
    op.GetActivateResult(&mut hr, &mut iface)?;
    hr.ok()?;
    iface.ok_or(windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?.cast::<IAudioClient>()
}

/// Формат для Initialize process-loopback клиента. Сам клиент (AudioSes!CMixerClient)
/// не реализует GetMixFormat (E_NOTIMPL) — это задокументированное поведение режима.
/// Строим вручную: IEEE float стерео 48кГц (совпадает с обычным shared-mode mix
/// format на практике). Единый формат у ВСЕХ клиентов — микс без пересэмплинга.
fn loopback_format() -> WAVEFORMATEX {
    const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
        nChannels: CHANNELS as u16,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * 2 * 4,
        nBlockAlign: 2 * 4,
        wBitsPerSample: 32,
        cbSize: 0,
    }
}

/// `wBitsPerSample==32` в mix-формате на практике всегда IEEE float (WASAPI
/// shared-mode), `==16` — PCM int. Без разбора WAVEFORMATEXTENSIBLE.SubFormat.
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

pub struct OpusChunk {
    pub data: Vec<u8>,
}

/// Общий mix-буфер: по interleaved-стерео i16 очереди на каждый источник (PID).
/// Клиентские потоки `push`-ат свой PCM; mixer-поток `pull`-ит выровненный по
/// wall-clock кадр, суммируя фронты очередей (отсутствующие/отставшие — тишиной).
/// Очередь ограничена ~200мс: клиент, чей endpoint-clock чуть быстрее нашего
/// 20мс-пейсинга, копил бы задержку — при переполнении дропаем старейшее.
struct Mixer {
    queues: HashMap<u32, VecDeque<i16>>,
}

impl Mixer {
    const QUEUE_CAP: usize = (SAMPLE_RATE as usize) * CHANNELS / 5; // 200ms

    fn new() -> Self {
        Self { queues: HashMap::new() }
    }

    fn push(&mut self, pid: u32, samples: &[i16]) {
        let q = self.queues.entry(pid).or_default();
        q.extend(samples.iter().copied());
        if q.len() > Self::QUEUE_CAP {
            let drop = q.len() - Self::QUEUE_CAP;
            q.drain(0..drop);
        }
    }

    fn remove(&mut self, pid: u32) {
        self.queues.remove(&pid);
    }

    /// Снять `n` interleaved-сэмплов: сумма фронтов всех очередей, i32-аккумулятор,
    /// clamp в i16. Очередь короче `n` (источник молчал/отстал) вносит вклад только
    /// на свою длину — остаток остаётся тишиной. Ноль очередей → тишина.
    fn pull(&mut self, n: usize) -> Vec<i16> {
        let mut acc = vec![0i32; n];
        for q in self.queues.values_mut() {
            let take = n.min(q.len());
            for slot in acc.iter_mut().take(take) {
                *slot += q.pop_front().unwrap() as i32;
            }
        }
        acc.into_iter()
            .map(|v| v.clamp(i16::MIN as i32, i16::MAX as i32) as i16)
            .collect()
    }
}

struct ClientHandle {
    stop: Arc<AtomicBool>,
    dead: Arc<AtomicBool>,
    join: std::thread::JoinHandle<()>,
}

/// Тело одного loopback-клиента: активирует INCLUDE(pid), читает пакеты и пушит
/// interleaved-стерео i16 в mixer. Возвращает Err при отказе WASAPI — вызвавший
/// поток взводит `dead`, супервизор его reaps (и re-add при возврате сессии).
unsafe fn capture_one(pid: u32, mixer: &Arc<Mutex<Mixer>>, stop: &AtomicBool) -> Result<(), String> {
    let client = activate_include_loopback(pid).map_err(|e| format!("activate pid {pid}: {e}"))?;
    let fmt = loopback_format();
    client
        .Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK, 10_000_000, 0, &fmt, None)
        .map_err(|e| format!("Initialize pid {pid}: {e}"))?;
    let capture_client: IAudioCaptureClient =
        client.GetService().map_err(|e| format!("GetService pid {pid}: {e}"))?;
    client.Start().map_err(|e| format!("Start pid {pid}: {e}"))?;
    let bytes_per_frame = (fmt.nChannels as usize) * (fmt.wBitsPerSample as usize / 8);

    while !stop.load(Ordering::Relaxed) {
        let packet_len = match capture_client.GetNextPacketSize() {
            Ok(n) => n,
            Err(_) => break,
        };
        if packet_len == 0 {
            std::thread::sleep(Duration::from_millis(5));
            continue;
        }
        let mut data_ptr: *mut u8 = std::ptr::null_mut();
        let mut frames: u32 = 0;
        let mut flags: u32 = 0;
        if capture_client.GetBuffer(&mut data_ptr, &mut frames, &mut flags, None, None).is_err() {
            break;
        }
        let silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0;
        let stereo_i16 = if silent || data_ptr.is_null() {
            vec![0i16; frames as usize * 2]
        } else {
            let raw = std::slice::from_raw_parts(data_ptr, frames as usize * bytes_per_frame);
            bytes_to_i16_stereo(raw, &fmt)
        };
        let _ = capture_client.ReleaseBuffer(frames);

        if !stereo_i16.is_empty() {
            if let Ok(mut m) = mixer.lock() {
                m.push(pid, &stereo_i16);
            }
        }
    }

    let _ = client.Stop();
    Ok(())
}

/// PID активных render-аудиосессий на дефолтном устройстве вывода. Ограничение:
/// только default console endpoint — звук на недефолтном устройстве не попадёт
/// (позже — цикл по EnumAudioEndpoints(eRender)). Дедуп: несколько сессий на PID.
unsafe fn list_active_render_pids() -> WinResult<HashSet<u32>> {
    let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
    let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
    let mgr: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
    let sessions = mgr.GetSessionEnumerator()?;
    let count = sessions.GetCount()?;
    let mut set = HashSet::new();
    for i in 0..count {
        let ctrl = sessions.GetSession(i)?;
        if ctrl.GetState()? != AudioSessionStateActive {
            continue;
        }
        let ctrl2: IAudioSessionControl2 = ctrl.cast()?;
        // pid==0 — session системных звуков; INCLUDE(0) невалиден и всё равно
        // отсеется на активации, но фильтруем сразу.
        let pid = ctrl2.GetProcessId()?;
        if pid != 0 {
            set.insert(pid);
        }
    }
    Ok(set)
}

/// Извлекает нуль-терминированную строку из фиксированного [u16]-поля.
fn wide_nul(w: &[u16]) -> String {
    let end = w.iter().position(|&c| c == 0).unwrap_or(w.len());
    String::from_utf16_lossy(&w[..end])
}

/// Полный путь образа процесса (Win32-формат) — для сверки WebView2-процессов
/// с папкой нашего приложения.
unsafe fn process_image_path(pid: u32) -> Option<String> {
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    let r = QueryFullProcessImageNameW(handle, PROCESS_NAME_FORMAT(0), PWSTR(buf.as_mut_ptr()), &mut len);
    let _ = CloseHandle(handle);
    r.ok()?;
    Some(String::from_utf16_lossy(&buf[..len as usize]))
}

/// Множество «наших» PID — их аудио НЕ должно попадать в стрим. Объединение двух
/// эвристик (у каждой поодиночке дыра):
///  (a) дерево-потомки нашего процесса (Toolhelp-снапшот, транзитивное замыкание по
///      parent-PID) — ловит WebView2-подпроцессы, приклеенные к нам как дети;
///  (b) любой `msedgewebview2.exe`, чей образ лежит под папкой приложения — ловит
///      отвязанные/reparented аудио-utility процессы, выпавшие из (a).
/// Остаточный риск: shared Evergreen WebView2 (`Program Files\...\EdgeWebView`) не
/// ловится (b); опора на (a). Полностью отвязанный utility-proc вне нашей папки —
/// теоретическая утечка, проверять на целевых машинах.
fn self_pid_set() -> HashSet<u32> {
    let mut set = HashSet::new();
    set.insert(std::process::id());

    unsafe {
        let snap = match CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            Ok(h) => h,
            Err(_) => return set,
        };
        // (pid, parent_pid, exe_name)
        let mut entries: Vec<(u32, u32, String)> = Vec::new();
        let mut pe = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut pe).is_ok() {
            loop {
                entries.push((pe.th32ProcessID, pe.th32ParentProcessID, wide_nul(&pe.szExeFile)));
                if Process32NextW(snap, &mut pe).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);

        // (a) транзитивное замыкание потомков от нашего PID.
        let mut changed = true;
        while changed {
            changed = false;
            for (pid, parent, _) in &entries {
                if !set.contains(pid) && set.contains(parent) {
                    set.insert(*pid);
                    changed = true;
                }
            }
        }

        // (b) msedgewebview2.exe под папкой нашего exe.
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(dir) = exe_path.parent() {
                let dir_l = dir.to_string_lossy().to_lowercase();
                for (pid, _, exe) in &entries {
                    if exe.to_lowercase() == "msedgewebview2.exe" && !set.contains(pid) {
                        if let Some(path) = process_image_path(*pid) {
                            if path.to_lowercase().starts_with(&dir_l) {
                                set.insert(*pid);
                            }
                        }
                    }
                }
            }
        }
    }
    set
}

/// Захватывает звук (всё кроме RelayApp, либо один выбранный процесс) в текущем
/// потоке, кодирует в Opus 48kHz/stereo/20ms и зовёт `on_chunk` на каждый пакет.
/// Поток блокирующий (WASAPI+COM) — не гонять на tokio-воркере. Вызывающий поток
/// уже сделал `CoInitializeEx(COINIT_MULTITHREADED)` (см. mod.rs).
///
/// Супервизор: держит по клиентскому потоку на источник (у каждого loopback-клиента
/// свой clock — round-robin в одном потоке залипал бы на медленном GetBuffer),
/// раз в ~1с переперечисляет желаемый набор PID, спавнит новые / reaps мёртвые,
/// и раз в 20мс тянет из mixer один Opus-кадр (пейсинг по wall-clock). Отказ
/// отдельного клиента логируется и не роняет весь захват.
pub fn run_capture_loop(stop: Arc<AtomicBool>, source: AudioSource, mut on_chunk: impl FnMut(OpusChunk)) -> Result<(), String> {
    const MAX_CLIENTS: usize = 8;
    const POLL: Duration = Duration::from_millis(1000);
    const TICK: Duration = Duration::from_millis(20);

    let manual_pid = match source {
        AudioSource::IncludeProcess(p) => Some(p),
        AudioSource::ExcludeSelfViaInclude => None,
    };
    eprintln!(
        "[audio] capture start (mode: {})",
        match manual_pid {
            Some(p) => format!("include-pid-{p}"),
            None => "exclude-self-via-include (auto)".to_string(),
        }
    );

    let encoder = audiopus::coder::Encoder::new(
        audiopus::SampleRate::Hz48000,
        audiopus::Channels::Stereo,
        audiopus::Application::Audio,
    ).map_err(|e| format!("opus encoder: {e}"))?;
    let mut opus_out = vec![0u8; 4000];

    let mixer = Arc::new(Mutex::new(Mixer::new()));
    let mut clients: HashMap<u32, ClientHandle> = HashMap::new();
    let mut next_enum = Instant::now(); // первый тик сразу
    let mut next_tick = Instant::now();

    while !stop.load(Ordering::Relaxed) {
        let now = Instant::now();
        if now >= next_enum {
            next_enum = now + POLL;
            let wanted: HashSet<u32> = match manual_pid {
                Some(p) => HashSet::from([p]),
                None => match unsafe { list_active_render_pids() } {
                    Ok(active) => {
                        let mine = self_pid_set();
                        active.into_iter().filter(|p| !mine.contains(p)).collect()
                    }
                    // Сессии не перечислились (транзиентный COM-отказ) — держим текущий
                    // набор клиентов, не сбрасываем захват.
                    Err(e) => {
                        log::warn!("audio: enum render sessions failed: {e}");
                        clients.keys().copied().collect()
                    }
                },
            };

            // Reap: мёртвые (клиент сам отвалился) или ушедшие из wanted.
            let to_remove: Vec<u32> = clients
                .iter()
                .filter(|(pid, h)| h.dead.load(Ordering::Relaxed) || !wanted.contains(pid))
                .map(|(pid, _)| *pid)
                .collect();
            for pid in to_remove {
                if let Some(h) = clients.remove(&pid) {
                    h.stop.store(true, Ordering::Relaxed);
                    let _ = h.join.join();
                    if let Ok(mut m) = mixer.lock() {
                        m.remove(pid);
                    }
                    log::info!("audio: dropped source pid {pid}");
                }
            }

            // Спавн новых.
            for pid in wanted {
                if clients.contains_key(&pid) {
                    continue;
                }
                if clients.len() >= MAX_CLIENTS {
                    log::warn!("audio: client cap {MAX_CLIENTS} reached, skipping pid {pid}");
                    break;
                }
                let cstop = Arc::new(AtomicBool::new(false));
                let cdead = Arc::new(AtomicBool::new(false));
                let m = mixer.clone();
                let cs = cstop.clone();
                let cd = cdead.clone();
                let join = std::thread::spawn(move || {
                    // Клиент-поток крутит GetBuffer/GetNextPacketSize по clock'у WASAPI —
                    // при голодании под игрой пакеты копятся и Mixer дропает старейшее.
                    super::prio::ensure_thread_mmcss(super::prio::MmTask::ProAudio);
                    unsafe {
                        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
                    }
                    if let Err(e) = unsafe { capture_one(pid, &m, &cs) } {
                        log::warn!("audio: client pid {pid} stopped: {e}");
                    }
                    cd.store(true, Ordering::Relaxed);
                    unsafe {
                        CoUninitialize();
                    }
                });
                clients.insert(pid, ClientHandle { stop: cstop, dead: cdead, join });
                log::info!("audio: capturing source pid {pid}");
            }
        }

        // Один 20мс-кадр микса → Opus. Ноль клиентов → тишина, трек не залипает.
        let frame = mixer
            .lock()
            .map(|mut m| m.pull(FRAME_INTERLEAVED))
            .unwrap_or_else(|_| vec![0i16; FRAME_INTERLEAVED]);
        match encoder.encode(&frame, &mut opus_out) {
            Ok(len) => on_chunk(OpusChunk { data: opus_out[..len].to_vec() }),
            Err(e) => log::warn!("opus encode error: {e}"),
        }

        // Пейсинг по абсолютному дедлайну — без накопления дрейфа.
        next_tick += TICK;
        let after = Instant::now();
        if next_tick > after {
            std::thread::sleep(next_tick - after);
        } else {
            next_tick = after;
        }
    }

    // Остановить всех клиентов.
    for (_pid, h) in clients.drain() {
        h.stop.store(true, Ordering::Relaxed);
        let _ = h.join.join();
    }
    Ok(())
}
