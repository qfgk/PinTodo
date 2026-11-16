// 主界面（Solid 组件）：状态驱动渲染，编辑/选中/拖拽全部局部化
import { createMemo, createSignal, For, Show, createEffect, onMount, onCleanup } from 'solid-js'
import { invoke } from '@tauri-apps/api/core'
import { type Task, type Chip, type ParsedInput, type ViewMode, type TimeGroupKey, type ListGroupKey } from './types'
import * as S from './state'
import { parseInput, dueLabel, priLabel, priClass, getTimeGroupKey } from './parse'
import { SVG } from './icons'
import { popupMenu } from './menus'
import * as W from './winstate'

export { SVG, h } from './icons'
export { getTimeGroupKey } from './parse'

// ---------------- 视图状态 ----------------

const [currentList, setCurrentList] = createSignal('默认')
const [view, setView] = createSignal<ViewMode>('list')
const [chip, setChip] = createSignal<Chip>('all')
const [query, setQuery] = createSignal('')
const [searchOpen, setSearchOpen] = createSignal(false)
const [selId, setSelId] = createSignal<string | null>(null)
const [helpOpen, setHelpOpen] = createSignal(false)
/** 任务进度历史与打卡弹窗 */
const [progModalTask, setProgModalTask] = createSignal<Task | null>(null)
/** 事项标签管理弹窗 */
const [tagModalTask, setTagModalTask] = createSignal<Task | null>(null)
/** 删除确认弹窗（行内 × 与右键菜单共用） */
const [deleteConfirmTask, setDeleteConfirmTask] = createSignal<Task | null>(null)
/** 回收站面板 */
const [trashOpen, setTrashOpen] = createSignal(false)
/** 历史视图：选中的日期（当日 0 点）与月份锚点 */
const [historySel, setHistorySel] = createSignal<number | null>(null)
const [historyMonth, setHistoryMonth] = createSignal<{ y: number; m: number } | null>(null)

/** 清单内时间分组折叠偏好记忆 */
const [collapsedGroups, setCollapsedGroups] = createSignal<Record<string, boolean>>(
  (S.settings().collapsedGroups as Record<string, boolean>) || {}
)

export function toggleTimeGroup(key: ListGroupKey) {
  const next = { ...collapsedGroups(), [key]: !collapsedGroups()[key] }
  setCollapsedGroups(next)
  S.patchSettings({ collapsedGroups: next })
}

export {
  currentList, setCurrentList, view, setView, chip, setChip,
  query, setQuery, searchOpen, setSearchOpen, selId, setSelId,
  helpOpen, setHelpOpen, historySel, setHistorySel, historyMonth, setHistoryMonth,
  progModalTask, setProgModalTask, tagModalTask, setTagModalTask,
  deleteConfirmTask, setDeleteConfirmTask, trashOpen, setTrashOpen,
  collapsedGroups, setCollapsedGroups,
}

const startOfToday = () => {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}
// 当天已过点的截止时间也算逾期（与分钟级通知一致）
const isOverdue = (t: Task) => !t.d && t.due != null && t.due < Date.now()
const isToday = (t: Task) => t.due != null && t.due >= startOfToday() && t.due < startOfToday() + 86400000

export const TIME_GROUPS: { key: TimeGroupKey; label: string }[] = [
  { key: 'today', label: '今天' },
  { key: 'week', label: '本周' },
  { key: 'month', label: '本月' },
  { key: 'continuous', label: '持续' },
]

/** 清单分组（四个时间组 + 挂起组）：挂起的任务收进最后一组，随时可恢复 */
export const LIST_GROUPS: { key: ListGroupKey; label: string }[] = [
  ...TIME_GROUPS,
  { key: 'parked', label: '挂起' },
]

export const allLists = () => {
  const lists: string[] = Array.isArray(S.settings().lists) ? [...S.settings().lists] : []
  for (const t of S.tasks()) if (!lists.includes(t.list)) lists.push(t.list)
  if (!lists.includes('默认')) lists.unshift('默认')
  return lists
}

const matchFilter = (t: Task, q: string) => {
  if (chip() === 'todo' && (t.d || t.susp)) return false
  if (chip() === 'done' && !t.d) return false
  if (chip() === 'star' && !t.star && t.pri !== 1) return false
  if (chip() === 'today' && !isToday(t)) return false
  if (chip() === 'overdue' && !isOverdue(t)) return false
  if (q && !(t.t.toLowerCase().includes(q) || (t.notes ?? '').toLowerCase().includes(q) || t.tags.some((x) => x.toLowerCase().includes(q)))) return false
  return true
}

const visibleTasks = createMemo<Task[]>(() => {
  const q = query().trim().toLowerCase()
  if (view() === 'note') return []
  if (view() === 'history') {
    // 历史日历：所选日期的完成记录，按完成时间倒序
    const sel = historySel()
    if (sel == null) return []
    const s = sel, e = sel + 86400000
    return S.tasks()
      .filter((t) => t.d && t.doneAt != null && t.doneAt >= s && t.doneAt < e)
      .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
  }
  // 清单视图：过滤"过期完成"（次日自动隐藏，数据保留可在历史查看）
  const today = startOfToday()
  const list = S.tasks().filter((t) => t.list === currentList() && !S.isStaleDone(t, today))
  const f = list.filter((t) => matchFilter(t, q))
  return S.sortTaskList(f)
})

const visibleIds = createMemo(() => visibleTasks().map((t) => t.id))

// ---------------- 外部动作（app.tsx 注入） ----------------

interface Actions {
  onCollapse(): void
  onPin(): void
  onClose(): void
  onMenu(x: number, y: number): void
  onListMenu(x: number, y: number): void
  onExportHistory(scope: 'day' | 'month' | 'all'): void
}
let A: Actions
export function setActions(a: Actions) {
  A = a
}

export interface ToastAction {
  label: string
  danger?: boolean
  onClick(): void
}
interface ToastState {
  msg: string
  undo?: string
  actions?: ToastAction[]
}

let toastTimer = 0
const [toastMsg, setToastMsg] = createSignal<ToastState | null>(null)
export function toast(msg: string, undoLabel?: string, actions?: ToastAction[], duration = 3200) {
  setToastMsg({ msg, undo: undoLabel, actions })
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => setToastMsg(null), duration)
}

// ---------------- 输入行 ----------------

const [hint, setHint] = createSignal<ParsedInput | null>(null)

function InputRow(props: { ref?: (el: HTMLInputElement) => void }) {
  let input!: HTMLInputElement
  const commit = () => {
    const p = parseInput(input.value)
    if (!p.text) return
    S.addTask({
      t: p.text, d: false, list: p.list ?? currentList(), tags: p.tags,
      pri: p.pri, due: p.due, recur: p.recur,
    })
    input.value = ''
    setHint(null)
  }
  const onPaste = (e: ClipboardEvent) => {
    const raw = e.clipboardData?.getData('text') ?? ''
    const lines = raw.split(/\r?\n/).map((l) => l.replace(/^[-*•\s]*(\[\s*\]\s*)?/, '').trim()).filter(Boolean)
    if (lines.length <= 1) return
    e.preventDefault()
    const batch = lines
      .map((line) => parseInput(line))
      .filter((p) => p.text)
      .map((p) => ({
        t: p.text, d: false, list: p.list ?? currentList(), tags: p.tags,
        pri: p.pri, due: p.due, recur: p.recur,
      }))
    if (batch.length) {
      S.addTasksBatch(batch)
      toast(`已批量添加 ${batch.length} 条待办`, '批量添加')
    }
  }
  return (
    <>
      <div class="input-row">
        <span class="plus" innerHTML={SVG.plus} />
        <input
          ref={(el) => { input = el; props.ref?.(el) }}
          type="text"
          class="new-input"
          placeholder="添加待办… 支持 #标签 @清单 !1 明天18:00"
          onInput={() => setHint(input.value.trim() ? parseInput(input.value) : null)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit() }
            e.stopPropagation()
          }}
        />
      </div>
      <Show when={hint()}>
        <div class="hint">
          <Show when={hint()!.due}><span class="hint-chip">⏰ {dueLabel(hint()!.due!).text}</span></Show>
          <Show when={hint()!.recur}>
            <span class="hint-chip">↻ {({ daily: '每天', weekly: '每周', monthly: '每月' } as const)[hint()!.recur!]}</span>
          </Show>
          <Show when={hint()!.pri}><span class="hint-chip pri">!{hint()!.pri} {priLabel(hint()!.pri)}</span></Show>
          <Show when={hint()!.list}><span class="hint-chip">清单: {hint()!.list}</span></Show>
          <For each={hint()!.tags}>{(t) => <span class="hint-chip">{t}</span>}</For>
        </div>
      </Show>
    </>
  )
}

// ---------------- 任务行（按 id 绑定，任务属性变更绝不销毁重建 DOM） ----------------

function TaskRow(props: { id: string }) {
  const t = createMemo<Task>(() => S.tasks().find((x) => x.id === props.id)!)
  const [editing, setEditing] = createSignal(false)
  const [descOpen, setDescOpen] = createSignal(false)
  let input: HTMLInputElement | undefined
  let descInput: HTMLTextAreaElement | undefined
  let editValue = ''
  let descTimer = 0

  const beginEdit = () => {
    const cur = t()
    if (!cur) return
    editValue = cur.t
    setEditing(true)
    queueMicrotask(() => {
      input?.focus()
      input?.setSelectionRange(editValue.length, editValue.length)
    })
  }
  const finishEdit = (commit: boolean) => {
    if (!editing()) return
    setEditing(false)
    if (commit) {
      S.editTask(props.id, editValue)
    }
  }

  const toggle = () => {
    S.toggleTask(props.id)
  }
  const remove = () => {
    const cur = t()
    if (cur) setDeleteConfirmTask(cur)
  }

  const toggleDesc = () => {
    const next = !descOpen()
    setDescOpen(next)
    if (next) {
      queueMicrotask(() => {
        if (descInput) {
          descInput.value = t().notes ?? ''
          descInput.focus()
          descInput.setSelectionRange(descInput.value.length, descInput.value.length)
        }
      })
    }
  }

  /** 单击主体：选中；再次单击同一行 → 展开/收起描述 */
  const onBodyClick = () => {
    if (selId() !== props.id) setSelId(props.id)
    else toggleDesc()
  }
  const flushNotes = () => {
    clearTimeout(descTimer)
    if (descInput) {
      const val = descInput.value
      if ((val.trim() || null) !== (t().notes?.trim() || null)) {
        S.setNotes(props.id, val)
      }
    }
  }
  createEffect(() => {
    const val = t()?.notes ?? ''
    if (descOpen() && descInput && document.activeElement !== descInput && descInput.value !== val) {
      descInput.value = val
    }
  })
  onCleanup(() => clearTimeout(descTimer))

  const openProg = () => {
    const cur = t()
    if (cur) setProgModalTask(cur)
  }

  const inAggregate = () => view() !== 'list'

  const openDueMenu = (e: MouseEvent) => {
    e.stopPropagation()
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dueQuickMenu(t(), r.left, r.bottom + 4)
  }

  return (
    <Show when={t()}>
      <div
        class="row"
        data-id={props.id}
        classList={{
          done: t().d,
          starred: !!t().star,
          susp: !!t().susp,
          overdue: isOverdue(t()),
          sel: selId() === props.id,
          desced: descOpen(),
        }}
        onDblClick={(e) => {
          const tgt = e.target instanceof Element ? e.target : null
          if (tgt && tgt.closest('button, input, textarea, .due')) return
          beginEdit()
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setSelId(props.id)
          rowMenu(t(), e.clientX, e.clientY, beginEdit, openProg)
        }}
      >
        <button class="check" title="完成 / 取消完成" onClick={toggle} innerHTML={SVG.check} />
        <div class="row-body" onClick={onBodyClick}>
          <Show
            when={editing()}
            fallback={
              <div class="txt">
                <Show when={t().pri}>
                  <span class={`pri-flag ${priClass(t().pri)}`}>!{t().pri}</span>{' '}
                </Show>
                {t().t}
              </div>
            }
          >
            <input
              ref={input}
              type="text"
              class="edit-input"
              value={editValue}
              onInput={(e) => (editValue = e.currentTarget.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') finishEdit(true)
                if (e.key === 'Escape') finishEdit(false)
              }}
              onBlur={() => finishEdit(true)}
              onDblClick={(e) => e.stopPropagation()}
            />
          </Show>
          <Show when={!descOpen() && t().notes}>
            <div class="notes-preview">{t().notes}</div>
          </Show>
          <Show when={t().prog}>
            <div
              class="prog-pill"
              classList={{ done: t().d }}
              title="点击查看进度历程与反馈"
              onClick={(e) => { e.stopPropagation(); openProg() }}
            >
              <span class="prog-dot" />
              <span class="prog-txt">{t().prog}</span>
              <Show when={t().progLogs && t().progLogs!.length > 1}>
                <span class="prog-badge">+{t().progLogs!.length}</span>
              </Show>
            </div>
          </Show>
          <Show when={t().susp || t().due || t().recur || t().tags.length || (inAggregate() && t().list !== currentList())}>
            <div class="meta">
              <Show when={t().susp}>
                <span
                  class="susp-chip"
                  title="点击恢复（取消挂起）"
                  onClick={(e) => {
                    e.stopPropagation()
                    S.setSusp(props.id, false)
                    toast('已恢复到清单', '恢复')
                  }}
                >
                  <span class="susp-chip-ico" innerHTML={SVG.pause} />
                  已挂起
                </span>
              </Show>
              <Show when={t().due}>
                {(() => {
                  const l = createMemo(() => dueLabel(t().due!))
                  return (
                    <span class={`due clickable ${l().cls}`} title="点击快速改期" onClick={openDueMenu}>
                      {l().text}
                    </span>
                  )
                })()}
              </Show>
              <Show when={t().recur}>
                <span class="rec">↻ {({ daily: '每天', weekly: '每周', monthly: '每月' } as const)[t().recur!]}</span>
              </Show>
              <Show when={inAggregate()}>
                <span class="list-tag">{t().list}</span>
              </Show>
              <For each={t().tags}>
                {(tag) => (
                  <span
                    class="tag"
                    title="点击按此标签筛选（再点一次取消）"
                    onClick={(e) => {
                      e.stopPropagation()
                      // 再次点击同一标签 = 取消筛选（开关语义）
                      if (searchOpen() && query() === tag) {
                        exportSearchToggle(false)
                      } else {
                        setSearchOpen(true)
                        setQuery(tag)
                      }
                    }}
                  >
                    {tag}
                  </span>
                )}
              </For>
              <span
                class="tag-add-inline"
                title="设置标签"
                onClick={(e) => {
                  e.stopPropagation()
                  setTagModalTask(t())
                }}
              >
                + 标签
              </span>
            </div>
          </Show>
          <Show when={descOpen()}>
            <textarea
              ref={descInput}
              class="row-notes"
              placeholder="补充描述…（点击别处自动保存）"
              onInput={(e) => {
                const val = e.currentTarget.value
                clearTimeout(descTimer)
                descTimer = window.setTimeout(() => {
                  S.setNotes(props.id, val)
                }, 600)
              }}
              onBlur={() => flushNotes()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Escape') {
                  clearTimeout(descTimer)
                  if (descInput) S.setNotes(props.id, descInput.value)
                  setDescOpen(false)
                }
              }}
              onDblClick={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            />
          </Show>
        </div>
        <div class="row-acts">
          <button
            class="ib tag-btn"
            classList={{ has: (t().tags?.length || 0) > 0 }}
            title="设置标签"
            onClick={(e) => {
              e.stopPropagation()
              setSelId(props.id)
              setTagModalTask(t())
            }}
            innerHTML={SVG.tagIcon}
          />
          <button
            class="ib prog"
            classList={{ has: !!t().prog }}
            title="查看与记录当前进度"
            onClick={(e) => {
              e.stopPropagation()
              setSelId(props.id)
              openProg()
            }}
            innerHTML={SVG.prog}
          />
          <button
            class="ib note"
            classList={{ has: !!t().notes }}
            title="描述"
            onClick={(e) => {
              e.stopPropagation()
              setSelId(props.id)
              const next = !descOpen()
              setDescOpen(next)
              if (next) queueMicrotask(() => {
                if (descInput) {
                  descInput.value = t().notes ?? ''
                  descInput.focus()
                  descInput.setSelectionRange(descInput.value.length, descInput.value.length)
                }
              })
            }}
            innerHTML={SVG.notes}
          />
          <button
            class="ib star"
            title="收藏打星"
            onClick={(e) => { e.stopPropagation(); S.starTask(props.id) }}
            innerHTML={t().star ? SVG.starFill : SVG.star}
          />
          <button class="ib del" title="删除" onClick={(e) => { e.stopPropagation(); remove() }} innerHTML={SVG.close} />
        </div>
      </div>
    </Show>
  )
}

// ---------------- 弹出菜单 ----------------

function dueQuickMenu(t: Task, x: number, y: number) {
  const dueAt = (h: number, dayOffset = 0, min = 0) => {
    const d = new Date()
    d.setDate(d.getDate() + dayOffset)
    d.setHours(h, min, 0, 0)
    return d.getTime()
  }
  const inMinutes = (m: number) => Date.now() + m * 60000
  popupMenu([
    { label: '推迟 15 分钟', action: () => S.setDue(t.id, inMinutes(15)) },
    { label: '推迟 1 小时', action: () => S.setDue(t.id, inMinutes(60)) },
    { sep: true },
    { label: '今天 18:00', action: () => S.setDue(t.id, dueAt(18)) },
    { label: '明天 9:00', action: () => S.setDue(t.id, dueAt(9, 1)) },
    { label: '明天 18:00', action: () => S.setDue(t.id, dueAt(18, 1)) },
    { label: '下周一 9:00', action: () => { const d = new Date(); const off = (8 - d.getDay()) % 8 || 7; S.setDue(t.id, dueAt(9, off)) } },
    { label: '选择日期…', datetime: t.due, action: (v?: number) => S.setDue(t.id, v ?? null) },
    ...(t.due ? [{ sep: true }, { label: '清除截止', danger: true, action: () => S.setDue(t.id, null) }] : []),
  ], x, y)
}

function rowMenu(t: Task, x: number, y: number, beginEdit: () => void, openProg: () => void) {
  const dueAt = (h: number, dayOffset = 0) => {
    const d = new Date()
    d.setDate(d.getDate() + dayOffset)
    d.setHours(h, 0, 0, 0)
    return d.getTime()
  }
  const setPri = (p: number) => {
    S.setPri(t.id, t.pri === p ? 0 : p)
  }
  popupMenu([
    { label: t.d ? '标记为未完成' : '标记为完成', action: () => { S.toggleTask(t.id) } },
    { label: t.star ? '取消收藏打星' : '收藏打星', action: () => S.starTask(t.id) },
    { label: t.prog ? '更新当前进度…' : '反馈当前进度…', action: openProg },
    ...(t.prog ? [{ label: '清除当前进度', action: () => S.setProg(t.id, null) }] : []),
    {
      label: t.susp ? '取消挂起（恢复到清单）' : '挂起（暂缓处理）',
      icon: SVG.pause,
      action: () => {
        S.setSusp(t.id, !t.susp)
        toast(t.susp ? '已恢复到清单' : '已挂起，可在清单末尾「挂起」分组找回', t.susp ? '恢复' : '挂起')
      },
    },
    { label: '设置标签…', action: () => setTagModalTask(t) },
    { label: '编辑标题', action: beginEdit },
    { sep: true },
    { label: '优先级 !1 高', radio: true, checked: t.pri === 1, action: () => setPri(1) },
    { label: '优先级 !2 中', radio: true, checked: t.pri === 2, action: () => setPri(2) },
    { label: '优先级 !3 低', radio: true, checked: t.pri === 3, action: () => setPri(3) },
    { sep: true },
    { label: '今天 18:00', action: () => S.setDue(t.id, dueAt(18)) },
    { label: '明天 9:00', action: () => S.setDue(t.id, dueAt(9, 1)) },
    { label: '明天 18:00', action: () => S.setDue(t.id, dueAt(18, 1)) },
    { label: '下周一 9:00', action: () => { const d = new Date(); const off = (8 - d.getDay()) % 8 || 7; S.setDue(t.id, dueAt(9, off)) } },
    { label: '选择日期…', datetime: t.due, action: (v?: number) => S.setDue(t.id, v ?? null) },
    ...(t.due ? [{ label: '清除截止', action: () => S.setDue(t.id, null) }] : []),
    { sep: true },
    { label: '重复：每天', action: () => S.setRecur(t.id, 'daily') },
    { label: '重复：每周', action: () => S.setRecur(t.id, 'weekly') },
    { label: '重复：每月', action: () => S.setRecur(t.id, 'monthly') },
    ...(t.recur ? [{ label: '停止重复', action: () => S.setRecur(t.id, null) }] : []),
    { sep: true },
    { label: '删除', danger: true, action: () => setDeleteConfirmTask(t) },
  ], x, y)
}

// ---------------- 筛选 chips ----------------

const CHIP_DEFS: [Chip, string][] = [
  ['all', '全部'], ['todo', '待办'], ['done', '已完成'],
  ['today', '今天'], ['overdue', '逾期'], ['star', '星标'],
]

function Chips() {
  const counts = createMemo(() => {
    const list = S.tasks().filter((t) => t.list === currentList())
    return {
      all: list.length,
      todo: list.filter((t) => !t.d && !t.susp).length,
      done: list.filter((t) => t.d).length,
      today: list.filter(isToday).length,
      overdue: list.filter(isOverdue).length,
      star: list.filter((t) => t.star || t.pri === 1).length,
    } as Record<Chip, number>
  })
  return (
    <Show when={searchOpen()}>
      <div class="chips">
        <For each={CHIP_DEFS}>
          {([c, label]) => (
            <button class="chip" classList={{ on: chip() === c }} onClick={() => setChip(c)}>
              {label}
              <Show when={counts()[c]}><i class="chip-n">{counts()[c]}</i></Show>
            </button>
          )}
        </For>
      </div>
    </Show>
  )
}

// ---------------- 头部进度环 ----------------

function ProgressRing() {
  const pct = createMemo(() => {
    const today = startOfToday()
    const scope = view() === 'list'
      ? S.tasks().filter((t) => t.list === currentList())
      : S.tasks()
    const rel = (t: Task) => (t.doneAt ?? 0) >= today || (!t.d && t.due != null && t.due < today + 86400000)
    const all = scope.filter((t) => (t.d ? rel(t) : !t.susp && ((t.due != null && t.due < today + 86400000) || isOverdue(t))))
    if (!all.length) return null
    const done = all.filter((t) => t.d).length
    return { done, total: all.length, k: done / all.length }
  })
  return (
    <Show when={pct()}>
      <span class="ring" title={`今日进度 ${pct()!.done}/${pct()!.total}`}>
        <svg viewBox="0 0 20 20" width="16" height="16">
          <circle cx="10" cy="10" r="8" fill="none" stroke="var(--line-strong)" stroke-width="2.4" />
          <circle
            cx="10" cy="10" r="8" fill="none" stroke="var(--accent)" stroke-width="2.4"
            stroke-linecap="round" stroke-dasharray={`${pct()!.k * 50.3} 50.3`}
            transform="rotate(-90 10 10)"
            style="transition: stroke-dasharray .3s ease"
          />
          <text x="10" y="12.8" text-anchor="middle" font-size="7.5" font-weight="600" fill="var(--sub)">{pct()!.total}</text>
        </svg>
      </span>
    </Show>
  )
}

// ---------------- 拖拽排序 ----------------

function wireDrag(list: HTMLElement) {
  let dragEl: HTMLElement | null = null
  let startY = 0
  let downAt = 0
  let pending: HTMLElement | null = null
  let targetId: string | null = null
  let targetBelow = false
  let scrollRaf = 0

  const clearMarks = () =>
    list.querySelectorAll('.row').forEach((r) => r.classList.remove('drop-above', 'drop-below'))

  const autoScroll = () => {
    if (!dragEl) return
    const rect = list.getBoundingClientRect()
    const dRect = dragEl.getBoundingClientRect()
    const edge = 48
    if (dRect.top - rect.top < edge && list.scrollTop > 0) list.scrollTop -= 12
    else if (rect.bottom - dRect.bottom < edge && list.scrollTop < list.scrollHeight - list.clientHeight) list.scrollTop += 12
    scrollRaf = requestAnimationFrame(autoScroll)
  }
  const stopScroll = () => cancelAnimationFrame(scrollRaf)

  const onMove = (e: PointerEvent) => {
    if (!dragEl) {
      if (!pending || Math.abs(e.clientY - startY) <= 6 || Date.now() - downAt < 80) return
      dragEl = pending
      dragEl.classList.add('dragging')
      stopScroll()
      scrollRaf = requestAnimationFrame(autoScroll)
    }
    dragEl!.style.transform = `translateY(${e.clientY - startY}px)`
    clearMarks()
    const rect = dragEl!.getBoundingClientRect()
    const cy = rect.top + rect.height / 2
    targetId = null
    for (const r of [...list.querySelectorAll<HTMLElement>('.row')]) {
      if (r === dragEl) continue
      const rr = r.getBoundingClientRect()
      if (cy >= rr.top && cy <= rr.bottom) {
        targetBelow = cy > rr.top + rr.height / 2
        r.classList.add(targetBelow ? 'drop-below' : 'drop-above')
        targetId = r.dataset.id!
      }
    }
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    stopScroll()
    if (dragEl) {
      dragEl.classList.remove('dragging')
      dragEl.style.transform = ''
      clearMarks()
      const id = dragEl.dataset.id!
      let tid: string | null = targetId
      if (tid && targetBelow) {
        const rows = [...list.querySelectorAll<HTMLElement>('.row')]
        const i = rows.findIndex((r) => r.dataset.id === tid)
        tid = rows[i + 1]?.dataset.id ?? null
      }
      if (tid !== id) S.moveTask(id, tid)
    }
    dragEl = null
    pending = null
  }
  list.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    const tgt = e.target instanceof Element ? e.target : null
    const r = tgt?.closest<HTMLElement>('.row')
    if (!r || tgt?.closest('button, input, textarea, .tag, .due')) return
    pending = r
    startY = e.clientY
    downAt = Date.now()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  })
  onCleanup(() => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    stopScroll()
  })
}

// ---------------- 历史日历面板 ----------------

function dayStartOf(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function historySelLabel(): string {
  const sel = historySel()
  if (sel == null) return '历史完成'
  const today = startOfToday()
  if (sel === today) return '今天'
  if (sel === today - 86400000) return '昨天'
  const d = new Date(sel)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function deleteHistoryDay() {
  const sel = historySel()
  if (sel == null) return
  const e = sel + 86400000
  const before = S.tasks().length
  const next = S.tasks().filter((t) => !(t.d && t.doneAt != null && t.doneAt >= sel && t.doneAt < e))
  if (next.length !== before) {
    S.replaceAll(next)
    toast(`已清理 ${historySelLabel()} 的完成记录`, '清理记录')
  }
}

function HistoryPanel() {
  // 进入历史视图时若未选日期，默认选中今天（或当前月）
  onMount(() => {
    const now = new Date()
    if (historySel() == null) setHistorySel(startOfToday())
    if (historyMonth() == null) setHistoryMonth({ y: now.getFullYear(), m: now.getMonth() })
  })

  const ym = () => {
    const cur = historyMonth()
    if (cur) return cur
    const now = new Date()
    return { y: now.getFullYear(), m: now.getMonth() }
  }

  /** 按当日 0 点时间戳聚合当月（及全量）已完成数量 */
  const countByDay = createMemo(() => {
    const map = new Map<number, number>()
    for (const t of S.tasks()) {
      if (!t.d || t.doneAt == null) continue
      const k = dayStartOf(t.doneAt)
      map.set(k, (map.get(k) ?? 0) + 1)
    }
    return map
  })

  const cells = createMemo(() => {
    const { y, m } = ym()
    const first = new Date(y, m, 1)
    // 周一为一周之首：0..6
    const offset = (first.getDay() + 6) % 7
    const daysInMonth = new Date(y, m + 1, 0).getDate()
    const out: ({ day: number; ts: number; cnt: number } | null)[] = []
    for (let i = 0; i < offset; i++) out.push(null)
    const map = countByDay()
    for (let d = 1; d <= daysInMonth; d++) {
      const ts = new Date(y, m, d).getTime()
      out.push({ day: d, ts, cnt: map.get(ts) ?? 0 })
    }
    return out
  })

  const monthTotal = createMemo(() => cells().reduce((a, c) => a + (c?.cnt ?? 0), 0))

  const stepMonth = (delta: number) => {
    const { y, m } = ym()
    const d = new Date(y, m + delta, 1)
    setHistoryMonth({ y: d.getFullYear(), m: d.getMonth() })
  }
  const jumpToday = () => {
    const now = new Date()
    setHistoryMonth({ y: now.getFullYear(), m: now.getMonth() })
    setHistorySel(startOfToday())
  }

  const todayTs = startOfToday()

  return (
    <div class="cal-card">
      <div class="cal-head">
        <button class="ib cal-nav" title="上个月" onClick={() => stepMonth(-1)} innerHTML={SVG.chevL} />
        <span class="cal-title">{ym().y}年 {ym().m + 1}月</span>
        <span class="cal-sum">完成 {monthTotal()}</span>
        <button class="cal-today" onClick={jumpToday} title="回到今天">今天</button>
        <button
          class="ib cal-export"
          title="导出完成清单"
          onClick={(e) => {
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            popupMenu([
              { label: `导出 ${historySelLabel()} 完成清单`, action: () => A.onExportHistory('day') },
              { label: `导出 ${ym().m + 1}月 完成月报`, action: () => A.onExportHistory('month') },
              { label: '导出 全部历史完成汇总', action: () => A.onExportHistory('all') },
            ], r.right, r.bottom + 4)
          }}
          innerHTML={SVG.exportIco}
        />
        <button class="ib cal-nav" title="下个月" onClick={() => stepMonth(1)} innerHTML={SVG.chevR} />
      </div>
      <div class="cal-wk">
        <span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span>
      </div>
      <div class="cal-grid">
        <For each={cells()}>
          {(c) => (
            <Show when={c} fallback={<span class="cal-pad" />}>
              <button
                class="cal-day"
                classList={{
                  today: c!.ts === todayTs,
                  sel: historySel() === c!.ts,
                  has: c!.cnt > 0,
                }}
                onClick={() => setHistorySel(c!.ts)}
              >
                <span class="cal-num">{c!.day}</span>
                <Show when={c!.cnt > 0}>
                  <span class="cal-cnt">{c!.cnt > 9 ? '9+' : c!.cnt}</span>
                </Show>
              </button>
            </Show>
          )}
        </For>
      </div>
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const timeStr = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (sameDay) return `今天 ${timeStr}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${timeStr}`
}

function ProgModal(props: { task: Task; onClose(): void }) {
  let inputEl!: HTMLInputElement
  const liveTask = createMemo(() => S.tasks().find((x) => x.id === props.task.id) ?? props.task)
  const logs = createMemo(() => {
    const cur = liveTask()
    if (cur.progLogs && cur.progLogs.length > 0) return cur.progLogs
    if (cur.prog) {
      return [{ id: 'init', text: cur.prog, time: cur.createdAt || Date.now() }]
    }
    return []
  })

  onMount(() => {
    queueMicrotask(() => inputEl?.focus())
  })

  const commit = () => {
    const val = inputEl.value.trim()
    if (!val) return
    S.addProgLog(props.task.id, val)
    inputEl.value = ''
    toast('已记录当前进度', '记录进度')
  }

  return (
    <div class="prog-modal-overlay" onClick={() => props.onClose()}>
      <div class="prog-modal-card" onClick={(e) => e.stopPropagation()}>
        <div class="prog-modal-head">
          <div class="prog-modal-title">
            <span class="prog-modal-badge" innerHTML={SVG.prog} />
            <span class="prog-modal-h">进度历程</span>
          </div>
          <button class="ib" title="关闭 (Esc)" onClick={() => props.onClose()} innerHTML={SVG.close} />
        </div>
        <div class="prog-modal-task-title">{liveTask().t}</div>

        <div class="prog-input-box">
          <input
            ref={inputEl}
            type="text"
            class="prog-modal-input"
            placeholder="记录此时此刻的进展，回车保存…"
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') props.onClose()
            }}
          />
          <button class="prog-modal-btn" onClick={commit}>打卡记录</button>
        </div>

        <div class="prog-timeline-wrap">
          <Show
            when={logs().length > 0}
            fallback={<div class="prog-timeline-empty">暂无进度打卡，在上方记录第一条进展吧</div>}
          >
            <div class="prog-timeline">
              <For each={logs()}>
                {(log, i) => (
                  <div class="prog-log-item" classList={{ latest: i() === 0 }}>
                    <div class="prog-log-line" />
                    <div class="prog-log-dot" />
                    <div class="prog-log-content">
                      <div class="prog-log-meta">
                        <span class="prog-log-time">{formatTime(log.time)}</span>
                        <Show when={i() === 0}>
                          <span class="prog-log-tag">最新</span>
                        </Show>
                        <button
                          class="prog-log-del"
                          title="删除此条记录"
                          onClick={() => S.deleteProgLog(props.task.id, log.id)}
                          innerHTML={SVG.close}
                        />
                      </div>
                      <div class="prog-log-text">{log.text}</div>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </div>

        <div class="prog-modal-foot">
          <Show when={logs().length > 0}>
            <button
              class="prog-clear-all"
              onClick={() => {
                S.clearProgLogs(props.task.id)
                toast('已清除全部进度记录', '清除进度')
              }}
            >
              清空进度历程
            </button>
          </Show>
          <span class="prog-foot-hint">Esc 或点击遮罩退出</span>
        </div>
      </div>
    </div>
  )
}

function TagModal(props: { task: Task; onClose(): void }) {
  let inputEl!: HTMLInputElement
  const liveTask = createMemo(() => S.tasks().find((x) => x.id === props.task.id) ?? props.task)
  const taskTags = createMemo(() => liveTask().tags || [])
  const otherTags = createMemo(() => {
    const cur = new Set(taskTags())
    return S.getAllTags().filter((t) => !cur.has(t))
  })

  onMount(() => {
    queueMicrotask(() => inputEl?.focus())
  })

  const doAdd = () => {
    const val = inputEl.value.trim()
    if (!val) return
    S.addTag(props.task.id, val)
    inputEl.value = ''
  }

  return (
    <div class="tag-modal-overlay" onClick={() => props.onClose()}>
      <div class="tag-modal-card" onClick={(e) => e.stopPropagation()}>
        <div class="tag-modal-head">
          <div class="tag-modal-title">
            <span class="tag-modal-badge" innerHTML={SVG.tagIcon} />
            <span class="tag-modal-h">设置标签</span>
          </div>
          <button class="ib" title="关闭 (Esc)" onClick={() => props.onClose()} innerHTML={SVG.close} />
        </div>
        <div class="tag-modal-task-title">{liveTask().t}</div>

        <div class="tag-input-box">
          <input
            ref={inputEl}
            type="text"
            class="tag-modal-input"
            placeholder="输入标签名（回车添加，如 #工作、#紧急）…"
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') doAdd()
              if (e.key === 'Escape') props.onClose()
            }}
          />
          <button class="tag-modal-btn" onClick={doAdd}>添加</button>
        </div>

        <div class="tag-section">
          <div class="tag-section-title">当前标签</div>
          <div class="tag-chip-list">
            <Show
              when={taskTags().length > 0}
              fallback={<span class="tag-empty-hint">暂未添加任何标签</span>}
            >
              <For each={taskTags()}>
                {(tag) => (
                  <span class="tag-chip current">
                    <span class="tag-chip-txt">{tag}</span>
                    <button
                      class="tag-chip-del"
                      title="移除此标签"
                      onClick={() => S.removeTag(props.task.id, tag)}
                      innerHTML={SVG.close}
                    />
                  </span>
                )}
              </For>
            </Show>
          </div>
        </div>

        <Show when={otherTags().length > 0}>
          <div class="tag-section">
            <div class="tag-section-title">已有标签（点击直接添加）</div>
            <div class="tag-chip-list">
              <For each={otherTags()}>
                {(tag) => (
                  <button
                    class="tag-chip candidate"
                    title="点击为此任务添加此标签"
                    onClick={() => S.addTag(props.task.id, tag)}
                  >
                    <span class="tag-chip-plus">+</span>
                    <span>{tag}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <div class="tag-modal-foot">
          <span class="tag-foot-hint">Esc 或点击遮罩退出</span>
          <button class="tag-done-btn" onClick={() => props.onClose()}>完成</button>
        </div>
      </div>
    </div>
  )
}

/** 删除确认：防误删，确认后仍可从底部「撤销」恢复 */
function DeleteModal(props: { task: Task; onClose(): void }) {
  const liveTask = createMemo(() => S.tasks().find((x) => x.id === props.task.id) ?? props.task)
  let delBtn!: HTMLButtonElement

  const confirm = () => {
    const trashId = S.deleteTask(props.task.id)
    if (trashId) {
      toast('已移入回收站', undefined, [{ label: '撤销', onClick: () => S.restoreTrash(trashId) }])
    }
    props.onClose()
  }

  onMount(() => {
    queueMicrotask(() => delBtn?.focus())
    // 捕获阶段拦截 Esc：优先关闭确认框，避免触发全局「收进侧边栏」
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation()
        e.preventDefault()
        props.onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    onCleanup(() => window.removeEventListener('keydown', onKey, true))
  })

  return (
    <div class="confirm-overlay" onClick={() => props.onClose()}>
      <div class="confirm-card" onClick={(e) => e.stopPropagation()}>
        <div class="confirm-title">删除这条事项？</div>
        <div class="confirm-task">{liveTask().t}</div>
        <div class="confirm-hint">删除后先放入回收站，可从底部「撤销」或回收站找回</div>
        <div class="confirm-acts">
          <button class="confirm-cancel" onClick={() => props.onClose()}>取消</button>
          <button ref={delBtn} class="confirm-del" onClick={confirm}>删除</button>
        </div>
      </div>
    </div>
  )
}

// ---------------- 回收站 ----------------

function formatTrashTime(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (d.toDateString() === now.toDateString()) return `今天 ${hm}`
  const y = new Date(now)
  y.setDate(y.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return `昨天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/** 打开回收站（顺带按当前规则清理过期条目） */
export function openTrash() {
  const days = typeof S.settings().trashDays === 'number' ? S.settings().trashDays : S.DEFAULT_TRASH_DAYS
  S.purgeExpiredTrash(days)
  setTrashOpen(true)
}

function TrashPanel() {
  const [confirmClear, setConfirmClear] = createSignal(false)
  let clearTimer = 0
  const days = () => (typeof S.settings().trashDays === 'number' ? S.settings().trashDays : S.DEFAULT_TRASH_DAYS)

  const setRule = (n: number) => {
    S.patchSettings({ trashDays: n })
    const removed = S.purgeExpiredTrash(n)
    toast(n === 0 ? '已关闭自动清理' : `已设为保留 ${n} 天${removed ? `，清理了 ${removed} 条` : ''}`)
  }

  const onClear = () => {
    if (!confirmClear()) {
      setConfirmClear(true)
      clearTimeout(clearTimer)
      clearTimer = window.setTimeout(() => setConfirmClear(false), 3000)
      return
    }
    clearTimeout(clearTimer)
    setConfirmClear(false)
    S.clearTrash()
    toast('回收站已清空')
  }
  onCleanup(() => clearTimeout(clearTimer))

  return (
    <div class="trash-overlay" onClick={() => setTrashOpen(false)}>
      <div class="trash-card" onClick={(e) => e.stopPropagation()}>
        <div class="trash-head">
          <div class="trash-title">
            <span class="trash-title-ico" innerHTML={SVG.trash} />
            回收站
          </div>
          <button class="ib" title="关闭 (Esc)" onClick={() => setTrashOpen(false)} innerHTML={SVG.close} />
        </div>

        <div class="trash-rule">
          <span class="trash-rule-label">自动清理</span>
          <div class="trash-rule-opts">
            <For each={[7, 30, 90, 0]}>
              {(n) => (
                <button class="trash-rule-opt" classList={{ on: days() === n }} onClick={() => setRule(n)}>
                  {n === 0 ? '永不' : `${n}天`}
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="trash-list">
          <Show
            when={S.trash().length > 0}
            fallback={<div class="trash-empty">回收站是空的</div>}
          >
            <For each={S.trash()}>
              {(it) => (
                <div class="trash-item">
                  <div class="trash-item-main">
                    <div class="trash-item-title">{it.task.t}</div>
                    <div class="trash-item-meta">
                      {it.task.list} · {formatTrashTime(it.deletedAt)} 删除
                    </div>
                  </div>
                  <div class="trash-item-acts">
                    <button
                      class="trash-restore"
                      title="恢复到原清单"
                      onClick={() => {
                        S.restoreTrash(it.id)
                        toast('已恢复到清单')
                      }}
                    >
                      恢复
                    </button>
                    <button
                      class="trash-purge"
                      title="彻底删除（不可恢复）"
                      onClick={() => {
                        S.purgeTrashItem(it.id)
                        toast('已彻底删除')
                      }}
                      innerHTML={SVG.close}
                    />
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>

        <div class="trash-foot">
          <button class="trash-clear" classList={{ armed: confirmClear() }} onClick={onClear}>
            {confirmClear() ? '再点一次确认清空' : '清空回收站'}
          </button>
          <span class="trash-hint">恢复后回到原清单</span>
        </div>
      </div>
    </div>
  )
}

// ---------------- 主界面 ----------------

export function MainApp() {
  let listEl!: HTMLDivElement
  let searchInput: HTMLInputElement | undefined
  let newInputEl: HTMLInputElement | undefined
  let scratchEl: HTMLTextAreaElement | undefined
  let scratchTimer = 0

  onMount(() => {
    wireDrag(listEl)
    setTimeout(() => newInputEl?.focus(), 80)
  })

  createEffect(() => {
    if (view() !== 'note') { clearTimeout(scratchTimer); return }
    ;(async () => {
      try {
        const content = await invoke<string>('load_scratchpad')
        if (scratchEl && document.activeElement !== scratchEl) {
          scratchEl.value = content
        }
      } catch { /* ignore */ }
      queueMicrotask(() => scratchEl?.focus())
    })()
  })
  const flushScratch = () => {
    clearTimeout(scratchTimer)
    if (scratchEl) {
      invoke('save_scratchpad', { content: scratchEl.value }).catch(() => {})
    }
  }
  const onScratchInput = () => {
    clearTimeout(scratchTimer)
    scratchTimer = window.setTimeout(flushScratch, 600)
  }

  /** 将随手记选中文本或非空行直接转为待办并归入当前清单 */
  const convertScratchToTodos = () => {
    if (!scratchEl) return
    const start = scratchEl.selectionStart
    const end = scratchEl.selectionEnd
    const hasSel = start !== end
    const chunk = hasSel ? scratchEl.value.slice(start, end) : scratchEl.value
    const lines = chunk.split(/\r?\n/).map((l) => l.replace(/^[-*•\s]*(\[\s*\]\s*)?/, '').trim()).filter(Boolean)
    if (!lines.length) { toast('随手记里没有可转换的文字'); return }
    const batch = lines
      .map((line) => parseInput(line))
      .filter((p) => p.text)
      .map((p) => ({
        t: p.text, d: false, list: p.list ?? currentList(), tags: p.tags,
        pri: p.pri, due: p.due, recur: p.recur,
      }))
    if (!batch.length) return
    S.addTasksBatch(batch)
    if (hasSel) {
      scratchEl.value = (scratchEl.value.slice(0, start) + scratchEl.value.slice(end)).replace(/\n{3,}/g, '\n\n')
    } else {
      scratchEl.value = ''
    }
    flushScratch()
    setView('list')
    toast(`已转入 ${batch.length} 条待办`, '转入待办')
  }

  createEffect(() => {
    const id = selId()
    if (!id) return
    const active = document.activeElement
    if (active && active.matches('input, textarea')) return
    listEl.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
  })

  const toggleSearch = (force?: boolean) => {
    const next = force ?? !searchOpen()
    setSearchOpen(next)
    setChip('all')
    if (next) queueMicrotask(() => searchInput?.focus())
    else { setQuery(''); if (searchInput) searchInput.value = '' }
  }
  exportSearchToggle = toggleSearch

  const footStats = createMemo(() => {
    // 只统计「当前清单里可见」的事项：次日归档的完成项不计入，保证与列表行数一致
    const today = startOfToday()
    const list = S.tasks().filter((t) => t.list === currentList() && !S.isStaleDone(t, today))
    const done = list.filter((t) => t.d).length
    const susp = list.filter((t) => !t.d && t.susp).length
    return { total: list.length, done, susp, pending: list.length - done - susp }
  })

  const headPending = createMemo(() => S.tasks().filter((t) => t.list === currentList() && !t.d && !t.susp).length)

  const headTitle = createMemo(() => {
    if (view() === 'history') return '历史'
    if (view() === 'note') return '随手记'
    return currentList()
  })

  const emptyText = createMemo(() => {
    if (view() === 'history') return { e1: '该日没有完成记录', e2: '在月历上选择其他日期查看' }
    return footStats().total
      ? { e1: '没有匹配的任务', e2: '换个关键词或筛选条件试试' }
      : { e1: '清单还是空的', e2: '在上方输入内容，回车即可保存；支持粘贴多行' }
  })

  /** 按时间分组计算各组的任务 ID 列表（挂起任务单独归入「挂起」组）。
   *  返回稳定的字符串数组：外层 <For> 直接迭代常量 LIST_GROUPS（分组容器只挂载一次），
   *  内层 <For> 以任务 id（原始字符串）做键复用 DOM —— 编辑备注时行节点不被重建，焦点不丢失。 */
  const tasksByGroup = createMemo<Record<ListGroupKey, string[]>>(() => {
    const buckets: Record<ListGroupKey, string[]> = {
      today: [],
      week: [],
      month: [],
      continuous: [],
      parked: [],
    }
    for (const t of visibleTasks()) {
      if (t.susp) {
        buckets.parked.push(t.id)
      } else {
        buckets[getTimeGroupKey(t.due)].push(t.id)
      }
    }
    return buckets
  })

  /** 各分组是否渲染：搜索/筛选时只显示有内容的组；普通清单视图下「今天」始终展示 */
  const shouldRenderGroup = createMemo<Record<ListGroupKey, boolean>>(() => {
    const q = query().trim()
    const c = chip()
    const isFiltering = !!q || c !== 'all'
    const totalInList = footStats().total
    const counts = tasksByGroup()
    const out = {} as Record<ListGroupKey, boolean>
    for (const g of LIST_GROUPS) {
      const n = counts[g.key].length
      if (g.key === 'parked') {
        // 挂起组只在有挂起任务时出现
        out[g.key] = n > 0
      } else {
        out[g.key] = isFiltering ? n > 0 : totalInList > 0 && (g.key === 'today' || n > 0)
      }
    }
    return out
  })

  return (
    <>
      <div class="card">
        {/* 第一层：清单选择 + 窗口操作 */}
        <header class="head" data-tauri-drag-region>
          <button
            class="list-btn"
            title="切换清单 / 视图"
            onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); A.onListMenu(r.left, r.bottom + 4) }}
          >
            <span class="list-name">{headTitle()}</span>
            <Show when={headPending()}>
              <span class="list-count">{headPending()}</span>
            </Show>
            <i class="chev" innerHTML={SVG.chevron} />
          </button>
          <ProgressRing />
          <div class="head-acts">
            <button class="ib" classList={{ on: searchOpen() }} title="搜索 ( / )" onClick={() => toggleSearch()} innerHTML={SVG.search} />
            <button class="ib" title="菜单与设置" onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); A.onMenu(r.right, r.bottom + 4) }} innerHTML={SVG.dots} />
            <button class="ib" title="收进侧边栏 (Esc)" onClick={() => A.onCollapse()} innerHTML={SVG.minus} />
            <button class="ib" classList={{ on: S.settings().topmost !== false }} title="窗口置顶" onClick={() => A.onPin()} innerHTML={SVG.pin} />
            <button
              class="ib"
              title="退出或收进侧边栏"
              onClick={(e) => {
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                popupMenu([
                  { label: '收进侧边栏（保留运行）', action: () => W.hideToEdge(W.currentSide()) },
                  { label: '退出 PinTodo', danger: true, action: () => invoke('quit') },
                ], r.right, r.bottom + 4)
              }}
              innerHTML={SVG.close}
            />
          </div>
        </header>

        {/* 第二层：分段视图切换栏（干净、对称、无 Emoji 参差） */}
        <nav class="seg-tabs">
          <button class="seg" classList={{ on: view() === 'list' }} onClick={() => setView('list')}>
            <span class="seg-ico" innerHTML={SVG.list} />
            <span>清单</span>
          </button>
          <button class="seg" classList={{ on: view() === 'note' }} onClick={() => setView('note')}>
            <span class="seg-ico" innerHTML={SVG.notePad} />
            <span>随手记</span>
          </button>
          <button class="seg" classList={{ on: view() === 'history' }} onClick={() => setView('history')}>
            <span class="seg-ico" innerHTML={SVG.cal} />
            <span>历史</span>
          </button>
        </nav>

        <div class="body-wrap">
          <div class="body-inner">
            <Show when={searchOpen() && view() === 'list'}>
              <div class="searchbar">
                <span class="s-ico" innerHTML={SVG.search} />
                <input
                  ref={searchInput}
                  type="text"
                  value={query()}
                  placeholder="搜索标题、描述或 #标签…"
                  onInput={(e) => setQuery(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Escape') toggleSearch(false)
                    if (e.key === 'Enter') newInputEl?.focus()
                  }}
                />
                <button class="ib s-clear" title="清空" onClick={() => { setQuery(''); if (searchInput) searchInput.value = '' }} innerHTML={SVG.close} />
              </div>
            </Show>
            <Show when={view() === 'list'}><Chips /></Show>
            <Show when={view() === 'list'}>
              <InputRow ref={(el) => (newInputEl = el)} />
            </Show>

            <Show when={view() === 'note'}>
              <div class="note-panel">
                <textarea
                  ref={scratchEl}
                  class="scratch"
                  placeholder="随时记录灵光、临时笔记、会议要点…&#10;选中部分行（或直接全部），点右下角「转为待办」即可拆分成任务。"
                  onInput={onScratchInput}
                  onBlur={flushScratch}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Escape') {
                      flushScratch()
                      setView('list')
                    }
                  }}
                />
                <div class="note-foot">
                  <span>自动保存 · Esc 返回清单</span>
                  <button class="note-convert" onClick={convertScratchToTodos} title="将选中文字（未选则全部）每行拆成一条待办">
                    <span innerHTML={SVG.sparkles} /> 转为待办
                  </button>
                </div>
              </div>
            </Show>

            <Show when={view() === 'history'}>
              <HistoryPanel />
            </Show>

            <div class="list-wrap">
              <div class="list" ref={listEl}>
                <Show
                  when={view() === 'list'}
                  fallback={<For each={visibleIds()}>{(id) => <TaskRow id={id} />}</For>}
                >
                  <For each={LIST_GROUPS}>
                    {(g) => (
                      <Show when={shouldRenderGroup()[g.key]}>
                        <div class="time-group" data-group={g.key}>
                          <div
                            class="time-group-head"
                            classList={{ collapsed: !!collapsedGroups()[g.key] }}
                            onClick={() => toggleTimeGroup(g.key)}
                          >
                            <span class="time-group-chev" innerHTML={SVG.chevron} />
                            <span class="time-group-title">{g.label}</span>
                            <span class="time-group-badge" classList={{ zero: tasksByGroup()[g.key].length === 0 }}>
                              {tasksByGroup()[g.key].length}
                            </span>
                          </div>
                          <Show when={!collapsedGroups()[g.key]}>
                            <div class="time-group-items">
                              <For each={tasksByGroup()[g.key]}>
                                {(id) => <TaskRow id={id} />}
                              </For>
                              <Show when={g.key === 'today' && tasksByGroup()[g.key].length === 0}>
                                <div class="time-group-empty">今天暂无待办</div>
                              </Show>
                            </div>
                          </Show>
                        </div>
                      </Show>
                    )}
                  </For>
                </Show>
              </div>
              <Show when={!visibleIds().length && view() !== 'note'}>
                <div class="empty">
                  <div class="empty-art" innerHTML={SVG.emptyCheck} />
                  <div class="e1">{emptyText().e1}</div>
                  <div class="e2">{emptyText().e2}</div>
                </div>
              </Show>
            </div>

            <footer class="foot">
              <span class="foot-stat">
                {view() === 'history'
                  ? `${historySelLabel()} · 完成 ${visibleIds().length} 项`
                  : `共 ${footStats().total} 项 · 待办 ${footStats().pending}${footStats().susp ? ` · 挂起 ${footStats().susp}` : ''}${footStats().done ? ` · 已完成 ${footStats().done}` : ''}`}
              </span>
              <span class="foot-right">
                <Show when={view() === 'history'}>
                  <button
                    class="clear-done"
                    title="导出历史完成清单"
                    onClick={(e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                      popupMenu([
                        { label: `导出 ${historySelLabel()} 清单`, action: () => A.onExportHistory('day') },
                        { label: `导出 当月完成月报`, action: () => A.onExportHistory('month') },
                        { label: `导出 全部历史完成`, action: () => A.onExportHistory('all') },
                      ], r.right, r.top - 6)
                    }}
                  >
                    导出清单
                  </button>
                </Show>
                <Show when={view() === 'history' && historySel()}>
                  <button
                    class="clear-done danger-btn"
                    title="删除该日的完成记录（数据删除，不可撤销）"
                    onClick={deleteHistoryDay}
                  >
                    删除该日记录
                  </button>
                </Show>
                <button class="ib foot-trash" title="回收站" onClick={() => openTrash()} innerHTML={SVG.trash} />
                <button class="ib foot-help" title="快捷键与语法说明 ( ? )" onClick={() => setHelpOpen(true)} innerHTML={SVG.help} />
                <span class="grip" title="拖动调整大小" innerHTML={SVG.grip} />
              </span>
            </footer>
          </div>

          {/* 快捷键与录入语法帮助浮层 */}
          <Show when={helpOpen()}>
            <div class="help-panel" onClick={() => setHelpOpen(false)}>
              <div class="help-card" onClick={(e) => e.stopPropagation()}>
                <div class="stats-head">
                  <span>操作与语法指南</span>
                  <button class="ib" onClick={() => setHelpOpen(false)} innerHTML={SVG.close} />
                </div>
                <div class="help-sec">
                  <div class="help-h">快速录入语法</div>
                  <div class="help-row"><code>!1</code> <code>!2</code> <code>!3</code><span>高 / 中 / 低 重要度</span></div>
                  <div class="help-row"><code>#标签</code> <code>@清单</code><span>自动归类与打标</span></div>
                  <div class="help-row"><code>明天18:00</code> <code>周五</code> <code>月底</code> <code>这个月底</code><span>智能识别截止日期</span></div>
                  <div class="help-row"><code>每天8:30</code> <code>每周三18点</code><span>重复任务（完成自动续期）</span></div>
                  <div class="help-row"><span>粘贴多行文本</span><span>批量拆分为多条待办</span></div>
                </div>
                <div class="help-sec">
                  <div class="help-h">常用操作</div>
                  <div class="help-row"><code>Ctrl+Alt+Space</code><span>显隐 / 收进侧边</span></div>
                  <div class="help-row"><code>Ctrl+Alt+A</code><span>全局快速添加</span></div>
                  <div class="help-row"><code>单击 / 再单击</code><span>选中 / 展开描述编辑</span></div>
                  <div class="help-row"><code>双击</code><span>行内编辑标题</span></div>
                  <div class="help-row"><code>/</code> <code>Ctrl+Z</code> <code>Esc</code><span>搜索 / 撤销 / 收起</span></div>
                </div>
              </div>
            </div>
          </Show>
          {/* 进度弹窗：时间轴历程展示与新增记录 */}
          <Show when={progModalTask()}>
            <ProgModal task={progModalTask()!} onClose={() => setProgModalTask(null)} />
          </Show>
          {/* 事项标签管理弹窗 */}
          <Show when={tagModalTask()}>
            <TagModal task={tagModalTask()!} onClose={() => setTagModalTask(null)} />
          </Show>
          {/* 删除确认弹窗 */}
          <Show when={deleteConfirmTask()}>
            <DeleteModal task={deleteConfirmTask()!} onClose={() => setDeleteConfirmTask(null)} />
          </Show>
          {/* 回收站面板 */}
          <Show when={trashOpen()}>
            <TrashPanel />
          </Show>
        </div>

        <Show when={toastMsg()}>
          <div class="toast show">
            <span>{toastMsg()!.msg}</span>
            <Show when={toastMsg()!.undo && S.canUndo()}>
              <button class="toast-undo" onClick={() => { S.undo(); setToastMsg(null) }}>
                撤销 {toastMsg()!.undo}
              </button>
            </Show>
            <Show when={toastMsg()!.actions?.length}>
              <div class="toast-acts">
                <For each={toastMsg()!.actions}>
                  {(act) => (
                    <button
                      class="toast-undo"
                      classList={{ danger: !!act.danger }}
                      onClick={() => { act.onClick(); setToastMsg(null) }}
                    >
                      {act.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </Show>
      </div>
      <TabOverlay />
    </>
  )
}

// ---------------- 贴片模式（支持拖动调整上下停靠高度 + 点击唤回） ----------------

function TabOverlay() {
  const [on, setOn] = createSignal(document.body.dataset.mode === 'tab')
  const [sleep, setSleep] = createSignal(document.body.dataset.suspended === '1')
  const [pop, setPop] = createSignal(false)
  let popTimer = 0

  onMount(() => {
    const mo = new MutationObserver(() => {
      setOn(document.body.dataset.mode === 'tab')
      setSleep(document.body.dataset.suspended === '1')
    })
    mo.observe(document.body, { attributes: true, attributeFilter: ['data-mode', 'data-suspended'] })
    onCleanup(() => mo.disconnect())
  })

  const count = createMemo(() => S.tasks().filter((t) => !t.d).length)
  // 待办数变化时触发弹跳动画
  createEffect(() => {
    count()
    setPop(true)
    clearTimeout(popTimer)
    popTimer = window.setTimeout(() => setPop(false), 450)
  })
  onCleanup(() => clearTimeout(popTimer))

  return (
    <Show when={on()}>
      <div class="tab-wrap" classList={{ sleeping: sleep() }}>
        <div
          class="tab"
          title={sleep() ? '已挂起 · 单击回到待办' : '点击回到待办 · 拖动可调整上下位置'}
          onPointerDown={(e) => {
            if (e.button === 0) {
              e.preventDefault()
              W.startPillDrag(e)
            }
          }}
        >
          <Show when={sleep()}>
            <span class="zzz" aria-hidden="true">z<span>z</span></span>
          </Show>
          <div class="pill" classList={{ pop: pop(), happy: count() === 0, sleeping: sleep() }}>
            <div class="pill-glow" />
            <span class="eye eye-l" />
            <span class="eye eye-r" />
            <span class="smile" />
          </div>
          <div class="tab-label" classList={{ zero: count() === 0 }}>
            {count() === 0 ? '✓' : count()}
          </div>
        </div>
      </div>
    </Show>
  )
}

export let exportSearchToggle: (force?: boolean) => void = () => {}
export function getVisible() {
  return visibleTasks()
}
export function focusNewInput() {
  document.querySelector<HTMLInputElement>('.new-input')?.focus()
}
