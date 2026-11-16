// 状态层（Solid signals）：唯一数据源 + 防抖持久化 + 撤销栈
import { createSignal } from 'solid-js'
import { invoke } from '@tauri-apps/api/core'
import type { Task, TrashItem } from './types'

const [tasks, setTasks] = createSignal<Task[]>([])
const [settings, setSettings] = createSignal<Record<string, any>>({})
/** 回收站（删除的任务快照），独立于 tasks 持久化到 trash.json */
const [trash, setTrash] = createSignal<TrashItem[]>([])
export { tasks, settings, trash }

let seq = 1
const undoStack: Task[][] = []
const UNDO_CAP = 25

export function setAll(t: Task[], s: Record<string, any>) {
  setTasks(t)
  setSettings(s)
}

export function patchSettings(patch: Record<string, any>) {
  setSettings((s) => ({ ...s, ...patch }))
  try {
    invoke('save_settings', { settings: settings() }).catch(() => {})
  } catch {}
}

export function newId(): string {
  return Date.now().toString(16) + '-' + (seq++).toString(16)
}

/** 所有改动的统一出口：落盘（UI 由 signal 自动更新，无需手动 render） */
function commit(next: Task[], snapshot?: Task[]) {
  if (snapshot) {
    undoStack.push(snapshot)
    if (undoStack.length > UNDO_CAP) undoStack.shift()
  }
  setTasks(next)
  try {
    invoke('save_tasks', { tasks: next }).catch(() => {})
  } catch {}
}

function withTasks(fn: (cur: Task[]) => Task[], snapshot = true): void {
  const cur = tasks()
  commit(fn(cur), snapshot ? structuredClone(cur) : undefined)
}

export function canUndo() {
  return undoStack.length > 0
}

export function undo(): boolean {
  // 刚删除的任务：Ctrl+Z 优先从回收站恢复
  if (lastDeletedTrashId) {
    const tid = lastDeletedTrashId
    lastDeletedTrashId = null
    return restoreTrash(tid)
  }
  const snap = undoStack.pop()
  if (!snap) return false
  setTasks(snap)
  try {
    invoke('save_tasks', { tasks: snap }).catch(() => {})
  } catch {}
  return true
}

// ---------------- 任务操作 ----------------

export function addTask(t: Omit<Task, 'id' | 'createdAt' | 'doneAt'> & Partial<Task>): Task {
  const task: Task = {
    id: newId(),
    createdAt: Date.now(),
    doneAt: null,
    star: false,
    ...t,
  } as Task
  withTasks((cur) => [task, ...cur])
  return task
}

/** 批量添加多条待办，合成单次持久化与单次撤销快照 */
export function addTasksBatch(items: (Omit<Task, 'id' | 'createdAt' | 'doneAt'> & Partial<Task>)[]): Task[] {
  if (!items.length) return []
  const now = Date.now()
  const built: Task[] = items.map((t, i) => ({
    id: newId(),
    createdAt: now + i,
    doneAt: null,
    star: false,
    ...t,
  } as Task))
  withTasks((cur) => [...built, ...cur])
  return built
}

export function toggleTask(id: string) {
  withTasks((cur) => {
    const i = cur.findIndex((t) => t.id === id)
    if (i < 0) return cur
    const t = { ...cur[i] }
    const next = [...cur]
    if (!t.d) {
      t.d = true
      t.doneAt = Date.now()
      next[i] = t
      // 重复任务：完成后自动生成下一期
      if (t.recur && t.due) {
        next.splice(i + 1, 0, {
          ...t,
          id: newId(),
          d: false,
          doneAt: null,
          createdAt: Date.now(),
          due: nextOccurrence(t.due, t.recur, Date.now()),
        })
      }
    } else {
      t.d = false
      t.doneAt = null
      next[i] = t
    }
    return next
  })
}

export function deleteTask(id: string): string | null {
  const cur = tasks()
  const target = cur.find((t) => t.id === id)
  if (!target) return null
  const next = cur.filter((t) => t.id !== id)
  // 删除不再进撤销栈：进入回收站，撤销也走回收站恢复
  commit(next)
  const item: TrashItem = { id: newId(), deletedAt: Date.now(), task: structuredClone(target) }
  saveTrash([item, ...trash()])
  lastDeletedTrashId = item.id
  return item.id
}

// ---------------- 回收站 ----------------

/** 默认自动清理天数（0=永不） */
export const DEFAULT_TRASH_DAYS = 30
let lastDeletedTrashId: string | null = null

function saveTrash(next: TrashItem[]) {
  setTrash(next)
  try {
    invoke('save_trash', { items: next }).catch(() => {})
  } catch {}
}

/** 启动时从磁盘加载回收站 */
export async function loadTrashFromDisk(): Promise<TrashItem[]> {
  try {
    const items = await invoke<TrashItem[]>('load_trash')
    if (Array.isArray(items)) setTrash(items)
    return Array.isArray(items) ? items : []
  } catch {
    return []
  }
}

/** 按规则清理过期的回收站条目；days<=0 表示永不清理。返回清理条数 */
export function purgeExpiredTrash(days: number): number {
  if (!days || days <= 0) return 0
  const cutoff = Date.now() - days * 86400000
  const cur = trash()
  const keep = cur.filter((x) => x.deletedAt >= cutoff)
  const removed = cur.length - keep.length
  if (removed > 0) saveTrash(keep)
  return removed
}

/** 从回收站恢复任务到原清单 */
export function restoreTrash(trashId: string): boolean {
  const items = trash()
  const item = items.find((x) => x.id === trashId)
  if (!item) return false
  const exists = tasks().some((x) => x.id === item.task.id)
  const restored: Task = exists ? { ...item.task, id: newId() } : { ...item.task }
  commit([restored, ...tasks()])
  saveTrash(items.filter((x) => x.id !== trashId))
  if (lastDeletedTrashId === trashId) lastDeletedTrashId = null
  return true
}

/** 彻底删除单条 */
export function purgeTrashItem(trashId: string) {
  saveTrash(trash().filter((x) => x.id !== trashId))
  if (lastDeletedTrashId === trashId) lastDeletedTrashId = null
}

/** 清空回收站 */
export function clearTrash() {
  if (!trash().length) return
  saveTrash([])
  lastDeletedTrashId = null
}

export function editTask(id: string, text: string) {
  const v = text.trim()
  if (!v) return
  withTasks((cur) => cur.map((t) => (t.id === id ? { ...t, t: v } : t)))
}

/** 判断是否收藏（兼容旧数据里没有 star 字段但 pri===1 点击过星标的情况：新版显式用 star） */
export function isStarred(t: Task): boolean {
  return !!t.star
}

export function addProgLog(id: string, text: string) {
  const v = text.trim()
  if (!v) return
  const now = Date.now()
  withTasks((cur) =>
    cur.map((t) => {
      if (t.id !== id) return t
      const logs = t.progLogs ? [...t.progLogs] : []
      if (logs.length === 0 && t.prog && t.prog !== v) {
        logs.push({ id: newId(), text: t.prog, time: t.createdAt || now })
      }
      logs.unshift({ id: newId(), text: v, time: now })
      return { ...t, prog: v, progLogs: logs }
    }),
  )
}

export function deleteProgLog(taskId: string, logId: string) {
  withTasks((cur) =>
    cur.map((t) => {
      if (t.id !== taskId || !t.progLogs) return t
      const nextLogs = t.progLogs.filter((l) => l.id !== logId)
      const nextProg = nextLogs.length > 0 ? nextLogs[0].text : null
      return { ...t, prog: nextProg, progLogs: nextLogs }
    }),
  )
}

export function clearProgLogs(taskId: string) {
  withTasks((cur) =>
    cur.map((t) => (t.id === taskId ? { ...t, prog: null, progLogs: [] } : t)),
  )
}

export function setProg(id: string, prog?: string | null) {
  if (prog && prog.trim()) {
    addProgLog(id, prog)
  } else {
    clearProgLogs(id)
  }
}

export function starTask(id: string) {
  withTasks((cur) => cur.map((t) => (t.id === id ? { ...t, star: !t.star } : t)))
}

/** 挂起 / 取消挂起：挂起的任务收进「挂起」分组，不计入待办统计与到期提醒 */
export function setSusp(id: string, susp: boolean) {
  withTasks((cur) => cur.map((t) => (t.id === id ? { ...t, susp } : t)))
}

export function setPri(id: string, pri: number) {
  withTasks((cur) => cur.map((t) => (t.id === id ? { ...t, pri } : t)))
}

/** 已完成任务是否已"过期"（完成时间在参照日之前）——过期的不出现在清单列表 */
export function setTags(id: string, tags: string[]) {
  withTasks((cur) =>
    cur.map((t) => (t.id === id ? { ...t, tags: Array.from(new Set(tags.map((x) => x.trim().replace(/^#*/, '#')).filter((x) => x.length > 1))) } : t)),
  )
}

export function addTag(id: string, rawTag: string) {
  const clean = rawTag.trim().replace(/^#*/, '#')
  if (clean.length <= 1) return
  withTasks((cur) =>
    cur.map((t) => {
      if (t.id !== id) return t
      if (t.tags && t.tags.includes(clean)) return t
      return { ...t, tags: [...(t.tags || []), clean] }
    }),
  )
}

export function removeTag(id: string, rawTag: string) {
  const clean = rawTag.trim().replace(/^#*/, '#')
  withTasks((cur) =>
    cur.map((t) => {
      if (t.id !== id || !t.tags) return t
      return { ...t, tags: t.tags.filter((x) => x !== clean) }
    }),
  )
}

export function getAllTags(): string[] {
  const set = new Set<string>()
  for (const t of tasks()) {
    if (t.tags) {
      for (const tag of t.tags) {
        if (tag && tag.length > 1) set.add(tag)
      }
    }
  }
  return Array.from(set)
}

export function isStaleDone(t: Task, refDayStart = startOfToday()): boolean {
  return t.d && (t.doneAt ?? 0) < refDayStart
}

function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 排序比较函数：
 * 1. 未完成在前，已完成沉底（已完成按完成时间倒序）
 * 2. 收藏打星（star）优先
 * 3. 重要程度（pri: 1高 > 2中 > 3低 > 0无）
 * 4. 截止时间越早越前（无截止排在有截止之后）
 * 5. 原顺序兜底（保留手动拖拽与新建靠前顺序）
 * 注：填写进度反馈仅作状态展示，不打乱上述排序优先级
 */
export function compareTasks(a: Task, b: Task, indexMap?: Map<string, number>): number {
  if (a.d !== b.d) return a.d ? 1 : -1
  if (a.d && b.d) {
    return (b.doneAt ?? 0) - (a.doneAt ?? 0)
  }
  const sa = a.star ? 1 : 0
  const sb = b.star ? 1 : 0
  if (sa !== sb) return sb - sa
  const pa = a.pri > 0 ? a.pri : 99
  const pb = b.pri > 0 ? b.pri : 99
  if (pa !== pb) return pa - pb
  const da = a.due ?? Number.MAX_SAFE_INTEGER
  const db = b.due ?? Number.MAX_SAFE_INTEGER
  if (da !== db) return da - db
  if (indexMap) return (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0)
  return 0
}

export function sortTaskList(list: Task[]): Task[] {
  const indexMap = new Map<string, number>()
  list.forEach((t, i) => indexMap.set(t.id, i))
  return [...list].sort((a, b) => compareTasks(a, b, indexMap))
}

export function setNotes(id: string, notes?: string | null) {
  withTasks((cur) =>
    cur.map((t) => (t.id === id ? { ...t, notes: notes && notes.trim() ? notes : null } : t)),
  )
}

export function setDue(id: string, due: number | null) {
  withTasks((cur) =>
    cur.map((t) => (t.id === id ? { ...t, due, recur: due === null ? null : t.recur } : t)),
  )
}

export function setRecur(id: string, recur: 'daily' | 'weekly' | 'monthly' | null) {
  withTasks((cur) =>
    cur.map((t) => {
      if (t.id !== id) return t
      const due = recur && !t.due ? nextOccurrence(Date.now(), recur, Date.now()) : t.due
      return { ...t, recur, due }
    }),
  )
}

export function clearDone(list: string) {
  const cur = tasks()
  const next = cur.filter((t) => !(t.d && t.list === list))
  if (next.length !== cur.length) commit(next, structuredClone(cur))
}

/** 把 id 移动到 targetId 之前；targetId 为 null 表示移到末尾 */
export function moveTask(id: string, targetId: string | null) {
  withTasks((cur) => {
    const from = cur.findIndex((t) => t.id === id)
    if (from < 0) return cur
    const next = [...cur]
    const [item] = next.splice(from, 1)
    if (targetId == null) {
      next.push(item)
    } else {
      const to = next.findIndex((t) => t.id === targetId)
      next.splice(to < 0 ? next.length : to, 0, item)
    }
    return next
  })
}

export function replaceAll(newTasks: Task[]) {
  const cur = tasks()
  commit(newTasks, structuredClone(cur))
}

// ---------------- 工具 ----------------

/** 重复任务下一期时间：从原 due 推进，跳过错过的周期 */
export function nextOccurrence(from: number, recur: string, now: number): number {
  let d = new Date(from)
  do {
    if (recur === 'daily') d = new Date(d.getTime() + 86400000)
    else if (recur === 'weekly') d = new Date(d.getTime() + 7 * 86400000)
    else d = new Date(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes())
  } while (d.getTime() <= now)
  return d.getTime()
}
