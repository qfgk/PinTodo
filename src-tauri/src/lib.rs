mod autostart;
mod commands;
mod data;
mod desktop_monitor;
mod hotkey;

use std::sync::OnceLock;
use std::time::Instant;

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

/// 进程启动时刻，main.rs 入口处写入
pub static BOOT: OnceLock<Instant> = OnceLock::new();

#[link(name = "dwmapi")]
extern "system" {
    fn DwmSetWindowAttribute(hwnd: isize, attr: u32, value: *const u32, size: u32) -> i32;
}

/// 关闭系统圆角：卡片/贴片均用 CSS 自绘圆角；Win11 会对 ROUND 窗口额外描 1px 边框，
/// 在透明贴片模式下会显形为悬浮矩形轮廓，因此统一 DONOTROUND。
fn round_corners(w: &tauri::WebviewWindow) {
    if let Ok(hwnd) = w.hwnd() {
        let pref: u32 = 1; // DWMWCP_DONOTROUND
        unsafe { DwmSetWindowAttribute(hwnd.0 as isize, 33, &pref, 4) };
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = data::AppState::new();

    let builder = tauri::Builder::default()
        // 单实例：二次启动只唤起已有窗口
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = app.emit_to("main", "show-requested", ());
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(state)
        .setup(|app| {
            use std::io::Write;
            let mut log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(data::data_dir().join("boot.log"))
                .ok();
            let mark = |log: &mut Option<std::fs::File>, tag: &str| {
                if let (Some(t0), Some(f)) = (BOOT.get(), log.as_mut()) {
                    let _ = writeln!(f, "{} {}", tag, t0.elapsed().as_millis());
                }
            };
            // 不再用 Mica：它会填满整个窗口背景（含卡片四周留白），形成灰框。
            // 卡片铺满窗口 + DWM 系统圆角；边框质感交给 CSS 发丝线。
            for label in ["main", "quickadd"] {
                if let Some(w) = app.get_webview_window(label) {
                    round_corners(&w);
                }
            }
            setup_tray(app)?;
            mark(&mut log, "s_tray");
            hotkey::register(app.handle())?;
            mark(&mut log, "s_key");
            data::spawn_reminder_loop(app.handle().clone());
            desktop_monitor::start_desktop_monitor(app.handle().clone());
            mark(&mut log, "setup");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_state,
            commands::save_tasks,
            commands::save_settings,
            commands::load_trash,
            commands::save_trash,
            commands::get_autostart,
            commands::set_autostart,
            commands::apply_theme,
            commands::report_ready,
            commands::set_hotkeys,
            commands::export_tasks,
            commands::import_tasks,
            commands::write_text,
            commands::read_text,
            commands::load_scratchpad,
            commands::save_scratchpad,
            commands::quit
        ]);
    #[cfg(windows)]
    {
        use std::io::Write;
        if let (Some(t0), Ok(mut f)) = (
            BOOT.get(),
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(data::data_dir().join("boot.log")),
        ) {
            let _ = writeln!(f, "pre_run {}", t0.elapsed().as_millis());
        }
    }
    builder
        .run(tauri::generate_context!())
        .expect("error while running PinTodo");
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let itoggle = MenuItemBuilder::with_id("toggle", "显示 / 隐藏").build(app)?;
    let iquick = MenuItemBuilder::with_id("quickadd", "快速添加").build(app)?;
    let iquit = MenuItemBuilder::with_id("quit", "退出 PinTodo").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&itoggle)
        .item(&iquick)
        .separator()
        .item(&iquit)
        .build()?;

    TrayIconBuilder::with_id("pintodo-tray")
        .icon(app.default_window_icon().expect("缺省图标").clone())
        .tooltip("PinTodo")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => {
                let _ = app.emit_to("main", "hotkey", "show");
            }
            "quickadd" => {
                let _ = app.emit_to("main", "hotkey", "add");
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let _ = tray.app_handle().emit_to("main", "hotkey", "show");
            }
        })
        .build(app)?;
    Ok(())
}
