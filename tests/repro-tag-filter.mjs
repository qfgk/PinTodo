// 标签筛选最小复现：点标签 → 检查搜索框状态 → 尝试各种清除方式
import { spawn, execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const EXE = join(process.cwd(), 'src-tauri/target/release/todo.exe')
const APPDATA = join(os.homedir(), 'AppData/Roaming')
const DATA_DIR = join(APPDATA, 'PinTodo')
const TASKS_JSON = join(DATA_DIR, 'tasks.json')
const SETTINGS_JSON = join(DATA_DIR, 'settings.json')
const PORT = 9227
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
  if (!page) { console.error('CDP 连接失败'); proc.kill(); process.exit(2) }

  await evalIn(page, `window.__pintodo.booted?.()`)
  await sleep(400)

  // 1. 添加一条带标签的任务
  await evalIn(page, `(() => {
    const inp = document.querySelector('.new-input')
    inp.focus()
    inp.value = '复现用任务 #复现标签'
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  await sleep(250)

  const s0 = await evalIn(page, `({
    rows: document.querySelectorAll('.row').length,
    hasTag: [...document.querySelectorAll('.row .tag')].some((e) => e.textContent?.includes('复现标签')),
    searchbar: !!document.querySelector('.searchbar'),
  })`)
  console.log('① 添加后:', JSON.stringify(s0))

  // 2. 点击标签筛选
  await evalIn(page, `(() => {
    const tagEl = [...document.querySelectorAll('.row .tag')].find((e) => e.textContent?.includes('复现标签'))
    tagEl?.click()
    return true
  })()`)
  await sleep(250)

  const s1 = await evalIn(page, `({
    rows: document.querySelectorAll('.row').length,
    searchbar: !!document.querySelector('.searchbar'),
    inputVal: document.querySelector('.searchbar input')?.value ?? null,
    sClearVisible: (() => { const b = document.querySelector('.s-clear'); if (!b) return false; const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 })(),
  })`)
  console.log('② 点标签后:', JSON.stringify(s1))

  // 3. 方式A：点 × 清空按钮
  await evalIn(page, `document.querySelector('.s-clear')?.click()`)
  await sleep(250)
  const s2 = await evalIn(page, `({
    rows: document.querySelectorAll('.row').length,
    inputVal: document.querySelector('.searchbar input')?.value ?? null,
    searchbar: !!document.querySelector('.searchbar'),
  })`)
  console.log('③ 点×清空后:', JSON.stringify(s2))

  // 4. 重新点标签，然后方式B：焦点不在输入框时按 Esc
  await evalIn(page, `(() => {
    const tagEl = [...document.querySelectorAll('.row .tag')].find((e) => e.textContent?.includes('复现标签'))
    tagEl?.click()
    return true
  })()`)
  await sleep(250)
  await evalIn(page, `document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(250)
  const s3 = await evalIn(page, `({
    rows: document.querySelectorAll('.row').length,
    searchbar: !!document.querySelector('.searchbar'),
    wstate: window.__pintodo.wstate?.(),
  })`)
  console.log('④ 点标签后按 Esc（焦点在外）:', JSON.stringify(s3))

  // 5. 方式C：焦点在搜索输入框内按 Esc
  await evalIn(page, `(() => {
    const inp = document.querySelector('.searchbar input')
    inp?.focus()
    return true
  })()`)
  await evalIn(page, `document.querySelector('.searchbar input')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(250)
  const s4 = await evalIn(page, `({
    rows: document.querySelectorAll('.row').length,
    searchbar: !!document.querySelector('.searchbar'),
  })`)
  console.log('⑤ 输入框内按 Esc 后:', JSON.stringify(s4))

  // 6. 方式D：再点一次同一标签 = 取消筛选（开关语义）
  await evalIn(page, `(() => {
    const tagEl = [...document.querySelectorAll('.row .tag')].find((e) => e.textContent?.includes('复现标签'))
    tagEl?.click()
    return true
  })()`)
  await sleep(250)
  const s5 = await evalIn(page, `({ rows: document.querySelectorAll('.row').length, searchbar: !!document.querySelector('.searchbar'), inputVal: document.querySelector('.searchbar input')?.value ?? null })`)
  console.log('⑥ 点标签开启筛选:', JSON.stringify(s5))
  await evalIn(page, `(() => {
    const tagEl = [...document.querySelectorAll('.row .tag')].find((e) => e.textContent?.includes('复现标签'))
    tagEl?.click()
    return true
  })()`)
  await sleep(250)
  const s6 = await evalIn(page, `({ rows: document.querySelectorAll('.row').length, searchbar: !!document.querySelector('.searchbar'), inputVal: document.querySelector('.searchbar input')?.value ?? null })`)
  console.log('⑦ 再点同一标签取消筛选:', JSON.stringify(s6))

  restore()
  proc.kill()
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
