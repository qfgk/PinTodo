// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 冷启动计时起点：进程入口即记录，JS 首帧后 report_ready 上报
    todo_lib::BOOT.get_or_init(std::time::Instant::now);
    todo_lib::run()
}
