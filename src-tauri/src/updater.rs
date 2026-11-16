//! 自动更新：从 GitHub Releases 检查最新版本、下载安装包并自替换重启。
//!
//! 流程：
//!   1. `check_update` 拉取 `releases/latest`，语义化版本比较后返回更新信息；
//!   2. `download_update` 只允许 GitHub 域名，下载到临时目录并做基础校验（MZ 头）；
//!   3. `install_update` 写一个批处理：退出后把旧 exe 改名为 .old、放入新 exe、拉起新进程。
//!      下次启动时 `cleanup_old_exe` 删掉 .old。

use serde::{Deserialize, Serialize};
use std::io::Write;

/// 仓库地址：可在发布新版本时直接改这里
const REPO: &str = "qfgk/PinTodo";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 最新版本号（去掉 v 前缀）
    pub version: String,
    /// 原始 tag（如 v1.0.2）
    pub tag: String,
    /// Release 说明（Markdown）
    pub notes: String,
    /// 安装包下载地址（GitHub 资产直链）
    pub url: String,
    /// 当前运行版本
    pub current: String,
}

pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn parse_ver(s: &str) -> (u64, u64, u64) {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let mut parts = s.split('.').map(|x| {
        x.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse::<u64>()
            .unwrap_or(0)
    });
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    assets: Vec<GhAsset>,
}

#[tauri::command]
pub fn app_version() -> String {
    current_version()
}

/// 检查最新版本：无更新返回 None；有更新返回 UpdateInfo
#[tauri::command]
pub async fn check_update() -> Result<Option<UpdateInfo>, String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("PinTodo-Updater/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("初始化网络客户端失败：{e}"))?;

    let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
    let resp = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("网络不可用：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("GitHub 返回 {}", resp.status()));
    }
    let rel: GhRelease = resp.json().await.map_err(|e| format!("解析版本信息失败：{e}"))?;

    let latest = rel.tag_name.trim().trim_start_matches(['v', 'V']).to_string();
    if parse_ver(&latest) <= parse_ver(&current_version()) {
        return Ok(None);
    }
    let asset = rel
        .assets
        .iter()
        .filter(|a| a.name.to_lowercase().ends_with(".exe"))
        .max_by_key(|a| a.size)
        .ok_or_else(|| "最新版本没有附带 exe 安装包".to_string())?;

    Ok(Some(UpdateInfo {
        version: latest,
        tag: rel.tag_name,
        notes: rel.body.unwrap_or_default(),
        url: asset.browser_download_url.clone(),
        current: current_version(),
    }))
}

/// 下载更新包到临时目录并返回本地路径
#[tauri::command]
pub async fn download_update(url: String, version: String) -> Result<String, String> {
    // 只信任 GitHub 域名，避免被替换成任意地址
    let ok_host = url.starts_with("https://github.com/")
        || url.starts_with("https://objects.githubusercontent.com/")
        || url.starts_with("https://release-assets.githubusercontent.com/");
    if !ok_host {
        return Err("更新地址不合法（非 GitHub 域名）".into());
    }

    let client = reqwest::Client::builder()
        .user_agent(concat!("PinTodo-Updater/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("初始化网络客户端失败：{e}"))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| format!("下载失败：{e}"))?;
    if bytes.len() < 1024 * 1024 || &bytes[0..2] != b"MZ" {
        return Err("下载的文件不是有效的 Windows 可执行文件".into());
    }

    let dir = std::env::temp_dir().join("PinTodo-update");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
    let safe_ver: String = version
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '-' || *c == '_')
        .collect();
    let path = dir.join(format!("PinTodo-{safe_ver}.exe"));
    std::fs::write(&path, &bytes).map_err(|e| format!("写入更新包失败：{e}"))?;
    Ok(path.to_string_lossy().to_string())
}

/// 应用更新：退出当前进程，由批处理替换 exe 并重启
#[tauri::command]
pub fn install_update(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位当前程序失败：{e}"))?;
    let old = exe.with_extension("exe.old");
    if !std::path::Path::new(&path).exists() {
        return Err("更新包不存在，请重新下载".into());
    }

    let bat = std::env::temp_dir().join("pintodo-apply-update.bat");
    // 2 秒后旧进程已退出：改名旧 exe → 放入新 exe → 拉起新进程 → 自删批处理
    let script = format!(
        "@echo off\r\nchcp 65001 >nul\r\ntimeout /t 2 /nobreak >nul\r\n\
         move /Y \"{exe}\" \"{old}\" >nul 2>nul\r\n\
         copy /Y \"{new}\" \"{exe}\" >nul\r\n\
         start \"\" \"{exe}\"\r\n\
         del \"%~f0\"\r\n",
        exe = exe.display(),
        old = old.display(),
        new = path
    );
    {
        let mut f = std::fs::File::create(&bat).map_err(|e| format!("写入更新脚本失败：{e}"))?;
        f.write_all(script.as_bytes())
            .map_err(|e| format!("写入更新脚本失败：{e}"))?;
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .arg("/C")
            .arg(format!("start \"\" /min \"{}\"", bat.display()))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("启动更新脚本失败：{e}"))?;
    }

    app.exit(0);
    Ok(())
}

/// 启动时清理上次更新留下的 todo.exe.old
pub fn cleanup_old_exe() {
    if let Ok(exe) = std::env::current_exe() {
        let old = exe.with_extension("exe.old");
        let _ = std::fs::remove_file(old);
    }
}
