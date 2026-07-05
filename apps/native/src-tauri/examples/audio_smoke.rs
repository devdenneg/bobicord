// Bisect helper (not part of Э5 deliverable): exercises ONLY WASAPI process-
// loopback capture + Opus encode, to isolate the audio-path crash.
use app_lib::broadcast::audio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

fn main() {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().expect("CoInitializeEx"); }
    println!("starting audio capture loop for 8s...");
    let stop = Arc::new(AtomicBool::new(false));
    let stop2 = stop.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(8));
        stop2.store(true, Ordering::Relaxed);
    });
    let mut n = 0u32;
    let result = audio::run_capture_loop(stop, audio::AudioSource::ExcludeSelf, |chunk| {
        n += 1;
        if n % 25 == 0 { println!("chunk {n}: {} bytes", chunk.data.len()); }
    });
    println!("run_capture_loop returned: {result:?}, total chunks={n}");
}
