// 更新器连通性检查：app_version / check_update / download_update 基础校验
import { spawn, execSync } from 'node:child_process'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const EXE = join(process.cwd(), 'src-tauri/target/release/todo.exe')
const PORT = 9235
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

async function evalIn(page, expression, awaitPromise = true) {
  await page.ready()
  const r = await page.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result?.value
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
  await evalIn(page, 'window.__pintodo.booted?.()')
  await sleep(500)

  const ver = await evalIn(page, `window.__TAURI_INTERNALS__.invoke('app_version')`)
  console.log('app_version =', ver)

  const upd = await evalIn(page, `window.__TAURI_INTERNALS__.invoke('check_update')`)
  console.log('check_update =', JSON.stringify(upd))

  const missing = await evalIn(page, `window.__TAURI_INTERNALS__.invoke('install_update', { path: 'C:/definitely/missing.exe' }).then(() => 'OK', (e) => 'ERR:' + e)`)
  console.log('install_update(missing) =', missing)

  const url = 'https://github.com/qfgk/PinTodo/releases/download/v1.0.0/PinTodo-1.0.0.exe'
  const path = await evalIn(page, `window.__TAURI_INTERNALS__.invoke('download_update', { url: ${JSON.stringify(url)}, version: '1.0.0' })`)
  console.log('download_update =', path)
  if (path && existsSync(path)) {
    console.log('downloaded size =', statSync(path).size)
    try { unlinkSync(path) } catch {}
  }

  page.close()
  proc.kill()
}

main().catch((e) => { console.error(e); process.exit(1) })
