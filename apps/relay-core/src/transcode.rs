// Roadmap-flow-стриминга Д2 — СПАЙК серверного транскода (главный риск проекта).
//
// Конвейер РЕНДИШНА (только для vrelay, никогда для нативного passthrough-узла):
//   входящий H.264-RTP от родителя  →  дублируется в локальный UDP-сокет (Feed)
//   →  ffmpeg (`-i in.sdp`, libx264 zerolatency CBR, scale-без-апскейла, GOP 60, bf 0)
//   →  RTP H.264 pt=102 на второй локальный UDP-порт
//   →  relay-core читает, пишет в ОТДЕЛЬНЫЙ TrackLocalStaticRTP (рендишн-трек).
//
// Opus НЕ транскодируется — рендишн-дерево реюзает passthrough audio_track источника
// (см. relay.rs::start_rendition). Через ffmpeg идёт только видео.
//
// Измеримость (ради этого и делается спайк): всё логируется префиксом `[transcode]`,
// снимается одной командой на VPS (`docker logs token 2>&1 | grep '\[transcode\]'`):
//   - добавка латентности транскода (per-frame по marker-биту: время от «кадр ушёл в
//     ffmpeg» до «кадр вернулся», EWMA) — ЦЕЛЬ ≤300 мс;
//   - CPU ffmpeg-процесса (Linux /proc/<pid>/stat, utime+stime);
//   - счётчики пакетов вход/выход, рестарты ffmpeg.
// Живые цифры снимает пользователь на VPS с реальным вещателем — локально их не получить.

use std::collections::VecDeque;
use std::net::UdpSocket as StdUdpSocket;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tokio::net::UdpSocket;
use tokio::process::{Child, Command};
use tokio::sync::Notify;
use webrtc::api::media_engine::MIME_TYPE_H264;
use webrtc::rtp::packet::Packet;
use webrtc::rtp_transceiver::rtp_codec::RTCRtpCodecCapability;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocalWriter;
use webrtc::util::marshal::{Marshal, Unmarshal};

use crate::link::{now_ms, H264_FMTP};

/// Payload type H.264 в дереве (согласован с relay.rs / peer.rs MediaEngine).
const PT_H264: u8 = 102;
/// Потолок глубины очереди меток кадров (per-frame латентность). Вход и выход расходятся
/// СИСТЕМАТИЧЕСКИ: fps=30-фильтр дропает кадры 60fps-исходника (метка на каждый входной
/// кадр, поп — на каждый выходной), и при капе 240 очередь за ~8с доезжала до потолка,
/// после чего EWMA-латентность мерила возраст 240-кадровой давности (секунды мусора).
/// Кап 8 ограничивает смещение метрики ~130мс; сама метрика при дропе кадров — приближённая.
const MARK_QUEUE_CAP: usize = 8;
/// Максимум подряд-рестартов ffmpeg до капитуляции (сломанный бинарь/аргументы — не крутить вечно).
const MAX_RESTARTS: u64 = 10;

static ACTIVE: AtomicUsize = AtomicUsize::new(0);
static MAX_TRANSCODES: OnceLock<usize> = OnceLock::new();

/// Кап одновременных ffmpeg-транскодов (VRELAY_MAX_TRANSCODES, дефолт 2). Публична: агент
/// (main.rs) читает её, чтобы сообщить серверу свою транскод-ёмкость в vrelay-hello — сервер
/// не объявляет зрителям рендишн-лестницу, которую агент физически не поднимет (0 = нет транскода).
pub fn max_transcodes() -> usize {
    *MAX_TRANSCODES.get_or_init(|| {
        std::env::var("VRELAY_MAX_TRANSCODES").ok().and_then(|v| v.parse().ok()).unwrap_or(2)
    })
}

/// Размеры рендишна (потолок; апскейла нет — ffmpeg режет через min(iw,W)).
pub fn rendition_dims(rendition: &str) -> (u32, u32) {
    match rendition {
        "1080" => (1920, 1080),
        "720" => (1280, 720),
        "480" => (854, 480),
        "360" => (640, 360),
        _ => (854, 480),
    }
}

/// Дефолтный CBR-битрейт рендишна (H.264, таблица пресетов роадмапа Д5), бит/с.
pub fn rendition_default_bitrate(rendition: &str) -> u32 {
    match rendition {
        "1080" => 4_500_000,
        "720" => 3_000_000,
        "480" => 1_500_000,
        "360" => 800_000,
        _ => 1_500_000,
    }
}

/// H.264-капабилити рендишн-трека (baseline, packetization-mode=1, без B-кадров).
pub fn h264_cap() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_H264.to_owned(),
        clock_rate: 90000,
        sdp_fmtp_line: H264_FMTP.to_owned(),
        ..Default::default()
    }
}

/// Вход транскода: relay пишет сюда каждый видео-RTP пакет от родителя. Держит
/// подключённый к ffmpeg-in-порту UDP-сокет (sync non-blocking send — UDP на loopback
/// не блокирует), счётчик и очередь меток кадров для замера латентности.
pub struct Feed {
    sock: Arc<StdUdpSocket>,
    in_pkts: Arc<AtomicU64>,
    /// Момент (мс) отправки последнего пакета КАЖДОГО кадра (по marker-биту) — reader
    /// сматчит с выходным кадром для per-frame латентности.
    in_marks: Arc<Mutex<VecDeque<u64>>>,
}

impl Feed {
    /// Дублирует видео-RTP пакет в ffmpeg. PT принудительно 102 (SDP ждёт 102; если
    /// upstream согласовал иной pt — ffmpeg молча игнорил бы поток). Не блокирует relay:
    /// на переполнении сокета пакет тихо теряется (loopback, FEC не нужен — роадмап).
    pub fn send_video(&self, pkt: &Packet) {
        let bytes = if pkt.header.payload_type == PT_H264 {
            match pkt.marshal() {
                Ok(b) => b,
                Err(_) => return,
            }
        } else {
            let mut p = pkt.clone();
            p.header.payload_type = PT_H264;
            match p.marshal() {
                Ok(b) => b,
                Err(_) => return,
            }
        };
        let _ = self.sock.send(&bytes);
        self.in_pkts.fetch_add(1, Ordering::Relaxed);
        if pkt.header.marker {
            let mut q = self.in_marks.lock().unwrap();
            q.push_back(now_ms());
            while q.len() > MARK_QUEUE_CAP {
                q.pop_front();
            }
        }
    }
}

/// Активный транскод рендишна: владеет жизненным циклом ffmpeg (надзор + рестарт + kill)
/// и задачей чтения выхода. stop()/Drop гасят ffmpeg — иначе зомби-процессы на VPS.
pub struct Transcode {
    pub rendition: String,
    in_port: u16,
    stop_sup: Arc<Notify>,
    stop_rd: Arc<Notify>,
    in_pkts: Arc<AtomicU64>,
    out_pkts: Arc<AtomicU64>,
    restarts: Arc<AtomicU64>,
    latency_us: Arc<AtomicU64>,
}

impl Transcode {
    /// Поднимает конвейер. `out_video` — рендишн-трек, куда пишется транскодированный RTP.
    /// Возвращает (Transcode, Feed): Feed отдаётся relay для дублирования входного видео.
    pub async fn start(
        rendition: &str,
        bitrate: u32,
        out_video: Arc<TrackLocalStaticRTP>,
    ) -> Result<(Transcode, Feed), String> {
        // Глобальный кап одновременных ffmpeg (CPU-защита VPS). CAS чтобы не пробить лимит гонкой.
        loop {
            let cur = ACTIVE.load(Ordering::Relaxed);
            if cur >= max_transcodes() {
                return Err(format!("лимит VRELAY_MAX_TRANSCODES={} выбран — рендишн недоступен", max_transcodes()));
            }
            if ACTIVE.compare_exchange(cur, cur + 1, Ordering::AcqRel, Ordering::Relaxed).is_ok() {
                break;
            }
        }
        // С этой точки при любой ошибке ОБЯЗАН вернуть слот.
        let guard = ActiveGuard;

        let in_port = free_udp_port().map_err(|e| format!("in-порт: {e}"))?;
        let out_sock = UdpSocket::bind("127.0.0.1:0").await.map_err(|e| format!("out-сокет: {e}"))?;
        let out_port = out_sock.local_addr().map_err(|e| e.to_string())?.port();

        let (w, h) = rendition_dims(rendition);
        let sdp_path = std::env::temp_dir().join(format!("relay-transcode-{in_port}.sdp"));
        let sdp = format!(
            "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=relay-transcode\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\n\
             m=video {in_port} RTP/AVP {PT_H264}\r\na=rtpmap:{PT_H264} H264/90000\r\n\
             a=fmtp:{PT_H264} packetization-mode=1;profile-level-id=42e01f\r\n"
        );
        std::fs::write(&sdp_path, &sdp).map_err(|e| format!("запись in.sdp: {e}"))?;

        let input = StdUdpSocket::bind("127.0.0.1:0").map_err(|e| format!("feed-сокет: {e}"))?;
        input.connect(("127.0.0.1", in_port)).map_err(|e| format!("feed connect: {e}"))?;
        input.set_nonblocking(true).map_err(|e| e.to_string())?;

        let args = ffmpeg_args(&sdp_path.to_string_lossy(), w, h, bitrate, out_port);
        log::info!(
            "[transcode] rendition={rendition} старт: in_port={in_port} out_port={out_port} \
             target={w}x{h} bitrate={} kbps (активных транскодов: {})",
            bitrate / 1000,
            ACTIVE.load(Ordering::Relaxed)
        );

        let in_pkts = Arc::new(AtomicU64::new(0));
        let out_pkts = Arc::new(AtomicU64::new(0));
        let restarts = Arc::new(AtomicU64::new(0));
        let latency_us = Arc::new(AtomicU64::new(0));
        let in_marks = Arc::new(Mutex::new(VecDeque::new()));
        let stop_sup = Arc::new(Notify::new());
        let stop_rd = Arc::new(Notify::new());
        let pid = Arc::new(AtomicU32::new(0));

        // --- Надзор ffmpeg: спавн, рестарт при падении, kill при stop ---
        {
            let rendition = rendition.to_string();
            let stop_sup = stop_sup.clone();
            let restarts = restarts.clone();
            let pid = pid.clone();
            let sdp_path = sdp_path.clone();
            tokio::spawn(async move {
                // Владелец слота ACTIVE живёт всю жизнь надзора — вернёт слот при выходе
                // (падение ffmpeg сверх лимита / stop / capitulate). `move` захватывает его,
                // т.к. связывание здесь; без этой строки guard дропнулся бы сразу после spawn.
                let _guard = guard;
                let mut restart = 0u64;
                loop {
                    let mut child = match spawn_ffmpeg(&args) {
                        Ok(c) => c,
                        Err(e) => {
                            log::error!("[transcode] rendition={rendition} spawn ffmpeg: {e} — стоп (ffmpeg установлен?)");
                            break;
                        }
                    };
                    pid.store(child.id().unwrap_or(0), Ordering::Relaxed);
                    tokio::select! {
                        status = child.wait() => {
                            restart += 1;
                            restarts.fetch_add(1, Ordering::Relaxed);
                            if restart > MAX_RESTARTS {
                                log::error!("[transcode] rendition={rendition} ffmpeg упал {restart} раз (последний {status:?}) — сдаюсь");
                                break;
                            }
                            log::warn!("[transcode] rendition={rendition} ffmpeg завершился {status:?} — рестарт #{restart}");
                            let backoff = Duration::from_millis(300 * restart.min(6));
                            tokio::select! {
                                _ = tokio::time::sleep(backoff) => {}
                                _ = stop_sup.notified() => break,
                            }
                        }
                        _ = stop_sup.notified() => {
                            let _ = child.start_kill();
                            let _ = child.wait().await;
                            break;
                        }
                    }
                }
                let _ = std::fs::remove_file(&sdp_path);
                // _guard дропается здесь → ACTIVE -= 1
                log::info!("[transcode] rendition={rendition} надзор завершён");
            });
        }

        // --- Чтение выхода ffmpeg → рендишн-трек + метрики ---
        {
            let rendition = rendition.to_string();
            let stop_rd = stop_rd.clone();
            let out_pkts = out_pkts.clone();
            let in_pkts = in_pkts.clone();
            let restarts = restarts.clone();
            let latency_us = latency_us.clone();
            let in_marks = in_marks.clone();
            let pid = pid.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 2048];
                let mut logtick = tokio::time::interval(Duration::from_secs(3));
                logtick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                let (mut prev_in, mut prev_out) = (0u64, 0u64);
                let mut prev_at = Instant::now();
                let mut prev_cpu: Option<u64> = None;
                let mut first_out = true;
                loop {
                    tokio::select! {
                        r = out_sock.recv(&mut buf) => {
                            let n = match r { Ok(n) => n, Err(_) => { if_break_on_stop(&stop_rd).await; continue; } };
                            let mut slice = &buf[..n];
                            let pkt = match Packet::unmarshal(&mut slice) { Ok(p) => p, Err(_) => continue };
                            out_pkts.fetch_add(1, Ordering::Relaxed);
                            if first_out {
                                first_out = false;
                                log::info!("[transcode] rendition={rendition} ПЕРВЫЙ выходной пакет — конвейер жив");
                            }
                            if pkt.header.marker {
                                let popped = in_marks.lock().unwrap().pop_front();
                                if let Some(t0) = popped {
                                    let lat = now_ms().saturating_sub(t0);
                                    let prev = latency_us.load(Ordering::Relaxed);
                                    // EWMA (вес 0.2 свежему), храним в микросекундах для точности лога
                                    let cur = lat * 1000;
                                    let ewma = if prev == 0 { cur } else { (prev * 4 + cur) / 5 };
                                    latency_us.store(ewma, Ordering::Relaxed);
                                }
                            }
                            if let Err(e) = out_video.write_rtp(&pkt).await {
                                if webrtc::Error::ErrClosedPipe.to_string() != e.to_string() {
                                    log::debug!("[transcode] rendition={rendition} write_rtp: {e}");
                                }
                            }
                        }
                        _ = logtick.tick() => {
                            let now = Instant::now();
                            let dt = now.duration_since(prev_at).as_secs_f64().max(0.001);
                            let ci = in_pkts.load(Ordering::Relaxed);
                            let co = out_pkts.load(Ordering::Relaxed);
                            let lat_ms = latency_us.load(Ordering::Relaxed) as f64 / 1000.0;
                            let cpu = read_cpu(pid.load(Ordering::Relaxed), &mut prev_cpu, dt);
                            let cpu_str = cpu.map(|c| format!("{c:.0}%")).unwrap_or_else(|| "n/a".into());
                            log::info!(
                                "[transcode] rendition={rendition} latency≈{lat_ms:.0}ms cpu={cpu_str} \
                                 in_pps={:.0} out_pps={:.0} in_pkts={ci} out_pkts={co} restarts={}",
                                (ci - prev_in) as f64 / dt,
                                (co - prev_out) as f64 / dt,
                                restarts.load(Ordering::Relaxed),
                            );
                            prev_in = ci; prev_out = co; prev_at = now;
                        }
                        _ = stop_rd.notified() => break,
                    }
                }
                log::info!("[transcode] rendition={rendition} reader завершён");
            });
        }

        let feed = Feed { sock: Arc::new(input), in_pkts: in_pkts.clone(), in_marks };
        let tc = Transcode {
            rendition: rendition.to_string(),
            in_port,
            stop_sup,
            stop_rd,
            in_pkts,
            out_pkts,
            restarts,
            latency_us,
        };
        Ok((tc, feed))
    }

    /// Гасит ffmpeg и обе задачи. Идемпотентна; permit-семантика Notify гарантирует
    /// пробуждение, даже если задача сейчас не в await.
    pub fn stop(&self) {
        self.stop_sup.notify_one();
        self.stop_rd.notify_one();
        log::info!("[transcode] rendition={} стоп запрошен", self.rendition);
    }

    pub fn in_packets(&self) -> u64 { self.in_pkts.load(Ordering::Relaxed) }
    pub fn out_packets(&self) -> u64 { self.out_pkts.load(Ordering::Relaxed) }
    pub fn restart_count(&self) -> u64 { self.restarts.load(Ordering::Relaxed) }
    pub fn latency_ms(&self) -> f64 { self.latency_us.load(Ordering::Relaxed) as f64 / 1000.0 }
    pub fn input_port(&self) -> u16 { self.in_port }
}

impl Drop for Transcode {
    fn drop(&mut self) {
        // Страховка от зомби-ffmpeg, если Transcode дропнули без stop().
        self.stop_sup.notify_one();
        self.stop_rd.notify_one();
    }
}

/// RAII-владелец слота ACTIVE: гарантирует декремент даже при раннем return/панике.
struct ActiveGuard;
impl Drop for ActiveGuard {
    fn drop(&mut self) { ACTIVE.fetch_sub(1, Ordering::Relaxed); }
}

async fn if_break_on_stop(stop: &Notify) {
    // Ошибка recv (сокет закрыт) — короткая пауза, чтобы не крутить busy-loop; выход по stop.
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        _ = stop.notified() => {}
    }
}

/// Аргументы ffmpeg-энкодера рендишна. CBR+HRD (nal-hrd=cbr, minrate=maxrate=bufsize),
/// без B-кадров, low-latency. Выход капнут 30fps: `fps=30` ПЕРВЫМ звеном -vf — дроп кадров
/// ДО scale (минус ~половина CPU скейла+энкода на 60fps-исходнике; один 1080p-ffmpeg на
/// 2 vCPU боксе ел ядро целиком и отставал, latency 1.3с — диаг 2026-07-11). Заодно `-g 60`
/// становится честными 2с при ЛЮБОМ исходнике: fps в транскод не прокидывается, и на
/// 60fps-входе GOP был 1с — IDR-шторм рендишна. fps=30 = честный CFR, консистентен с
/// force-cfr=1. Scale без апскейла (min(iw,W)/min(ih,H)).
fn ffmpeg_args(sdp_path: &str, w: u32, h: u32, bitrate: u32, out_port: u16) -> Vec<String> {
    let vf = format!(
        "fps=30,scale='min({w},iw)':'min({h},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"
    );
    let bufsize = bitrate; // ~1× битрейт — минимальная HRD-задержка
    let x264 = "nal-hrd=cbr:force-cfr=1".to_string();
    vec![
        "-hide_banner".into(), "-loglevel".into(), "warning".into(),
        "-protocol_whitelist".into(), "file,udp,rtp".into(),
        "-fflags".into(), "nobuffer".into(), "-flags".into(), "low_delay".into(),
        "-i".into(), sdp_path.into(),
        "-an".into(),
        "-c:v".into(), "libx264".into(),
        "-preset".into(), "ultrafast".into(),
        "-tune".into(), "zerolatency".into(),
        "-profile:v".into(), "baseline".into(),
        "-pix_fmt".into(), "yuv420p".into(),
        "-bf".into(), "0".into(),
        "-g".into(), "60".into(), "-keyint_min".into(), "60".into(), "-sc_threshold".into(), "0".into(),
        "-vf".into(), vf,
        "-b:v".into(), bitrate.to_string(),
        "-minrate".into(), bitrate.to_string(),
        "-maxrate".into(), bitrate.to_string(),
        "-bufsize".into(), bufsize.to_string(),
        "-x264-params".into(), x264,
        "-payload_type".into(), PT_H264.to_string(),
        "-f".into(), "rtp".into(),
        format!("rtp://127.0.0.1:{out_port}?pkt_size=1200"),
    ]
}

fn spawn_ffmpeg(args: &[String]) -> std::io::Result<Child> {
    Command::new("ffmpeg")
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::inherit()) // ffmpeg warning/error → docker logs
        .kill_on_drop(true)
        .spawn()
}

/// Свободный UDP-порт на loopback: биндим :0, узнаём порт, отпускаем. TOCTOU-окно до
/// того, как ffmpeg займёт его — на dev-loopback пренебрежимо (риск отмечен в отчёте).
fn free_udp_port() -> std::io::Result<u16> {
    let s = StdUdpSocket::bind("127.0.0.1:0")?;
    Ok(s.local_addr()?.port())
}

/// CPU% ffmpeg-процесса из /proc/<pid>/stat (utime+stime, поля 14/15). Только Linux
/// (vrelay крутится в debian-контейнере). CLK_TCK принят 100 Гц (стандарт Linux) →
/// разница jiffies за dt секунд ≈ проценты CPU. На иных ОС — None.
#[cfg(target_os = "linux")]
fn read_cpu(pid: u32, prev: &mut Option<u64>, dt: f64) -> Option<f64> {
    if pid == 0 { return None; }
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // Поле comm в скобках может содержать пробелы — режем по последней ')'.
    let rest = stat.rsplit_once(')').map(|(_, r)| r)?.trim();
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // После ')' idx0 = state (поле 3). utime=поле14→idx11, stime=поле15→idx12.
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    let total = utime + stime;
    let out = prev.map(|p| (total.saturating_sub(p)) as f64 / dt); // jiffies/сек ≈ % при 100 Гц
    *prev = Some(total);
    out
}

#[cfg(not(target_os = "linux"))]
fn read_cpu(_pid: u32, _prev: &mut Option<u64>, _dt: f64) -> Option<f64> { None }
