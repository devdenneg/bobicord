// Профиль железа и загрузка CPU для диагностики стрима.
//
// Зачем. Разбор диага упирался в вопрос «а что за машина у вещателя». Одни и те же
// цифры (cb 15мс при бюджете 16.7) на 16-ядерном десктопе значат «всё хорошо», а на
// 4-ядерном ноутбуке — «на грани». Имя GPU отвечает, почему выбрался тот или иной MFT
// (см. encoder.rs: у Intel-iGPU кандидаты D3D-aware и падают на SetOutputType), а
// объём RAM — почему WGC роняет презенты под своп.
//
// Никакого сбора личных данных: имя CPU/GPU, число ядер, объём памяти, билд Windows.
// IP-адреса и так лежат в ICE-строках лога вещателя (диаг доступен только админу).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use windows::core::PCWSTR;
use windows::Win32::Foundation::FILETIME;
use windows::Win32::Graphics::Gdi::{EnumDisplayDevicesW, DISPLAY_DEVICEW, DISPLAY_DEVICE_ATTACHED_TO_DESKTOP};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::Win32::System::Threading::GetSystemTimes;

/// Снимок машины. Собирается один раз за процесс (значения не меняются), уезжает в
/// диаг-сессию вместе с семплами.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")] // конвенция JS-стороны, как у DebugSnapshot в broadcast/mod.rs
pub struct HwInfo {
    /// Полное имя из реестра, напр. «AMD Ryzen 7 5800X 8-Core Processor».
    pub cpu: String,
    /// Логических процессоров (то есть с HT/SMT) — с ними сравнивается cpu_percent.
    pub cores: u32,
    pub ram_mb: u64,
    /// Имена активных видеоадаптеров. Их порядок объясняет выбор MFT в encoder.rs.
    pub gpus: Vec<String>,
    /// «Windows 11 Pro 24H2 (26200)» — билд важнее маркетингового имени: поведение
    /// WGC и аппаратных MFT различается между билдами.
    pub os: String,
    /// Версия приложения (Cargo.toml) — сессии без неё нельзя привязать к бандлу.
    pub app_version: String,
}

fn reg_string(key: &str, value: &str) -> String {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(key, KEY_READ)
        .and_then(|k| k.get_value::<String, _>(value))
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Активные видеоадаптеры через `EnumDisplayDevicesW`. Выбран он, а не DXGI, чтобы не
/// тянуть в бандл ещё одну windows-фичу и не создавать D3D-устройство ради одной строки.
/// Фильтр ATTACHED_TO_DESKTOP отбрасывает зеркальные/виртуальные драйверы; дубли имён
/// схлопываем — один адаптер отдаётся по разу на каждый подключённый выход.
fn gpus() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    unsafe {
        for i in 0..8u32 {
            let mut dd = DISPLAY_DEVICEW { cb: std::mem::size_of::<DISPLAY_DEVICEW>() as u32, ..Default::default() };
            if !EnumDisplayDevicesW(PCWSTR::null(), i, &mut dd, 0).as_bool() { break; }
            if (dd.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP).0 == 0 { continue; }
            let name = String::from_utf16_lossy(&dd.DeviceString)
                .trim_end_matches('\0')
                .trim()
                .to_string();
            if !name.is_empty() && !out.contains(&name) { out.push(name); }
        }
    }
    out
}

fn ram_mb() -> u64 {
    let mut st = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe {
        if GlobalMemoryStatusEx(&mut st).is_err() { return 0; }
    }
    st.ullTotalPhys / (1024 * 1024)
}

/// Собирает читаемое имя ОС. `ProductName` на Windows 11 ВСЁ ЕЩЁ пишет «Windows 10»
/// (проверено живьём: билд 26200 отдаёт «Windows 10 Pro»), единственный надёжный признак
/// 11-й — билд ≥ 22000. Без подмены все 11-е машины в отчётах выглядели бы десятками.
/// Билд остаётся в строке всегда: поведение WGC и аппаратных MFT различается между билдами.
fn os_name(product: &str, display: &str, build: &str) -> String {
    let product = if build.parse::<u32>().unwrap_or(0) >= 22000 {
        product.replace("Windows 10", "Windows 11")
    } else {
        product.to_string()
    };
    format!("{product} {display} ({build})").replace("  ", " ").trim().to_string()
}

pub fn collect() -> HwInfo {
    const CPU_KEY: &str = r"HARDWARE\DESCRIPTION\System\CentralProcessor\0";
    const OS_KEY: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";
    HwInfo {
        cpu: reg_string(CPU_KEY, "ProcessorNameString"),
        cores: std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(0),
        ram_mb: ram_mb(),
        gpus: gpus(),
        os: os_name(
            &reg_string(OS_KEY, "ProductName"),
            &reg_string(OS_KEY, "DisplayVersion"),
            &reg_string(OS_KEY, "CurrentBuild"),
        ),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
    }
}

#[tauri::command]
pub fn diag_hw() -> HwInfo {
    static CACHE: OnceLock<HwInfo> = OnceLock::new();
    CACHE.get_or_init(collect).clone()
}

/* ---------- загрузка CPU системы ---------- */

/// Прошлый снимок `GetSystemTimes` (idle | kernel+user), упакованный в два атомика —
/// загрузка считается как приращение между вызовами. Абсолютных «процентов» у Windows
/// нет, только счётчики тиков, поэтому первый вызов честно возвращает None.
static PREV_IDLE: AtomicU64 = AtomicU64::new(0);
static PREV_BUSY: AtomicU64 = AtomicU64::new(0);

fn ft_to_u64(ft: FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

/// Загрузка CPU ВСЕЙ системы за интервал с прошлого вызова, 0..100. Именно системная, а
/// не наша: захват вытесняет игра (см. prio.rs), и «наш процесс на 12%» ничего не
/// объясняет, пока не видно, что машина в целом на 100%. Зовётся из stats-тика (2с).
pub fn cpu_load_percent() -> Option<f64> {
    let (mut idle, mut kern, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
    unsafe {
        GetSystemTimes(Some(&mut idle), Some(&mut kern), Some(&mut user)).ok()?;
    }
    // kernel включает idle — вычитаем, иначе «занято» всегда ≈100%.
    let idle_n = ft_to_u64(idle);
    let busy_n = ft_to_u64(kern) + ft_to_u64(user);
    let prev_idle = PREV_IDLE.swap(idle_n, Ordering::Relaxed);
    let prev_busy = PREV_BUSY.swap(busy_n, Ordering::Relaxed);
    if prev_busy == 0 { return None; } // первый вызов: не с чем сравнивать
    let d_idle = idle_n.saturating_sub(prev_idle) as f64;
    let d_busy = busy_n.saturating_sub(prev_busy) as f64;
    if d_busy <= 0.0 { return None; }
    Some(((d_busy - d_idle) / d_busy * 100.0).clamp(0.0, 100.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collect_fills_basics() {
        let hw = collect();
        // Ядра и память доступны на любой машине, где вообще идёт тест.
        assert!(hw.cores >= 1, "cores = {}", hw.cores);
        assert!(hw.ram_mb > 256, "ram_mb = {}", hw.ram_mb);
        assert!(!hw.app_version.is_empty());
        // Пустой CPU или os = реестр отдал не то (ключ переехал / нет прав) — это ловится
        // только на живой машине, в CI Windows-раннера тоже.
        assert!(!hw.cpu.is_empty(), "имя CPU пустое — проверь HARDWARE\\DESCRIPTION\\System\\CentralProcessor\\0");
        assert!(hw.os.contains('('), "билд ОС не прочитан: {:?}", hw.os);
    }

    #[test]
    fn os_name_fixes_win11_and_keeps_build() {
        // Живой случай с этой машины: билд 26200 при ProductName «Windows 10 Pro».
        assert_eq!(os_name("Windows 10 Pro", "25H2", "26200"), "Windows 11 Pro 25H2 (26200)");
        // Настоящая десятка (билд < 22000) остаётся десяткой.
        assert_eq!(os_name("Windows 10 Pro", "22H2", "19045"), "Windows 10 Pro 22H2 (19045)");
        // Пустой DisplayVersion не должен оставлять двойной пробел.
        assert_eq!(os_name("Windows 10 Pro", "", "19045"), "Windows 10 Pro (19045)");
        // Реестр недоступен — не паникуем и не врём про версию.
        assert_eq!(os_name("", "", ""), "()");
    }

    #[test]
    fn cpu_load_needs_two_calls() {
        // Первый вызов калибровочный (нет предыдущего снимка), дальше — число в 0..100.
        let _ = cpu_load_percent();
        std::thread::sleep(std::time::Duration::from_millis(30));
        if let Some(p) = cpu_load_percent() {
            assert!((0.0..=100.0).contains(&p), "percent = {p}");
        }
    }
}
