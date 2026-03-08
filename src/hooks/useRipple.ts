import { useEffect } from 'react'

const RIPPLE_DURATION = 700

const CLICKABLE_SELECTOR = [
  'button',
  'a[href]',
  '[role="button"]',
  '.sidebar-link',
  '.search-result',
  '.pdv-search-result',
  '.customer-result',
  '.purchase-product-option',
  '.purchase-order-option',
  '.custom-select-option',
  '.payment-combobox-option',
  '.v-cmd-item',
  '.v-table-clickable',
  '.cadastro-row',
  '.quote-row',
  '.finance-aging-card-button',
  '.v-kpi-clickable',
  '.btn-inline',
  '.history-expand-btn',
  '.inventory-link-button',
].join(', ')

function findClickable(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null
  return target.closest<HTMLElement>(CLICKABLE_SELECTOR)
}

function createRipple(e: MouseEvent) {
  const el = findClickable(e.target)
  if (!el) return
  if (el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true') return

  const rect = el.getBoundingClientRect()
  const size = Math.max(el.clientWidth, el.clientHeight) * 2
  const x = e.clientX - rect.left - size / 2
  const y = e.clientY - rect.top - size / 2

  const span = document.createElement('span')
  span.className = 'ripple-effect'
  span.style.width = `${size}px`
  span.style.height = `${size}px`
  span.style.left = `${x}px`
  span.style.top = `${y}px`

  const position = globalThis.getComputedStyle(el).position
  if (position === 'static') {
    el.style.position = 'relative'
  }
  el.style.overflow = 'hidden'

  el.appendChild(span)

  requestAnimationFrame(() => {
    span.classList.add('ripple-effect-active')
  })

  setTimeout(() => {
    span.remove()
  }, RIPPLE_DURATION)
}

export function useRipple() {
  useEffect(() => {
    document.addEventListener('mousedown', createRipple)
    return () => {
      document.removeEventListener('mousedown', createRipple)
    }
  }, [])
}
