//! 开机自启：HKCU Run，值名沿用旧版的 "PinTodo"（新版直接接管）
use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
use winreg::RegKey;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const NAME: &str = "PinTodo";

pub fn enabled() -> bool {
    let hk = RegKey::predef(HKEY_CURRENT_USER);
    hk.open_subkey_with_flags(RUN_KEY, KEY_READ)
        .and_then(|k| k.get_value::<String, _>(NAME))
        .map(|v| !v.is_empty())
        .unwrap_or(false)
}

pub fn set(on: bool) -> bool {
    let hk = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(k) = hk.open_subkey_with_flags(RUN_KEY, KEY_READ | KEY_SET_VALUE) else {
        return false;
    };
    let res = if on {
        let exe = std::env::current_exe()
            .ok()
            .map(|p| format!("\"{}\"", p.display()))
            .unwrap_or_default();
        k.set_value(NAME, &exe)
    } else {
        match k.delete_value(NAME) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    };
    res.is_ok()
}
