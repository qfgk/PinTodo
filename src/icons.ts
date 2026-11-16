// 内联 SVG 图标（无外部资源，保证启动速度）
export const s = (d: string, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`

export const SVG = {
  check: s('<path d="M5 12.5l4.5 4.5L19 7"/>'),
  plus: s('<path d="M12 5v14M5 12h14"/>'),
  close: s('<path d="M6 6l12 12M18 6L6 18"/>'),
  minus: s('<path d="M5 12h14"/>'),
  search: s('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
  dots: s('<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>'),
  chevron: s('<path d="M6 9l6 6 6-6"/>'),
  star: s('<path d="M12 3l2.7 5.6 6.3.9-4.5 4.4 1 6.1L12 17l-5.5 3 1-6.1L3 9.5l6.3-.9z"/>'),
  starFill: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M12 3l2.7 5.6 6.3.9-4.5 4.4 1 6.1L12 17l-5.5 3 1-6.1L3 9.5l6.3-.9z"/></svg>',
  pin: s('<path d="M12 17v5M5 9l7-7 7 7-2 2v4l2 3H5l2-3v-4z"/>'),
  chart: s('<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>'),
  grip: s('<path d="M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01M15 19h.01"/>'),
  recur: s('<path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 014-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 01-4 4H3"/>'),
  back: s('<path d="M15 18l-6-6 6-6"/>'),
  sun: s('<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: s('<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>'),
  notes: s('<path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z"/><path d="M14 3v6h6"/><path d="M8.5 13h7M8.5 16.5h4.5"/>'),
  pencil: s('<path d="M17 3a2.8 2.8 0 114 4L7.5 20.5 2 22l1.5-5.5z"/>'),
  clock: s('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  notePad: s('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>'),
  list: s('<path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/>'),
  checkCircle: s('<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>'),
  emptyCheck: '<svg viewBox="0 0 64 64" width="54" height="54" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="32" cy="32" r="24" stroke-dasharray="4 5" opacity="0.55"/><path d="M22 33l6.5 6.5L43 24" stroke-width="2.6"/></svg>',
  help: s('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 014.8.8c0 1.7-2.3 2.2-2.3 3.7"/><path d="M12 17h.01"/>'),
  sparkles: s('<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z"/>'),
  cal: s('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>'),
  prog: s('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  chevL: s('<path d="M15 18l-6-6 6-6"/>'),
  chevR: s('<path d="M9 18l6-6-6-6"/>'),
  exportIco: s('<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
  tagIcon: s('<path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>'),
  pause: s('<path d="M9 5v14M15 5v14"/>'),
  trash: s('<path d="M4 7h16"/><path d="M9 7V5a2 2 0 012-2h2a2 2 0 012 2v2"/><path d="M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12"/><path d="M10 11v6M14 11v6"/>'),
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}
