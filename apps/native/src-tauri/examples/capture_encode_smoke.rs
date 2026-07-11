// Bisect helper (not part of Э5 deliverable): real screen capture -> real MF
// encoder, no webrtc/signaling/tokio at all, to isolate the remaining crash.
use app_lib::broadcast::capture;
use app_lib::broadcast::encoder::H264Encoder;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use windows::Win32::Media::MediaFoundation::{MFStartup, MFSTARTUP_FULL, MFSTARTUP_NOSOCKET, MF_VERSION};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

fn main() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_FULL | MFSTARTUP_NOSOCKET).expect("MFStartup");
    }
    let source = capture::CaptureSource::Monitor { index: 1 };
    let stats = Arc::new(app_lib::broadcast::stats::SharedStats::default());
    let (shutdown_tx, _shutdown_rx) = tokio::sync::mpsc::unbounded_channel();
    let (mut sup, rx, buf_pool, _preview_rx) = capture::CaptureSupervisor::new(1920, 1080, 30, stats, shutdown_tx);
    sup.start(source).expect("start capture");
    let force_keyframe = Arc::new(AtomicBool::new(true));
    let mut enc = H264Encoder::new(1920, 1080, 30, 6_000_000, force_keyframe).expect("encoder new");
    println!("encoder ready, capturing+encoding for 10s...");

    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut n = 0;
    while std::time::Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(frame) => {
                let encoded = enc.encode(&frame);
                buf_pool.put(frame.data); // вернуть буфер в оборот, как это делает mod.rs
                match encoded {
                    Ok(chunks) => { n += 1; println!("frame {n}: {} chunks {:?}", chunks.len(), chunks.iter().map(|c| c.data.len()).collect::<Vec<_>>()); }
                    Err(e) => { println!("encode error: {e}"); break; }
                }
            }
            Err(_) => println!("(no frame)"),
        }
    }
    sup.stop();
    drop(rx);
    println!("done, {n} frames encoded");
}
