// Roadmap-flow-стриминга Д2 — offline-смоук транскод-конвейера БЕЗ вещателя/VPS.
// Доказывает plumbing RTP→ffmpeg→RTP: синтетический H.264-RTP (testsrc через ffmpeg) →
// наш Feed → transcode.rs (второй ffmpeg, энкод рендишна) → выходные RTP-пакеты.
//
// Запуск (нужен локальный ffmpeg): cargo run -p relay-core --example transcode_smoke
// Успех: `[smoke] OK` + out_pkts>0 и печать латентности/рестартов. Требует ffmpeg в PATH;
// в CI/на VPS — есть. Если ffmpeg нет — пример выходит с пояснением (exit 0), plumbing
// проверяется на машине с ffmpeg.
use std::sync::Arc;
use std::time::{Duration, Instant};

use relay_core::transcode::{self, Transcode};
use tokio::net::UdpSocket;
use tokio::process::Command;
use webrtc::rtp::packet::Packet;
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::util::marshal::Unmarshal;

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // ffmpeg присутствует?
    if Command::new("ffmpeg").arg("-version").stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().await.map(|s| !s.success()).unwrap_or(true) {
        eprintln!("[smoke] ffmpeg не найден в PATH — пропускаю (plumbing проверяется на машине/CI с ffmpeg)");
        return;
    }

    // Наш транскод рендишна 480p.
    let out_video = Arc::new(TrackLocalStaticRTP::new(transcode::h264_cap(), "video".into(), "smoke::480".into()));
    let (tc, feed) = match Transcode::start("480", 1_500_000, out_video).await {
        Ok(v) => v,
        Err(e) => { eprintln!("[smoke] FAIL: транскод не стартовал: {e}"); std::process::exit(1); }
    };

    // Синтетический источник: ffmpeg testsrc → H.264-RTP на локальный порт, который читаем мы.
    let src = UdpSocket::bind("127.0.0.1:0").await.expect("bind src");
    let src_port = src.local_addr().unwrap().port();
    let mut helper = Command::new("ffmpeg")
        .args([
            "-hide_banner", "-loglevel", "warning",
            "-re", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30",
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
            "-profile:v", "baseline", "-pix_fmt", "yuv420p", "-bf", "0", "-g", "60",
            "-payload_type", "102",
            "-f", "rtp", &format!("rtp://127.0.0.1:{src_port}?pkt_size=1200"),
        ])
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn helper ffmpeg");

    // Читаем синтетический RTP и прогоняем через Feed (тот же путь, что relay в бою).
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut buf = vec![0u8; 2048];
    let mut fed = 0u64;
    while Instant::now() < deadline {
        tokio::select! {
            r = src.recv(&mut buf) => {
                if let Ok(n) = r {
                    let mut slice = &buf[..n];
                    if let Ok(pkt) = Packet::unmarshal(&mut slice) { feed.send_video(&pkt); fed += 1; }
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(200)) => {}
        }
    }

    let out = tc.out_packets();
    println!(
        "[smoke] fed={fed} in_pkts={} out_pkts={out} latency≈{:.0}ms restarts={}",
        tc.in_packets(), tc.latency_ms(), tc.restart_count()
    );
    let _ = helper.start_kill();
    tc.stop();
    tokio::time::sleep(Duration::from_millis(300)).await;

    if out == 0 {
        eprintln!("[smoke] FAIL: транскод не выдал ни одного выходного пакета");
        std::process::exit(1);
    }
    println!("[smoke] OK");
}
