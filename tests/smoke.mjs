// PinTodo 冒烟测试：CDP 驱动 release exe 走真实用户路径
// 用法：node tests/smoke.mjs  （需先构建 release）
import { spawn, execSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'

const EXE = join(process.cwd(), 'src-tauri/target/release/todo.exe')
const APPDATA = join(os.homedir(), 'AppData/Roaming')
const DATA_DIR = join(APPDATA, 'PinTodo')
const BOOT_LOG = join(DATA_DIR, 'boot.log')
const TASKS_JSON = join(DATA_DIR, 'tasks.json')
const PORT = 9225
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let passed = 0
const failures = []
function check(name, cond, extra = '') {
  if (cond) {
    passed++
    console.log('  ✓', name)
  } else {
    failures.push(name)
    console.log('  ✗', name, extra)
  }
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

async function evalIn(page, expression) {
  await page.ready()
  const r = await page.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result?.value
}

async function waitFor(page, expr, timeout = 8000, every = 200) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    try {
      const v = await evalIn(page, expr)
      if (v) return v
    } catch { /* 页面尚未就绪 */ }
    await sleep(every)
  }
  return null
}

async function main() {
  if (!existsSync(EXE)) {
    console.error('缺少 release exe，先跑 npx tauri build --no-bundle')
    process.exit(2)
  }
  // 备份用户真实 tasks.json 和 settings.json，测试结束后还原
  mkdirSync(DATA_DIR, { recursive: true })
  const SETTINGS_JSON = join(DATA_DIR, 'settings.json')
  const SCRATCH_TXT = join(DATA_DIR, 'scratchpad.txt')
  const origTasks = existsSync(TASKS_JSON) ? readFileSync(TASKS_JSON, 'utf-8') : null
  const origSettings = existsSync(SETTINGS_JSON) ? readFileSync(SETTINGS_JSON, 'utf-8') : null
  const origScratch = existsSync(SCRATCH_TXT) ? readFileSync(SCRATCH_TXT, 'utf-8') : null
  const restoreUserFiles = () => {
    try {
      if (origTasks !== null) writeFileSync(TASKS_JSON, origTasks)
      if (origSettings !== null) writeFileSync(SETTINGS_JSON, origSettings)
      if (origScratch !== null) writeFileSync(SCRATCH_TXT, origScratch)
    } catch {}
  }
  // 干净的 boot 日志
  writeFileSync(BOOT_LOG, '')

  console.log('▶ 启动应用（CDP 9225）')
  // 清理旧实例（WebView2 属系统组件，勿动）
  try { execSync('taskkill /IM todo.exe /F', { stdio: 'ignore' }); } catch {}
  await sleep(1200)
  const proc = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: 'ignore',
  })

  // 等 CDP 目标出现（多个页面同名，按 __pintodo 钩子甄别主窗）
  let page = null
  let browser = null
  for (let i = 0; i < 50 && (!page || !browser); i++) {
    await sleep(300)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      if (!page) {
        for (const t of list.filter((t) => t.type === 'page')) {
          try {
            const c = new CDP(t.webSocketDebuggerUrl)
            await c.ready()
            const has = await c.send('Runtime.evaluate', {
              expression: 'typeof window.__pintodo',
              returnByValue: true,
            })
            if (has.result?.value === 'object') {
              page = c
              page.targetId = t.id
              break
            }
            c.close()
          } catch { /* 下一个 */ }
        }
      }
      if (!browser) {
        const ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
        if (ver.webSocketDebuggerUrl) browser = new CDP(ver.webSocketDebuggerUrl)
      }
    } catch { /* 还没起 */ }
  }
  if (!page || !browser) {
    console.error('  ✗ CDP 连接失败')
    proc.kill()
    process.exit(2)
  }

  // ---------- 1. 启动与首帧 ----------
  console.log('■ 启动')
  const booted = await waitFor(page, `!!window.__pintodo && window.__pintodo.booted?.()`, 10000)
  check('应用启动并完成 boot()', !!booted)
  const visible = await waitFor(page, `document.querySelector('.list') !== null`)
  check('列表已渲染', !!visible)

  // 上次会话若以贴边隐藏态退出，轮询归位到 normal，保证后续步骤前提一致
  const st0 = String((await evalIn(page, `window.__pintodo.wstate()`)) || '')
  if (st0.startsWith('hidden')) {
    for (let i = 0; i < 5; i++) {
      await evalIn(page, `window.__pintodo.restore()`)
      await sleep(700)
      const back = String(await evalIn(page, `window.__pintodo.wstate()`))
      if (back === 'normal') break
    }
  }
  const finalState = String(await evalIn(page, `window.__pintodo.wstate()`))
  check('隐藏态启动自动归位', finalState === 'normal', finalState)

  // ---------- 2. 语法添加 ----------
  console.log('■ 录入语法')
  const baseRows = await evalIn(page, `document.querySelectorAll('.row').length`)
  await evalIn(page, `(() => {
    const inp = document.querySelector('.new-input')
    inp.value = '明天18:00 交方案 #工作 !1'
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  await sleep(300)
  const afterRows = await evalIn(page, `document.querySelectorAll('.row').length`)
  check('回车新增一条任务', afterRows === baseRows + 1, `${baseRows}→${afterRows}`)
  const metaOk = await evalIn(page, `(() => {
    const rows = [...document.querySelectorAll('.row')]
    const hit = rows.find((r) => (r.querySelector('.txt')?.textContent || '').includes('交方案'))
    return !!hit && !!hit.querySelector('.due') && !!hit.querySelector('.pri-flag.p1')
  })()`)
  check('解析出明天截止与内容（并按新排序规则落位）', !!metaOk)
  const priOk = await evalIn(page, `!!document.querySelector('.row .pri-flag.p1')`)
  check('!1 优先级角标渲染', !!priOk)

  // ---------- 3. 双击编辑 ----------
  console.log('■ 行内编辑')
  await evalIn(page, `(() => {
    const rows = [...document.querySelectorAll('.row')]
    const hit = rows.find((r) => (r.querySelector('.txt')?.textContent || '').includes('交方案'))
    // Solid 的 onDblClick 使用事件委托（绑定在 document），需要 bubbles+composed 且在元素上触发
    const txt = hit?.querySelector('.txt')
    txt?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window }))
    return !!txt
  })()`)
  await sleep(150)
  const editShown = await evalIn(page, `!!document.querySelector('.edit-input')`)
  check('双击出现编辑框', !!editShown)
  if (editShown) {
  await evalIn(page, `(() => {
    const inp = document.querySelector('.edit-input')
    inp.value = '交最终方案 v3'
    inp.dispatchEvent(new Event('input', { bubbles: true }))
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
    await sleep(300)
    const edited = await evalIn(page, `(() => {
      const texts = [...document.querySelectorAll('.row .txt')].map((e) => e.textContent || '')
      return texts.some((x) => x.includes('交最终方案 v3'))
    })()`)
    check('回车提交编辑', !!edited)
    const rowCount = await evalIn(page, `document.querySelectorAll('.row').length`)
    check('编辑后列表完整（不截断）', rowCount === afterRows, `${rowCount}`)
  }

  // ---------- 3.5 描述持续输入不失焦（回归此前打字断焦 bug） ----------
  console.log('■ 描述输入连续性')
  await evalIn(page, `(() => {
    const rows = [...document.querySelectorAll('.row')]
    const hit = rows.find((r) => (r.querySelector('.txt')?.textContent || '').includes('交最终方案 v3'))
    hit?.querySelector('.note')?.click()
    return true
  })()`)
  await sleep(100)
  const descOpen = await evalIn(page, `!!document.querySelector('.row-notes')`)
  check('点击描述按钮展开描述框', !!descOpen)
  if (descOpen) {
    await evalIn(page, `(() => {
      const ta = document.querySelector('.row-notes')
      ta.focus()
      ta.value = '第一段内容'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    // 等待超过原 600ms 防抖保存窗口，验证期间输入依然聚焦
    await sleep(850)
    const focusDiag = await evalIn(page, `({
      active: document.activeElement ? document.activeElement.className + '|' + document.activeElement.tagName : 'null',
      mode: document.body.dataset.mode,
      tabWrap: !!document.querySelector('.tab-wrap'),
      headH: document.querySelector('.head')?.offsetHeight,
      winSize: window.innerWidth + 'x' + window.innerHeight,
      notesVal: document.querySelector('.row-notes')?.value?.slice(0, 12) ?? null
    })`)
    console.log('    诊断:', JSON.stringify(focusDiag))
    const stillFocused = await evalIn(page, `document.activeElement?.classList.contains('row-notes')`)
    check('描述自动保存后焦点保持不丢失', !!stillFocused, JSON.stringify(focusDiag))
    await evalIn(page, `(() => {
      const ta = document.querySelector('.row-notes')
      ta.value = '第一段内容 继续追加'
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      return true
    })()`)
    await sleep(200)
    const descClosed = await evalIn(page, `!document.querySelector('.row-notes')`)
    check('描述框 Esc 保存并收起', !!descClosed)
  }

  // ---------- 3.8 批量粘贴多行拆分为多条待办 + Ctrl+Z 保护与撤销 ----------
  console.log('■ 批量粘贴与 Ctrl+Z')
  const countBeforePaste = await evalIn(page, `document.querySelectorAll('.row').length`)
  await evalIn(page, `(() => {
    const inp = document.querySelector('.new-input')
    inp.focus()
    const dt = new DataTransfer()
    dt.setData('text/plain', '- 第一条批量任务\\n* 第二条批量任务 #工作')
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    inp.dispatchEvent(ev)
    return true
  })()`)
  await sleep(250)
  const countAfterPaste = await evalIn(page, `document.querySelectorAll('.row').length`)
  check('粘贴多行自动批量拆分为多条待办', countAfterPaste === countBeforePaste + 2, `${countBeforePaste}→${countAfterPaste}`)

  // 在输入框内按 Ctrl+Z 不应撤销刚刚批量添加的任务
  await evalIn(page, `(() => {
    const inp = document.querySelector('.new-input')
    inp.focus()
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    return true
  })()`)
  await sleep(200)
  const countInInputUndo = await evalIn(page, `document.querySelectorAll('.row').length`)
  check('输入框内 Ctrl+Z 不劫持全局任务撤销', countInInputUndo === countAfterPaste, `${countInInputUndo}`)

  // 失焦后在列表区按 Ctrl+Z 撤销刚才的批量添加
  await evalIn(page, `(() => {
    document.activeElement?.blur()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }))
    return true
  })()`)
  await sleep(250)
  const countAfterGlobalUndo = await evalIn(page, `document.querySelectorAll('.row').length`)
  check('列表区 Ctrl+Z 撤销批量添加成功', countAfterGlobalUndo === countBeforePaste, `${countAfterGlobalUndo}`)

  // ---------- 3.9 随手记视图切换 + 自动保存 + Esc 返回 ----------
  console.log('■ 随手记视图')
  await evalIn(page, `(() => {
    const tabs = [...document.querySelectorAll('.seg-tabs .seg')]
    tabs.find((b) => b.textContent?.includes('随手记'))?.click()
    return true
  })()`)
  await sleep(250)
  const scratchInfo = await evalIn(page, `({
    hasScratch: !!document.querySelector('.scratch'),
    headH: document.querySelector('.head')?.offsetHeight || 0
  })`)
  check('分段栏切换到随手记且不遮挡头部', scratchInfo.hasScratch && scratchInfo.headH > 0, JSON.stringify(scratchInfo))
  await evalIn(page, `(() => {
    const sc = document.querySelector('.scratch')
    sc.focus()
    sc.value = '随手记测试条目一'
    sc.dispatchEvent(new Event('input', { bubbles: true }))
    sc.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return true
  })()`)
  await sleep(250)
  const backToList = await evalIn(page, `!document.querySelector('.scratch')`)
  check('随手记 Esc 立即保存并返回清单', backToList)

  // ---------- 3.95 任务进度弹窗打卡与历程展示 + 历史日历视图 ----------
  console.log('■ 任务进度与历史日历')
  await evalIn(page, `(() => {
    const rows = [...document.querySelectorAll('.row')]
    const hit = rows.find((r) => (r.querySelector('.txt')?.textContent || '').includes('交最终方案 v3'))
    hit?.querySelector('.prog')?.click()
    return true
  })()`)
  await sleep(150)
  const modalShown = await evalIn(page, `!!document.querySelector('.prog-modal-card')`)
  check('点击进度按钮打开专门的进度弹窗', !!modalShown)
  if (modalShown) {
    await evalIn(page, `(() => {
      const inp = document.querySelector('.prog-modal-input')
      inp.value = '第2轮联调中 80%'
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    await sleep(250)
    const logItemShown = await evalIn(page, `document.querySelector('.prog-log-text')?.textContent?.includes('第2轮联调中 80%')`)
    check('打卡记录进入时间轴历程', !!logItemShown)
    await evalIn(page, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
    await sleep(150)
    const progPillOk = await evalIn(page, `[...document.querySelectorAll('.row .prog-pill')].some((e) => e.textContent?.includes('第2轮联调中 80%'))`)
    check('行内进度胶囊更新展示最新进度', !!progPillOk)
  }
  await evalIn(page, `[...document.querySelectorAll('.seg-tabs .seg')].find((b) => b.textContent?.includes('历史'))?.click()`)
  await sleep(250)
  const calShown = await evalIn(page, `!!document.querySelector('.cal-card') && document.querySelectorAll('.cal-day').length >= 28`)
  check('历史视图渲染完整月历', !!calShown)
  const exportBtnShown = await evalIn(page, `!!document.querySelector('.cal-export')`)
  check('月历头部包含导出清单按钮', !!exportBtnShown)
  await evalIn(page, `[...document.querySelectorAll('.seg-tabs .seg')].find((b) => b.textContent?.includes('清单'))?.click()`)
  await sleep(200)

  // ---------- 4. 最小化收进侧边 + resize 主体完好 ----------
  console.log('■ 最小化/resize 回归')
  await evalIn(page, `window.__pintodo.hide()`)
  const hid0 = await waitFor(page, `String(window.__pintodo.wstate()).startsWith('hidden')`, 5000)
  check('最小化收进侧边', !!hid0)
  await evalIn(page, `window.__pintodo.restore()`)
  const back0 = await waitFor(page, `window.__pintodo.wstate() === 'normal'`, 5000)
  check('恢复 normal', !!back0)
  await sleep(400)
  // CDP 系统级 resize ×3（原白屏复现路径）
  const winInfo = await browser.send('Browser.getWindowForTarget', { targetId: page.targetId }).catch(() => null)
  let boundsOk = false
  if (winInfo?.windowId != null) {
    for (const h of [500, 300, 650]) {
      await browser.send('Browser.setWindowBounds', {
        windowId: winInfo.windowId,
        bounds: { width: 420, height: h, windowState: 'normal' },
      })
      await sleep(450)
      const bodyH = await evalIn(page, `document.querySelector('.body-inner')?.offsetHeight || 0`)
      const cardH = await evalIn(page, `document.querySelector('.card')?.offsetHeight || 0`)
      if (!(bodyH > 100 && cardH > h - 30)) { check(`resize 到 ${h}px 主体完好`, false, `body=${bodyH} card=${cardH}`); boundsOk = false; break }
      boundsOk = true
    }
  }
  if (winInfo?.windowId == null) {
    const bodyH = await evalIn(page, `document.querySelector('.body-inner')?.offsetHeight || 0`)
    boundsOk = bodyH > 100
    check('主体高度正常（降级断言）', boundsOk, `body=${bodyH}`)
  } else {
    check('resize×3 后主体完好（白屏已修）', boundsOk)
  }

  // ---------- 6. 分段栏精简与时间分类折叠分组 + 事项标签设置 ----------
  console.log('■ 时间分类折叠与标签管理')
  const segLabels = await evalIn(page, `[...document.querySelectorAll('.seg-tabs .seg')].map((b) => b.textContent?.trim() || '')`)
  check('分段栏精简为三段（清单·随手记·历史）', segLabels.length === 3 && !segLabels.some((s) => s.includes('今天')), JSON.stringify(segLabels))

  const groupHeaders = await evalIn(page, `[...document.querySelectorAll('.time-group-title')].map((e) => e.textContent?.trim() || '')`)
  check('清单按时间分类分组（今天/本周/本月/持续）', groupHeaders.includes('今天'), JSON.stringify(groupHeaders))

  // 测试分组点击折叠与展开
  await evalIn(page, `(() => {
    const head = document.querySelector('.time-group-head')
    head?.click()
    return true
  })()`)
  await sleep(200)
  const isCollapsed = await evalIn(page, `!!document.querySelector('.time-group-head.collapsed')`)
  check('点击分组头部可折叠', !!isCollapsed)
  await evalIn(page, `(() => {
    const head = document.querySelector('.time-group-head.collapsed')
    head?.click()
    return true
  })()`)
  await sleep(200)
  const isExpanded = await evalIn(page, `!document.querySelector('.time-group-head.collapsed')`)
  check('再次点击分组头部可展开', !!isExpanded)

  // 测试事项设置标签弹窗与打标
  await evalIn(page, `(() => {
    const r = document.querySelector('.row')
    r?.querySelector('.tag-btn')?.click()
    return true
  })()`)
  await sleep(200)
  const tagModalOpen = await evalIn(page, `!!document.querySelector('.tag-modal-card')`)
  check('点击标签按钮打开设置标签弹窗', !!tagModalOpen)
  if (tagModalOpen) {
    await evalIn(page, `(() => {
      const inp = document.querySelector('.tag-modal-input')
      inp.value = '自动测试'
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return true
    })()`)
    await sleep(200)
    const hasChip = await evalIn(page, `[...document.querySelectorAll('.tag-chip.current .tag-chip-txt')].some((e) => e.textContent?.includes('自动测试'))`)
    check('弹窗内成功添加新标签', !!hasChip)
    await evalIn(page, `document.querySelector('.tag-done-btn')?.click()`)
    await sleep(200)
    const rowHasTag = await evalIn(page, `[...document.querySelectorAll('.row .tag')].some((e) => e.textContent?.includes('自动测试'))`)
    check('任务行成功展示新设置的标签', !!rowHasTag)
  }

  // ---------- 6.5 清单挂起态：右键挂起 → 归入「挂起」分组 → 点击恢复 ----------
  console.log('■ 清单挂起态')
  const suspendTarget = await evalIn(page, `(() => {
    const row = document.querySelector('.time-group[data-group="today"] .row') || document.querySelector('.row')
    if (!row) return null
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 160 }))
    return row.dataset.id
  })()`)
  await sleep(200)
  const menuIconOk = await evalIn(page, `(() => {
    const item = [...document.querySelectorAll('.ctx-item')].find((b) => (b.textContent || '').includes('挂起（暂缓处理）'))
    if (!item) return { found: false }
    return {
      found: true,
      hasSvgIcon: !!item.querySelector('.ctx-dot.icon svg'),
      noRawSvgText: !(item.textContent || '').includes('<svg'),
    }
  })()`)
  check('右键菜单图标以 SVG 渲染（不显示源码文本）', menuIconOk.found && menuIconOk.hasSvgIcon && menuIconOk.noRawSvgText, JSON.stringify(menuIconOk))
  const suspendClicked = await evalIn(page, `(() => {
    const item = [...document.querySelectorAll('.ctx-item')].find((b) => (b.textContent || '').includes('挂起（暂缓处理）'))
    item?.click()
    return !!item
  })()`)
  check('右键菜单提供「挂起（暂缓处理）」入口', !!suspendClicked)
  await sleep(300)
  const parkedInfo = await evalIn(page, `(() => {
    const g = document.querySelector('.time-group[data-group="parked"]')
    return {
      group: !!g,
      hasRow: !!g?.querySelector('.row'),
      chip: !!g?.querySelector('.susp-chip'),
      targetInGroup: !!g?.querySelector('[data-id="${suspendTarget}"]'),
    }
  })()`)
  check('挂起后任务归入「挂起」分组并带挂起标记', parkedInfo.group && parkedInfo.hasRow && parkedInfo.chip && parkedInfo.targetInGroup, JSON.stringify(parkedInfo))
  // 按任务 id 精确定位挂起标记（用户真实数据里可能已有其他挂起任务，不能点「第一个」）
  await evalIn(page, `document.querySelector('.time-group[data-group="parked"] [data-id="${suspendTarget}"] .susp-chip')?.click()`)
  await sleep(300)
  const resumedInfo = await evalIn(page, `({
    stillParked: !!document.querySelector('.time-group[data-group="parked"] [data-id="${suspendTarget}"]'),
    chipGone: !document.querySelector('[data-id="${suspendTarget}"] .susp-chip'),
    backInList: [...document.querySelectorAll('.row')].some((r) => r.dataset.id === '${suspendTarget}'),
    inTimeGroup: !!document.querySelector('.time-group:not([data-group="parked"]) [data-id="${suspendTarget}"]'),
  })`)
  check('点击挂起标记恢复任务（回到原时间分组）', !resumedInfo.stillParked && resumedInfo.chipGone && resumedInfo.backInList && resumedInfo.inTimeGroup, JSON.stringify(resumedInfo))

  // ---------- 6.8 删除确认 + 底部统计与行数一致 ----------
  console.log('■ 删除确认与统计')
  // 统计口径：无筛选时「共 N 项」应等于列表实际行数（次日归档的完成项不计入）
  const statInfo = await evalIn(page, `(() => {
    const m = (document.querySelector('.foot-stat')?.textContent || '').match(/共\\s*(\\d+)\\s*项/)
    return { stat: m ? Number(m[1]) : null, rows: document.querySelectorAll('.row').length }
  })()`)
  check('底部统计「共 N 项」与实际行数一致', statInfo.stat !== null && statInfo.stat === statInfo.rows, JSON.stringify(statInfo))

  // 新建一条专用任务用于删除测试
  await evalIn(page, `(() => {
    const inp = document.querySelector('.new-input')
    inp.focus()
    inp.value = '删除确认测试任务'
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  await sleep(300)
  const delOpen = await evalIn(page, `(() => {
    const rows = [...document.querySelectorAll('.row')]
    const hit = rows.find((r) => (r.querySelector('.txt')?.textContent || '').includes('删除确认测试任务'))
    hit?.querySelector('.del')?.click()
    return !!document.querySelector('.confirm-card')
  })()`)
  check('点击删除按钮弹出确认框', !!delOpen)
  // 取消：任务保留
  await evalIn(page, `document.querySelector('.confirm-cancel')?.click()`)
  await sleep(250)
  const cancelKeep = await evalIn(page, `({
    modalGone: !document.querySelector('.confirm-card'),
    rowStill: [...document.querySelectorAll('.row')].some((r) => (r.querySelector('.txt')?.textContent || '').includes('删除确认测试任务')),
  })`)
  check('取消删除后任务保留', cancelKeep.modalGone && cancelKeep.rowStill, JSON.stringify(cancelKeep))
  // Esc 关闭确认框
  await evalIn(page, `(() => {
    const rows = [...document.querySelectorAll('.row')]
    const hit = rows.find((r) => (r.querySelector('.txt')?.textContent || '').includes('删除确认测试任务'))
    hit?.querySelector('.del')?.click()
    return true
  })()`)
  await sleep(150)
  await evalIn(page, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(200)
  const escClosed = await evalIn(page, `!document.querySelector('.confirm-card') && window.__pintodo.wstate() === 'normal'`)
  check('Esc 关闭确认框且不误触发收起', !!escClosed)
  // 确认删除：任务移除
  await evalIn(page, `(() => {
    const rows = [...document.querySelectorAll('.row')]
    const hit = rows.find((r) => (r.querySelector('.txt')?.textContent || '').includes('删除确认测试任务'))
    hit?.querySelector('.del')?.click()
    return true
  })()`)
  await sleep(150)
  await evalIn(page, `document.querySelector('.confirm-del')?.click()`)
  await sleep(350)
  const delGone = await evalIn(page, `({
    modalGone: !document.querySelector('.confirm-card'),
    rowGone: ![...document.querySelectorAll('.row')].some((r) => (r.querySelector('.txt')?.textContent || '').includes('删除确认测试任务')),
    undone: !!document.querySelector('.toast-undo'),
  })`)
  check('确认删除后任务移除且提供撤销', delGone.modalGone && delGone.rowGone && delGone.undone, JSON.stringify(delGone))
  const statAfter = await evalIn(page, `(() => {
    const m = (document.querySelector('.foot-stat')?.textContent || '').match(/共\\s*(\\d+)\\s*项/)
    return { stat: m ? Number(m[1]) : null, rows: document.querySelectorAll('.row').length }
  })()`)
  check('删除后统计与行数仍一致', statAfter.stat !== null && statAfter.stat === statAfter.rows, JSON.stringify(statAfter))

  // ---------- 7. 贴边隐藏 / 唤回 ----------
  console.log('■ 贴边循环')
  await evalIn(page, `window.__pintodo.hide('right')`)
  const hid = await waitFor(page, `window.__pintodo.wstate() === 'hidden-right'`, 5000)
  check('滑出贴边隐藏', !!hid)
  await sleep(300)
  await evalIn(page, `window.__pintodo.restore()`)
  const restored = await waitFor(page, `window.__pintodo.wstate() === 'normal'`, 5000)
  check('唤回恢复 normal', !!restored)
  const noRebound = await waitFor(page, `window.__pintodo.wstate() === 'normal'`, 1600)
  check('唤回后不回弹（抑制期）', !!noRebound)

  // ---------- 7.5 Win+D / 显示桌面 → 挂起态（胶囊留在桌面上睡眠） ----------
  console.log('■ Win+D 挂起态')
  await evalIn(page, `window.__pintodo.onShowDesktop?.() || window.__pintodo.hide()`)
  const winDHid = await waitFor(page, `String(window.__pintodo.wstate()).startsWith('hidden')`, 5000)
  check('显示桌面自动收缩到侧边胶囊', !!winDHid)
  const suspendedOn = await waitFor(page, `window.__pintodo.suspended?.() === true`, 3000)
  check('进入挂起态（suspended=true）', !!suspendedOn)
  const sleepFace = await evalIn(page, `({
    dataset: document.body.dataset.suspended,
    zzz: !!document.querySelector('.zzz'),
    sleeping: !!document.querySelector('.pill.sleeping'),
  })`)
  check('挂起外观（闭眼 + Zzz 标记）', sleepFace.dataset === '1' && sleepFace.zzz && sleepFace.sleeping, JSON.stringify(sleepFace))
  // 补强期结束后窗口必须仍然可见、未最小化、置顶（Win+D 隐藏动作已被对抗）
  await sleep(1700)
  const dg = await evalIn(page, `window.__pintodo.diag()`)
  check('挂起窗口仍可见且置顶（未被 Win+D 隐藏）', dg.visible === true && dg.minimized === false && dg.topmost === true, JSON.stringify(dg))
  // 点击胶囊 → 唤醒并恢复完整窗口
  await evalIn(page, `(() => {
    const tab = document.querySelector('.tab')
    tab?.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, screenX: 500, screenY: 300 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, screenX: 500, screenY: 300 }))
    return true
  })()`)
  const wokeUp = await waitFor(page, `window.__pintodo.wstate() === 'normal'`, 5000)
  check('点击挂起胶囊唤醒并恢复主窗口', !!wokeUp)
  const suspendedOff = await waitFor(page, `window.__pintodo.suspended?.() === false`, 3000)
  const zzzGone = await evalIn(page, `!document.querySelector('.zzz') && document.body.dataset.suspended !== '1'`)
  check('恢复后退出挂起态（睡眠标记消失）', !!suspendedOff && !!zzzGone)
  await waitFor(page, `window.__pintodo.wstate() === 'normal'`, 5000)

  // ---------- 8. 数据持久化 + 无 JS 错误 ----------
  console.log('■ 持久化与错误')
  // 先挂起一条任务，验证 susp 字段经 Rust 落盘/回读不丢失
  await evalIn(page, `(() => {
    const rows = [...document.querySelectorAll('.row')]
    const hit = rows.find((r) => (r.querySelector('.txt')?.textContent || '').includes('交最终方案 v3'))
    hit?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 160 }))
    return true
  })()`)
  await sleep(200)
  await evalIn(page, `[...document.querySelectorAll('.ctx-item')].find((b) => (b.textContent || '').includes('挂起'))?.click()`)
  await sleep(350)
  const parkedBeforeExit = await evalIn(page, `!!document.querySelector('.time-group[data-group="parked"] .susp-chip')`)
  check('退出前任务处于挂起态', !!parkedBeforeExit)
  proc.kill()
  await sleep(800)
  const tasks = JSON.parse(readFileSync(TASKS_JSON, 'utf-8'))
  const saved = tasks.find((t) => t.t.includes('交最终方案 v3'))
  check('任务落盘且编辑保留', !!saved && saved.due > Date.now())
  check('挂起状态落盘', saved?.susp === true, JSON.stringify({ susp: saved?.susp }))
  const priSaved = saved?.pri === 1
  check('优先级落盘', !!priSaved)
  const notesSaved = saved?.notes === '第一段内容 继续追加'
  check('任务描述落盘', !!notesSaved, String(saved?.notes))
  const progSaved = saved?.prog === '第2轮联调中 80%'
  check('任务进度反馈落盘', !!progSaved, String(saved?.prog))
  const boot = existsSync(BOOT_LOG) ? readFileSync(BOOT_LOG, 'utf-8') : ''
  check('无 JS 运行时错误（jserr）', !boot.includes('jserr'), boot.split('\n').filter((l) => l.includes('jserr')).join(' | '))

  browser.close()
  page.close()
  restoreUserFiles()
  console.log(failures.length ? `\n✗ ${failures.length} 项失败` : `\n✅ 全部 ${passed} 项通过`)
  process.exit(failures.length ? 1 : 0)
}

main().catch((e) => {
  console.error('SMOKE CRASH:', e)
  try { spawn('taskkill', ['/IM', 'todo.exe', '/F']) } catch {}
  process.exit(2)
})
