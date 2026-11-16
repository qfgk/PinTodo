// 自动更新（GitHub Releases）：检查 → 下载 → 重启替换
import { invoke } from '@tauri-apps/api/core'
import { toast } from './ui'

export interface UpdateInfo {
  version: string
  tag: string
  notes: string
  url: string
  current: string
}

let checking = false
let downloading = false

export async function currentVersion(): Promise<string> {
  try {
    return await invoke<string>('app_version')
  } catch {
    return '?'
  }
}

/** 检查更新：manual=true 时无更新/失败都会给提示；自动检查时静默失败 */
export async function checkUpdates(manual = false): Promise<void> {
  if (checking) return
  checking = true
  try {
    const info = await invoke<UpdateInfo | null>('check_update')
    if (!info) {
      if (manual) toast(`已是最新版本 v${await currentVersion()}`)
      return
    }
    toast(`发现新版本 v${info.version}（当前 v${info.current}）`, undefined, [
      { label: `下载 v${info.version}`, onClick: () => void downloadAndInstall(info) },
    ], 20000)
  } catch (e) {
    if (manual) toast('检查更新失败：' + String(e), undefined, [], 6000)
  } finally {
    checking = false
  }
}

async function downloadAndInstall(info: UpdateInfo): Promise<void> {
  if (downloading) return
  downloading = true
  toast(`正在下载 v${info.version}…`, undefined, [], 180000)
  try {
    const path = await invoke<string>('download_update', {
      url: info.url,
      version: info.version,
    })
    toast(`v${info.version} 已下载，重启后完成更新`, undefined, [
      {
        label: '立即重启更新',
        onClick: () => {
          invoke('install_update', { path }).catch((e) => toast('安装失败：' + String(e)))
        },
      },
    ], 60000)
  } catch (e) {
    toast('下载更新失败：' + String(e), undefined, [], 8000)
  } finally {
    downloading = false
  }
}
