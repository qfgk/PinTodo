import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  setAll, tasks, trash, deleteTask, restoreTrash, purgeTrashItem,
  clearTrash, purgeExpiredTrash, DEFAULT_TRASH_DAYS,
} from './state'
import type { Task } from './types'

const DAY = 86400000
const T0 = new Date('2026-11-01T10:00:00').getTime()

const mk = (id: string, over: Partial<Task> = {}): Task => ({
  id, t: id + '事项', d: false, list: '默认', tags: [], pri: 0, star: false,
  due: null, recur: null, notes: null, createdAt: 1, doneAt: null,
  ...over,
})

describe('回收站', () => {
  beforeEach(() => {
    clearTrash()
    setAll([], {})
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => vi.useRealTimers())

  it('删除进入回收站、恢复回到清单', () => {
    setAll([mk('x'), mk('y')], {})
    const tid = deleteTask('x')!
    expect(tid).toBeTruthy()
    expect(tasks().map((t) => t.id)).toEqual(['y'])
    expect(trash().length).toBe(1)
    expect(trash()[0].task.id).toBe('x')

    expect(restoreTrash(tid)).toBe(true)
    expect(tasks().map((t) => t.id)).toContain('x')
    expect(trash().length).toBe(0)
  })

  it('默认保留天数与「永不清理」语义', () => {
    expect(DEFAULT_TRASH_DAYS).toBe(30)
    setAll([mk('a')], {})
    deleteTask('a')
    expect(purgeExpiredTrash(0)).toBe(0) // 0 = 永不清理
    expect(trash().length).toBe(1)
  })

  it('自动清理：只删除超过保留天数的条目', () => {
    setAll([mk('a'), mk('b'), mk('c')], {})
    deleteTask('a') // T0
    vi.setSystemTime(T0 + 10 * DAY)
    deleteTask('b') // T0 + 10天
    vi.setSystemTime(T0 + 40 * DAY)
    deleteTask('c') // T0 + 40天（当前时间）

    // 保留 30 天 → 截止 = 当前 - 30 天 = T0+10天；a 过期，b/c 保留
    expect(purgeExpiredTrash(30)).toBe(1)
    expect(trash().map((x) => x.task.id)).toEqual(['c', 'b'])

    // 再次清理无更多过期项
    expect(purgeExpiredTrash(30)).toBe(0)
  })

  it('彻底删除单条与清空回收站', () => {
    setAll([mk('a'), mk('b')], {})
    const a = deleteTask('a')!
    deleteTask('b')
    expect(trash().length).toBe(2)

    purgeTrashItem(a)
    expect(trash().length).toBe(1)
    expect(trash()[0].task.id).toBe('b')

    clearTrash()
    expect(trash().length).toBe(0)
  })
})
