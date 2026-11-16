// 真实「显示桌面」(Win+D 等价命令) 验证：胶囊是否留在桌面上并进入挂起态
// 注意：会短暂隐藏当前桌面所有窗口（约 4 秒），随后自动还原
import { spawn, execSync, execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXE = join(process.cwd(), 'src-tauri/target/release/todo.exe')
const APPDATA = join(os.homedir(), 'AppData/Roaming')
const DATA_DIR = join(APPDATA, 'PinTodo')
const TASKS_JSON = join(DATA_DIR, 'tasks.json')
const SETTINGS_JSON = join(DATA_DIR, 'settings.json')
const PS1 = join(__dirname, 'show-desktop.ps1')
const PORT = 9228
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TOGGLE_ACTION = process.argv[2] === 'toggle' ? 'toggle' : 'wind'
const showDesktop = (action = TOGGLE_ACTION) =>
  execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Action', action], { encoding: 'utf-8' }).trim()

const isDesktopClass = (cls) => cls === 'Progman' || cls === 'WorkerW'

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

async function main() {
  mkdirSync(DATA_DIR, { recursive: true })
  const origTasks = existsSync(TASKS_JSON) ? readFileSync(TASKS_JSON, 'utf-8') : null
  const origSettings = existsSync(SETTINGS_JSON) ? readFileSync(SETTINGS_JSON, 'utf-8') : null
  const restore = () => {
    try {
      if (origTasks !== null) writeFileSync(TASKS_JSON, origTasks)
      if (origSettings !== null) writeFileSync(SETTINGS_JSON, origSettings)
    } catch {}
  }

  try { execSync('taskkill /IM todo.exe /F', { stdio: 'ignore' }) } catch {}
  await sleep(1200)
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
  if (!page) { console.error('CDP 连接失败'); proc.kill(); restore(); process.exit(2) }

  await evalIn(page, `window.__pintodo.booted?.()`)
  await sleep(600)

  // 归一化：确保主窗口处于 normal 展开态（贴片态会走另一条分支，测不到“展开→收缩”路径）
  const st0 = await evalIn(page, `window.__pintodo.wstate()`)
  if (st0 !== 'normal') {
    await evalIn(page, `window.__pintodo.restore()`)
    for (let i = 0; i < 25; i++) {
      if ((await evalIn(page, `window.__pintodo.wstate()`)) === 'normal') break
      await sleep(200)
    }
  }
  // 模拟用户正在使用主窗口（聚焦），这是“首次启动后按 Win+D”的真实场景
  try { await page.send('Page.bringToFront') } catch {}
  await sleep(500)

  const base = await evalIn(page, `window.__pintodo.diag()`)
  const fg0 = showDesktop('foreground')
  console.log('① 基线:', JSON.stringify(base), '前台窗口类:', fg0)

  // 归一化：若桌面已处于「显示桌面」状态，先切回来，保证 419 一定是「进入桌面」
  if (isDesktopClass(fg0)) {
    console.log('  桌面已处于显示状态，先还原…')
    showDesktop()
    await sleep(900)
  }

  let desktopShown = false
  try {
    console.log('▶ 发送真实「显示桌面」命令…')
    const out = showDesktop()
    desktopShown = out.includes('SENT')
    console.log('  PowerShell:', out)
    // 等待超过补强窗口期（150/380/780/1400ms）
    await sleep(2600)

    const dg = await evalIn(page, `window.__pintodo.diag()`)
    const ui = await evalIn(page, `({
      dataset: document.body.dataset.suspended,
      zzz: !!document.querySelector('.zzz'),
      pill: !!document.querySelector('.pill'),
      tabMode: document.body.dataset.mode,
    })`)
    console.log('② 显示桌面后:', JSON.stringify(dg), JSON.stringify(ui), '前台窗口类:', showDesktop('foreground'))

    const ok =
      dg.wstate.startsWith('hidden') &&
      dg.suspended === true &&
      dg.visible === true &&
      dg.minimized === false &&
      dg.topmost === true &&
      ui.zzz === true && ui.pill === true && ui.tabMode === 'tab'
    console.log(ok ? '✅ 挂起态正确：胶囊留在桌面上，可见、未最小化、置顶、睡眠外观' : '❌ 挂起态异常')

    // 还原桌面窗口（只有在桌面仍处于显示状态时才切换）
    console.log('▶ 还原桌面窗口…')
    if (isDesktopClass(showDesktop('foreground'))) {
      showDesktop()
      desktopShown = false
      await sleep(900)
    }
    console.log('  还原后前台窗口类:', showDesktop('foreground'))

    // 点击胶囊唤醒
    await evalIn(page, `(() => {
      const tab = document.querySelector('.tab')
      tab?.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, screenX: 600, screenY: 400 }))
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, screenX: 600, screenY: 400 }))
      return true
    })()`)
    for (let i = 0; i < 25; i++) {
      const s = await evalIn(page, `window.__pintodo.wstate()`)
      if (s === 'normal') break
      await sleep(200)
    }
    const after = await evalIn(page, `window.__pintodo.diag()`)
    console.log('③ 点击胶囊后:', JSON.stringify(after))
    console.log(after.wstate === 'normal' && after.suspended === false ? '✅ 唤醒成功，退出挂起态' : '❌ 唤醒失败')
    process.exitCode = ok && after.wstate === 'normal' && !after.suspended ? 0 : 1
  } finally {
    // 兜底：尽量把桌面恢复为「不显示」状态，别把用户窗口留在隐藏态
    try {
      for (let i = 0; i < 2; i++) {
        if (!isDesktopClass(showDesktop('foreground'))) break
        showDesktop()
        await sleep(700)
      }
    } catch {}
    restore()
    proc.kill()
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
