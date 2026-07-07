// Самолечение ярлыков (рабочий стол + меню Пуск) на каждом запуске приложения.
//
// installer-hooks.nsh переименовывает дефолтный ярлык таури «RelayApp» в «Рилэй» при
// установке. На практике воспроизведён случай, когда через диалог NSIS «Обновить/Удалить»
// (апдейт поверх старой установки) хук либо не выполнился, либо выполнился частично: на
// столе остались рабочий «RelayApp.lnk» и битый (без валидного пути) «Рилэй.lnk». Точный
// порядок макросов NSIS на ветке «Обновить» живым тестом не подтверждён — вместо того чтобы
// гоняться за этим в инсталляторе, ярлык чинит само приложение при каждом запуске: это не
// зависит от того, что именно сделал (или не сделал) инсталлятор.
//
// Без чтения старого ярлыка — просто безусловно перезаписываем «Рилэй.lnk» свежим, с путём
// на текущий exe (CreateShortcut-подобно, через IShellLinkW+IPersistFile).

use std::mem::ManuallyDrop;
use std::path::{Path, PathBuf};

use windows::core::{Interface, PCWSTR, PWSTR, GUID};
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::Foundation::PROPERTYKEY;
use windows::Win32::System::Variant::VT_LPWSTR;
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    FOLDERID_Desktop, FOLDERID_Programs, IShellLinkW, SHGetKnownFolderPath, ShellLink,
    KNOWN_FOLDER_FLAG,
};

// Идентификатор приложения = identifier из tauri.conf.json. tauri-plugin-notification шлёт
// WinRT-toast именно с этим app_id; Windows покажет его ТОЛЬКО если в меню «Пуск» есть ярлык
// с System.AppUserModel.ID == этому значению. Инсталлятор такой ярлык ставит, но наше
// самолечение раньше перезаписывало «Рилэй.lnk» БЕЗ AUMID → тосты молча дропались.
const APP_USER_MODEL_ID: &str = "com.relayapp.desktop";

// PKEY_AppUserModel_ID (propkey.h): {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, pid 5.
const PKEY_APPUSERMODEL_ID: PROPERTYKEY = PROPERTYKEY {
    fmtid: GUID::from_u128(0x9F4C2855_9F79_4B39_A8D0_E1D42DE1D5F3),
    pid: 5,
};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn known_folder(id: &GUID) -> Option<PathBuf> {
    unsafe {
        let p = SHGetKnownFolderPath(id, KNOWN_FOLDER_FLAG(0), None).ok()?;
        let s = p.to_string().ok()?;
        Some(PathBuf::from(s))
    }
}

fn write_shortcut(lnk: &Path, target: &Path, icon: &Path) -> windows::core::Result<()> {
    unsafe {
        let sl: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        sl.SetPath(PCWSTR(wide(&target.to_string_lossy()).as_ptr()))?;
        sl.SetIconLocation(PCWSTR(wide(&icon.to_string_lossy()).as_ptr()), 0)?;

        // Записываем System.AppUserModel.ID на ярлык — без него Windows не связывает
        // toast-уведомления приложения (app_id == identifier) с этим ярлыком и молча их
        // не показывает. VT_LPWSTR-PROPVARIANT строим вручную и оборачиваем в ManuallyDrop,
        // чтобы Drop PROPVARIANT не пытался освободить наш Vec (не CoTaskMem-память).
        // Ошибку не фатализируем: путь/иконка важнее, ярлык всё равно должен создаться.
        if let Ok(store) = sl.cast::<IPropertyStore>() {
            let id_wide = wide(APP_USER_MODEL_ID);
            let raw_prop = PROPVARIANT {
                Anonymous: PROPVARIANT_0 {
                    Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                        vt: VT_LPWSTR,
                        wReserved1: 0,
                        wReserved2: 0,
                        wReserved3: 0,
                        Anonymous: PROPVARIANT_0_0_0 {
                            pwszVal: PWSTR(id_wide.as_ptr() as *mut u16),
                        },
                    }),
                },
            };
            let prop = ManuallyDrop::new(raw_prop);
            if let Err(e) = store.SetValue(&PKEY_APPUSERMODEL_ID, &*prop).and_then(|_| store.Commit()) {
                log::warn!("branding: не удалось записать AppUserModelID на ярлык: {e}");
            }
        }

        let pf: IPersistFile = sl.cast()?;
        pf.Save(PCWSTR(wide(&lnk.to_string_lossy()).as_ptr()), true)?;
    }
    Ok(())
}

/// Вызывается один раз при старте (см. lib.rs setup()), в отдельном потоке — COM-вызовы и
/// файловый I/O не должны блокировать инициализацию окна.
pub fn fix_shortcuts() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
    let Ok(exe) = std::env::current_exe() else { return };
    let dir = exe.parent().map(|p| p.to_path_buf());
    let icon = dir
        .as_ref()
        .map(|d| d.join("icons").join("icon.ico"))
        .filter(|p| p.exists())
        .or_else(|| dir.as_ref().map(|d| d.join("resources").join("icons").join("icon.ico")).filter(|p| p.exists()))
        .unwrap_or_else(|| exe.clone());

    for folder in [known_folder(&FOLDERID_Desktop), known_folder(&FOLDERID_Programs)] {
        let Some(d) = folder else { continue };
        let stale = d.join("RelayApp.lnk");
        if stale.exists() {
            let _ = std::fs::remove_file(&stale);
        }
        if let Err(e) = write_shortcut(&d.join("Рилэй.lnk"), &exe, &icon) {
            log::warn!("branding: не удалось (пере)создать ярлык в {}: {e}", d.display());
        }
    }
    unsafe {
        CoUninitialize();
    }
}
