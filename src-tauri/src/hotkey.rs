//! 全局热键：默认 Ctrl+Alt+Space 显隐 / Ctrl+Alt+A 快速添加，可在设置里改
use std::sync::Mutex;

use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

static REGISTERED: Mutex<Vec<Shortcut>> = Mutex::new(Vec::new());

pub fn register(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let gs = app.global_shortcut();
    {
        let mut cur = REGISTERED.lock().unwrap();
        for sc in cur.iter().cloned() {
            let _ = gs.unregister(sc);
        }
        cur.clear();
    }

    let (show, add) = current_hotkeys(app);
    for (combo, evt) in [(show, "show"), (add, "add")] {
        let Ok(sc) = Shortcut::try_from(combo.as_str()) else {
            continue; // 单个组合键非法不影响另一个
        };
        let name = evt.to_string();
        gs.on_shortcut(sc, move |app, _sc, e| {
            if e.state == ShortcutState::Pressed {
                let _ = app.emit_to("main", "hotkey", name.clone());
            }
        })?;
        REGISTERED.lock().unwrap().push(sc);
    }
    Ok(())
}

fn current_hotkeys(app: &AppHandle) -> (String, String) {
    use tauri::Manager;
    let st = app.state::<crate::data::AppState>();
    let s = st.settings.lock().unwrap();
    let show = s
        .get("hotkeyShow")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| "Ctrl+Alt+Space".into());
    let add = s
        .get("hotkeyAdd")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| "Ctrl+Alt+A".into());
    (show, add)
}
