//! 数据层：与旧 Python 版共用 %APPDATA%\PinTodo\ 下的文件，向后兼容。
//! 写入走防抖合并线程（150ms），原子替换，与旧版同节奏。
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn data_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join("PinTodo")
}

fn tasks_path() -> PathBuf {
    data_dir().join("tasks.json")
}

fn settings_path() -> PathBuf {
    data_dir().join("settings.json")
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

static ID_SEQ: AtomicU32 = AtomicU32::new(1);

pub fn new_id() -> String {
    let n = ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{:x}-{:x}", now_ms(), n)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgLog {
    pub id: String,
    pub text: String,
    pub time: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub t: String,
    #[serde(default)]
    pub d: bool,
    #[serde(default = "default_list")]
    pub list: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// 0 普通 / 1 高 / 2 中 / 3 低
    #[serde(default)]
    pub pri: i64,
    /// 收藏 / 打星
    #[serde(default)]
    pub star: bool,
    /// 挂起（暂缓处理，不计入待办与提醒）
    #[serde(default)]
    pub susp: bool,
    /// 截止时间（ms epoch）
    #[serde(default)]
    pub due: Option<i64>,
    /// daily / weekly / monthly
    #[serde(default)]
    pub recur: Option<String>,
    /// 任务描述
    #[serde(default)]
    pub notes: Option<String>,
    /// 当前进度（最新文本反馈）
    #[serde(default)]
    pub prog: Option<String>,
    /// 进度反馈历程记录
    #[serde(default)]
    pub prog_logs: Vec<ProgLog>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub done_at: Option<i64>,
}

fn default_list() -> String {
    "默认".to_string()
}

/// 旧格式 {t,d} 或缺字段的记录 → 补全为完整 Task；未知字段丢弃
pub fn migrate_task(mut v: Value) -> Task {
    if v.get("id").and_then(|x| x.as_str()).map(|s| !s.is_empty()) != Some(true) {
        v["id"] = Value::String(new_id());
    }
    if v.get("list").and_then(|x| x.as_str()).is_none() {
        v["list"] = Value::String(default_list());
    }
    if v.get("tags").and_then(|x| x.as_array()).is_none() {
        v["tags"] = Value::Array(vec![]);
    }
    if v.get("pri").and_then(|x| x.as_i64()).is_none() {
        v["pri"] = Value::from(0);
    }
    if v.get("createdAt").and_then(|x| x.as_i64()).is_none() {
        v["createdAt"] = Value::from(now_ms());
    }
    if v.get("progLogs").and_then(|x| x.as_array()).is_none() {
        let mut logs = vec![];
        if let Some(p) = v.get("prog").and_then(|x| x.as_str()) {
            if !p.trim().is_empty() {
                logs.push(serde_json::json!({
                    "id": new_id(),
                    "text": p.trim(),
                    "time": now_ms()
                }));
            }
        }
        v["progLogs"] = Value::Array(logs);
    }
    if v.get("d").and_then(|x| x.as_bool()) == Some(true)
        && v.get("doneAt").and_then(|x| x.as_i64()).is_none()
    {
        v["doneAt"] = Value::from(now_ms());
    }
    serde_json::from_value(v).unwrap_or(Task {
        id: new_id(),
        t: "(无法读取的记录)".to_string(),
        d: false,
        list: default_list(),
        tags: vec![],
        pri: 0,
        star: false,
        susp: false,
        due: None,
        recur: None,
        notes: None,
        prog: None,
        prog_logs: vec![],
        created_at: now_ms(),
        done_at: None,
    })
}

pub enum SaveReq {
    Tasks(Vec<Task>),
    Settings(Value),
}

pub struct AppState {
    pub tasks: Mutex<Vec<Task>>,
    /// 以 object 形式保存，保留未知键（旧版回退时不丢新增设置）
    pub settings: Mutex<Value>,
    /// 已提醒过 (任务id, 截止时间)，防重复通知
    notified: Mutex<HashSet<(String, i64)>>,
    tx: Sender<SaveReq>,
}

/// 启动时滚动备份 tasks.json，保留最近 7 份（数据安全兜底）
fn backup_tasks() {
    let src = tasks_path();
    let Ok(content) = fs::read_to_string(&src) else { return };
    if content.trim().is_empty() || content.trim() == "[]" {
        return;
    }
    let dir = data_dir().join("backup");
    let _ = fs::create_dir_all(&dir);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = format!("tasks-{}.json", ts);
    let _ = fs::write(dir.join(&name), &content);
    // 只留最近 7 份
    let mut entries: Vec<PathBuf> = fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| p.file_name().map(|n| n.to_string_lossy().starts_with("tasks-")).unwrap_or(false))
                .collect()
        })
        .unwrap_or_default();
    if entries.len() > 7 {
        entries.sort_by_key(|p| {
            p.file_name()
                .map(|n| n.to_string_lossy().trim_start_matches("tasks-").trim_end_matches(".json").to_string())
                .unwrap_or_default()
        });
        let excess = entries.len() - 7;
        for p in entries.into_iter().take(excess) {
            let _ = fs::remove_file(p);
        }
    }
}

impl AppState {
    pub fn new() -> Self {
        backup_tasks();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || saver_loop(rx));
        Self {
            tasks: Mutex::new(load_tasks()),
            settings: Mutex::new(load_settings()),
            notified: Mutex::new(HashSet::new()),
            tx,
        }
    }

    pub fn send(&self, req: SaveReq) {
        let _ = self.tx.send(req);
    }
}

fn load_tasks() -> Vec<Task> {
    fs::read_to_string(tasks_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<Value>>(&s).ok())
        .map(|arr| arr.into_iter().map(migrate_task).collect())
        .unwrap_or_default()
}

fn load_settings() -> Value {
    fs::read_to_string(settings_path())
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn write_json_atomic(path: &PathBuf, bytes: &[u8]) {
    let _ = fs::create_dir_all(path.parent().unwrap_or(path));
    let tmp = path.with_extension("json.tmp");
    if let Ok(mut f) = fs::File::create(&tmp) {
        if f.write_all(bytes).is_ok() {
            drop(f);
            if fs::rename(&tmp, path).is_ok() {
                return;
            }
        }
    }
    let _ = fs::write(path, bytes);
}

/// 防抖合并写线程：收到首个请求后等 150ms，窗口内的写请求按类别取最新
fn saver_loop(rx: Receiver<SaveReq>) {
    loop {
        let Ok(first) = rx.recv() else { return };
        let mut tasks: Option<Vec<Task>> = None;
        let mut settings: Option<Value> = None;
        match first {
            SaveReq::Tasks(t) => tasks = Some(t),
            SaveReq::Settings(s) => settings = Some(s),
        }
        let deadline = std::time::Instant::now() + Duration::from_millis(150);
        loop {
            let Some(wait) = deadline.checked_duration_since(std::time::Instant::now()) else {
                break;
            };
            match rx.recv_timeout(wait) {
                Ok(SaveReq::Tasks(t)) => tasks = Some(t),
                Ok(SaveReq::Settings(s)) => settings = Some(s),
                Err(_) => break,
            }
        }
        if let Some(t) = &tasks {
            if let Ok(bytes) = serde_json::to_vec_pretty(t) {
                write_json_atomic(&tasks_path(), &bytes);
            }
        }
        if let Some(s) = &settings {
            if let Ok(bytes) = serde_json::to_vec_pretty(s) {
                write_json_atomic(&settings_path(), &bytes);
            }
        }
    }
}

/// 到期提醒线程：每 30s 扫一遍（首个周期 5s），到期未完成 → 系统通知，每条只提醒一次
pub fn spawn_reminder_loop(app: tauri::AppHandle) {
    use tauri_plugin_notification::NotificationExt;
    std::thread::spawn(move || {
        use tauri::Manager;
        let mut first = true;
        loop {
            std::thread::sleep(if first { Duration::from_secs(5) } else { Duration::from_secs(30) });
            first = false;
            let now = now_ms();
            let mut hits: Vec<(String, String)> = vec![];
            {
                let st = app.state::<AppState>();
                let tasks = st.tasks.lock().unwrap();
                let mut notified = st.notified.lock().unwrap();
                if notified.len() > 1000 {
                    notified.clear(); // 溢出清理；过期任务不会再次命中条件
                }
                for t in tasks.iter() {
                    // 已完成或已挂起的任务不做到期提醒
                    if t.d || t.susp {
                        continue;
                    }
                    if let Some(due) = t.due {
                        if due <= now && now - due < 86_400_000 && notified.insert((t.id.clone(), due)) {
                            hits.push((t.id.clone(), t.t.clone()));
                        }
                    }
                }
            }
            let mut payloads: Vec<serde_json::Value> = Vec::new();
            for (id, text) in hits {
                let _ = app
                    .notification()
                    .builder()
                    .title("PinTodo 待办提醒")
                    .body(&text)
                    .show();
                payloads.push(serde_json::json!({"id": id, "t": text}));
            }
            if !payloads.is_empty() {
                use tauri::Emitter as _;
                let _ = app.emit_to("main", "reminders-due", payloads);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn migrate_old_record() {
        let old = json!({"t": "买牛奶", "d": false});
        let t = migrate_task(old);
        assert!(!t.id.is_empty());
        assert_eq!(t.t, "买牛奶");
        assert_eq!(t.list, "默认");
        assert_eq!(t.tags.len(), 0);
        assert_eq!(t.pri, 0);
        assert!(t.due.is_none());
        assert!(t.created_at > 0);

        let done = migrate_task(json!({"t": "旧完成项", "d": true}));
        assert!(done.done_at.is_some());
    }

    #[test]
    fn migrate_keeps_new_fields() {
        let v = json!({"id":"abc","t":"x","d":false,"list":"工作","tags":["#a"],"pri":1,
                       "due":1731168000000i64,"recur":"daily","createdAt":1,"doneAt":null});
        let t = migrate_task(v);
        assert_eq!(t.id, "abc");
        assert_eq!(t.list, "工作");
        assert_eq!(t.recur.as_deref(), Some("daily"));
        assert_eq!(t.due, Some(1731168000000i64));
    }

    #[test]
    fn serialize_camel_case() {
        let t = migrate_task(json!({"t":"x"}));
        let s = serde_json::to_value(&t).unwrap();
        assert!(s.get("createdAt").is_some());
        assert!(s.get("doneAt").is_some());
    }
}
