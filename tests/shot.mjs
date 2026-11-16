// 截图工具：启动 release 应用（带 CDP），截取主窗画面保存 PNG
import { spawn, execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXE = join(process.cwd(), 'src-tauri/target/release/todo.exe')
const OUT = process.argv[2] || join(__dirname, 'shot.png')
const PORT = Number(process.argv[3] || 9230)
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

async function main() {
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
  if (!page) { console.error('CDP 连接失败'); proc.kill(); process.exit(2) }
  await page.send('Runtime.evaluate', { expression: 'window.__pintodo.booted?.()', awaitPromise: true })
  await sleep(900)
  const shot = await page.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log('saved:', OUT)
  page.close()
  proc.kill()
}

main().catch((e) => { console.error(e); process.exit(1) })
