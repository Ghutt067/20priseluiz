import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { modules, type ModeKey } from '../../config/modes'

type CommandPaletteProps = {
  readonly mode: ModeKey
}

export function CommandPalette({ mode }: CommandPaletteProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  const items = useMemo(() => {
    const allowed = modules.filter((m) => m.modes.includes(mode))
    if (!query.trim()) return allowed
    const q = query.trim().toLowerCase()
    return allowed.filter(
      (m) =>
        m.label.toLowerCase().includes(q) ||
        m.group.toLowerCase().includes(q) ||
        (m.description ?? '').toLowerCase().includes(q),
    )
  }, [mode, query])

  const toggle = useCallback(() => {
    setOpen((s) => {
      if (!s) {
        setQuery('')
        setSelectedIndex(0)
      }
      return !s
    })
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        toggle()
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault()
        setOpen(false)
      }
    }
    globalThis.addEventListener('keydown', handler)
    return () => globalThis.removeEventListener('keydown', handler)
  }, [open, toggle])

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  const go = (path: string) => {
    navigate(path)
    setOpen(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, items.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && items[selectedIndex]) {
      e.preventDefault()
      go(items[selectedIndex].path)
    }
  }

  if (!open) return null

  return (
    <div className="v-cmd-backdrop" onClick={() => setOpen(false)}>
      <div className="v-cmd-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="v-cmd-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Localizar módulo... (Ctrl+K)"
        />
        <div className="v-cmd-list">
          {items.length === 0 && (
            <div className="v-cmd-empty">Módulo não localizado.</div>
          )}
          {items.map((item, i) => (
            <button
              key={item.key}
              type="button"
              className={`v-cmd-item${i === selectedIndex ? ' v-cmd-selected' : ''}`}
              onMouseEnter={() => setSelectedIndex(i)}
              onClick={() => go(item.path)}
            >
              <span className="v-cmd-item-label">{item.label}</span>
              <span className="v-cmd-item-group">{item.group}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
