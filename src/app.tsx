// 主窗应用：启动编排 + 窗口管理 + 菜单 + 键盘 + 导入导出
import { render } from 'solid-js/web'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow, LogicalSize, PhysicalPosition } from '@tauri-apps/api/window'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { listen } from '@tauri-apps/api/event'
import { save as saveDialog, open as openDialog } from '@tauri-apps/plugin-dialog'
import type { Task } from './types'
import * as S from './state'
import * as W from './winstate'
import {
  MainApp, setActions, toast, focusNewInput, getVisible,
  setCurrentList, setView, allLists, currentList, view, searchOpen,
  selId, setSelId, exportSearchToggle, helpOpen, setHelpOpen,
  progModalTask, setProgModalTask, deleteConfirmTask, setDeleteConfirmTask,
  trashOpen, setTrashOpen, openTrash,
} from './ui'
import { initTheme, currentMode, setTheme } from './theme'
import { toggleStats } from './stats'
import { checkUpdates } from './update'
import { popupMenu, closeMenus, type MenuEntry } from './menus'
import { h } from './icons'

const win = getCurrentWindow()
let topmost = true
let autostart = false
// 自身尺寸动画期间由 winstate 抑制持久化；这里只管系统缩放路径
let selfSize = false
let bootedDone = false

const clampNum = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

export async function boot() {
  const st = await invoke<{ tasks: Task[]; settings: Record<string, any> }>('load_state')
  S.setAll(st.tasks, st.settings)
  topmost = st.settings.topmost !== false

  // 回收站：加载并执行自动清理规则（默认保留 30 天，0=永不清理）
  await S.loadTrashFromDisk()
  const trashDays = typeof st.settings.trashDays === 'number' ? st.settings.trashDays : S.DEFAULT_TRASH_DAYS
  S.purgeExpiredTrash(trashDays)

  const w = clampNum(st.settings.w ?? 322, 280, 560)
  const hh = clampNum(st.settings.h ?? 480, W.MIN_H, W.MAX_H)

  render(() => <MainApp />, document.getElementById('app')!)

  setActions({
    onCollapse: () => W.hideToEdge(),
    onPin: () => setTopmost(!topmost),
    onClose: () => invoke('quit'),
    onMenu: mainMenu,
    onListMenu: listMenu,
    onExportHistory: exportHistoryList,
  })

  // 几何恢复：仅正常启动时恢复主窗位置与尺寸（贴片模式直接由 bootFromEdgeIfHidden 定型，切勿覆盖！）
  const edgeHidden = W.isEdgeHiddenAtBoot()
  if (edgeHidden) {
    await W.bootFromEdgeIfHidden()
    await win.setAlwaysOnTop(topmost)
  } else {
    selfSize = true
    await win.setSize(new LogicalSize(w, hh))
    if (typeof st.settings.x === 'number' && typeof st.settings.y === 'number') {
      await win.setPosition(new PhysicalPosition(st.settings.x, st.settings.y))
    }
    await win.setAlwaysOnTop(topmost)
    setTimeout(() => { selfSize = false }, 100)
  }
  const pillSettled = edgeHidden

  initTheme()

  const lists = allLists()
  const last = st.settings.lastList
  setCurrentList(lists.includes(last) ? last : '默认')

  autostart = await invoke<boolean>('get_autostart')

  wireKeyboard()
  wireGrip()

  // 隐藏态启动：贴片已在上方落定；否则显示主窗（先显示，重活延后）
  if (!pillSettled) {
    await win.show()
    // 只有当前没有任何输入元素聚焦时才自动聚焦到新任务框，避免覆盖用户在首帧的点击焦点
    if (!document.activeElement || document.activeElement === document.body) {
      focusNewInput()
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  }
  invoke('report_ready', { phase: null })

  wireWindowEvents()
  await wireTauriEvents()
  bootedDone = true

  // 启动后静默检查更新（可在 ··· 菜单关闭）；延迟到首帧稳定后再请求网络
  if (st.settings.autoUpdate !== false) {
    window.setTimeout(() => { void checkUpdates(false) }, 4000)
  }
}

function setTopmost(v: boolean) {
  topmost = v
  win.setAlwaysOnTop(v)
  S.patchSettings({ topmost: v })
}

// ---------------- 窗口事件持久化 ----------------

function wireWindowEvents() {
  let moveTimer = 0
  win.onMoved(async () => {
    clearTimeout(moveTimer)
    moveTimer = window.setTimeout(async () => {
      if (W.isAnimating() || W.isPillDragging()) return
      if (W.isHidden()) {
        // 贴片态：Snap/移动等外部强改后按当前形态自愈
        await W.ensurePill()
        return
      }
      const docked = await W.checkDockAfterMove()
      if (!docked && !W.isHidden()) {
        const p = await win.outerPosition()
        S.patchSettings({ x: p.x, y: p.y })
      }
    }, 260)
  })
  let sizeTimer = 0
  win.onResized(async () => {
    // 贴片态：Windows Snap（拖到边缘半屏）会强改窗口尺寸，自愈回圆形气泡
    if (W.isHidden()) {
      clearTimeout(sizeTimer)
      sizeTimer = window.setTimeout(() => W.ensurePill(), 250)
      return
    }
    // 正常态：非尺寸动画中才持久化
    if (selfSize || W.isSelfSizing()) return
    clearTimeout(sizeTimer)
    sizeTimer = window.setTimeout(async () => {
      if (selfSize || W.isSelfSizing() || W.wstate() !== 'normal') return
      const scale = await win.scaleFactor()
      const s = await win.outerSize()
      S.patchSettings({
        w: clampNum(Math.round(s.width / scale), 280, 560),
        h: clampNum(Math.round(s.height / scale), W.MIN_H, W.MAX_H),
      })
    }, 300)
  })
}

// ---------------- 缩放 ----------------

function wireGrip() {
  document.querySelector('.grip')?.addEventListener('pointerdown', async (e) => {
    e.preventDefault()
    // 关键修复：resize 开始前强制离开折叠态（白屏根治点）
    await W.beginResize()
    const w2 = win as unknown as { startResizeDragging?: (d: string) => Promise<void> }
    if (typeof w2.startResizeDragging === 'function') {
      await w2.startResizeDragging('SouthEast')
      return
    }
    const scale = await win.scaleFactor()
    const s0 = await win.outerSize()
    const sx = (e as PointerEvent).screenX
    const sy = (e as PointerEvent).screenY
    const onMove = async (ev: PointerEvent) => {
      const nw = clampNum((s0.width + (ev.screenX - sx)) / scale, 280, 560)
      const nh = clampNum((s0.height + (ev.screenY - sy)) / scale, W.MIN_H, W.MAX_H)
      await win.setSize(new LogicalSize(nw, nh))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  })
}

// ---------------- 键盘 ----------------

function wireKeyboard() {
  window.addEventListener('keydown', (e) => {
    // window 上触发全局事件时 e.target 可能是 window/document（无 matches 方法），必须做实例判断
    const el = e.target instanceof Element ? e.target : document.activeElement
    const inInput = !!(el && el.matches('input, textarea'))
    // 关键修复：焦点在输入框/文本域内时，保留原生的 Ctrl+Z 文本撤销，不劫持为全局任务撤销！
    if (!inInput && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      if (S.undo()) toast('已撤销')
      return
    }
    if (inInput) return
    if (e.key === '/') {
      e.preventDefault()
      exportSearchToggle(true)
      return
    }
    if (e.key === '?') {
      e.preventDefault()
      setHelpOpen(!helpOpen())
      return
    }
    if (e.key === 'Escape') {
      if (trashOpen()) setTrashOpen(false)
      else if (deleteConfirmTask()) setDeleteConfirmTask(null)
      else if (progModalTask()) setProgModalTask(null)
      else if (helpOpen()) setHelpOpen(false)
      else if (searchOpen()) exportSearchToggle(false)
      else if (selId()) setSelId(null)
      else if (view() !== 'list') setView('list')
      else if (W.wstate() === 'normal') W.hideToEdge()
      return
    }
    const vis = getVisible()
    if (!vis.length) return
    const idx = vis.findIndex((t) => t.id === selId())
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const n = e.key === 'ArrowDown' ? Math.min(vis.length - 1, idx + 1) : Math.max(0, idx - 1)
      setSelId(vis[idx < 0 ? 0 : n].id)
    } else if (e.key === ' ' || e.key === 'Enter') {
      if (idx >= 0) {
        e.preventDefault()
        S.toggleTask(vis[idx].id)
      }
    } else if (e.key === 'Delete') {
      if (idx >= 0) {
        e.preventDefault()
        // 与行内 × 一致：先弹确认框，确认后进回收站
        setDeleteConfirmTask(vis[idx])
      }
    }
  })
}

// ---------------- Tauri 事件 ----------------

async function wireTauriEvents() {
  await listen('hotkey', async (e) => {
    const p = e.payload as string
    if (p === 'add') await showQuickadd()
    else await toggleVisible()
  })
  await listen('show-requested', async () => {
    if (W.isHidden()) await W.restoreFromEdge()
    else {
      await win.show()
      await win.setFocus()
    }
  })
  await listen('edge-restore', () => W.restoreFromEdge())
  // 监听 Windows 显示桌面（Win+D / Win+M / 任务栏右下角）：进入挂起态，胶囊留在桌面上
  await listen('show-desktop-detected', () => {
    W.onShowDesktop()
  })
  // 离开桌面（前台不再是桌面窗口）：胶囊苏醒，但保持贴片形态
  await listen('desktop-restored', () => {
    W.onDesktopRestored()
  })
  await listen('quick-add', (e) => {
    const p = e.payload as any
    if (p.list && !allLists().includes(p.list)) S.patchSettings({ lists: [...allLists(), p.list] })
    S.addTask({
      t: p.text, d: false, list: p.list ?? currentList(), tags: p.tags,
      pri: p.pri ?? 0, due: p.due, recur: p.recur,
    })
  })
  // 到期提醒：展示可交互贪睡 / 完成 Toast
  await listen('reminders-due', (e) => {
    const items = e.payload as { id: string; t: string }[]
    for (const it of items.slice(0, 2)) {
      snoozeMenu4Task(it.id)
      toast(`⏰ 到期：${it.t}`, undefined, [
        { label: '延后15分', onClick: () => S.setDue(it.id, Date.now() + 15 * 60000) },
        { label: '1小时', onClick: () => S.setDue(it.id, Date.now() + 3600000) },
        { label: '明天', onClick: () => snooze(it.id, 'tomorrow') },
        { label: '完成', onClick: () => S.toggleTask(it.id) },
      ], 9000)
    }
  })
}

async function toggleVisible() {
  if (W.isHidden()) await W.restoreFromEdge()
  else if (W.justRestored()) return
  else if (await win.isVisible()) await W.hideToEdge(W.currentSide())
  else await win.show()
}

/** 行内贪睡：toast 附近弹菜单代价高，直接给最近一个到期任务挂菜单 */
let lastDueTaskId: string | null = null
function snoozeMenu4Task(id: string) {
  lastDueTaskId = id
}

export function snooze(id: string | null, kind: '5m' | '1h' | 'tomorrow') {
  if (!id) return
  const d = new Date()
  if (kind === '5m') d.setMinutes(d.getMinutes() + 5)
  else if (kind === '1h') d.setHours(d.getHours() + 1)
  else {
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
  }
  S.setDue(id, d.getTime())
  toast('已延后')
}
  // 暴露给菜单与测试钩子：追加 booted() 以便测试精确等待异步 boot 完成
  ;(window as any).__pintodo = {
    snooze,
    get lastDueTaskId() { return lastDueTaskId },
    hide: (side: 'left' | 'right') => W.hideToEdge(side),
    restore: () => W.restoreFromEdge(),
    onShowDesktop: () => W.onShowDesktop(),
    onDesktopRestored: () => W.onDesktopRestored(),
    wstate: () => W.wstate(),
    suspended: () => W.isSuspended(),
    diag: async () => ({
      wstate: W.wstate(),
      suspended: W.isSuspended(),
      visible: await win.isVisible(),
      minimized: await win.isMinimized(),
      topmost: await win.isAlwaysOnTop(),
    }),
    booted: () => bootedDone,
    moveBy: async (dx: number, dy: number) => {
      const { PhysicalPosition } = await import('@tauri-apps/api/window')
      const p = await win.outerPosition()
      await win.setPosition(new PhysicalPosition(p.x + dx, p.y + dy))
    },
    size: async (w: number, h: number) => {
      const { LogicalSize } = await import('@tauri-apps/api/window')
      await win.setSize(new LogicalSize(w, h))
    },
    rect: async () => {
      const p = await win.outerPosition()
      const s = await win.outerSize()
      return { x: p.x, y: p.y, w: s.width, h: s.height, vis: await win.isVisible() }
    },
  }

async function showQuickadd() {
  const deadline = Date.now() + 3000
  let qa = null
  while (!qa && Date.now() < deadline) {
    qa = await WebviewWindow.getByLabel('quickadd')
    if (!qa) await new Promise((r) => setTimeout(r, 100))
  }
  if (!qa) return
  await qa.center()
  await qa.show()
  await qa.setFocus()
  const { emitTo } = await import('@tauri-apps/api/event')
  await emitTo('quickadd', 'qa-focus', null)
}

// ---------------- 菜单 ----------------

function mainMenu(x: number, y: number) {
  closeMenus()
  const entries: MenuEntry[] = [
    { label: '主题：跟随系统', radio: true, checked: currentMode() === 'auto', action: () => setTheme('auto') },
    { label: '主题：浅色', radio: true, checked: currentMode() === 'light', action: () => setTheme('light') },
    { label: '主题：深色', radio: true, checked: currentMode() === 'dark', action: () => setTheme('dark') },
    { sep: true },
    { label: '统计', action: () => toggleStats() },
    { label: '回收站…', action: () => openTrash() },
    { label: '导出 JSON 备份', action: exportJson },
    { label: '导入 JSON', action: importJson },
    { label: '导出 todo.txt', action: exportTodoTxt },
    { label: '导入 todo.txt', action: importTodoTxt },
    { sep: true },
    { label: '窗口置顶', checked: topmost, action: () => setTopmost(!topmost) },
    {
      label: '开机自启', checked: autostart,
      action: async () => {
        const v = !autostart
        autostart = await invoke<boolean>('set_autostart', { on: v })
      },
    },
    { sep: true },
    { label: '检查更新…', action: () => { void checkUpdates(true) } },
    {
      label: '启动时自动检查更新',
      checked: S.settings().autoUpdate !== false,
      action: () => S.patchSettings({ autoUpdate: !(S.settings().autoUpdate !== false) }),
    },
    { label: '快捷键与语法', action: () => setHelpOpen(true) },
    { label: '隐藏到侧边', action: () => W.hideToEdge(W.currentSide()) },
    { label: '退出 PinTodo', danger: true, action: () => invoke('quit') },
  ]
  popupMenu(entries, x, y)
}

function listMenu(x: number, y: number) {
  closeMenus()
  const entries: MenuEntry[] = [
    {
      label: '随手记', radio: true, checked: view() === 'note',
      action: () => setView('note'),
    },
    {
      label: '历史日历', radio: true, checked: view() === 'history',
      action: () => setView('history'),
    },
    { sep: true },
  ]
  for (const name of allLists()) {
    entries.push({
      label: name,
      radio: true,
      checked: view() === 'list' && name === currentList(),
      action: () => {
        setCurrentList(name)
        setView('list')
        S.patchSettings({ lastList: name })
      },
    })
  }
  entries.push({ sep: true })
  entries.push({
    label: '＋ 新建清单',
    action: () => textPrompt(x, y - 60, '新清单名称', '', (name) => {
      if (!name || allLists().includes(name)) return
      const next = [...allLists(), name]
      S.patchSettings({ lists: next, lastList: name })
      setCurrentList(name)
      setView('list')
    }),
  })
  if (currentList() !== '默认' && view() === 'list') {
    entries.push({
      label: '重命名清单',
      action: () => textPrompt(x, y - 60, '重命名', currentList(), (name) => {
        if (!name || name === currentList()) return
        const old = currentList()
        S.replaceAll(S.tasks().map((t) => (t.list === old ? { ...t, list: name } : t)))
        S.patchSettings({ lists: allLists().map((l) => (l === old ? name : l)), lastList: name })
        setCurrentList(name)
      }),
    })
    entries.push({
      label: '删除清单（任务移入默认）',
      danger: true,
      action: () => {
        const old = currentList()
        S.replaceAll(S.tasks().map((t) => (t.list === old ? { ...t, list: '默认' } : t)))
        S.patchSettings({ lists: allLists().filter((l) => l !== old), lastList: '默认' })
        setCurrentList('默认')
      },
    })
  }
  popupMenu(entries, x, y)
}

function textPrompt(x: number, y: number, title: string, initial: string, cb: (v: string) => void) {
  closeMenus()
  const box = h('div', 'ctx-menu prompt show')
  box.style.left = Math.min(x, window.innerWidth - 220) + 'px'
  box.style.top = Math.max(8, y) + 'px'
  box.appendChild(h('div', 'prompt-title', title))
  const inp = document.createElement('input')
  inp.type = 'text'
  inp.className = 'prompt-input'
  inp.value = initial
  box.appendChild(inp)
  document.body.appendChild(box)
  inp.focus()
  inp.setSelectionRange(inp.value.length, inp.value.length)
  const done = (ok: boolean) => {
    box.remove()
    if (ok) cb(inp.value.trim())
  }
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation()
    if (e.key === 'Enter') done(true)
    if (e.key === 'Escape') done(false)
  })
  inp.addEventListener('blur', () => setTimeout(() => box.isConnected && done(false), 150))
}

// ---------------- 导入导出 ----------------

async function exportJson() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const path = await saveDialog({
    defaultPath: `PinTodo-备份-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (!path) return
  try {
    await invoke('export_tasks', { path })
    toast('已导出')
  } catch {
    toast('导出失败')
  }
}

async function importJson() {
  const path = await openDialog({
    multiple: false,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (!path || Array.isArray(path)) return
  try {
    const tasks = await invoke<Task[]>('import_tasks', { path })
    S.replaceAll(tasks)
    toast(`已导入 ${tasks.length} 项`, '导入')
  } catch {
    toast('导入失败（文件格式不正确）')
  }
}

// ---------------- todo.txt 互操作 ----------------

function toTodoTxt(tasks: Task[]): string {
  return tasks
    .map((t) => {
      const parts: string[] = []
      parts.push(t.d ? 'x' : '')
      const pri = t.pri ? `(${['', 'A', 'B', 'C'][t.pri]})` : ''
      const date = new Date(t.createdAt)
      const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
      const due = t.due ? ` due:${new Date(t.due).toISOString().slice(0, 10)}` : ''
      const tags = t.tags.map((x) => x.replace(/^#/, '+')).join(' ') // #清单语义映射为 +项目
      const body = [pri, iso, t.t, due, tags].filter(Boolean).join(' ')
      return (parts[0] ? 'x ' : '') + body
    })
    .join('\n')
}

async function exportTodoTxt() {
  const path = await saveDialog({
    defaultPath: 'todo.txt',
    filters: [{ name: 'todo.txt', extensions: ['txt'] }],
  })
  if (!path) return
  try {
    await invoke('write_text', { path, content: toTodoTxt(S.tasks()) })
    toast('已导出 todo.txt')
  } catch {
    toast('导出失败')
  }
}

async function importTodoTxt() {
  const path = await openDialog({
    multiple: false,
    filters: [{ name: 'todo.txt', extensions: ['txt'] }],
  })
  if (!path || Array.isArray(path)) return
  try {
    const content = await invoke<string>('read_text', { path })
    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    const now = Date.now()
    const parsed = lines.map((line, i) => {
      let text = line
      let pri = 0
      let done = false
      if (text.startsWith('x ')) { done = true; text = text.slice(2) }
      const pm = text.match(/^\(([A-C])\)\s+/)
      if (pm) {
        pri = { A: 1, B: 2, C: 3 }[pm[1]] ?? 0
        text = text.slice(pm[0].length)
      }
      text = text.replace(/^\d{4}-\d{2}-\d{2}\s+/, '')
      const dueM = text.match(/\bdue:(\d{4}-\d{2}-\d{2})/)
      let due: number | null = null
      if (dueM) {
        due = new Date(dueM[1] + 'T18:00:00').getTime()
        text = text.replace(dueM[0], '')
      }
      const listM = text.match(/\+([^\s]+)/)
      text = text.replace(/\+[^\s]+/g, '')
      text = text.replace(/\s+/g, ' ').trim()
      return {
        id: `${now.toString(16)}-t${i}`,
        t: text || '(空任务)',
        d: done, list: listM?.[1] ?? '默认', tags: [] as string[],
        pri, due, recur: null, createdAt: now, doneAt: done ? now : null,
      } satisfies Task
    })
    if (parsed.length) {
      S.replaceAll([...parsed, ...S.tasks()])
      toast(`已导入 ${parsed.length} 项`, '导入')
    } else toast('文件为空')
  } catch {
    toast('导入失败')
  }
}

// ---------------- 历史完成清单导出 ----------------

function formatDateTimeStr(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function generateHistoryMarkdown(tasks: Task[], title: string): string {
  const lines: string[] = [`# ${title}`, '', `> 导出时间：${formatDateTimeStr(Date.now())} · 共 ${tasks.length} 项完成`, '']
  if (!tasks.length) {
    lines.push('_（暂无已完成记录）_')
    return lines.join('\n')
  }
  tasks.forEach((t, i) => {
    const doneStr = t.doneAt ? formatDateTimeStr(t.doneAt) : '未知'
    const priStr = t.pri ? ` [!${t.pri}]` : ''
    const listStr = t.list ? ` #${t.list}` : ''
    lines.push(`${i + 1}. [x] **${t.t}**${priStr}${listStr}`)
    lines.push(`   - 完成时间: ${doneStr}`)
    if (t.prog) {
      lines.push(`   - 最终进度: ${t.prog}`)
    }
    if (t.progLogs && t.progLogs.length > 0) {
      lines.push(`   - 进度历程:`)
      t.progLogs.forEach((l) => {
        lines.push(`     * ${formatDateTimeStr(l.time)}: ${l.text}`)
      })
    }
    if (t.notes) {
      lines.push(`   - 备注描述: ${t.notes.replace(/\r?\n/g, ' ')}`)
    }
  })
  return lines.join('\n')
}

function generateHistoryCsv(tasks: Task[]): string {
  const headers = ['序号', '待办标题', '所属清单', '优先级', '完成时间', '创建时间', '最终进度', '详细描述']
  const escapeCsv = (val: string) => `"${(val || '').replace(/"/g, '""')}"`
  const rows = tasks.map((t, i) => [
    String(i + 1),
    escapeCsv(t.t),
    escapeCsv(t.list),
    t.pri ? `!${t.pri}` : '无',
    escapeCsv(t.doneAt ? formatDateTimeStr(t.doneAt) : ''),
    escapeCsv(t.createdAt ? formatDateTimeStr(t.createdAt) : ''),
    escapeCsv(t.prog || ''),
    escapeCsv(t.notes || ''),
  ].join(','))
  return [headers.join(','), ...rows].join('\n')
}

async function exportHistoryList(scope: 'day' | 'month' | 'all') {
  const allTasks = S.tasks()
  let list: Task[] = []
  let defaultFileName = ''
  let title = ''

  const { historySel, historyMonth } = await import('./ui')
  const curSel = historySel()
  const curYm = historyMonth() || { y: new Date().getFullYear(), m: new Date().getMonth() }
  const p = (n: number) => String(n).padStart(2, '0')

  if (scope === 'day') {
    const ts = curSel ?? Date.now()
    const d = new Date(ts)
    const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const dayEnd = dayStart + 86400000
    list = allTasks
      .filter((t) => t.d && t.doneAt != null && t.doneAt >= dayStart && t.doneAt < dayEnd)
      .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
    const dateStr = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    defaultFileName = `PinTodo-完成清单-${dateStr}`
    title = `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 完成清单`
  } else if (scope === 'month') {
    const monthStart = new Date(curYm.y, curYm.m, 1).getTime()
    const monthEnd = new Date(curYm.y, curYm.m + 1, 1).getTime()
    list = allTasks
      .filter((t) => t.d && t.doneAt != null && t.doneAt >= monthStart && t.doneAt < monthEnd)
      .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
    const ymStr = `${curYm.y}${p(curYm.m + 1)}`
    defaultFileName = `PinTodo-完成月报-${ymStr}`
    title = `${curYm.y}年${curYm.m + 1}月 完成月报`
  } else {
    list = allTasks
      .filter((t) => t.d)
      .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
    defaultFileName = `PinTodo-全部历史完成-${new Date().getFullYear()}${p(new Date().getMonth() + 1)}${p(new Date().getDate())}`
    title = `全部历史完成汇总`
  }

  if (!list.length) {
    toast('该时间范围没有可导出的完成任务')
    return
  }

  const path = await saveDialog({
    defaultPath: `${defaultFileName}.md`,
    filters: [
      { name: 'Markdown 清单 (*.md)', extensions: ['md'] },
      { name: 'CSV 表格 (*.csv)', extensions: ['csv'] },
      { name: '纯文本 (*.txt)', extensions: ['txt'] },
    ],
  })
  if (!path) return

  try {
    const isCsv = path.toLowerCase().endsWith('.csv')
    const content = isCsv ? generateHistoryCsv(list) : generateHistoryMarkdown(list, title)
    // UTF-8 带 BOM，防止 Excel 打开 CSV 中文乱码
    const fileData = isCsv ? '\uFEFF' + content : content
    await invoke('write_text', { path, content: fileData })
    toast(`已导出 ${list.length} 项完成清单`, '导出')
  } catch (err) {
    console.error('export history failed:', err)
    toast('导出完成清单失败')
  }
}
