//! 监听 Windows 显示桌面（Win+D / Win+M / 任务栏右下角按钮）事件。
//!
//! 判定依据：前台窗口的窗口类是否为桌面窗口（Progman / WorkerW）。
//! 双通道检测：
//!   1. SetWinEventHook(EVENT_SYSTEM_FOREGROUND) 实时钩子；
//!   2. 400ms 轮询 GetForegroundWindow 兜底（部分触发路径不产生前台事件，
//!      例如已聚焦桌面时再按 Win+D、或任务栏角落按钮）。
//! 只在「进入桌面 / 离开桌面」的状态跃变时各发一次事件，避免事件风暴：
//!   - 进入桌面 → show-desktop-detected （前端进入挂起态并收缩为侧边胶囊）
//!   - 离开桌面 → desktop-restored     （前端让胶囊苏醒，但保持贴片形态）

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
/// 上一次检测到的「桌面是否为前台」状态（钩子与轮询线程共享）
static DESKTOP_ACTIVE: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
mod win32 {
    use std::ffi::c_void;

    pub type HWND = isize;
    pub type DWORD = u32;
    pub type LONG = i32;

    #[link(name = "user32")]
    extern "system" {
        pub fn GetForegroundWindow() -> HWND;
        pub fn GetClassNameW(hWnd: HWND, lpString: *mut u16, nMaxCount: i32) -> i32;
        pub fn SetWinEventHook(
            eventMin: DWORD,
            eventMax: DWORD,
            hmodWinEventProc: *mut c_void,
            lpfnWinEventProc: extern "system" fn(*mut c_void, DWORD, HWND, LONG, LONG, DWORD, DWORD),
            idProcess: DWORD,
            idThread: DWORD,
            dwFlags: DWORD,
        ) -> *mut c_void;
        pub fn GetMessageW(lpMsg: *mut c_void, hWnd: HWND, wMsgFilterMin: u32, wMsgFilterMax: u32) -> i32;
        pub fn TranslateMessage(lpMsg: *const c_void) -> i32;
        pub fn DispatchMessageW(lpMsg: *const c_void) -> isize;
        pub fn UnhookWinEvent(hWinEventHook: *mut c_void) -> i32;
        pub fn ShowWindow(hWnd: HWND, nCmdShow: i32) -> i32;
        pub fn SetWindowPos(
            hWnd: HWND,
            hWndInsertAfter: HWND,
            X: i32,
            Y: i32,
            cx: i32,
            cy: i32,
            uFlags: u32,
        ) -> i32;
    }

    pub const SW_RESTORE: i32 = 9;
    /// (HWND)-1：置于所有非置顶窗口之上
    pub const HWND_TOPMOST: HWND = -1;
    pub const SWP_NOSIZE: u32 = 0x0001;
    pub const SWP_NOMOVE: u32 = 0x0002;
    pub const SWP_NOACTIVATE: u32 = 0x0010;
    pub const SWP_SHOWWINDOW: u32 = 0x0040;

    /// 桌面窗口（Progman=桌面本体，WorkerW=壁纸层，两者都出现在「显示桌面」路径上）
    pub fn is_desktop_window(hwnd: HWND) -> bool {
        if hwnd == 0 {
            return false;
        }
        let mut buf = [0u16; 128];
        let len = unsafe { GetClassNameW(hwnd, buf.as_mut_ptr(), 128) };
        if len <= 0 {
            return false;
        }
        let class_name = String::from_utf16_lossy(&buf[..len as usize]);
        class_name == "Progman" || class_name == "WorkerW"
    }

    /// 多次把主窗口从最小化/隐藏状态重新拉起并钉回置顶层。
    /// 直接在监控线程里用 Win32 完成，不依赖 WebView2（Win+D 会同步挂起前台窗口的渲染与 JS）。
    pub fn reveal_pulses(hwnd: HWND) {
        std::thread::spawn(move || {
            let delays = [0u64, 120, 320, 700, 1200];
            let mut prev = 0u64;
            for d in delays {
                std::thread::sleep(std::time::Duration::from_millis(d - prev));
                prev = d;
                unsafe {
                    ShowWindow(hwnd, SW_RESTORE);
                    SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                    );
                }
            }
        });
    }
}

#[cfg(windows)]
use win32::*;

/// 状态跃变通知：只在进入/离开桌面时各发一次
#[cfg(windows)]
fn notify_transition(desktop_now: bool) {
    let prev = DESKTOP_ACTIVE.swap(desktop_now, Ordering::SeqCst);
    if desktop_now == prev {
        return;
    }
    if let Some(app) = APP_HANDLE.get() {
        if desktop_now {
            let _ = app.emit_to("main", "show-desktop-detected", ());
            // 关键兜底：Win+D 会同步最小化/隐藏前台窗口（含 WebView2 的 JS 执行），
            // 前端收缩逻辑可能来不及跑。这里直接用 Win32 把主窗反复拉回置顶层，
            // 保证胶囊不会“整个消失”。
            {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    if let Ok(hwnd) = w.hwnd() {
                        win32::reveal_pulses(hwnd.0 as isize);
                    }
                }
            }
        } else {
            let _ = app.emit_to("main", "desktop-restored", ());
        }
    }
}

#[cfg(windows)]
pub fn start_desktop_monitor(app: AppHandle) {
    let _ = APP_HANDLE.set(app);

    // ---- 通道 1：前台窗口事件钩子（实时） ----
    std::thread::spawn(|| {
        unsafe {
            const EVENT_SYSTEM_FOREGROUND: DWORD = 0x0003;
            const WINEVENT_OUTOFCONTEXT: DWORD = 0;

            extern "system" fn win_event_proc(
                _hook: *mut std::ffi::c_void,
                _event: DWORD,
                hwnd: HWND,
                _id_object: LONG,
                _id_child: LONG,
                _dw_event_thread: DWORD,
                _dwms_event_time: DWORD,
            ) {
                notify_transition(is_desktop_window(hwnd));
            }

            let hook = SetWinEventHook(
                EVENT_SYSTEM_FOREGROUND,
                EVENT_SYSTEM_FOREGROUND,
                std::ptr::null_mut(),
                win_event_proc,
                0,
                0,
                WINEVENT_OUTOFCONTEXT,
            );

            if !hook.is_null() {
                // 标准 Windows 消息泵（28 字节 MSG 结构）
                let mut msg = [0u8; 48];
                while GetMessageW(msg.as_mut_ptr() as *mut std::ffi::c_void, 0, 0, 0) > 0 {
                    TranslateMessage(msg.as_ptr() as *const std::ffi::c_void);
                    DispatchMessageW(msg.as_ptr() as *const std::ffi::c_void);
                }
                UnhookWinEvent(hook);
            }
        }
    });

    // ---- 通道 2：轮询兜底（覆盖不触发前台事件或事件丢失的路径） ----
    std::thread::spawn(|| {
        loop {
            std::thread::sleep(std::time::Duration::from_millis(400));
            let hwnd = unsafe { GetForegroundWindow() };
            notify_transition(is_desktop_window(hwnd));
        }
    });
}

#[cfg(not(windows))]
pub fn start_desktop_monitor(_app: AppHandle) {}
