// 生成仓库用截图：临时写入演示数据 → 截图 → 还原真实数据
import { spawn, execSync } from 'node:child_process'
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
const OUT = process.argv[2] || join(process.cwd(), 'docs/screenshot.png')
const PORT = 9231
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const now = Date.now()
const d0 = new Date()
d0.setHours(0, 0, 0, 0)
const today = d0.getTime()
const DAY = 86400000
const at = (dayOffset, h, m = 0) => {
  const d = new Date(today + dayOffset * DAY)
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

const demoTasks = [
  { id: 'demo-1', t: '敲定产品周会纪要', d: false, list: '默认', tags: ['#工作'], pri: 1, star: true,
    due: at(0, 18), recur: null, notes: '把 3 条待确认结论同步给相关同学',
    prog: '已整理 3 条待确认结论', progLogs: [
      { id: 'p1', text: '已整理 3 条待确认结论', time: now - 3600_000 },
      { id: 'p2', text: '收集完各组周报', time: now - 2 * 3600_000 },
    ], createdAt: now - DAY, doneAt: null },
  { id: 'demo-2', t: '回复设计稿评审意见', d: false, list: '默认', tags: ['#设计'], pri: 2, star: false,
    due: at(0, 17, 30), recur: null, notes: null, prog: null, progLogs: [], createdAt: now - DAY, doneAt: null },
  { id: 'demo-3', t: '提交季度复盘初稿', d: false, list: '默认', tags: ['#工作'], pri: 2, star: false,
    due: at(1, 18), recur: null, notes: null, prog: null, progLogs: [], createdAt: now - DAY, doneAt: null },
  { id: 'demo-4', t: '整理读书笔记《深度工作》', d: false, list: '默认', tags: ['#阅读'], pri: 3, star: false,
    due: at(3, 20), recur: null, notes: null, prog: null, progLogs: [], createdAt: now - DAY, doneAt: null },
  { id: 'demo-5', t: '给妈妈打个电话', d: false, list: '默认', tags: ['#生活'], pri: 0, star: true,
    due: at(4, 20), recur: 'weekly', notes: null, prog: null, progLogs: [], createdAt: now - DAY, doneAt: null },
  { id: 'demo-6', t: '续签健身年卡', d: false, list: '默认', tags: ['#生活'], pri: 0, star: false,
    due: at(9, 12), recur: null, notes: null, prog: null, progLogs: [], createdAt: now - DAY, doneAt: null },
  { id: 'demo-7', t: '学习 Rust 异步编程', d: false, list: '默认', tags: ['#学习'], pri: 0, star: false,
    due: null, recur: null, notes: null, prog: null, progLogs: [], createdAt: now - DAY, doneAt: null },
  { id: 'demo-8', t: '策划年度旅行路线', d: false, list: '默认', tags: ['#生活'], pri: 0, star: false,
    due: at(20, 12), recur: null, susp: true, notes: null, prog: null, progLogs: [], createdAt: now - DAY, doneAt: null },
  { id: 'demo-9', t: '晨跑 5 公里', d: true, list: '默认', tags: [], pri: 0, star: false,
    due: null, recur: 'daily', notes: null, prog: null, progLogs: [], createdAt: now - 2 * DAY, doneAt: now - 5 * 3600_000 },
]

const demoSettings = {
  x: 360, y: 90, w: 352, h: 712,
  edge: null, pillMode: null, edgeY: null,
  lists: ['默认'], lastList: '默认',
  theme: 'light', topmost: true,
  collapsedGroups: {},
}

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

async function main() {
  mkdirSync(DATA_DIR, { recursive: true })
  mkdirSync(dirname(OUT), { recursive: true })
  const origTasks = existsSync(TASKS_JSON) ? readFileSync(TASKS_JSON, 'utf-8') : null
  const origSettings = existsSync(SETTINGS_JSON) ? readFileSync(SETTINGS_JSON, 'utf-8') : null
  const TRASH_JSON = join(DATA_DIR, 'trash.json')
  const origTrash = existsSync(TRASH_JSON) ? readFileSync(TRASH_JSON, 'utf-8') : null
  const restore = () => {
    try {
      if (origTasks !== null) writeFileSync(TASKS_JSON, origTasks)
      if (origSettings !== null) writeFileSync(SETTINGS_JSON, origSettings)
      // 保护用户回收站不被启动时自动清理
      if (origTrash !== null) writeFileSync(TRASH_JSON, origTrash)
    } catch {}
  }

  writeFileSync(TASKS_JSON, JSON.stringify(demoTasks, null, 2))
  writeFileSync(SETTINGS_JSON, JSON.stringify(demoSettings, null, 2))

  try { execSync('taskkill /IM todo.exe /F', { stdio: 'ignore' }) } catch {}
  await sleep(1000)
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
  await page.send('Runtime.evaluate', { expression: 'window.__pintodo.booted?.()', awaitPromise: true })
  await sleep(1200)
  const shot = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log('saved:', OUT)
  page.close()
  proc.kill()
  await sleep(400)
  restore()
}

main().catch((e) => { console.error(e); process.exit(1) })
