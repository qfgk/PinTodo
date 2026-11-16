//! Tauri 命令面：前端通过 invoke 调用
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::data::{self, AppState, SaveReq, Task};

#[tauri::command]
pub fn load_state(state: State<'_, AppState>) -> Value {
    json!({
        "tasks": state.tasks.lock().unwrap().clone(),
        "settings": state.settings.lock().unwrap().clone(),
    })
}

#[tauri::command]
pub fn load_trash() -> Vec<data::TrashItem> {
    data::load_trash()
}

#[tauri::command]
pub fn save_trash(items: Vec<data::TrashItem>) {
    data::save_trash(&items);
}

#[tauri::command]
pub fn save_tasks(tasks: Vec<Task>, state: State<'_, AppState>, app: AppHandle) {
    // 托盘提示同步今日待办数（在 move 之前计算）
    let today = chrono_like_today() + 86_400_000;
    let pending_today = tasks
        .iter()
        .filter(|t| !t.d && t.due.map(|due| due < today).unwrap_or(false))
        .count();
    let pending_all = tasks.iter().filter(|t| !t.d).count();

    *state.tasks.lock().unwrap() = tasks.clone();
    state.send(SaveReq::Tasks(tasks));

    if let Some(tray) = app.tray_by_id("pintodo-tray") {
        let _ = tray.set_tooltip(Some(if pending_today > 0 {
            format!("PinTodo · 今日到期 {} 件", pending_today)
        } else {
            format!("PinTodo · 待办 {} 件", pending_all)
        }));
    }
}

fn chrono_like_today() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    // 本地零点近似：粗略按 UTC 零点切日（托盘计数误差可接受）
    now - (now % 86_400_000)
}

/// 合并写：未知键保留（旧版共存）
#[tauri::command]
pub fn save_settings(settings: Value, state: State<'_, AppState>) {
    let mut s = state.settings.lock().unwrap();
    if let (Some(new), Some(old)) = (settings.as_object(), s.as_object_mut()) {
        for (k, v) in new {
            old.insert(k.clone(), v.clone());
        }
    }
    state.send(SaveReq::Settings(s.clone()));
}

#[tauri::command]
pub fn get_autostart() -> bool {
    crate::autostart::enabled()
}

#[tauri::command]
pub fn set_autostart(on: bool) -> bool {
    crate::autostart::set(on)
}

/// 材质命令已弃用（Mica 会在窗口留白处形成灰框）；保留空实现以兼容前端调用
#[tauri::command]
pub fn apply_theme(dark: bool, app: AppHandle) -> bool {
    let _ = (dark, &app);
    false
}

/// JS 分阶段上报启动耗时（phase 为空表示首帧就绪）
#[tauri::command]
pub fn report_ready(phase: Option<String>) {
    if let Some(t0) = crate::BOOT.get() {
        let ms = t0.elapsed().as_millis();
        #[cfg(debug_assertions)]
        eprintln!("[boot] {:?} {}ms", phase, ms);
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(data::data_dir().join("boot.log"))
        {
            let _ = writeln!(f, "{} {}", phase.unwrap_or_else(|| "ready".into()), ms);
        }
    }
}

/// 热键变更：落设置并重注册
#[tauri::command]
pub fn set_hotkeys(show: String, add: String, app: AppHandle) -> bool {
    {
        let st = app.state::<AppState>();
        let mut s = st.settings.lock().unwrap();
        if let Some(o) = s.as_object_mut() {
            o.insert("hotkeyShow".into(), Value::String(show));
            o.insert("hotkeyAdd".into(), Value::String(add));
        }
        st.send(SaveReq::Settings(s.clone()));
    }
    crate::hotkey::register(&app).is_ok()
}

#[tauri::command]
pub fn export_tasks(path: String, state: State<'_, AppState>) -> Result<(), String> {
    let tasks = state.tasks.lock().unwrap().clone();
    let bytes = serde_json::to_vec_pretty(&tasks).map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_tasks(path: String, state: State<'_, AppState>) -> Result<Vec<Task>, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let arr: Vec<Value> = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let tasks: Vec<Task> = arr.into_iter().map(data::migrate_task).collect();
    *state.tasks.lock().unwrap() = tasks.clone();
    state.send(SaveReq::Tasks(tasks.clone()));
    Ok(tasks)
}

#[tauri::command]
pub fn quit(app: AppHandle) {
    app.exit(0);
}

/// todo.txt 等文本文件的写出（路径来自前端文件对话框）
#[tauri::command]
pub fn write_text(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 随手记：单页便签，独立于任务数据
#[tauri::command]
pub fn load_scratchpad() -> String {
    std::fs::read_to_string(crate::data::data_dir().join("scratchpad.txt")).unwrap_or_default()
}

#[tauri::command]
pub fn save_scratchpad(content: String) {
    let dir = crate::data::data_dir();
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(dir.join("scratchpad.txt"), content.as_bytes());
}
