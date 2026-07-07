// Глобальные хоткеи мута (настройки -> «Настройка клавиш»). Ловят комбинацию клавиш
// вне зависимости от фокуса окна (в игре) через низкоуровневый WH_KEYBOARD_LL-хук —
// как в Discord: клавиша НЕ поглощается (всегда CallNextHookEx), игра/другие приложения
// получают её как обычно, мы только подсматриваем состояние клавиатуры.
//
// Хук обязан крутиться на отдельном OS-потоке со своим message loop (GetMessageW) —
// LL-хук получает колбэки только пока поток, его установивший, качает очередь сообщений.
// Стартует лениво при первом set_hotkeys и живёт до конца процесса (ОС снимает хук сама
// при выходе), явного шатдауна не требуется.

use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::thread;

use tauri::{AppHandle, Emitter, Manager};
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetForegroundWindow, GetMessageW, SetWindowsHookExW,
    TranslateMessage, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN,
    WM_SYSKEYUP,
};

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum Action {
    MuteMic,
    Deafen,
}

impl Action {
    fn wire_name(self) -> &'static str {
        match self {
            Action::MuteMic => "muteMic",
            Action::Deafen => "deafen",
        }
    }
}

struct State {
    app: Option<AppHandle>,
    // HWND главного окна (как isize — сырой хэндл, не завязываемся на Send/Sync у HWND).
    // Используется, чтобы не эмитить событие, когда наше окно и так в фокусе (см. hook_proc) —
    // тогда клавишу обрабатывает in-app JS-хендлер (App.tsx), иначе сработало бы дважды.
    own_hwnd: Option<isize>,
    // (действие, требуемые VK-коды комбинации; модификаторы уже нормализованы — без L/R различия)
    combos: Vec<(Action, Vec<u32>)>,
    pressed: HashSet<u32>,
    armed: HashSet<Action>,
    thread_started: bool,
}

fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(State {
            app: None,
            own_hwnd: None,
            combos: Vec::new(),
            pressed: HashSet::new(),
            armed: HashSet::new(),
            thread_started: false,
        })
    })
}

/// Левый/правый модификатор — один бинд (симметрично normKey() в util.ts на фронте).
fn normalize_raw_vk(vk: u32) -> u32 {
    match vk {
        0xA0 | 0xA1 => 0x10, // VK_LSHIFT/VK_RSHIFT -> VK_SHIFT
        0xA2 | 0xA3 => 0x11, // VK_LCONTROL/VK_RCONTROL -> VK_CONTROL
        0xA4 | 0xA5 => 0x12, // VK_LMENU/VK_RMENU (Alt) -> VK_MENU
        other => other,
    }
}

/// `KeyboardEvent.code` (JS/фронт) -> нормализованный Windows VK-код. Покрывает буквы,
/// цифры, модификаторы, F-клавиши, стрелки и основные знаки препинания — то, что реально
/// может прилететь из KeyCaptureDialog (Modals.tsx). Неизвестный код -> None (клавиша
/// в комбинацию не попадает, бинд по ней не сработает — редкий edge case, не блокирует).
fn code_to_vk(code: &str) -> Option<u32> {
    match code {
        "ControlLeft" | "ControlRight" => return Some(0x11),
        "ShiftLeft" | "ShiftRight" => return Some(0x10),
        "AltLeft" | "AltRight" => return Some(0x12),
        "MetaLeft" | "MetaRight" => return Some(0x5B), // VK_LWIN (общего VK_META нет)
        "Space" => return Some(0x20),
        "Enter" => return Some(0x0D),
        "Escape" => return Some(0x1B),
        "Tab" => return Some(0x09),
        "Backspace" => return Some(0x08),
        "CapsLock" => return Some(0x14),
        "ArrowUp" => return Some(0x26),
        "ArrowDown" => return Some(0x28),
        "ArrowLeft" => return Some(0x25),
        "ArrowRight" => return Some(0x27),
        "Backquote" => return Some(0xC0),
        "Minus" => return Some(0xBD),
        "Equal" => return Some(0xBB),
        "BracketLeft" => return Some(0xDB),
        "BracketRight" => return Some(0xDD),
        "Backslash" => return Some(0xDC),
        "Semicolon" => return Some(0xBA),
        "Quote" => return Some(0xDE),
        "Comma" => return Some(0xBC),
        "Period" => return Some(0xBE),
        "Slash" => return Some(0xBF),
        _ => {}
    }
    if let Some(rest) = code.strip_prefix("Key") {
        let ch = rest.chars().next()?;
        if ch.is_ascii_alphabetic() {
            return Some(ch.to_ascii_uppercase() as u32); // VK_A..VK_Z == ASCII 'A'..'Z'
        }
    }
    if let Some(rest) = code.strip_prefix("Digit") {
        let ch = rest.chars().next()?;
        if ch.is_ascii_digit() {
            return Some(ch as u32); // VK_0..VK_9 == ASCII '0'..'9'
        }
    }
    if let Some(rest) = code.strip_prefix('F') {
        if let Ok(n) = rest.parse::<u32>() {
            if (1..=24).contains(&n) {
                return Some(0x70 + (n - 1)); // VK_F1..VK_F24
            }
        }
    }
    None
}

/// Вызывается из UI-команды `set_global_hotkeys` при старте и на каждое изменение
/// биндов/чекбокса «отключить вне приложения». `enabled=false` -> комбинации пустые,
/// глобальный хук фактически не матчит ничего (in-app хендлер в App.tsx берёт мут на себя).
pub fn set_hotkeys(app: AppHandle, mute_mic: Vec<String>, deafen: Vec<String>, enabled: bool) {
    let mut st = state().lock().unwrap();
    st.own_hwnd = app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map(|h| h.0 as isize);
    st.app = Some(app);
    st.combos = if enabled {
        vec![
            (Action::MuteMic, mute_mic.iter().filter_map(|c| code_to_vk(c)).collect()),
            (Action::Deafen, deafen.iter().filter_map(|c| code_to_vk(c)).collect()),
        ]
    } else {
        Vec::new()
    };
    st.armed.clear();
    st.pressed.clear();
    let started = st.thread_started;
    st.thread_started = true;
    drop(st);
    if !started {
        start_hook_thread();
    }
}

fn start_hook_thread() {
    thread::spawn(|| unsafe {
        let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook_proc), None, 0) {
            Ok(h) => h,
            Err(e) => {
                log::error!("hotkeys: SetWindowsHookExW не смог поставить хук: {e}");
                return;
            }
        };
        let mut msg = MSG::default();
        // Блокирующий message loop потока — обязателен, иначе колбэк хука не вызывается.
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        let _ = windows::Win32::UI::WindowsAndMessaging::UnhookWindowsHookEx(hook);
    });
}

unsafe extern "system" fn hook_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code >= 0 {
        let kb = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let vk = normalize_raw_vk(kb.vkCode);
        let msg = wparam.0 as u32;
        let down = msg == WM_KEYDOWN || msg == WM_SYSKEYDOWN;
        let up = msg == WM_KEYUP || msg == WM_SYSKEYUP;
        if down || up {
            let mut st = state().lock().unwrap();
            if down {
                st.pressed.insert(vk);
                let combos = st.combos.clone();
                let app = st.app.clone();
                // наше окно сейчас в фокусе -> клавишу и так обработает in-app JS-хендлер
                // (App.tsx слушает keydown на window, он получает событие только в фокусе);
                // не эмитим, чтобы не сработало дважды на одно нажатие.
                let we_are_foreground = st.own_hwnd.map(|h| unsafe { GetForegroundWindow() } == HWND(h as _)).unwrap_or(false);
                for (action, combo) in &combos {
                    if !st.armed.contains(action) && !combo.is_empty() && combo.iter().all(|c| st.pressed.contains(c)) {
                        st.armed.insert(*action);
                        if !we_are_foreground {
                            if let Some(app) = &app {
                                let _ = app.emit("global-hotkey", serde_json::json!({ "action": action.wire_name() }));
                            }
                        }
                    }
                }
            } else {
                st.pressed.remove(&vk);
                let combos = st.combos.clone();
                st.armed.retain(|a| {
                    !combos.iter().find(|(ac, _)| ac == a).map(|(_, c)| c.contains(&vk)).unwrap_or(false)
                });
            }
        }
    }
    // Всегда прокидываем дальше — клавиша не поглощается (игра/другие окна её тоже получат).
    CallNextHookEx(None, code, wparam, lparam)
}
