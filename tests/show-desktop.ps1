# 显示桌面诊断与切换工具
#   -Action toggle      发送「显示桌面」任务栏命令（等价 Win+D）
#   -Action wind        用真实键盘事件模拟 Win+D（keybd_event，系统级）
#   -Action foreground  输出当前前台窗口类名（Progman/WorkerW 即桌面）
param([string]$Action = "toggle")
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class Win32Desk {
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern IntPtr FindWindow(string cls, string win);
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")]
  public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
if ($Action -eq "foreground") {
  $h = [Win32Desk]::GetForegroundWindow()
  $sb = New-Object System.Text.StringBuilder 256
  [void][Win32Desk]::GetClassName($h, $sb, 256)
  Write-Output $sb.ToString()
  exit 0
}
if ($Action -eq "wind") {
  # LWIN down, D down, D up, LWIN up → 真实 Win+D
  [Win32Desk]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [Win32Desk]::keybd_event(0x44, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [Win32Desk]::keybd_event(0x44, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [Win32Desk]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
  Write-Output "SENT"
  exit 0
}
$tray = [Win32Desk]::FindWindow("Shell_TrayWnd", $null)
if ($tray -eq [IntPtr]::Zero) { Write-Output "NO_TRAY"; exit 1 }
[void][Win32Desk]::SendMessage($tray, 0x111, [IntPtr]419, [IntPtr]0)
Write-Output "SENT"
exit 0
