import { describe, it, expect } from 'vitest'
import { parseInput, extractDue, dueLabel, getTimeGroupKey } from './parse'
import {
  sortTaskList, isStaleDone, addProgLog, deleteProgLog, clearProgLogs,
  setAll, tasks, setTags, addTag, removeTag, getAllTags, setSusp,
} from './state'
import type { Task } from './types'

const DAY = 86400000

describe('parseInput', () => {
  it('提取 #标签 与 @清单', () => {
    const p = parseInput('买牛奶 #生活 @购物清单')
    expect(p.text).toBe('买牛奶')
    expect(p.tags).toEqual(['#生活'])
    expect(p.list).toBe('购物清单')
  })

  it('多个标签去重', () => {
    const p = parseInput('写周报 #工作 #工作 #重要')
    expect(p.tags).toEqual(['#工作', '#重要'])
  })

  it('明天18:00 语法', () => {
    const p = parseInput('交报告 明天18:00')
    expect(p.text).toBe('交报告')
    expect(p.recur).toBeNull()
    const d = new Date(p.due!)
    expect(d.getHours()).toBe(18)
    expect(d.getMinutes()).toBe(0)
    const now = new Date()
    const tmr = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    expect(d.toDateString()).toBe(tmr.toDateString())
  })

  it('每天 重复任务', () => {
    const p = parseInput('喝水 每天8:30')
    expect(p.text).toBe('喝水')
    expect(p.recur).toBe('daily')
    expect(p.due).not.toBeNull()
  })

  it('每周 / 每月', () => {
    expect(parseInput('周会 每周').recur).toBe('weekly')
    expect(parseInput('月报 每月').recur).toBe('monthly')
  })

  it('周X 解析到未来', () => {
    const { due } = extractDue('周五 开会')
    expect(due!).toBeGreaterThan(Date.now())
  })

  it('裸时间已过则顺延明天', () => {
    const { due } = extractDue('站会 6:30')
    expect(due).toBeGreaterThan(Date.now())
  })

  it('今天已过时间顺延', () => {
    const p = parseInput('提醒 今天0:01')
    expect(p.due! - Date.now()).toBeLessThan(2 * DAY)
  })

  it('解析结果带 pri 字段', () => {
    const p = parseInput('普通任务')
    expect('pri' in p).toBe(true)
    expect(p.pri).toBe(0)
  })

  it('纯文本不受影响', () => {
    const p = parseInput('普通任务 abc 123')
    expect(p).toEqual({ text: '普通任务 abc 123', tags: [], list: null, due: null, recur: null, pri: 0 })
  })

  it('!1-!3 优先级解析', () => {
    expect(parseInput('修bug !1').pri).toBe(1)
    expect(parseInput('修bug !2').pri).toBe(2)
    expect(parseInput('修bug !3').pri).toBe(3)
    expect(parseInput('修bug').pri).toBe(0)
    const p = parseInput('!1 紧急发布 v2.0')
    expect(p.pri).toBe(1)
    expect(p.text).toBe('紧急发布 v2.0')
  })

  it('感叹号不误伤（! 后非数字）', () => {
    expect(parseInput('完了! 崩了').pri).toBe(0)
    expect(parseInput('完了! 崩了').text).toBe('完了! 崩了')
  })

  it('下周X 解析到下个日历周', () => {
    const { due } = extractDue('下周三交报告')
    expect(due).not.toBeNull()
    const d = new Date(due!)
    expect(d.getDay()).toBe(3)
    const days = Math.floor((due! - Date.now()) / DAY)
    expect(days).toBeGreaterThanOrEqual(1)
    expect(days).toBeLessThanOrEqual(13)
  })

  it('月底 解析到本月或下月末', () => {
    const { due } = extractDue('交房租 月底')
    expect(due).not.toBeNull()
    const d = new Date(due!)
    expect([d.getHours(), d.getMinutes()]).toEqual([18, 0])
    // 必然是某月最后一天
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    expect(d.getDate()).toBe(lastDay)
  })

  it('每周三18点 解析到最近的周三', () => {
    const { due, recur } = extractDue('例会 每周三18点')
    expect(recur).toBe('weekly')
    const d = new Date(due!)
    expect(d.getDay()).toBe(3)
    expect([d.getHours(), d.getMinutes()]).toEqual([18, 0])
    expect(due!).toBeGreaterThan(Date.now())
  })
})

describe('dueLabel', () => {
  it('逾期标注', () => {
    const { text, cls } = dueLabel(Date.now() - 3 * DAY)
    expect(cls).toBe('over')
    expect(text).toContain('逾期')
  })

  it('今天标注（未来时刻 vs 当天已过时刻）', () => {
    const now = new Date()
    const future = new Date(now)
    future.setHours(23, 59, 0, 0)
    expect(dueLabel(future.getTime(), now.getTime()).cls).toBe('today')

    const past = new Date(now)
    past.setHours(0, 1, 0, 0)
    if (past.getTime() < now.getTime()) {
      const r = dueLabel(past.getTime(), now.getTime())
      expect(r.cls).toBe('over')
      expect(r.text).toContain('已过')
    }
  })

  it('明天标注', () => {
    expect(dueLabel(Date.now() + 1.5 * DAY).cls).toBe('next')
  })
})

describe('sortTaskList', () => {
  const mk = (id: string, over: Partial<Task> = {}): Task => ({
    id, t: id, d: false, list: '默认', tags: [], pri: 0, star: false,
    due: null, recur: null, notes: null, createdAt: 1, doneAt: null,
    ...over,
  })

  it('排序优先级：收藏打星 > 重要程度(1>2>3>0) > 截止时间越早 > 原顺序 > 已完成沉底（反馈进度不打乱排序）', () => {
    const list = [
      mk('plain-late', { due: 3000 }),
      mk('plain-early', { due: 1000 }),
      mk('p2', { pri: 2, due: 5000, prog: '联调中' }),
      mk('p1-late', { pri: 1, due: 4000 }),
      mk('p1-early', { pri: 1, due: 2000 }),
      mk('star-nodue', { star: true }),
      mk('star-due', { star: true, due: 1500 }),
      mk('done-star', { d: true, star: true, pri: 1, due: 100, doneAt: 500 }),
    ]
    const sorted = sortTaskList(list).map((t) => t.id)
    expect(sorted).toEqual([
      'star-due',
      'star-nodue',
      'p1-early',
      'p1-late',
      'p2',
      'plain-early',
      'plain-late',
      'done-star',
    ])
  })

  it('次日不展示：当天已完成保留，跨日已完成标记为 stale', () => {
    const today0 = new Date()
    today0.setHours(0, 0, 0, 0)
    const ref = today0.getTime()
    expect(isStaleDone(mk('a', { d: true, doneAt: ref + 3600000 }), ref)).toBe(false)
    expect(isStaleDone(mk('b', { d: true, doneAt: ref - 1000 }), ref)).toBe(true)
    expect(isStaleDone(mk('c', { d: false, doneAt: null }), ref)).toBe(false)
  })

  it('进度历史记录打卡、覆盖最新与单项删除', () => {
    const t0 = mk('t-prog', { prog: '旧单条进度' })
    setAll([t0], {})
    addProgLog('t-prog', '第一次打卡：完成设计')
    let cur = tasks()[0]
    expect(cur.prog).toBe('第一次打卡：完成设计')
    expect(cur.progLogs?.length).toBe(2) // 自动迁移旧 prog + 新插入

    addProgLog('t-prog', '第二次打卡：完成联调')
    cur = tasks()[0]
    expect(cur.prog).toBe('第二次打卡：完成联调')
    expect(cur.progLogs?.[0].text).toBe('第二次打卡：完成联调')

    const firstId = cur.progLogs![0].id
    deleteProgLog('t-prog', firstId)
    cur = tasks()[0]
    expect(cur.prog).toBe('第一次打卡：完成设计')

    clearProgLogs('t-prog')
    cur = tasks()[0]
    expect(cur.prog).toBeNull()
    expect(cur.progLogs?.length).toBe(0)
  })

  it('标签设置、添加、移除与全量标签池', () => {
    const t0 = mk('t-tag', { tags: ['#工作'] })
    setAll([t0], {})
    addTag('t-tag', '紧急')
    expect(tasks()[0].tags).toEqual(['#工作', '#紧急'])

    removeTag('t-tag', '#工作')
    expect(tasks()[0].tags).toEqual(['#紧急'])

    setTags('t-tag', ['项目A', '#项目B', '项目A'])
    expect(tasks()[0].tags).toEqual(['#项目A', '#项目B'])
    expect(getAllTags()).toContain('#项目A')
    expect(getAllTags()).toContain('#项目B')
  })

  it('时间分类分组算法（今天、本周、本月、持续）', () => {
    expect(getTimeGroupKey(null)).toBe('continuous')

    const now = new Date()
    const todayTs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0).getTime()
    expect(getTimeGroupKey(todayTs)).toBe('today')

    // 逾期任务归入今天组优先关注
    const overdueTs = todayTs - 86400000 * 2
    expect(getTimeGroupKey(overdueTs)).toBe('today')

    // 持续组：无截止
    expect(getTimeGroupKey(null)).toBe('continuous')
  })

  it('挂起 / 取消挂起状态', () => {
    const t0 = mk('t-susp', {})
    setAll([t0], {})
    expect(tasks()[0].susp).toBeFalsy()
    setSusp('t-susp', true)
    expect(tasks()[0].susp).toBe(true)
    // 挂起不影响完成态与数据完整性
    expect(tasks()[0].d).toBe(false)
    expect(tasks()[0].t).toBe('t-susp')
    setSusp('t-susp', false)
    expect(tasks()[0].susp).toBe(false)
  })
})
