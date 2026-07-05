// Bisect helper (not part of Э5 deliverable): exercises ONLY screen capture +
// NV12 conversion, no MF encoder, to isolate which stage corrupts the heap.
use app_lib::broadcast::capture;
use std::time::Duration;

fn main() {
    let monitors = capture::list_monitors();
    println!("monitors: {monitors:?}");
    let (handle, stop, rx) = capture::spawn_capture(1, 1920, 1080, 30).expect("spawn_capture");
    let mut n = 0;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(f) => { n += 1; println!("frame {n}: {}x{} bytes={}", f.width, f.height, f.data.len()); }
            Err(_) => println!("(no frame yet)"),
        }
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    drop(rx);
    let _ = handle.join();
    println!("done, {n} frames");
}
