//! 自动更新：从 GitHub Releases 检查最新版本、下载安装包并自替换重启。
//!
//! 流程：
//!   1. `check_update` 拉取 `releases/latest`，语义化版本比较后返回更新信息；
//!   2. `download_update` 只允许 GitHub 域名，下载到临时目录并做基础校验（MZ 头）；
//!   3. `install_update` 改名运行中的 exe，复制新版本并分离式重启。
//!      下次启动时 `cleanup_old_exe` 删掉 .old。

use serde::Serialize;

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

#[tauri::command]
pub fn app_version() -> String {
    current_version()
}

/// 检查最新版本：无更新返回 None；有更新返回 UpdateInfo。
///
/// 不走 api.github.com（匿名 60 次/小时限流，容易 403），
/// 而是访问 releases/latest 页面 —— GitHub 会 302 跳转到 /releases/tag/vX.Y.Z，
/// 从最终 URL 里读出版本号，安装包地址按命名约定拼接，完全不受配额限制。
#[tauri::command]
pub async fn check_update() -> Result<Option<UpdateInfo>, String> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("PinTodo-Updater/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("初始化网络客户端失败：{e}"))?;

    let page = format!("https://github.com/{REPO}/releases/latest");
    let resp = client
        .get(page)
        .send()
        .await
        .map_err(|e| format!("网络不可用：{e}"))?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("仓库还没有发布任何版本".into());
    }
    if !resp.status().is_success() {
        return Err(format!("GitHub 返回 {}", resp.status()));
    }

    // 跟随跳转后的最终 URL 形如 https://github.com/{REPO}/releases/tag/v1.0.2
    let final_url = resp.url().to_string();
    let marker = "/tag/";
    let tag = match final_url.rsplit_once(marker) {
        Some((_, t)) if !t.is_empty() && t.len() <= 64 => t.to_string(),
        _ => return Err("无法从 GitHub 解析最新版本号".into()),
    };
    let tag_ok = tag
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | '+'));
    if !tag_ok {
        return Err("解析到的版本号格式异常".into());
    }

    let latest = tag.trim().trim_start_matches(['v', 'V']).to_string();
    if parse_ver(&latest) <= parse_ver(&current_version()) {
        return Ok(None);
    }

    // 安装包按命名约定：releases/download/{tag}/PinTodo-{version}.exe
    let url = format!("https://github.com/{REPO}/releases/download/{tag}/PinTodo-{latest}.exe");

    Ok(Some(UpdateInfo {
        version: latest,
        tag,
        notes: String::new(),
        url,
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

/// 应用更新：启动独立 PowerShell 助手；助手等待旧进程退出后替换 exe 并重启。
/// 参数使用 Command::args 分项传递，脚本内容固定，不拼接 shell 命令字符串。
#[tauri::command]
pub fn install_update(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("定位当前程序失败：{e}"))?;
    let new = std::path::PathBuf::from(&path);
    if !new.exists() {
        return Err("更新包不存在，请重新下载".into());
    }
    // 更新包必须位于我们自己的临时下载目录且命名符合约定，拒绝任意路径。
    let valid_dir = new
        .parent()
        .map(|p| p.file_name().map(|n| n == "PinTodo-update").unwrap_or(false))
        .unwrap_or(false);
    let valid_name = new
        .file_name()
        .map(|n| {
            let s = n.to_string_lossy();
            s.starts_with("PinTodo-") && s.to_lowercase().ends_with(".exe")
        })
        .unwrap_or(false);
    if !valid_dir || !valid_name {
        return Err("更新包路径不合法".into());
    }

    let old = exe.with_extension("exe.old");
    if old.exists() {
        let _ = std::fs::remove_file(&old); // 上次更新的残留
    }

    // 首选原位替换：若 Windows 允许改名当前映像，Tauri 会在旧进程退出后重启新 exe。
    if std::fs::rename(&exe, &old).is_ok() {
        match std::fs::copy(&new, &exe) {
            Ok(_) => {
                app.request_restart();
                return Ok(());
            }
            Err(e) => {
                let _ = std::fs::remove_file(&exe);
                let _ = std::fs::rename(&old, &exe);
                return Err(format!("写入新版本失败，已恢复旧版：{e}"));
            }
        }
    }

    // 若当前 exe 被系统/杀软锁定，则用独立 PowerShell 助手等待文件句柄释放后替换。
    let pid = std::process::id().to_string();
    let script = std::env::temp_dir().join(format!("pintodo-update-{pid}.ps1"));
    const SCRIPT: &str = r#"
param([int]$TargetProcessId, [string]$ExePath, [string]$NewPath, [string]$OldPath)
$ErrorActionPreference = 'Stop'
$LogPath = Join-Path $env:TEMP 'pintodo-update-helper.log'
function Write-Log([string]$Message) {
  Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format o) + ' ' + $Message)
}
try {
  Write-Log ('helper started pid=' + $PID + ' target=' + $TargetProcessId)
  Wait-Process -Id $TargetProcessId -Timeout 30 -ErrorAction Stop
  Write-Log 'old process exited'
  Start-Sleep -Milliseconds 300
  $moved = $false
  for ($i = 0; $i -lt 40; $i++) {
    try {
      Move-Item -LiteralPath $ExePath -Destination $OldPath -Force -ErrorAction Stop
      $moved = $true
      break
    } catch { Start-Sleep -Milliseconds 250 }
  }
  if (-not $moved) { throw 'Unable to move old executable after retries' }
  Write-Log 'old exe moved'
  Copy-Item -LiteralPath $NewPath -Destination $ExePath -Force -ErrorAction Stop
  Write-Log 'new exe copied'
  Start-Process -FilePath $ExePath -ErrorAction Stop
  Write-Log 'new exe started'
} catch {
  Write-Log ('ERROR: ' + $_.ToString())
  if ((Test-Path -LiteralPath $OldPath) -and -not (Test-Path -LiteralPath $ExePath)) {
    Move-Item -LiteralPath $OldPath -Destination $ExePath -Force -ErrorAction SilentlyContinue
    Write-Log 'rollback attempted'
  }
  exit 1
}
"#;
    std::fs::write(&script, SCRIPT).map_err(|e| format!("写入更新助手失败：{e}"))?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        let spawn_helper = |flags| {
            std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                ])
                .arg(&script)
                .arg(&pid)
                .arg(&exe)
                .arg(&new)
                .arg(&old)
                .creation_flags(flags)
                .spawn()
        };
        // 若父进程位于不允许 breakaway 的 job object 中，回退到普通 detached 子进程。
        spawn_helper(DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_BREAKAWAY_FROM_JOB)
            .or_else(|_| spawn_helper(DETACHED_PROCESS | CREATE_NO_WINDOW))
            .map_err(|e| format!("启动更新助手失败：{e}"))?;
    }

    // 助手独立等待此进程退出，避免与 single-instance 插件竞争。
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

#[cfg(test)]
mod tests {
    use super::parse_ver;

    #[test]
    fn version_compare_semantic() {
        assert!(parse_ver("v1.0.2") > parse_ver("1.0.1"));
        assert!(parse_ver("V1.1.0") > parse_ver("v1.0.9"));
        assert!(parse_ver("1.2.0") > parse_ver("1.1.99"));
        assert_eq!(parse_ver("v1.0.2"), parse_ver("1.0.2"));
        assert_eq!(parse_ver("1.0"), (1, 0, 0));
        assert!(parse_ver("v1.0.2-beta") >= parse_ver("1.0.2"));
    }
}
