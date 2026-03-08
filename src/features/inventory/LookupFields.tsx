import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from 'react'
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence'
import {
  createVirtualDropdownWindow,
  ensureDropdownItemVisible,
  getEstimatedTotalRowCount,
} from '../../components/ui'

export type LookupItem = {
  id: string
  name: string
}

export type LookupSearchParams = Readonly<{
  query: string
  offset: number
  limit: number
  signal?: AbortSignal
}>

export type LookupSearchResult<T extends LookupItem> = {
  rows: T[]
  totalCount: number | null
}

const LOOKUP_PAGE_SIZE = 5
const LOOKUP_ROW_HEIGHT = 46

function mergeLookupItemsById<T extends { id: string }>(
  previous: T[],
  incoming: T[],
  options?: { replace?: boolean },
) {
  if (options?.replace) {
    return incoming
  }
  if (incoming.length === 0) return previous
  const seen = new Set(previous.map((item) => item.id))
  const appended = incoming.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
  return appended.length > 0 ? [...previous, ...appended] : previous
}

type LookupFieldProps<T extends LookupItem> = Readonly<{
  value: string
  selectedLabel: string
  placeholder: string
  searchOptions: (params: LookupSearchParams) => Promise<LookupSearchResult<T>>
  onSelect: (item: T) => void
  onClear: () => void
  disabled?: boolean
  renderMeta?: (item: T) => string | null
  emptyHint?: { label: string; onAdd?: () => void }
  renderCreateForm?: (props: { initialName: string; onCreated: (entity: { id: string; name: string }) => void; onCancel: () => void }) => ReactNode
}>

export function LookupField<T extends LookupItem>({
  value,
  selectedLabel,
  placeholder,
  searchOptions,
  onSelect,
  onClear,
  disabled = false,
  renderMeta,
  emptyHint,
  renderCreateForm,
}: LookupFieldProps<T>) {
  const [open, setOpen] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<T[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [knownTotalRows, setKnownTotalRows] = useState<number | null>(null)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const requestControllerRef = useRef<AbortController | null>(null)
  const searchTimeoutRef = useRef<number | null>(null)
  const loadMoreRequestOffsetRef = useRef<number | null>(null)
  const skipNextFocusRef = useRef(false)
  const hasTypedRef = useRef(false)

  const isOpen = open && !disabled
  const { mounted: dropMounted, exiting: dropExiting } = useAnimatedPresence(isOpen && results.length > 0, 180)
  const inputValue = isOpen
    ? (hasTypedRef.current ? query : (query || selectedLabel))
    : selectedLabel
  const estimatedTotalRows = useMemo(
    () => (knownTotalRows !== null
      ? Math.max(Math.floor(knownTotalRows), results.length)
      : getEstimatedTotalRowCount(results.length, hasMore, LOOKUP_PAGE_SIZE)),
    [hasMore, knownTotalRows, results.length],
  )
  const virtualRows = useMemo(
    () => createVirtualDropdownWindow(estimatedTotalRows, scrollTop, LOOKUP_ROW_HEIGHT),
    [estimatedTotalRows, scrollTop],
  )

  const clearSearchTimeout = useCallback(() => {
    if (searchTimeoutRef.current === null) return
    globalThis.clearTimeout(searchTimeoutRef.current)
    searchTimeoutRef.current = null
  }, [])

  const resetLookupState = useCallback(() => {
    setResults([])
    setHasMore(true)
    setKnownTotalRows(null)
    setFocusedIndex(0)
    setScrollTop(0)
    loadMoreRequestOffsetRef.current = null
    if (listRef.current) {
      listRef.current.scrollTop = 0
    }
  }, [])

  const runSearch = useCallback(
    async (
      searchValue: string,
      offset: number,
      options?: {
        replace?: boolean
      },
    ) => {
      setLoading(true)
      requestControllerRef.current?.abort()
      const controller = new AbortController()
      requestControllerRef.current = controller

      try {
        const result = await searchOptions({
          query: searchValue,
          offset,
          limit: LOOKUP_PAGE_SIZE,
          signal: controller.signal,
        })
        const rows = result.rows
        const reportedTotalCount =
          typeof result.totalCount === 'number' && Number.isFinite(result.totalCount)
            ? Math.max(Math.floor(result.totalCount), 0)
            : null

        setResults((state) => mergeLookupItemsById(state, rows, { replace: options?.replace }))
        if (reportedTotalCount !== null) {
          setKnownTotalRows(reportedTotalCount)
          setHasMore(offset + rows.length < reportedTotalCount)
        } else {
          if (options?.replace) {
            setKnownTotalRows(null)
          }
          setHasMore(rows.length === LOOKUP_PAGE_SIZE)
        }
        loadMoreRequestOffsetRef.current = null
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (options?.replace) {
          setResults([])
          setKnownTotalRows(null)
        }
        setHasMore(false)
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    },
    [searchOptions],
  )

  const startFreshSearch = useCallback(
    (searchValue: string) => {
      clearSearchTimeout()
      resetLookupState()
      void runSearch(searchValue, 0, { replace: true })
    },
    [clearSearchTimeout, resetLookupState, runSearch],
  )

  const scheduleSearch = useCallback(
    (searchValue: string) => {
      clearSearchTimeout()
      searchTimeoutRef.current = globalThis.setTimeout(() => {
        void startFreshSearch(searchValue)
      }, 80)
    },
    [clearSearchTimeout, startFreshSearch],
  )

  const loadMore = useCallback(() => {
    if (loading || !hasMore) return
    if (loadMoreRequestOffsetRef.current === results.length) return
    loadMoreRequestOffsetRef.current = results.length
    void runSearch(query, results.length)
  }, [hasMore, loading, query, results.length, runSearch])

  useEffect(() => {
    return () => {
      clearSearchTimeout()
      requestControllerRef.current?.abort()
    }
  }, [clearSearchTimeout])

  useEffect(() => {
    if (!isOpen) return
    const handleOutsideClick = (event: MouseEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return
      setOpen(false)
      setQuery('')
      setFocusedIndex(0)
      setScrollTop(0)
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [isOpen])

  useEffect(() => {
    if (!disabled) return
    setOpen(false)
    setQuery('')
    setResults([])
    setFocusedIndex(0)
    setScrollTop(0)
  }, [disabled])

  useEffect(() => {
    if (!isOpen || loading || !hasMore) return
    if (virtualRows.end < results.length) return
    loadMore()
  }, [hasMore, isOpen, loadMore, loading, results.length, virtualRows.end])

  const openLookup = () => {
    if (disabled) return
    if (!isOpen) {
      hasTypedRef.current = false
      setOpen(true)
      setQuery('')
      startFreshSearch('')
      return
    }
    if (results.length === 0 && !loading) {
      startFreshSearch(query)
    }
  }

  const handleSelect = (item: T) => {
    onSelect(item)
    hasTypedRef.current = false
    setQuery('')
    setResults([])
    setHasMore(true)
    setKnownTotalRows(null)
    setOpen(false)
    setFocusedIndex(0)
    setScrollTop(0)
    skipNextFocusRef.current = true
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return

    if (!isOpen) {
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        event.preventDefault()
        openLookup()
      }
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (results.length === 0) {
        loadMore()
        return
      }
      const nextIndex = Math.min(focusedIndex + 1, Math.max(results.length - 1, 0))
      setFocusedIndex(nextIndex)
      ensureDropdownItemVisible(listRef.current, nextIndex, LOOKUP_ROW_HEIGHT)
      if (nextIndex >= results.length - 2) {
        loadMore()
      }
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      const nextIndex = Math.max(focusedIndex - 1, 0)
      setFocusedIndex(nextIndex)
      ensureDropdownItemVisible(listRef.current, nextIndex, LOOKUP_ROW_HEIGHT)
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      setOpen(false)
      setQuery('')
      setScrollTop(0)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      const focused = results[focusedIndex]
      if (!focused) return
      handleSelect(focused)
    }
  }

  const handleLookupScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    setScrollTop(element.scrollTop)
  }

  return (
    <div
      ref={containerRef}
      className={`purchase-order-search purchase-catalog-search${isOpen ? ' open' : ''}${disabled ? ' disabled' : ''}`}
    >
      <div className="purchase-product-search-input-row">
        <input
          value={inputValue}
          onFocus={() => {
            if (skipNextFocusRef.current) {
              skipNextFocusRef.current = false
              return
            }
            openLookup()
          }}
          onChange={(event) => {
            hasTypedRef.current = true
            if (value) onClear()
            setOpen(true)
            setQuery(event.target.value)
            scheduleSearch(event.target.value)
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
        />
      </div>

      {dropMounted && (
        <div className={`purchase-order-search-dropdown ${dropExiting ? 'dropdown-rubber-exit' : 'dropdown-rubber-enter'}`}>
          {showCreateForm && renderCreateForm ? (
            renderCreateForm({
              initialName: query.trim(),
              onCreated: (entity) => {
                onSelect(entity as unknown as T)
                setShowCreateForm(false)
                hasTypedRef.current = false
                setQuery('')
                setResults([])
                setHasMore(true)
                setKnownTotalRows(null)
                setOpen(false)
                setFocusedIndex(0)
                setScrollTop(0)
                skipNextFocusRef.current = true
              },
              onCancel: () => setShowCreateForm(false),
            })
          ) : (
            <>
              {emptyHint &&
                (renderCreateForm || emptyHint.onAdd) &&
                hasTypedRef.current &&
                query.trim() !== '' &&
                !results.some((item) => item.name.toLowerCase() === query.trim().toLowerCase()) && (
                  <button
                    type="button"
                    className="purchase-order-option"
                    style={{
                      borderBottom: results.length > 0 ? '1px solid var(--border)' : undefined,
                      borderRadius: results.length > 0 ? 0 : undefined,
                    }}
                    onClick={() => {
                      if (renderCreateForm) {
                        setShowCreateForm(true)
                      } else {
                        emptyHint.onAdd?.()
                        setOpen(false)
                        setQuery('')
                      }
                    }}
                  >
                    <span className="result-title" style={{ color: 'var(--text)' }}>
                      {emptyHint.label}
                    </span>
                  </button>
                )}

              {results.length > 0 && (
                <div ref={listRef} className="purchase-lookup-scroll" onScroll={handleLookupScroll}>
                  <div style={{ height: virtualRows.offsetTop }} />
                  {Array.from(
                    { length: Math.max(virtualRows.end - virtualRows.start, 0) },
                    (_, localIndex) => {
                      const index = virtualRows.start + localIndex
                      const item = results[index]
                      if (!item) {
                        return (
                          <div
                            key={`inventory-lookup-skeleton-${index}`}
                            aria-hidden="true"
                            className="purchase-order-option virtualized-dropdown-placeholder"
                            style={{ height: LOOKUP_ROW_HEIGHT }}
                          />
                        )
                      }
                      const meta = renderMeta?.(item)
                      return (
                        <button
                          key={item.id}
                          type="button"
                          style={{ height: LOOKUP_ROW_HEIGHT }}
                          className={`purchase-order-option virtualized-dropdown-fade${item.id === value ? ' selected' : ''}${index === focusedIndex ? ' focused' : ''}`}
                          onMouseEnter={() => setFocusedIndex(index)}
                          onClick={() => handleSelect(item)}
                        >
                          <span className="result-title">{item.name}</span>
                          {meta && <span className="result-meta">{meta}</span>}
                        </button>
                      )
                    },
                  )}
                  <div style={{ height: virtualRows.offsetBottom }} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
