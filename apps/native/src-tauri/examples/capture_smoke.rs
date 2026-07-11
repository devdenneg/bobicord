// Bisect helper (not part of Э5 deliverable): exercises ONLY screen capture +
// NV12 conversion, no MF encoder, to isolate which stage corrupts the heap.
use app_lib::broadcast::capture;
use app_lib::broadcast::stats::SharedStats;
use std::sync::Arc;
use std::time::Duration;

fn main() {
    let monitors = capture::list_monitors();
    println!("monitors: {monitors:?}");
    let source = capture::CaptureSource::Monitor { index: 1 };
    let stats = Arc::new(SharedStats::default());
    let (shutdown_tx, _shutdown_rx) = tokio::sync::mpsc::unbounded_channel();
    let (mut sup, rx, buf_pool, _preview_rx) = capture::CaptureSupervisor::new(1920, 1080, 30, stats, shutdown_tx);
    sup.start(source).expect("start capture");
    let mut n = 0;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(f) => {
                n += 1;
                println!("frame {n}: {}x{} bytes={}", f.width, f.height, f.data.len());
                buf_pool.put(f.data); // без возврата пул вымоется и каждый кадр будет аллоцировать
            }
            Err(_) => println!("(no frame yet)"),
        }
    }
    sup.stop();
    drop(rx);
    println!("done, {n} frames");
}
