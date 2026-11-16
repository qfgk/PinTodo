export interface ProgLog {
  id: string
  text: string
  time: number
}

export interface Task {
  id: string
  t: string
  d: boolean
  list: string
  tags: string[]
  /** 0 无 / 1 高(红) / 2 中(橙) / 3 低(蓝)；向后兼容旧星标 */
  pri: number
  /** 收藏 / 打星（独立于优先级） */
  star?: boolean
  /** 挂起：暂缓处理，收进「挂起」分组，不计入待办与到期提醒 */
  susp?: boolean
  due: number | null
  recur: 'daily' | 'weekly' | 'monthly' | null
  /** 任务描述 */
  notes?: string | null
  /** 最新当前进度（便捷显示） */
  prog?: string | null
  /** 进度反馈历史记录（时间轴历程） */
  progLogs?: ProgLog[]
  createdAt: number
  doneAt: number | null
}

export type ThemeMode = 'auto' | 'light' | 'dark'
export type Chip = 'all' | 'todo' | 'done' | 'today' | 'overdue' | 'star'
/** 主界面视图：清单（含时间分类折叠） / 随手记 / 历史日历 */
export type ViewMode = 'list' | 'note' | 'history'

export type TimeGroupKey = 'today' | 'week' | 'month' | 'continuous'
/** 清单分组键：四个时间分组 + 挂起分组（展示被暂缓的任务） */
export type ListGroupKey = TimeGroupKey | 'parked'

export interface ParsedInput {
  text: string
  tags: string[]
  list: string | null
  due: number | null
  recur: 'daily' | 'weekly' | 'monthly' | null
  pri: number
}
