// 快速添加迷你窗：任意界面热键唤起，实时展示解析预览芯片，Enter 提交
import { getCurrentWindow, LogicalSize } from '@tauri-apps/api/window'
import { emitTo, listen } from '@tauri-apps/api/event'
import { parseInput, dueLabel, priLabel } from './parse'
import { SVG } from './icons'

const win = getCurrentWindow()
const BASE_H = 76
const HINT_H = 104

export async function boot() {
  document.body.dataset.win = 'quickadd'
  const app = document.getElementById('app')!
  app.innerHTML = `
    <div class="qa-card">
      <div class="qa-main">
        <span class="qa-ico">${SVG.plus}</span>
        <input type="text" class="qa-input" placeholder="快速添加，支持 #标签 @清单 !1 明天18:00…" />
        <span class="qa-done" style="display:none">✓ 已添加</span>
      </div>
      <div class="qa-hints" style="display:none"></div>
    </div>`

  const input = app.querySelector('.qa-input') as HTMLInputElement
  const done = app.querySelector('.qa-done') as HTMLElement
  const hints = app.querySelector('.qa-hints') as HTMLElement

  const syncHints = () => {
    const raw = input.value.trim()
    if (!raw) {
      hints.style.display = 'none'
      hints.innerHTML = ''
      win.setSize(new LogicalSize(480, BASE_H)).catch(() => {})
      return
    }
    const p = parseInput(raw)
    const chips: string[] = []
    if (p.due) chips.push(`<span class="hint-chip">⏰ ${dueLabel(p.due).text}</span>`)
    if (p.recur) chips.push(`<span class="hint-chip">↻ ${({ daily: '每天', weekly: '每周', monthly: '每月' })[p.recur]}</span>`)
    if (p.pri) chips.push(`<span class="hint-chip pri">!${p.pri} ${priLabel(p.pri)}</span>`)
    if (p.list) chips.push(`<span class="hint-chip">清单: ${esc(p.list)}</span>`)
    p.tags.forEach((t) => chips.push(`<span class="hint-chip">${esc(t)}</span>`))

    if (chips.length) {
      hints.innerHTML = chips.join('')
      hints.style.display = ''
      win.setSize(new LogicalSize(480, HINT_H)).catch(() => {})
    } else {
      hints.style.display = 'none'
      hints.innerHTML = ''
      win.setSize(new LogicalSize(480, BASE_H)).catch(() => {})
    }
  }

  input.addEventListener('input', syncHints)
  input.addEventListener('keydown', async (e) => {
    e.stopPropagation()
    if (e.key === 'Escape') {
      input.value = ''
      syncHints()
      await win.hide()
    } else if (e.key === 'Enter') {
      const p = parseInput(input.value)
      if (!p.text) return
      emitTo('main', 'quick-add', p)
      input.value = ''
      syncHints()
      input.blur()
      done.style.display = ''
      setTimeout(async () => {
        done.style.display = 'none'
        await win.hide()
      }, 360)
    }
  })

  // 失焦自动关闭（点别处时）
  input.addEventListener('blur', async () => {
    setTimeout(async () => {
      try {
        const vis = await win.isVisible()
        if (vis && !input.value) await win.hide()
      } catch { /* ignore */ }
    }, 200)
  })

  // 每次被主窗唤起时重新聚焦
  await listen('qa-focus', () => {
    input.value = ''
    syncHints()
    setTimeout(() => input.focus(), 20)
  })
  setTimeout(() => input.focus(), 30)
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}

