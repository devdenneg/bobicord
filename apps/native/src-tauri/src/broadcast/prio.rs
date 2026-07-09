// MMCSS (Multimedia Class Scheduler Service) + приоритет потока для медиа-тракта.
//
// Зачем. Игра регистрирует свои потоки в MMCSS-задаче "Games" и/или поднимает им
// приоритет; наши capture/encoder/audio — обычные `std::thread::spawn` с NORMAL.
// Когда игра выедает CPU под 100%, планировщик отдаёт им квант последними: WGC
// роняет презенты (падает `raw` в логе capture), энкодер не успевает забрать кадр
// (bounded(2) переполняется -> capture_drops), зритель видит рывки. Регистрация в
// MMCSS ставит наши потоки в ту же весовую категорию, что и потоки игры.
//
// Регистрация и снятие — строго на ОДНОМ потоке (`AvRevertMmThreadCharacteristics`
// нельзя вызвать с чужого). Отсюда: хэндл живёт в thread-local, снимается его
// TLS-деструктором; `Registration` не Send. `ensure` идемпотентен — второй вызов на
// том же потоке ничего не делает (дёшево: проверка thread-local).

use std::cell::RefCell;
use std::marker::PhantomData;

use windows::core::PCWSTR;
use windows::Win32::Foundation::HANDLE;
use windows::Win32::System::Threading::{
    AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, AvSetMmThreadPriority,
    GetCurrentThread, SetThreadPriority, AVRT_PRIORITY_HIGH, THREAD_PRIORITY_ABOVE_NORMAL,
};

/// Класс MMCSS-задачи — имя подключа в
/// `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile\Tasks`.
/// Берём только те, что заведены Windows по умолчанию (несуществующее имя = отказ
/// регистрации).
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum MmTask {
    /// Видео-тракт: WGC-сессия, конверсия, энкодер. Тот же класс, что у самой игры —
    /// не конкурируем с ней «снизу».
    Games,
    /// Звук: лёгкий по CPU, но чувствителен к джиттеру (бюджет голоса 250 мс).
    ProAudio,
}

impl MmTask {
    fn name(self) -> &'static str {
        match self {
            MmTask::Games => "Games",
            MmTask::ProAudio => "Pro Audio",
        }
    }
}

/// Живая регистрация потока в MMCSS. Снимается на Drop (TLS-деструктор при выходе
/// потока). `PhantomData<*const ()>` делает тип !Send: revert обязан произойти там же,
/// где был set.
struct Registration {
    handle: HANDLE,
    _not_send: PhantomData<*const ()>,
}

impl Drop for Registration {
    fn drop(&mut self) {
        unsafe { let _ = AvRevertMmThreadCharacteristics(self.handle); }
    }
}

thread_local! {
    static CURRENT: RefCell<Option<Registration>> = const { RefCell::new(None) };
}

/// Регистрирует ТЕКУЩИЙ поток в MMCSS-задаче `task` и поднимает ему приоритет.
/// Идемпотентно: повторный вызов на том же потоке — no-op (первая задача побеждает).
/// Все отказы мягкие (нет прав, MMCSS-служба выключена, урезанный образ Windows) —
/// логируем и едем дальше на обычном приоритете.
///
/// `THREAD_PRIORITY_ABOVE_NORMAL`, не `TIME_CRITICAL`: конверсия BGRA->NV12 тяжёлая,
/// на 15-м приоритете она заголодала бы систему целиком.
pub fn ensure_thread_mmcss(task: MmTask) {
    let _ = CURRENT.try_with(|cell| {
        let Ok(mut slot) = cell.try_borrow_mut() else { return };
        if slot.is_some() {
            return;
        }
        // PCWSTR требует нуль-терминатор; буфер должен пережить вызов.
        let name: Vec<u16> = task.name().encode_utf16().chain(std::iter::once(0)).collect();
        let mut index: u32 = 0;
        unsafe {
            match AvSetMmThreadCharacteristicsW(PCWSTR(name.as_ptr()), &mut index) {
                Ok(handle) => {
                    let _ = AvSetMmThreadPriority(handle, AVRT_PRIORITY_HIGH);
                    let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL);
                    *slot = Some(Registration { handle, _not_send: PhantomData });
                    log::debug!("prio: поток зарегистрирован в MMCSS «{}»", task.name());
                }
                Err(e) => log::warn!("prio: MMCSS «{}» недоступен ({e}) — обычный приоритет", task.name()),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::Threading::GetThreadPriority;

    /// Проверяет, что связка AvSetMmThreadCharacteristicsW + SetThreadPriority реально
    /// отрабатывает (правильные сигнатуры/линковка avrt.dll) и что повторный вызов —
    /// no-op. На машине без MMCSS-службы регистрация мягко отказывает: тогда проверять
    /// нечего, но и падать нельзя (CI-раннеры бывают урезанными).
    #[test]
    fn mmcss_registers_once_and_raises_priority() {
        ensure_thread_mmcss(MmTask::Games);
        let registered = CURRENT.with(|c| c.borrow().is_some());
        if !registered {
            eprintln!("MMCSS недоступен на этой машине — проверка приоритета пропущена");
            return;
        }
        let prio = unsafe { GetThreadPriority(GetCurrentThread()) };
        assert_eq!(prio, THREAD_PRIORITY_ABOVE_NORMAL.0, "приоритет потока не поднят");

        // Второй вызов с ДРУГОЙ задачей не должен перерегистрировать поток: revert
        // возможен только по исходному хэндлу, повторный set его бы потерял.
        let before = CURRENT.with(|c| c.borrow().as_ref().map(|r| r.handle.0));
        ensure_thread_mmcss(MmTask::ProAudio);
        let after = CURRENT.with(|c| c.borrow().as_ref().map(|r| r.handle.0));
        assert_eq!(before, after, "повторный ensure перерегистрировал поток");
    }
}
