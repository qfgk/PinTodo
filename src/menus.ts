// 轻量弹出菜单：条目 / 分隔线 / 单选 / 日期选择行
import { h } from './icons'

export interface MenuEntry {
  label?: string
  action?: (value?: number) => void
  sep?: boolean
  checked?: boolean
  radio?: boolean
  danger?: boolean
  icon?: string
  datetime?: number | null // 显示日期选择行
}

let openMenu: HTMLElement | null = null

export function closeMenus() {
  if (openMenu) {
    openMenu.remove()
    openMenu = null
    document.removeEventListener('pointerdown', onDocDown, true)
  }
}

function onDocDown(e: Event) {
  if (openMenu && !openMenu.contains(e.target as Node)) closeMenus()
}

export function popupMenu(entries: MenuEntry[], x: number, y: number) {
  closeMenus()
  const m = h('div', 'ctx-menu')
  for (const ent of entries) {
    if (ent.sep) {
      m.appendChild(h('div', 'ctx-sep'))
      continue
    }
    if (ent.datetime !== undefined) {
      const row = h('div', 'ctx-datetime')
      const inp = document.createElement('input')
      inp.type = 'datetime-local'
      inp.className = 'ctx-dt-input'
      if (ent.datetime) {
        const d = new Date(ent.datetime)
        const p = (n: number) => String(n).padStart(2, '0')
        inp.value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
      }
      inp.addEventListener('change', () => {
        const v = inp.value ? new Date(inp.value).getTime() : null
        closeMenus()
        ent.action?.(v ?? undefined)
      })
      inp.addEventListener('pointerdown', (e) => e.stopPropagation())
      row.appendChild(h('span', 'ctx-label', ent.label ?? '选择日期'))
      row.appendChild(inp)
      m.appendChild(row)
      continue
    }
    const b = h('button', 'ctx-item' + (ent.danger ? ' danger' : ''))
    if (ent.checked) {
      b.appendChild(h('span', 'ctx-dot' + (ent.radio ? ' radio' : ''), '✓'))
    } else if (ent.icon) {
      // 图标是内联 SVG 字符串，必须走 innerHTML（textContent 会把 SVG 源码当文本显示出来）
      const ico = h('span', 'ctx-dot icon')
      ico.innerHTML = ent.icon
      b.appendChild(ico)
    } else {
      b.appendChild(h('span', 'ctx-dot', ''))
    }
    b.appendChild(h('span', '', ent.label ?? ''))
    b.addEventListener('click', () => {
      closeMenus()
      ent.action?.()
    })
    m.appendChild(b)
  }
  document.body.appendChild(m)
  // 定位：越界翻转
  const r = m.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (x + r.width > vw - 8) x = Math.max(8, vw - r.width - 8)
  if (y + r.height > vh - 8) y = Math.max(8, y - r.height - 4)
  m.style.left = x + 'px'
  m.style.top = y + 'px'
  m.classList.add('show')
  openMenu = m
  document.addEventListener('pointerdown', onDocDown, true)
}
