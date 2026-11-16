// 主题：auto / light / dark，深浅色跟随系统
import { settings, patchSettings } from './state'
import type { ThemeMode } from './types'

const mq = window.matchMedia('(prefers-color-scheme: dark)')

export function initTheme() {
  apply(currentMode())
  mq.addEventListener('change', () => {
    if (currentMode() === 'auto') apply('auto')
  })
}

export function currentMode(): ThemeMode {
  const t = settings().theme
  return t === 'light' || t === 'dark' ? t : 'auto'
}

export function setTheme(mode: ThemeMode) {
  patchSettings({ theme: mode })
  apply(mode)
}

function apply(mode: ThemeMode) {
  const dark = mode === 'auto' ? mq.matches : mode === 'dark'
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}
