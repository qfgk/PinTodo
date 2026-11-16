// 输入解析：#标签 @清单 !优先级 截止/重复时间 的自然语法（对标 Todoist/Things 快速录入）
import type { ParsedInput } from './types'

const DAY = 86400000

function startOfDay(d: Date): number {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x.getTime()
}

function atTime(base: number, h: number, m: number): number {
  const d = new Date(base)
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

/** "18" / "18:30" / "18：30" / "18点" / "18点半" → [h, m]；解析失败返回 null */
function parseTime(s: string): [number, number] | null {
  const m = s.match(/(\d{1,2})(?:[:：点时](\d{1,2})?)?\s*(半)?/)
  if (!m) return null
  const h = parseInt(m[1], 10)
  if (h > 23) return null
  let mm = m[2] ? parseInt(m[2], 10) : 0
  if (m[3]) mm = 30
  if (mm > 59) return null
  return [h, mm]
}

const WEEK: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 }

/** 距今最近的周X（含今天；已过则下周） */
function daysUntilWeekday(target: number, cur: number): number {
  const delta = (target - cur + 7) % 7
  return delta === 0 ? 7 : delta
}

/**
 * 从文本里提取截止时间与重复规则
 * 支持：今天/明天/后天/大后天、周X、下周X、N天后、月底、HH:MM、每天/每周X/每月 [时间]
 */
export function extractDue(raw: string): {
  due: number | null
  recur: 'daily' | 'weekly' | 'monthly' | null
  rest: string
} {
  let rest = raw
  const now = new Date()
  const today = startOfDay(now)
  let due: number | null = null
  let recur: 'daily' | 'weekly' | 'monthly' | null = null

  const eat = (re: RegExp): string => {
    const m = rest.match(re)
    if (m) rest = rest.replace(m[0], ' ')
    return m ? m[0] : ''
  }

  // 重复：每天[时间] / 每周[X][时间] / 每月[时间]
  const rec = eat(
    /(每天|每日|每周|每月)(?:\s*([一二三四五六日天]))?(?:\s*(\d{1,2}(?:[:：]\d{1,2})?|\d{1,2}[点时](?:半|\d{1,2})?))?/,
  )
  if (rec) {
    recur = rec.includes('周') ? 'weekly' : rec.includes('月') ? 'monthly' : 'daily'
    const wd = rec.match(/([一二三四五六日天])/)?.[1]
    const tm = parseTime(rec.replace(/^(每天|每日|每周|每月)\s*[一二三四五六日天]?/, ''))
    const [h, m] = tm ?? [9, 0]
    if (recur === 'weekly' && wd) {
      // 每周三18点 → 最近的周X（含今天，已过时刻/已过则下周）
      let delta = daysUntilWeekday(WEEK[wd], now.getDay())
      let t = atTime(today + delta * DAY, h, m)
      if (t <= now.getTime()) t += 7 * DAY
      due = t
    } else {
      let t = atTime(today, h, m)
      if (t <= now.getTime()) t += recur === 'monthly' ? 30 * DAY : recur === 'weekly' ? 7 * DAY : DAY
      due = t
    }
  }

  if (due === null) {
    // 月底（默认 18:00；当天月底且已过 18 点 → 下个月底）
    const me = eat(/月底|月末/)
    if (me) {
      const eom = (base: Date) => new Date(base.getFullYear(), base.getMonth() + 1, 0, 18, 0)
      let t = eom(now).getTime()
      if (t <= now.getTime()) t = eom(new Date(now.getFullYear(), now.getMonth() + 2, 0)).getTime()
      due = t
    }
  }

  if (due === null) {
    // 下周X（下周一=下个日历周的周一，默认 9:00）
    const nwk = eat(/下(?:周|星期|礼拜)([一二三四五六日天])(?:\s*(\d{1,2}[:：]\d{1,2}|\d{1,2}[点时](?:半|\d{1,2})?))?/)
    if (nwk) {
      const wd = WEEK[nwk.match(/([一二三四五六日天])/)![1]]
      const tm = parseTime(nwk.replace(/下(?:周|星期|礼拜)[一二三四五六日天]/, ''))
      const nextMonday = today + (daysUntilWeekday(1, now.getDay()) * DAY)
      const offset = wd === 0 ? 6 : wd - 1 // 周一为一周之首
      due = tm
        ? atTime(nextMonday + offset * DAY, tm[0], tm[1])
        : atTime(nextMonday + offset * DAY, 18, 0)
    }
  }

  if (due === null) {
    // 今天/明天/后天/大后天 [+时间]
    const rel = eat(/(大后天|后天|明天|今天)(?:\s*(\d{1,2}[:：]\d{1,2}|\d{1,2}[点时](?:半|\d{1,2})?|[早晚]))?/)
    if (rel) {
      const off = rel.startsWith('大后天') ? 3 : rel.startsWith('后天') ? 2 : rel.startsWith('明天') ? 1 : 0
      const tail = rel.replace(/^(大后天|后天|明天|今天)/, '')
      let tm = parseTime(tail)
      if (!tm && tail.includes('晚')) tm = [20, 0]
      if (!tm && tail.includes('早')) tm = [9, 0]
      due = tm ? atTime(today + off * DAY, tm[0], tm[1]) : atTime(today + off * DAY, 18, 0) // 无时间默认当天 18:00
      if (tm && off === 0 && due <= now.getTime()) due += DAY // "今天18:00" 已过 → 明天
    }
  }

  if (due === null) {
    // 周X / 星期X [+时间]
    const wk = eat(/(?:周|星期|礼拜)([一二三四五六日天])(?:\s*(\d{1,2}[:：]\d{1,2}|\d{1,2}[点时](?:半|\d{1,2})?))?(号|日)?/)
    if (wk) {
      const wd = WEEK[wk.match(/([一二三四五六日天])/)![1]]
      const tm = parseTime(wk.replace(/(?:周|星期|礼拜)[一二三四五六日天]/, ''))
      const delta = daysUntilWeekday(wd, now.getDay())
      due = tm
        ? atTime(today + delta * DAY, tm[0], tm[1])
        : atTime(today + delta * DAY, 18, 0)
    }
  }

  if (due === null) {
    // N天后 [+时间]
    const af = eat(/(\d{1,3})\s*天[后後]?(?:\s*(\d{1,2}[:：]\d{1,2}|\d{1,2}[点时](?:半|\d{1,2})?))?/)
    if (af) {
      const n = parseInt(af, 10)
      const tm = parseTime(af.replace(/\d{1,3}\s*天[后後]?/, ''))
      due = tm ? atTime(today + n * DAY, tm[0], tm[1]) : atTime(today + n * DAY, 18, 0)
    }
  }

  if (due === null) {
    // 裸时间 HH:MM → 今天（已过则明天）
    const bt = eat(/\b(\d{1,2}[:：]\d{1,2})\b/)
    if (bt) {
      const [h, m] = parseTime(bt)!
      let t = atTime(today, h, m)
      if (t <= now.getTime()) t += DAY
      due = t
    }
  }

  return { due, recur, rest: rest.replace(/\s+/g, ' ').trim() }
}

/** 完整解析：#标签 @清单 !优先级 + 时间语法 */
export function parseInput(raw: string): ParsedInput {
  let rest = raw
  const tags: string[] = []
  let list: string | null = null
  let pri = 0

  rest = rest.replace(/#([^\s#@,，;；]+)/g, (_, tag) => {
    const t = '#' + tag
    if (!tags.includes(t)) tags.push(t)
    return ' '
  })
  rest = rest.replace(/@([^\s#@,，;；]+)/g, (_, l) => {
    list = l
    return ' '
  })
  rest = rest.replace(/(?:^|\s)!([123])(?=\s|$)/g, (_, p) => {
    pri = parseInt(p, 10)
    return ' '
  })

  const { due, recur, rest: text } = extractDue(rest)
  return { text: text.replace(/\s+/g, ' ').trim(), tags, list, due, recur, pri }
}

const PRI_LABEL = ['', '高', '中', '低'] as const
const PRI_CLS = ['', 'p1', 'p2', 'p3'] as const

export function priLabel(pri: number): string {
  return PRI_LABEL[pri] ?? ''
}
export function priClass(pri: number): string {
  return PRI_CLS[pri] ?? ''
}

/** 截止时间的展示标签（当天已过时刻也明确标红为逾期，与闹钟提醒语义一致） */
export function dueLabel(due: number, nowMs = Date.now()): { text: string; cls: string } {
  const now = new Date(nowMs)
  const today = startOfDay(now)
  const tmr = today + DAY
  const d = new Date(due)
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  const md = `${d.getMonth() + 1}/${d.getDate()}`

  if (due < today) {
    const days = Math.floor((today - startOfDay(d)) / DAY)
    return { text: days <= 0 ? `逾期 ${hm}` : `逾期 ${days}天`, cls: 'over' }
  }
  if (due < tmr) {
    if (due < nowMs) return { text: `已过 ${hm}`, cls: 'over' }
    return { text: `今天 ${hm}`, cls: 'today' }
  }
  if (due < tmr + DAY) return { text: `明天 ${hm}`, cls: 'next' }
  if (due < today + 7 * DAY) {
    const w = '日一二三四五六'[d.getDay()]
    return { text: `周${w} ${hm}`, cls: 'next' }
  }
  const sameYear = d.getFullYear() === now.getFullYear()
  return { text: `${sameYear ? md : d.getFullYear() + '/' + md} ${hm}`, cls: 'next' }
}

/** 判断截止时间属于哪一时间分类组：今天 / 本周 / 本月 / 持续 */
export function getTimeGroupKey(due: number | null): 'today' | 'week' | 'month' | 'continuous' {
  if (due == null) return 'continuous'
  const now = new Date()
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime()
  if (due <= todayEnd) return 'today'

  // 本周日 23:59:59.999 (周一为起始，周日为结束)
  const day = now.getDay()
  const daysUntilSunday = day === 0 ? 0 : 7 - day
  const endOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysUntilSunday, 23, 59, 59, 999).getTime()
  if (due <= endOfWeek) return 'week'

  // 本月最后一天 23:59:59.999
  const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime()
  if (due <= endOfMonth) return 'month'

  return 'continuous'
}

