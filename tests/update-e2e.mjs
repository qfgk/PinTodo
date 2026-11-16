// 端到端验证自动更新：1.0.1 运行中 → 检查到 1.0.2 → 下载 → 替换重启
import { spawn, execSync, execFileSync } from 'node:child_process'
import { join } from 'node:path'

const EXE = join(process.cwd(), 'src-tauri/target/release/todo.exe')
const PORT = 9236
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url)
    this.id = 0
    this.pending = new Map()
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    })
  }
  get open() { return this.ws.readyState === 1 }
  async ready() {
    if (this.open) return
    await new Promise((r, j) => {
      this.ws.addEventListener('open', r, { once: true })
      this.ws.addEventListener('error', j, { once: true })
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  close() { this.ws.close() }
}

async function evalIn(page, expression) {
  await page.ready()
  const r = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result?.value
}

const exeVersion = () => {
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Item '${EXE.replace(/\\/g, '\\\\')}').VersionInfo.ProductVersion`], { encoding: 'utf-8' }).trim()
  } catch { return '?' }
}
const running = () => {
  try { return execSync('tasklist /FI "IMAGENAME eq todo.exe" /NH', { encoding: 'utf-8' }).includes('todo.exe') } catch { return false }
}

async function main() {
  try { execSync('taskkill /IM todo.exe /F', { stdio: 'ignore' }) } catch {}
  await sleep(1000)
  console.log('当前 exe 版本:', exeVersion())
  const proc = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: 'ignore',
  })
  let page = null
  for (let i = 0; i < 50 && !page; i++) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      for (const t of list.filter((t) => t.type === 'page')) {
        try {
          const c = new CDP(t.webSocketDebuggerUrl)
          await c.ready()
          const has = await c.send('Runtime.evaluate', { expression: 'typeof window.__pintodo', returnByValue: true })
          if (has.result?.value === 'object') { page = c; break }
          c.close()
        } catch {}
      }
    } catch {}
  }
  if (!page) { console.error('CDP 连接失败'); proc.kill(); process.exit(2) }
  await evalIn(page, 'window.__pintodo.booted?.()')
  await sleep(500)

  const ver = await evalIn(page, `window.__TAURI_INTERNALS__.invoke('app_version')`)
  console.log('运行版本:', ver)
  const info = await evalIn(page, `window.__TAURI_INTERNALS__.invoke('check_update')`)
  console.log('check_update:', JSON.stringify(info))
  if (!info || info.version !== '1.0.2') { console.error('❌ 未检测到 1.0.2 更新'); proc.kill(); process.exit(1) }

  const path = await evalIn(page, `window.__TAURI_INTERNALS__.invoke('download_update', { url: ${JSON.stringify(info.url)}, version: ${JSON.stringify(info.version)} })`)
  console.log('下载完成:', path)

  // 触发安装：应用会退出，CDP 可能断开
  try {
    await evalIn(page, `window.__TAURI_INTERNALS__.invoke('install_update', { path: ${JSON.stringify(path)} })`)
  } catch { /* 进程退出导致断开，属预期 */ }
  page.close()

  // 等批处理替换并重启（2s 延迟 + 复制 5MB）
  await sleep(9000)
  console.log('替换后 exe 版本:', exeVersion())
  console.log('进程存活:', running())
  const okVer = exeVersion() === '1.0.2'
  const okRun = running()
  console.log(okVer && okRun ? '✅ 自动更新端到端成功（1.0.1 → 1.0.2，进程已重启）' : '❌ 自动更新失败')
  process.exit(okVer && okRun ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
