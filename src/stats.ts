// 统计面板：7 天完成量 + 连续打卡
import { tasks } from './state'
import { h } from './icons'

export function toggleStats() {
  const host = document.querySelector('.body-wrap') ?? document.getElementById('app')!
  let p = host.querySelector('.stats-panel') as HTMLElement
  if (p) {
    p.remove()
    return
  }
  p = h('div', 'stats-panel')
  p.innerHTML = `<div class="stats-head"><span>最近 7 天完成趋势</span><button class="ib stats-close" title="关闭">✕</button></div>
    <div class="stats-bars"></div>
    <div class="stats-rows"></div>`
  host.appendChild(p)
  p.querySelector('.stats-close')!.addEventListener('click', () => p.remove())
  render(p)
}

function dayStart(offset: number) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime() - offset * 86400000
}

function render(p: HTMLElement) {
  const bars = p.querySelector('.stats-bars') as HTMLElement
  const rows = p.querySelector('.stats-rows') as HTMLElement

  const days: { label: string; n: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const s = dayStart(i)
    const n = tasks().filter((t) => t.d && t.doneAt != null && t.doneAt >= s && t.doneAt < s + 86400000).length
    days.push({ label: i === 0 ? '今天' : '周' + '日一二三四五六'[new Date(s).getDay()], n })
  }
  const max = Math.max(1, ...days.map((d) => d.n))

  // 内联 SVG 柱状图
  const W = 268
  const H = 96
  const bw = 24
  const gap = (W - bw * 7) / 8
  let svg = `<svg viewBox="0 0 ${W} ${H + 18}" width="100%">`
  days.forEach((d, i) => {
    const bh = Math.round((d.n / max) * (H - 12))
    const x = gap + i * (bw + gap)
    const y = H - bh
    svg += `<rect x="${x}" y="${y}" width="${bw}" height="${Math.max(bh, d.n ? 3 : 2)}" rx="4" fill="${d.n ? 'var(--accent)' : 'var(--line-strong)'}"/>`
    if (d.n) svg += `<text x="${x + bw / 2}" y="${y - 5}" text-anchor="middle" font-size="10" fill="var(--sub)">${d.n}</text>`
    svg += `<text x="${x + bw / 2}" y="${H + 13}" text-anchor="middle" font-size="10" fill="var(--sub)">${d.label}</text>`
  })
  svg += '</svg>'
  bars.innerHTML = svg

  // 打卡与总量
  let streak = 0
  for (let i = 0; ; i++) {
    const s = dayStart(i)
    const has = tasks().some((t) => t.d && t.doneAt != null && t.doneAt >= s && t.doneAt < s + 86400000)
    if (has) streak++
    else if (i > 0 || !has) break
  }
  const total = tasks().length
  const done = tasks().filter((t) => t.d).length
  const week = days.reduce((a, b) => a + b.n, 0)
  rows.innerHTML = ''
  rows.appendChild(row('连续打卡', streak + ' 天'))
  rows.appendChild(row('本周完成', week + ' 项'))
  rows.appendChild(row('累计', `${total} 项 / 已完成 ${done}`))
}

function row(k: string, v: string) {
  const r = h('div', 'stats-row')
  r.appendChild(h('span', '', k))
  r.appendChild(h('b', '', v))
  return r
}
