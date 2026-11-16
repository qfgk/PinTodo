// 窗口状态机：normal / hidden(left|right) 的唯一合法状态源。
// 贴片（小精灵胶囊）支持：半嵌入左/右边缘或自由停靠屏幕任意位置；
// 单击直接唤回完整主窗口（不再搞两段式），拖动自由挪位并按距离磁吸贴边。
import { getCurrentWindow, PhysicalPosition, PhysicalSize, currentMonitor, LogicalSize } from '@tauri-apps/api/window'
import { settings, patchSettings, tasks } from './state'

export type Side = 'left' | 'right'
export type WState = 'normal' | `hidden-${Side}`

const win = getCurrentWindow()
export const MIN_H = 280
export const MAX_H = 720
/** 贴片窗口尺寸（逻辑 px）：内容为 48×54 胶囊 + 数量标签，水平居中 */
export const TAB_W = 110
export const TAB_H = 92
const PILL_D = 48
const PILL_CENTER_X = TAB_W / 2

let state: WState = 'normal'
let selfSizing = false
let animating = false
let suppressDockUntil = 0
let lastRestoreAt = 0
let lastSide: Side = 'right'
/** 贴片形态：dock=半嵌入边缘 / free=自由停靠屏幕任意处 */
let pillMode: 'dock' | 'free' | null = null
let dockSide: Side = 'right'
let pillMon: MonInfo | null = null
let lastPillRect: { x: number; y: number; w: number; h: number } | null = null
/** 贴片胶囊手动拖动中（抑制 onMoved 联动与 ensurePill 自愈） */
let pillDragging = false
/** 挂起态：Win+D 显示桌面后进入，胶囊保留在桌面上进入睡眠外观，点击恢复 */
let suspended = false
/** 进入挂起态的时刻（用于忽略自身重新拉起窗口造成的 foreground 抖动） */
let suspendEnteredAt = 0
let suspendTimer = 0

const setTabMode = (on: boolean, side?: Side) => {
  document.body.dataset.mode = on ? 'tab' : ''
  if (side) document.body.dataset.side = side
}
const setPillDataset = () => {
  document.body.dataset.pillDock = dockSide
  document.body.dataset.pillMode = pillMode ?? ''
}

export function wstate(): WState {
  return state
}
export function isHidden() {
  return state.startsWith('hidden')
}
/** 挂起态（Win+D 显示桌面后）：胶囊留在桌面上睡眠，任何恢复动作清除 */
export function isSuspended() {
  return suspended
}
export function setSuspended(v: boolean) {
  if (suspended === v) return
  suspended = v
  document.body.dataset.suspended = v ? '1' : ''
}
export function isAnimating() {
  return animating
}
export function isSelfSizing() {
  return selfSizing
}
export function justRestored(ms = 500) {
  return Date.now() - lastRestoreAt < ms
}
export function currentSide(): Side {
  return state.startsWith('hidden-') ? (state.split('-')[1] as Side) : lastSide
}

const clampNum = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

interface MonInfo {
  x: number
  y: number
  w: number
  h: number
  scale: number
}

async function monInfo(): Promise<MonInfo | null> {
  try {
    const m = await currentMonitor()
    if (!m) return null
    return { x: m.position.x, y: m.position.y, w: m.size.width, h: m.size.height, scale: m.scaleFactor }
  } catch {
    return null
  }
}

async function outerLogical() {
  const s = await win.outerSize()
  const sc = await win.scaleFactor()
  return { w: Math.round(s.width / sc), h: Math.round(s.height / sc) }
}

async function animateX(from: number, to: number, ms = 140) {
  const y = (await win.outerPosition()).y
  const t0 = performance.now()
  await new Promise<void>((resolve) => {
    const step = async () => {
      const k = Math.min(1, (performance.now() - t0) / ms)
      const e = 1 - Math.pow(1 - k, 3)
      try {
        await win.setPosition(new PhysicalPosition(Math.round(from + (to - from) * e), y))
      } catch { /* 窗口已销毁 */ }
      if (k < 1) requestAnimationFrame(step)
      else resolve()
    }
    requestAnimationFrame(step)
  })
}

async function animateRectP(
  fx: number, fy: number, fw: number, fh: number,
  tx: number, ty: number, tw: number, th: number,
  ms = 170,
) {
  selfSizing = true
  const t0 = performance.now()
  await new Promise<void>((resolve) => {
    const step = async () => {
      const k = Math.min(1, (performance.now() - t0) / ms)
      const e = 1 - Math.pow(1 - k, 3)
      try {
        await win.setSize(new PhysicalSize(Math.round(fw + (tw - fw) * e), Math.round(fh + (th - fh) * e)))
        await win.setPosition(new PhysicalPosition(Math.round(fx + (tx - fx) * e), Math.round(fy + (ty - fy) * e)))
      } catch { /* 窗口已销毁 */ }
      if (k < 1) requestAnimationFrame(step)
      else resolve()
    }
    requestAnimationFrame(step)
  })
  setTimeout(() => { selfSizing = false }, 80)
}

function focusInput() {
  const act = document.activeElement
  if (act && act.matches('input, textarea')) return
  document.querySelector<HTMLInputElement>('.new-input')?.focus()
}

export async function beginResize() {
  selfSizing = false
}

// ---------------- 贴片模式 ----------------

export function pendingCount() {
  // 已挂起的任务不计入胶囊待办数
  return tasks().filter((t) => !t.d && !t.susp).length
}

function pillTargetRect(mode: 'dock' | 'free', mon: MonInfo): { x: number; y: number; w: number; h: number } {
  const sc = mon.scale
  const w = Math.round(TAB_W * sc)
  const h = Math.round(TAB_H * sc)
  const cy = Math.round(clampNum(settings().edgeY ?? mon.y + mon.h / 2, mon.y + h / 2 + 6, mon.y + mon.h - h / 2 - 6))
  if (mode === 'dock') {
    // 半嵌入：胶囊中心压在屏幕边缘（露出约半个软胶囊 + 数量牌）
    const x = dockSide === 'right'
      ? Math.round(mon.x + mon.w - PILL_CENTER_X * sc)
      : Math.round(mon.x - PILL_CENTER_X * sc)
    return { x, y: Math.round(cy - h / 2), w, h }
  }
  const fx = typeof settings().pillFree?.x === 'number' ? settings().pillFree.x : mon.x + mon.w - w - 40
  const fy = typeof settings().pillFree?.y === 'number' ? settings().pillFree.y : mon.y + mon.h / 2 - h / 2
  return {
    x: Math.round(clampNum(fx, mon.x + 4, mon.x + mon.w - w - 4)),
    y: Math.round(clampNum(fy, mon.y + 4, mon.y + mon.h - h - 4)),
    w, h,
  }
}

async function applyPillGeometry(instant = false) {
  const mon = await monInfo()
  if (!mon) return
  const mode = pillMode === 'free' ? 'free' : 'dock'
  const r = pillTargetRect(mode, mon)
  lastPillRect = r
  if (instant) {
    try {
      await win.setSize(new PhysicalSize(r.w, r.h))
      await win.setPosition(new PhysicalPosition(r.x, r.y))
    } catch { /* ignore */ }
    return
  }
  const pos = await win.outerPosition()
  const s = await win.outerSize()
  await animateRectP(pos.x, pos.y, s.width, s.height, r.x, r.y, r.w, r.h)
}

/** 从贴片拖动中磁吸回边缘（允许在 hidden 态调用） */
async function snapPillToEdge(side: Side, cy: number) {
  const mon = await monInfo()
  if (!mon) return
  animating = true
  lastSide = side
  dockSide = side
  pillMode = 'dock'
  state = `hidden-${side}`
  setTabMode(true, side)
  setPillDataset()
  patchSettings({
    edge: side,
    pillMode: 'dock',
    edgeY: Math.round(clampNum(cy, mon.y + PILL_D, mon.y + mon.h - PILL_D)),
  })
  await applyPillGeometry()
  animating = false
}

/** 自由停靠到屏幕任意位置 */
async function parkFree(x: number, y: number) {
  const mon = await monInfo()
  if (!mon) return
  animating = true
  pillMode = 'free'
  setPillDataset()
  patchSettings({
    pillMode: 'free',
    pillFree: { x, y },
    edge: dockSide, // 保持 hidden 状态标记以便重启恢复贴片模式
  })
  await applyPillGeometry(true)
  animating = false
}

/** 最小化：滑出屏幕并半嵌入侧边栏 */
export async function hideToEdge(side?: Side) {
  if (isHidden() || animating) return
  const mon = await monInfo()
  if (!mon) return
  animating = true

  const pos = await win.outerPosition()
  const l = await outerLogical()
  const target: Side = side ?? (pos.x + l.w / 2 < mon.x + mon.w / 2 ? 'left' : 'right')
  lastSide = target
  dockSide = target
  pillMode = 'dock'
  state = `hidden-${target}`

  patchSettings({
    x: pos.x, y: pos.y, // 冻结主窗位置
    w: clampNum(l.w, 280, 560),
    h: clampNum(l.h, MIN_H, MAX_H),
    edge: target,
    pillMode: 'dock',
    edgeY: Math.round(clampNum(pos.y + l.h / 2, mon.y + PILL_D, mon.y + mon.h - PILL_D)),
  })

  // 先滑出屏幕，再以半嵌入形态贴回边缘
  const off = target === 'left' ? mon.x - l.w - 8 : mon.x + mon.w + 8
  await animateX(pos.x, off)
  setTabMode(true, target)
  setPillDataset()
  await applyPillGeometry(true)
  animating = false
}

export async function restoreFromEdge() {
  if (!isHidden() || animating) return
  // 用户主动唤回：退出挂起态（胶囊醒来）
  clearTimeout(suspendTimer)
  setSuspended(false)
  const mon = await monInfo()
  if (!mon) return
  animating = true
  pillMode = null
  setTabMode(false)
  document.body.dataset.pillDock = ''
  document.body.dataset.pillMode = ''

  const savedX = typeof settings().x === 'number' ? settings().x : mon.x + mon.w - 560 - 56
  const savedY = typeof settings().y === 'number' ? settings().y : 140
  const w = clampNum(settings().w ?? 322, 280, 560)
  const h = clampNum(settings().h ?? 480, MIN_H, MAX_H)
  const sc = mon.scale
  const thr = Math.round(20 * sc)
  // 若主窗口保存的位置在边缘停靠区内，自动往内挪开，防止恢复后又立刻触发自动吸附
  let x = Math.max(mon.x + thr + 8, Math.min(savedX, mon.x + mon.w - w - thr - 8))
  const y = Math.max(mon.y + 4, Math.min(savedY, mon.y + mon.h - h - 4))
  patchSettings({ edge: null, pillMode: null, x, y })

  // 抑制期间严禁 onMoved 把主窗口再吸回边缘
  suppressDockUntil = Date.now() + 1500
  const startX = dockSide === 'left' ? mon.x - w - 8 : mon.x + mon.w + 8
  await win.setSize(new LogicalSize(w, h))
  await win.setPosition(new PhysicalPosition(startX, y))
  await animateX(startX, x)
  try {
    await win.setFocus()
  } catch { /* 拒绝焦点也可 */ }
  state = 'normal'
  animating = false
  lastRestoreAt = Date.now()
  suppressDockUntil = Date.now() + 1500
  // 恢复用户偏好：挂起期间为了钉在桌面上强制置顶，唤回后还原用户设置
  try { await win.setAlwaysOnTop(settings().topmost !== false) } catch { /* ignore */ }
  setTimeout(focusInput, 100)
}

/** 启动时快速判断是否处于贴边隐藏态 */
export function isEdgeHiddenAtBoot(): boolean {
  const edge = settings().edge
  return edge === 'left' || edge === 'right'
}

/** 启动时还原贴片形态（半嵌入 / 自由停靠） */
export async function bootFromEdgeIfHidden() {
  const side = settings().edge
  if (side !== 'left' && side !== 'right') return false
  state = `hidden-${side as Side}`
  lastSide = side
  dockSide = side
  pillMode = settings().pillMode === 'free' ? 'free' : 'dock'
  const mon = await monInfo()
  if (mon) {
    setTabMode(true, side)
    setPillDataset()
    await applyPillGeometry(true)
    await win.show()
    await win.setAlwaysOnTop(true)
  }
  return true
}

/** 贴片态自愈：Snap/系统强改窗口尺寸后按当前形态扳回 */
export async function ensurePill() {
  if (!isHidden() || animating || pillDragging) return
  const s = await win.outerSize()
  const sc = await win.scaleFactor()
  const wLogical = Math.round(s.width / sc)
  const hLogical = Math.round(s.height / sc)
  if (Math.abs(wLogical - TAB_W) > 2 || Math.abs(hLogical - TAB_H) > 2) {
    await applyPillGeometry(true)
  }
}

/** 拖动结束：磁吸判定（靠近左/右边缘 → 半嵌入；否则自由停靠原地） */
export async function settleAfterDrag() {
  if (!isHidden()) return
  const mon = await monInfo()
  if (!mon) return
  const r = lastPillRect
  if (!r) return
  const sc = mon.scale
  const cx = r.x + PILL_CENTER_X * sc
  const cy = r.y + Math.round((TAB_H * sc) / 2)
  const dL = Math.abs(cx - mon.x)
  const dR = Math.abs(mon.x + mon.w - cx)
  const snapDist = Math.round(62 * mon.scale)
  if (dL <= snapDist || dR <= snapDist) {
    await snapPillToEdge(dL <= dR ? 'left' : 'right', cy)
  } else {
    await parkFree(r.x, r.y)
  }
}

// ---------------- 贴片胶囊拖动（自实现，规避原生拖拽触发 Snap 半屏） ----------------

let pillOff = { x: 0, y: 0 }
let pillOffReady = false
let pillMoved = false
let pillStart = { x: 0, y: 0 }
let pillRaf = 0
let pillLast: PointerEvent | null = null

export function isPillDragging() {
  return pillDragging
}

export function startPillDrag(e: PointerEvent) {
  if (!isHidden() || pillDragging || animating) return
  pillDragging = true
  pillMoved = false
  pillOffReady = false
  pillStart = { x: e.screenX, y: e.screenY }
  ;(async () => {
    pillMon = await monInfo()
    const pos = await win.outerPosition()
    pillOff = { x: e.screenX - pos.x, y: e.screenY - pos.y }
    pillOffReady = true
  })()
  window.addEventListener('pointermove', onPillMove)
  window.addEventListener('pointerup', onPillUp)
}

function onPillMove(e: PointerEvent) {
  if (!pillDragging) return
  if (Math.hypot(e.screenX - pillStart.x, e.screenY - pillStart.y) > 8) pillMoved = true
  pillLast = e
  if (!pillRaf) pillRaf = requestAnimationFrame(applyPillMove)
}

async function applyPillMove() {
  pillRaf = 0
  const e = pillLast
  if (!e || !pillDragging) return
  if (!pillMon) pillMon = await monInfo()
  if (!pillMon) return
  if (!pillOffReady) {
    const pos = await win.outerPosition()
    pillOff = { x: e.screenX - pos.x, y: e.screenY - pos.y }
    pillOffReady = true
  }
  const sc = pillMon.scale
  const x = clampNum(e.screenX - pillOff.x, pillMon.x - Math.round(PILL_D * sc), pillMon.x + pillMon.w - Math.round((TAB_W - PILL_D) * sc))
  const y = clampNum(e.screenY - pillOff.y, pillMon.y + 4, pillMon.y + pillMon.h - Math.round(TAB_H * sc) - 4)
  lastPillRect = { x: Math.round(x), y: Math.round(y), w: Math.round(TAB_W * sc), h: Math.round(TAB_H * sc) }
  try {
    await win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y)))
  } catch { /* ignore */ }
}

function onPillUp() {
  window.removeEventListener('pointermove', onPillMove)
  window.removeEventListener('pointerup', onPillUp)
  if (pillRaf) { cancelAnimationFrame(pillRaf); pillRaf = 0 }
  const wasDrag = pillMoved
  pillDragging = false
  pillMon = null
  pillOffReady = false
  if (wasDrag) {
    settleAfterDrag()
  } else {
    // 无论半嵌还是自由，单击直接滑出完整待办主窗口！
    restoreFromEdge()
  }
}

/** 把窗口重新拉起并钉回置顶层。
 *  Win+D 会隐藏/最小化所有窗口（置顶窗口也不例外），且隐藏动作可能在事件之后才完成，
 *  因此必须 unminimize + show + setAlwaysOnTop 反复补强。 */
async function reassertVisible() {
  try {
    if (await win.isMinimized()) await win.unminimize()
  } catch { /* 权限或窗口销毁 */ }
  try {
    if (!(await win.isVisible())) await win.show()
  } catch { /* ignore */ }
  try {
    await win.setAlwaysOnTop(true)
  } catch { /* ignore */ }
  if (isHidden()) await ensurePill()
}

/** 当系统触发显示桌面（Win+D / Win+M / 任务栏按钮）时进入「挂起态」：
 * 1. 展开态 → 平滑收缩为侧边胶囊（挂起标记 + 睡眠外观）
 * 2. 胶囊态 → 保持贴片并重新钉回置顶层
 * 3. 延迟多次补强拉起，确保 Windows 的隐藏动作结束后胶囊仍留在桌面上可见 */
export async function onShowDesktop() {
  if (animating) return
  setSuspended(true)
  suspendEnteredAt = Date.now()

  if (!isHidden()) {
    // Win+D 会挂起被最小化窗口的 rAF，收缩动画可能永远不结束：
    // 最多等 350ms，随后无论如何继续把窗口拉起（Rust 侧还有独立的 Win32 补强）
    await Promise.race([
      hideToEdge(),
      new Promise<void>((resolve) => setTimeout(resolve, 350)),
    ])
  }
  await reassertVisible()

  clearTimeout(suspendTimer)
  const delays = [150, 380, 780, 1400]
  const pulse = (i: number) => {
    suspendTimer = window.setTimeout(async () => {
      if (!suspended) return
      await reassertVisible()
      if (i + 1 < delays.length) pulse(i + 1)
    }, delays[i])
  }
  if (delays.length) pulse(0)
}

/** 离开桌面（前台不再是桌面窗口）：让胶囊苏醒，但仍保持贴片形态不自动展开 */
export function onDesktopRestored() {
  if (!suspended) return
  // 忽略自身重新拉起窗口造成的 foreground 抖动（进入挂起后的补强窗口期内）
  if (Date.now() - suspendEnteredAt < 2500) return
  clearTimeout(suspendTimer)
  setSuspended(false)
  // 桌面已退场：不再需要强制置顶，还原用户偏好
  try { win.setAlwaysOnTop(settings().topmost !== false).catch(() => {}) } catch { /* ignore */ }
}

/** 拖动结束：主窗口贴到左右边缘则隐藏；返回是否触发了停靠 */
export async function checkDockAfterMove(): Promise<boolean> {
  if (isHidden() || animating) return false
  if (Date.now() < suppressDockUntil) return false
  const mon = await monInfo()
  if (!mon) return false
  try {
    const pos = await win.outerPosition()
    const size = await win.outerSize()
    const thr = Math.round(12 * mon.scale)
    if (pos.x <= mon.x + thr) {
      hideToEdge('left')
      return true
    }
    if (pos.x + size.width >= mon.x + mon.w - thr) {
      hideToEdge('right')
      return true
    }
  } catch { /* ignore */ }
  return false
}
