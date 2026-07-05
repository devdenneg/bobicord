// Bisect helper (not part of Э5 deliverable): real screen capture -> real MF
// encoder, no webrtc/signaling/tokio at all, to isolate the remaining crash.
use app_lib::broadcast::capture;
use app_lib::broadcast::encoder::H264Encoder;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use windows::Win32::Media::MediaFoundation::{MFStartup, MFSTARTUP_FULL, MFSTARTUP_NOSOCKET, MF_VERSION};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

fn main() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_FULL | MFSTARTUP_NOSOCKET).expect("MFStartup");
    }
    let (handle, stop, rx) = capture::spawn_capture(1, 1920, 1080).expect("spawn_capture");
    let force_keyframe = Arc::new(AtomicBool::new(true));
    let mut enc = H264Encoder::new(1920, 1080, 30, 6_000_000, force_keyframe).expect("encoder new");
    println!("encoder ready, capturing+encoding for 10s...");

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut n = 0;
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(frame) => {
                match enc.encode(&frame) {
                    Ok(chunks) => { n += 1; println!("frame {n}: {} chunks {:?}", chunks.len(), chunks.iter().map(|c| c.data.len()).collect::<Vec<_>>()); }
                    Err(e) => { println!("encode error: {e}"); break; }
                }
            }
            Err(_) => println!("(no frame)"),
        }
    }
    stop.store(true, Ordering::Relaxed);
    drop(rx);
    let _ = handle.join();
    println!("done, {n} frames encoded");
}
