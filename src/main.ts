// 入口：按窗口 label 分流到对应模块
import { getCurrentWindow } from '@tauri-apps/api/window'

const label = getCurrentWindow().label

// 任何 boot 失败都暴露到窗口标题 + 落盘 boot.log（release 无 devtools 时可诊断）
window.addEventListener('error', (e) => {
  const msg = (e.message || 'unknown').slice(0, 120)
  document.title = 'ERR ' + msg
  try {
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('report_ready', { phase: 'jserr ' + msg }))
      .catch(() => {})
  } catch { /* ignore */ }
})
window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
  const msg = typeof e.reason === 'string' ? e.reason : e.reason?.message ?? JSON.stringify(e.reason)
  document.title = 'REJ ' + String(msg).slice(0, 120)
  try {
    import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke('report_ready', { phase: 'jserr REJ ' + String(msg).slice(0, 100) }))
      .catch(() => {})
  } catch { /* ignore */ }
})

if (label === 'quickadd') {
  import('./quickadd').then((m) => m.boot())
} else {
  import('./app').then((m) => m.boot()).catch((e) => {
    document.title = 'BOOT_FAIL ' + String(e).slice(0, 120)
  })
}
