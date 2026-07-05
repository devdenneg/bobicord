// Bisect helper (not part of Э5 deliverable): feeds synthetic NV12 frames into
// H264Encoder directly (no screen capture, no webrtc) to isolate the MF encoder.
use app_lib::broadcast::capture::Nv12Frame;
use app_lib::broadcast::encoder::H264Encoder;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;
use windows::Win32::Media::MediaFoundation::{MFStartup, MFSTARTUP_FULL, MFSTARTUP_NOSOCKET, MF_VERSION};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

fn main() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        MFStartup(MF_VERSION, MFSTARTUP_FULL | MFSTARTUP_NOSOCKET).expect("MFStartup");
    }
    let width = 1920u32;
    let height = 1080u32;
    let fps = 30u32;
    let force_keyframe = Arc::new(AtomicBool::new(true));
    println!("creating encoder...");
    let mut enc = H264Encoder::new(width, height, fps, 6_000_000, force_keyframe).expect("encoder new");
    println!("encoder created, feeding frames...");

    let nv12_len = (width * height * 3 / 2) as usize;
    for i in 0..60 {
        let data = vec![(i * 4) as u8; nv12_len];
        let frame = Nv12Frame { data, width, height, captured_at: Instant::now() };
        match enc.encode(&frame) {
            Ok(chunks) => println!("frame {i}: {} chunks, sizes={:?}", chunks.len(), chunks.iter().map(|c| c.data.len()).collect::<Vec<_>>()),
            Err(e) => { println!("frame {i}: ERROR {e}"); break; }
        }
        std::thread::sleep(std::time::Duration::from_millis(33));
    }
    println!("done");
}
