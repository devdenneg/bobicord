// Извлечение иконки приложения по HWND (Э-icon: показ иконки стримящегося окна в UI
// зрителей). Порядок попыток: иконка окна (WM_GETICON) -> иконка класса окна -> иконка
// exe-файла процесса (SHGetFileInfo). HICON рендерим в 32x32 BGRA через DrawIconEx на
// DIB-секцию (единый путь для любого исходного размера, с альфой), кодируем PNG + base64.
// Результат уходит в join broadcaster'а (signaling.rs appIcon) и дальше зрителям.

use std::ffi::c_void;
use std::mem::size_of;
use std::ptr::null_mut;
use std::sync::OnceLock;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, WPARAM};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
    BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HGDIOBJ,
};
use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_NORMAL, FILE_FLAGS_AND_ATTRIBUTES};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_USEFILEATTRIBUTES};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, DrawIconEx, GetClassLongPtrW, SendMessageTimeoutW, DI_NORMAL, GCLP_HICON,
    GCLP_HICONSM, HICON, ICON_BIG, ICON_SMALL2, SMTO_ABORTIFHUNG, WM_GETICON,
};

const ICON_SZ: i32 = 32;

/// Иконка окна как PNG 32x32 в base64 (без data-URI-префикса) или None, если извлечь
/// не удалось. `pid` — для фолбэка на иконку exe-файла процесса.
pub fn window_icon_png_base64(hwnd: isize, pid: u32) -> Option<String> {
    unsafe {
        let (hicon, owned) = get_hicon(hwnd, pid)?;
        let rgba = hicon_to_rgba(hicon);
        // DestroyIcon только для иконок, которые создали мы (SHGetFileInfo). Иконки окна и
        // класса принадлежат чужому окну — их трогать нельзя.
        if owned {
            let _ = DestroyIcon(hicon);
        }
        let rgba = rgba?;
        // Генерик-иконка Windows (exe без своей иконки — дефолтный «пустой» значок) → считаем, что
        // иконки НЕТ: вызывающий (detect_game) не покажет игру. Эталон генерика рендерим тем же путём
        // (SHGetFileInfo с USEFILEATTRIBUTES) → байты сравнимы точно.
        if generic_exe_icon_rgba().map_or(false, |g| *g == rgba) {
            return None;
        }
        encode_png(&rgba).map(|bytes| STANDARD.encode(bytes))
    }
}

/// RGBA дефолтной («генерик») exe-иконки Windows — рендерим один раз и кэшируем. Через
/// SHGFI_USEFILEATTRIBUTES + FILE_ATTRIBUTE_NORMAL: возвращает системный значок для .exe БЕЗ
/// обращения к диску (детерминированно на этой машине), тем же hicon_to_rgba, что и игры.
fn generic_exe_icon_rgba() -> Option<&'static Vec<u8>> {
    static GENERIC: OnceLock<Option<Vec<u8>>> = OnceLock::new();
    GENERIC
        .get_or_init(|| unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let wpath: Vec<u16> = "generic.exe".encode_utf16().chain(std::iter::once(0)).collect();
            let mut sfi = SHFILEINFOW::default();
            let r = SHGetFileInfoW(
                PCWSTR(wpath.as_ptr()),
                FILE_ATTRIBUTE_NORMAL,
                Some(&mut sfi),
                size_of::<SHFILEINFOW>() as u32,
                SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES,
            );
            if r == 0 || sfi.hIcon.is_invalid() {
                return None;
            }
            let rgba = hicon_to_rgba(sfi.hIcon);
            let _ = DestroyIcon(sfi.hIcon);
            rgba
        })
        .as_ref()
}

/// Возвращает (HICON, owned): owned=true — иконку создали мы и обязаны DestroyIcon.
unsafe fn get_hicon(hwnd: isize, pid: u32) -> Option<(HICON, bool)> {
    let h = HWND(hwnd as *mut c_void);

    // 1. Иконка самого окна. Таймаут + ABORTIFHUNG — не виснуть на подвисшем окне.
    for icon_type in [ICON_SMALL2, ICON_BIG] {
        let mut res: usize = 0;
        let _ = SendMessageTimeoutW(
            h,
            WM_GETICON,
            WPARAM(icon_type as usize),
            LPARAM(0),
            SMTO_ABORTIFHUNG,
            150,
            Some(&mut res),
        );
        if res != 0 {
            return Some((HICON(res as *mut c_void), false));
        }
    }

    // 2. Иконка класса окна.
    for idx in [GCLP_HICONSM, GCLP_HICON] {
        let v = GetClassLongPtrW(h, idx);
        if v != 0 {
            return Some((HICON(v as *mut c_void), false));
        }
    }

    // 3. Иконка exe-файла процесса.
    if let Some(path) = process_exe_path(pid) {
        // SHGetFileInfoW требует COM-апартамент. Ленивая инициализация: если поток уже
        // MTA — игнорируем RPC_E_CHANGED_MODE (нам подойдёт любой апартамент).
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let wpath: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut sfi = SHFILEINFOW::default();
        let r = SHGetFileInfoW(
            PCWSTR(wpath.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut sfi),
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        );
        if r != 0 && !sfi.hIcon.is_invalid() {
            return Some((sfi.hIcon, true));
        }
    }

    None
}

/// Полный путь к exe процесса по pid (для иконки файла).
unsafe fn process_exe_path(pid: u32) -> Option<String> {
    if pid == 0 {
        return None;
    }
    let proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = [0u16; 260];
    let mut size = buf.len() as u32;
    let r = QueryFullProcessImageNameW(proc, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
    let _ = CloseHandle(proc);
    r.ok()?;
    Some(String::from_utf16_lossy(&buf[..size as usize]))
}

/// HICON -> сырые RGBA-байты 32x32 (4 байта/пиксель) через DrawIconEx на top-down DIB.
/// PNG-кодирование и сравнение с генериком — на вызывающей стороне.
unsafe fn hicon_to_rgba(hicon: HICON) -> Option<Vec<u8>> {
    let screen = GetDC(None);
    let hdc = CreateCompatibleDC(Some(screen));
    ReleaseDC(None, screen);
    if hdc.is_invalid() {
        return None;
    }

    let mut bmi = BITMAPINFO::default();
    bmi.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
    bmi.bmiHeader.biWidth = ICON_SZ;
    bmi.bmiHeader.biHeight = -ICON_SZ; // отрицательная высота = top-down (строки сверху вниз)
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = 0; // BI_RGB

    let mut bits: *mut c_void = null_mut();
    let hbmp = match CreateDIBSection(Some(hdc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0) {
        Ok(b) => b,
        Err(_) => {
            let _ = DeleteDC(hdc);
            return None;
        }
    };
    let old = SelectObject(hdc, HGDIOBJ(hbmp.0));

    let mut out = None;
    let drawn = DrawIconEx(hdc, 0, 0, hicon, ICON_SZ, ICON_SZ, 0, None, DI_NORMAL).is_ok();
    if drawn && !bits.is_null() {
        let n = (ICON_SZ * ICON_SZ * 4) as usize;
        let bgra = std::slice::from_raw_parts(bits as *const u8, n);
        let mut rgba = vec![0u8; n];
        for i in (0..n).step_by(4) {
            rgba[i] = bgra[i + 2]; // R
            rgba[i + 1] = bgra[i + 1]; // G
            rgba[i + 2] = bgra[i]; // B
            rgba[i + 3] = bgra[i + 3]; // A
        }
        // Старые иконки без альфа-канала (AND/XOR-маска) дают полностью нулевую альфу —
        // получился бы прозрачный квадрат. Считаем такие непрозрачными.
        if rgba.iter().skip(3).step_by(4).all(|&a| a == 0) {
            for i in (3..n).step_by(4) {
                rgba[i] = 255;
            }
        }
        out = Some(rgba);
    }

    SelectObject(hdc, old);
    let _ = DeleteObject(HGDIOBJ(hbmp.0));
    let _ = DeleteDC(hdc);
    out
}

fn encode_png(rgba: &[u8]) -> Option<Vec<u8>> {
    let mut buf = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut buf, ICON_SZ as u32, ICON_SZ as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(rgba).ok()?;
    }
    Some(buf)
}
