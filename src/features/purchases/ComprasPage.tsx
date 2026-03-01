import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type UIEvent,
  type ReactNode,
} from 'react'
import {
  createPurchaseOrder,
  fetchPurchaseOrderReceiveContext,
  fetchSuppliers,
  fetchSuppliersPaged,
  fetchWarehouses,
  fetchWarehousesPaged,
  receivePurchase,
  searchProducts,
  searchProductsPaged,
  searchPurchaseOrders,
  approvePurchaseOrder,
  cancelPurchaseOrder,
  type PurchaseOrderLookup,
  type PurchaseOrderReceiveContext,
} from '../../services/core'
import {
  DateInput,
  NumericInput,
  StatusBadge,
  EmptyState,
  PageHeader,
  Tabs,
  createVirtualDropdownWindow,
  ensureDropdownItemVisible,
  getEstimatedTotalRowCount,
} from '../../components/ui'
import { useAuth } from '../../contexts/useAuth'
import { fmtCurrency } from '../../lib/formatters'
import { useStatusToast } from '../../hooks/useStatusToast'
import { can } from '../../lib/permissions'
import { InlineCreateForm } from '../../components/InlineCreateForm'

type PurchaseItemDraft = {
  id: string
  purchase_order_item_id: string
  product_id: string
  description: string
  quantity: number
  unit_cost: number
}

type NormalizedPurchaseItem = {
  purchase_order_item_id?: string
  product_id?: string
  description: string
  quantity: number
  unit_cost: number
}

type PastedPurchaseItem = {
  description: string
  quantity: number
  unit_cost: number
}

type PurchaseProductLookup = {
  id: string
  sku: string | null
  name: string
  price: number
  cost: number
}

type SearchProductRow = Awaited<ReturnType<typeof searchProducts>>[number]

type ProductLookupFieldProps = {
  value: string
  selectedLabel: string
  warehouseId: string
  disabled?: boolean
  onSelect: (product: PurchaseProductLookup) => void
  onClear: () => void
  onDiscoverProducts: (products: PurchaseProductLookup[]) => void
  emptyHint?: { label: string; onAdd?: () => void }
  renderCreateForm?: (props: { initialName: string; onCreated: (entity: { id: string; name: string }) => void; onCancel: () => void }) => ReactNode
}

type CatalogLookupItem = { id: string; name: string }

type CatalogLookupSearchResult = {
  rows: CatalogLookupItem[]
  totalCount: number | null
}

type PurchaseDefaultsEntry = {
  supplier?: CatalogLookupItem
  warehouse?: CatalogLookupItem
}

type CatalogLookupFieldProps = {
  value: string
  selectedLabel: string
  placeholder: string
  searchCatalog: (params: {
    query: string
    offset: number
    limit: number
    signal?: AbortSignal
  }) => Promise<CatalogLookupSearchResult>
  disabled?: boolean
  onDiscoverOptions?: (options: CatalogLookupItem[]) => void
  onChange: (value: string) => void
  emptyHint?: { label: string; onAdd?: () => void }
  renderCreateForm?: (props: { initialName: string; onCreated: (entity: { id: string; name: string }) => void; onCancel: () => void }) => ReactNode
}

const LOOKUP_PAGE_SIZE = 5
const LOOKUP_ROW_HEIGHT = 46
const LOOKUP_CACHE_SCOPE_STORAGE_KEY = 'vinteenterprise.organizationId'
const PURCHASE_DEFAULTS_STORAGE_KEY = 'vinteenterprise.purchases.defaults.v1'
const productSearchCache = new Map<string, PurchaseProductLookup[]>()
const productSearchTotalCountCache = new Map<string, number>()
const supplierLookupCache = new Map<string, CatalogLookupItem[]>()
const supplierLookupTotalCountCache = new Map<string, number>()
const warehouseLookupCache = new Map<string, CatalogLookupItem[]>()
const warehouseLookupTotalCountCache = new Map<string, number>()
const purchaseOrderSearchCache = new Map<string, PurchaseOrderLookup[]>()

function createDraftNonce(prefix: 'purchase-order' | 'purchase-receive') {
  if (globalThis.crypto !== undefined && 'randomUUID' in globalThis.crypto) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function hashIdempotencyPayload(payload: unknown) {
  const raw = JSON.stringify(payload) ?? ''
  let hash = 2166136261
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.codePointAt(index) ?? 0
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return (hash >>> 0).toString(16)
}

function createLineId() {
  if (globalThis.crypto !== undefined && 'randomUUID' in globalThis.crypto) {
    return globalThis.crypto.randomUUID()
  }
  return `line-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function createEmptyItem(description = ''): PurchaseItemDraft {
  return {
    id: createLineId(),
    purchase_order_item_id: '',
    product_id: '',
    description,
    quantity: 1,
    unit_cost: 0,
  }
}

function looksLikeUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function isShortcutsHelpToggleHotkey(event: {
  ctrlKey: boolean
  metaKey: boolean
  key: string
  code?: string
}) {
  const withCommand = event.ctrlKey || event.metaKey
  return withCommand && (event.key === '/' || event.code === 'Slash')
}

function toDraftItemFromOrderContextItem(
  item: PurchaseOrderReceiveContext['items'][number],
): PurchaseItemDraft {
  return {
    id: createLineId(),
    purchase_order_item_id: item.purchaseOrderItemId,
    product_id: item.productId ?? '',
    description: item.description,
    quantity: Number(item.remainingQuantity.toFixed(4)),
    unit_cost: Number(item.unitCost ?? 0),
  }
}

function toFiniteNumber(value: number | string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function parseClipboardNumber(rawValue: string) {
  const value = rawValue.trim()
  if (!value) return null
  const normalized = value.includes(',') ? value.replaceAll('.', '').replace(',', '.') : value
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

function parsePastedPurchaseItems(raw: string): PastedPurchaseItem[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const columns = (line.includes('\t') ? line.split('\t') : line.split(';')).map((part) =>
        part.trim(),
      )
      const description = columns[0] ?? ''
      if (!description) return null
      const quantity = parseClipboardNumber(columns[1] ?? '') ?? 1
      const unitCost = parseClipboardNumber(columns[2] ?? '') ?? 0
      return {
        description,
        quantity: quantity > 0 ? quantity : 1,
        unit_cost: Math.max(unitCost, 0),
      }
    })
    .filter((item): item is PastedPurchaseItem => item !== null)
}

function normalizeLookupQuery(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
}

function getLookupCacheScope() {
  if (globalThis.window === undefined) return 'no-window'
  const organizationId = globalThis.window.localStorage
    .getItem(LOOKUP_CACHE_SCOPE_STORAGE_KEY)
    ?.trim()
  return organizationId ? organizationId : 'no-org'
}

function getPurchaseDefaultsScope(organizationId: string, userId: string | null | undefined) {
  return `${organizationId}::${userId ?? 'anonymous'}`
}

function parsePurchaseDefaults(raw: string | null): Record<string, PurchaseDefaultsEntry> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, PurchaseDefaultsEntry>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function normalizePurchaseDefaultsEntry(entry: PurchaseDefaultsEntry | undefined): PurchaseDefaultsEntry {
  if (!entry || typeof entry !== 'object') return {}
  const normalized: PurchaseDefaultsEntry = {}
  if (entry.supplier && typeof entry.supplier.id === 'string' && typeof entry.supplier.name === 'string') {
    normalized.supplier = { id: entry.supplier.id, name: entry.supplier.name }
  }
  if (entry.warehouse && typeof entry.warehouse.id === 'string' && typeof entry.warehouse.name === 'string') {
    normalized.warehouse = { id: entry.warehouse.id, name: entry.warehouse.name }
  }
  return normalized
}

function readPurchaseDefaults(scope: string): PurchaseDefaultsEntry {
  if (globalThis.window === undefined) return {}
  const raw = globalThis.window.localStorage.getItem(PURCHASE_DEFAULTS_STORAGE_KEY)
  const parsed = parsePurchaseDefaults(raw)
  return normalizePurchaseDefaultsEntry(parsed[scope])
}

function writePurchaseDefaults(scope: string, patch: Partial<PurchaseDefaultsEntry>) {
  if (globalThis.window === undefined) return
  const raw = globalThis.window.localStorage.getItem(PURCHASE_DEFAULTS_STORAGE_KEY)
  const parsed = parsePurchaseDefaults(raw)
  const current = normalizePurchaseDefaultsEntry(parsed[scope])
  const next: PurchaseDefaultsEntry = {
    supplier: patch.supplier ?? current.supplier,
    warehouse: patch.warehouse ?? current.warehouse,
  }
  parsed[scope] = next
  globalThis.window.localStorage.setItem(PURCHASE_DEFAULTS_STORAGE_KEY, JSON.stringify(parsed))
}

function formatProductOptionLabel(product: PurchaseProductLookup) {
  return product.sku ? `${product.name} • ${product.sku}` : product.name
}

function toPurchaseProductLookup(row: SearchProductRow): PurchaseProductLookup {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    price: toFiniteNumber(row.price),
    cost: toFiniteNumber(row.cost),
  }
}

function mergeProductsById(
  current: Record<string, PurchaseProductLookup>,
  products: PurchaseProductLookup[],
) {
  if (products.length === 0) return current
  const next = { ...current }
  let changed = false
  for (const product of products) {
    const previous = next[product.id]
    if (
      previous &&
      previous.name === product.name &&
      previous.sku === product.sku &&
      previous.cost === product.cost &&
      previous.price === product.price
    ) {
      continue
    }
    next[product.id] = product
    changed = true
  }
  return changed ? next : current
}

function filterCatalogOptions(options: CatalogLookupItem[], normalizedQuery: string) {
  if (!normalizedQuery) return options
  return options.filter((option) => normalizeLookupQuery(option.name).includes(normalizedQuery))
}

function mergeCatalogById(
  current: Record<string, CatalogLookupItem>,
  options: CatalogLookupItem[],
) {
  if (options.length === 0) return current
  const next = { ...current }
  let changed = false
  for (const option of options) {
    const previous = next[option.id]
    if (previous?.name === option.name) continue
    next[option.id] = option
    changed = true
  }
  return changed ? next : current
}

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

function mapOrderStatusLabel(status: string) {
  if (status === 'approved') return 'Aprovada'
  if (status === 'received') return 'Recebida'
  if (status === 'cancelled') return 'Cancelada'
  return 'Rascunho'
}

function formatOrderLookupLabel(order: PurchaseOrderLookup) {
  const supplier = order.supplierName ?? 'Fornecedor não informado'
  return `${supplier} • ${order.id.slice(0, 8)} • ${mapOrderStatusLabel(order.status)}`
}

function ProductLookupField({
  value,
  selectedLabel,
  warehouseId,
  disabled,
  onSelect,
  onClear,
  onDiscoverProducts,
  emptyHint,
  renderCreateForm,
}: ProductLookupFieldProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [knownTotalRows, setKnownTotalRows] = useState<number | null>(null)
  const [results, setResults] = useState<PurchaseProductLookup[]>([])
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
      const normalized = normalizeLookupQuery(searchValue)
      const cacheKey = `${getLookupCacheScope()}::${warehouseId || 'all'}::${normalized}::${offset}::${LOOKUP_PAGE_SIZE}`
      const totalCacheKey = `${getLookupCacheScope()}::${warehouseId || 'all'}::${normalized}`

      const applyRows = (rows: PurchaseProductLookup[], totalCount: number | null) => {
        onDiscoverProducts(rows)
        setResults((state) => mergeLookupItemsById(state, rows, { replace: options?.replace }))
        if (typeof totalCount === 'number' && Number.isFinite(totalCount)) {
          const safeTotalCount = Math.max(Math.floor(totalCount), 0)
          setKnownTotalRows(safeTotalCount)
          setHasMore(offset + rows.length < safeTotalCount)
        } else {
          if (options?.replace) {
            setKnownTotalRows(null)
          }
          setHasMore(rows.length === LOOKUP_PAGE_SIZE)
        }
        loadMoreRequestOffsetRef.current = null
      }

      const cached = productSearchCache.get(cacheKey)
      if (cached) {
        applyRows(cached, productSearchTotalCountCache.get(totalCacheKey) ?? null)
        setLoading(false)
        return
      }

      setLoading(true)
      requestControllerRef.current?.abort()
      const controller = new AbortController()
      requestControllerRef.current = controller

      try {
        const response = await searchProductsPaged(normalized, warehouseId, controller.signal, {
          limit: LOOKUP_PAGE_SIZE,
          offset,
        })
        if (typeof response.totalCount === 'number') {
          productSearchTotalCountCache.set(totalCacheKey, response.totalCount)
        }
        const mapped = response.rows.map(toPurchaseProductLookup)
        productSearchCache.set(cacheKey, mapped)
        applyRows(mapped, response.totalCount ?? productSearchTotalCountCache.get(totalCacheKey) ?? null)
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
    [onDiscoverProducts, warehouseId],
  )

  const startFreshSearch = useCallback(
    (searchValue: string) => {
      clearSearchTimeout()
      resetLookupState()
      void runSearch(searchValue, 0, { replace: true })
    },
    [clearSearchTimeout, resetLookupState, runSearch],
  )

  const scheduleFreshSearch = useCallback(
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
    const handleOutside = (event: MouseEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return
      setOpen(false)
      setQuery('')
      setFocusedIndex(0)
      setScrollTop(0)
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [isOpen])

  useEffect(() => {
    if (!disabled) return
    setOpen(false)
    setQuery('')
  }, [disabled])

  useEffect(() => {
    if (!isOpen || loading || !hasMore) return
    if (virtualRows.end < results.length) return
    loadMore()
  }, [hasMore, isOpen, loadMore, loading, results.length, virtualRows.end])

  const handleSelect = (product: PurchaseProductLookup) => {
    onDiscoverProducts([product])
    onSelect(product)
    hasTypedRef.current = false
    setQuery('')
    setResults([])
    setHasMore(true)
    setFocusedIndex(0)
    setScrollTop(0)
    setOpen(false)
    skipNextFocusRef.current = true
  }

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

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
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
    <div ref={containerRef} className={`purchase-product-search${isOpen ? ' open' : ''}`}>
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
            scheduleFreshSearch(event.target.value)
          }}
          onKeyDown={handleKeyDown}
          placeholder="Buscar produto"
          disabled={disabled}
        />
      </div>

      {isOpen && (
        <div className="purchase-product-dropdown">
          {showCreateForm && renderCreateForm ? (
            renderCreateForm({
              initialName: query.trim(),
              onCreated: (entity) => {
                onSelect({ id: entity.id, name: entity.name, sku: null, price: 0, cost: 0 } as PurchaseProductLookup)
                setShowCreateForm(false)
                hasTypedRef.current = false
                setQuery('')
                setResults([])
                setOpen(false)
                skipNextFocusRef.current = true
              },
              onCancel: () => setShowCreateForm(false),
            })
          ) : (
            <>
              {emptyHint && (renderCreateForm || emptyHint.onAdd) && hasTypedRef.current && query.trim() !== '' && !results.some((r) => r.name.toLowerCase() === query.trim().toLowerCase()) && (
                <button type="button" className="purchase-product-option" style={{ borderBottom: results.length > 0 ? '1px solid var(--border)' : undefined, borderRadius: results.length > 0 ? 0 : undefined }} onClick={() => { if (renderCreateForm) { setShowCreateForm(true) } else { emptyHint.onAdd?.(); setOpen(false); setQuery('') } }}>
                  <span className="result-title" style={{ color: 'var(--text)' }}>{emptyHint.label}</span>
                </button>
              )}
              {results.length > 0 && (
                <div
                  ref={listRef}
                  className="purchase-lookup-scroll"
                  onScroll={handleLookupScroll}
                >
                  <div style={{ height: virtualRows.offsetTop }} />
                  {Array.from({ length: Math.max(virtualRows.end - virtualRows.start, 0) }, (_, localIndex) => {
                    const index = virtualRows.start + localIndex
                    const product = results[index]
                    if (!product) {
                      return (
                        <div
                          key={`purchase-product-skeleton-${index}`}
                          aria-hidden="true"
                          className="purchase-product-option virtualized-dropdown-placeholder"
                          style={{ height: LOOKUP_ROW_HEIGHT }}
                        />
                      )
                    }
                    return (
                      <button
                        key={product.id}
                        type="button"
                        style={{ height: LOOKUP_ROW_HEIGHT }}
                        className={`purchase-product-option virtualized-dropdown-fade${product.id === value ? ' selected' : ''}${index === focusedIndex ? ' focused' : ''}`}
                        onMouseEnter={() => setFocusedIndex(index)}
                        onClick={() => handleSelect(product)}
                      >
                        <span className="result-title">{product.name}</span>
                        <span className="result-meta">
                          {product.sku ? `SKU ${product.sku} • ` : ''}Custo sugerido {fmtCurrency(product.cost)}
                        </span>
                      </button>
                    )
                  })}
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

function CatalogLookupField({
  value,
  selectedLabel,
  placeholder,
  searchCatalog,
  disabled = false,
  onDiscoverOptions,
  onChange,
  emptyHint,
  renderCreateForm,
}: CatalogLookupFieldProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [knownTotalRows, setKnownTotalRows] = useState<number | null>(null)
  const [options, setOptions] = useState<CatalogLookupItem[]>([])
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
  const inputValue = isOpen
    ? (hasTypedRef.current ? query : (query || selectedLabel))
    : selectedLabel
  const estimatedTotalRows = useMemo(
    () => (knownTotalRows !== null
      ? Math.max(Math.floor(knownTotalRows), options.length)
      : getEstimatedTotalRowCount(options.length, hasMore, LOOKUP_PAGE_SIZE)),
    [hasMore, knownTotalRows, options.length],
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
    setOptions([])
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
      optionsConfig?: {
        replace?: boolean
      },
    ) => {
      setLoading(true)
      requestControllerRef.current?.abort()
      const controller = new AbortController()
      requestControllerRef.current = controller

      try {
        const result = await searchCatalog({
          query: searchValue,
          offset,
          limit: LOOKUP_PAGE_SIZE,
          signal: controller.signal,
        })
        const rows = result.rows
        const reportedTotalCount = typeof result.totalCount === 'number' && Number.isFinite(result.totalCount)
          ? Math.max(Math.floor(result.totalCount), 0)
          : null
        onDiscoverOptions?.(rows)
        setOptions((state) => mergeLookupItemsById(state, rows, { replace: optionsConfig?.replace }))
        if (reportedTotalCount !== null) {
          setKnownTotalRows(reportedTotalCount)
          setHasMore(offset + rows.length < reportedTotalCount)
        } else {
          if (optionsConfig?.replace) {
            setKnownTotalRows(null)
          }
          setHasMore(rows.length === LOOKUP_PAGE_SIZE)
        }
        loadMoreRequestOffsetRef.current = null
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (optionsConfig?.replace) {
          setOptions([])
          setKnownTotalRows(null)
        }
        setHasMore(false)
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false)
        }
      }
    },
    [onDiscoverOptions, searchCatalog],
  )

  const startFreshSearch = useCallback(
    (searchValue: string) => {
      clearSearchTimeout()
      resetLookupState()
      void runSearch(searchValue, 0, { replace: true })
    },
    [clearSearchTimeout, resetLookupState, runSearch],
  )

  const scheduleFreshSearch = useCallback(
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
    if (loadMoreRequestOffsetRef.current === options.length) return
    loadMoreRequestOffsetRef.current = options.length
    void runSearch(query, options.length)
  }, [hasMore, loading, options.length, query, runSearch])

  useEffect(() => {
    return () => {
      clearSearchTimeout()
      requestControllerRef.current?.abort()
    }
  }, [clearSearchTimeout])

  useEffect(() => {
    if (!isOpen) return
    const handleOutside = (event: MouseEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return
      setOpen(false)
      setQuery('')
      setFocusedIndex(0)
      setScrollTop(0)
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen || loading || !hasMore) return
    if (virtualRows.end < options.length) return
    loadMore()
  }, [hasMore, isOpen, loadMore, loading, options.length, virtualRows.end])

  const openLookup = () => {
    if (disabled) return
    if (!isOpen) {
      hasTypedRef.current = false
      setOpen(true)
      setQuery('')
      startFreshSearch('')
      return
    }
    if (options.length === 0 && !loading) {
      startFreshSearch(query)
    }
  }

  const handleSelect = (option: CatalogLookupItem) => {
    onChange(option.id)
    onDiscoverOptions?.([option])
    hasTypedRef.current = false
    setQuery('')
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
      if (options.length === 0) {
        loadMore()
        return
      }
      const nextIndex = Math.min(focusedIndex + 1, Math.max(options.length - 1, 0))
      setFocusedIndex(nextIndex)
      ensureDropdownItemVisible(listRef.current, nextIndex, LOOKUP_ROW_HEIGHT)
      if (nextIndex >= options.length - 2) {
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
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      const focused = options[focusedIndex]
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
            if (value) onChange('')
            setOpen(true)
            setQuery(event.target.value)
            scheduleFreshSearch(event.target.value)
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
        />
      </div>
      {isOpen && (
        <div className="purchase-order-search-dropdown">
          {showCreateForm && renderCreateForm ? (
            renderCreateForm({
              initialName: query.trim(),
              onCreated: (entity) => {
                onChange(entity.id)
                onDiscoverOptions?.([entity])
                setShowCreateForm(false)
                hasTypedRef.current = false
                setQuery('')
                setOptions([])
                setOpen(false)
                skipNextFocusRef.current = true
              },
              onCancel: () => setShowCreateForm(false),
            })
          ) : (
            <>
              {emptyHint && (renderCreateForm || emptyHint.onAdd) && hasTypedRef.current && query.trim() !== '' && !options.some((o) => o.name.toLowerCase() === query.trim().toLowerCase()) && (
                <button type="button" className="purchase-order-option" style={{ borderBottom: options.length > 0 ? '1px solid var(--border)' : undefined, borderRadius: options.length > 0 ? 0 : undefined }} onClick={() => { if (renderCreateForm) { setShowCreateForm(true) } else { emptyHint.onAdd?.(); setOpen(false); setQuery('') } }}>
                  <span className="result-title" style={{ color: 'var(--text)' }}>{emptyHint.label}</span>
                </button>
              )}
              {options.length > 0 && (
                <div
                  ref={listRef}
                  className="purchase-lookup-scroll"
                  onScroll={handleLookupScroll}
                >
                  <div style={{ height: virtualRows.offsetTop }} />
                  {Array.from({ length: Math.max(virtualRows.end - virtualRows.start, 0) }, (_, localIndex) => {
                    const index = virtualRows.start + localIndex
                    const option = options[index]
                    if (!option) {
                      return (
                        <div
                          key={`purchase-catalog-skeleton-${index}`}
                          aria-hidden="true"
                          className="purchase-order-option virtualized-dropdown-placeholder"
                          style={{ height: LOOKUP_ROW_HEIGHT }}
                        />
                      )
                    }
                    return (
                      <button
                        key={option.id}
                        type="button"
                        style={{ height: LOOKUP_ROW_HEIGHT }}
                        className={`purchase-order-option virtualized-dropdown-fade${option.id === value ? ' selected' : ''}${index === focusedIndex ? ' focused' : ''}`}
                        onMouseEnter={() => setFocusedIndex(index)}
                        onClick={() => handleSelect(option)}
                      >
                        <span className="result-title">{option.name}</span>
                      </button>
                    )
                  })}
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

function toPayloadItem(
  item: PurchaseItemDraft,
  productById: Map<string, PurchaseProductLookup>,
): NormalizedPurchaseItem {
  const normalizedOrderLineId = item.purchase_order_item_id.trim()
  const normalizedProductId = item.product_id.trim()
  const product = normalizedProductId ? productById.get(normalizedProductId) : undefined
  const description = (item.description.trim() || product?.name) ?? ''
  return {
    purchase_order_item_id: normalizedOrderLineId || undefined,
    product_id: normalizedProductId || undefined,
    description,
    quantity: toFiniteNumber(item.quantity),
    unit_cost: Number(toFiniteNumber(item.unit_cost).toFixed(2)),
  }
}

function getItemsPreview(items: PurchaseItemDraft[], productById: Map<string, PurchaseProductLookup>) {
  return items
    .map((item) => toPayloadItem(item, productById))
    .filter((item) => item.description || item.product_id)
    .map((item) => ({
      ...item,
      quantity: Math.max(item.quantity, 0),
      unit_cost: Math.max(item.unit_cost, 0),
    }))
}

function normalizeItemsForMutation(
  items: PurchaseItemDraft[],
  productById: Map<string, PurchaseProductLookup>,
) {
  const normalized = getItemsPreview(items, productById)

  if (normalized.length === 0) {
    throw new Error('Adicione pelo menos um item antes de continuar.')
  }

  for (const [index, item] of normalized.entries()) {
    if (!item.description) {
      throw new Error(`Item ${index + 1}: informe a descrição.`)
    }
    if (item.quantity <= 0) {
      throw new Error(`Item ${index + 1}: quantidade deve ser maior que zero.`)
    }
    if (item.unit_cost < 0) {
      throw new Error(`Item ${index + 1}: custo unitário não pode ser negativo.`)
    }
  }

  return normalized
}

function getItemValidationMessages(
  item: PurchaseItemDraft,
  productById: Map<string, PurchaseProductLookup>,
  options?: {
    allowZeroQuantity?: boolean
  },
) {
  const product = item.product_id ? productById.get(item.product_id) : undefined
  const normalizedDescription = (item.description.trim() || product?.name || '').trim()
  const issues: string[] = []
  const quantity = toFiniteNumber(item.quantity)
  if (!normalizedDescription) {
    issues.push('Informe descrição ou selecione um produto válido.')
  }
  if (quantity < 0) {
    issues.push('Quantidade não pode ser negativa.')
  } else if (!options?.allowZeroQuantity && quantity <= 0) {
    issues.push('Quantidade deve ser maior que zero.')
  }
  if (toFiniteNumber(item.unit_cost) < 0) {
    issues.push('Custo unitário não pode ser negativo.')
  }
  return issues
}

function XmlImportPanel({ onImported }: { onImported: () => void }) {
  const [xmlText, setXmlText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importStatus, setImportStatus] = useState('')
  const [importResult, setImportResult] = useState<{
    importId: string
    supplierId: string | null
    supplierName: string | null
    items: Array<{ productId: string | null; description: string; quantity: number; unitCost: number }>
  } | null>(null)

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result
      if (typeof text === 'string') setXmlText(text)
    }
    reader.readAsText(file)
  }

  const handleImport = async () => {
    if (!xmlText.trim()) { setImportStatus('Selecione ou cole um XML válido.'); return }
    setImporting(true)
    setImportStatus('')
    setImportResult(null)
    try {
      const { importPurchaseXml } = await import('../../services/fiscal')
      const result = await importPurchaseXml({ xml: xmlText })
      setImportResult(result)
      setImportStatus(`Importação concluída. ${result.items.length} item(ns) identificado(s).`)
    } catch (err) {
      setImportStatus(err instanceof Error ? err.message : 'Erro ao importar XML.')
    }
    setImporting(false)
  }

  return (
    <section className="purchase-section" aria-label="Passo 4 - Importar XML">
      <div style={{ display: 'grid', gap: 12, marginTop: 8 }}>
        <label>
          Arquivo XML
          <input type="file" accept=".xml" onChange={handleFileSelect} />
        </label>

        <label>
          Ou cole o XML aqui
          <textarea
            value={xmlText}
            onChange={(e) => setXmlText(e.target.value)}
            
            style={{ minHeight: 140, fontFamily: "'Sohne Mono', monospace", fontSize: '0.78rem' }}
          />
        </label>

        <div className="actions" style={{ display: 'flex', gap: 8 }}>
          <button type="button" onClick={handleImport} disabled={importing || !xmlText.trim()}>
          {importing ? 'Processando...' : 'Importar XML'}
        </button>
          {importResult && (
            <button type="button" className="ghost" onClick={onImported}>
              Concluir
            </button>
          )}
        </div>

        <p className="subtitle purchase-feedback" style={{ visibility: importStatus ? 'visible' : 'hidden', margin: importStatus ? undefined : 0, height: importStatus ? undefined : 0, overflow: 'hidden' }}>{importStatus}</p>

        {importResult && (
          <div style={{ marginTop: 4 }}>
            {importResult.supplierName && (
              <p className="subtitle" style={{ marginBottom: 8 }}>
                Fornecedor identificado: <strong>{importResult.supplierName}</strong>
              </p>
            )}
            <div className="cadastro-list">
              {importResult.items.map((item, i) => (
                <div key={`${item.description}-${i}`} className="cadastro-row" style={{ cursor: 'default' }}>
                  <div>
                    <span className="cadastro-row-name">{item.description}</span>
                    <span className="cadastro-row-meta">
                      {' '}— Qtd: {item.quantity} · Custo: {item.unitCost.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
                    </span>
                  </div>
                  {item.productId && <span className="cadastro-row-meta">Produto vinculado</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

export function ComprasPage() {
  const { organizationId, profile, role } = useAuth()
  const userRole = role ?? 'vendedor'
  const [purchaseOrderStatus, setPurchaseOrderStatus] = useState('')
  const [purchaseReceiveStatus, setPurchaseReceiveStatus] = useState('')
  const [purchaseToast, setPurchaseToast] = useState<string | null>(null)
  useStatusToast(purchaseToast ?? '')
  
  const [catalogStatus, setCatalogStatus] = useState('')
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [orderSubmitting, setOrderSubmitting] = useState(false)
  const [receiveSubmitting, setReceiveSubmitting] = useState(false)

  const [supplierCatalogById, setSupplierCatalogById] = useState<Record<string, CatalogLookupItem>>({})
  const [warehouseCatalogById, setWarehouseCatalogById] = useState<Record<string, CatalogLookupItem>>({})
  const [hasSuppliersCatalog, setHasSuppliersCatalog] = useState(true)
  const [hasWarehousesCatalog, setHasWarehousesCatalog] = useState(true)
  const [knownProductsById, setKnownProductsById] = useState<Record<string, PurchaseProductLookup>>({})

  const [receiveOrderSearchQuery, setReceiveOrderSearchQuery] = useState('')
  const [receiveOrderSearchResults, setReceiveOrderSearchResults] = useState<PurchaseOrderLookup[]>([])
  const [receiveOrderSearchLoading, setReceiveOrderSearchLoading] = useState(false)
  const [receiveOrderSearchHasMore, setReceiveOrderSearchHasMore] = useState(true)
  const [receiveOrderSearchOpen, setReceiveOrderSearchOpen] = useState(false)
  const [receiveOrderSearchFocusedIndex, setReceiveOrderSearchFocusedIndex] = useState(0)
  const [receiveOrderSearchScrollTop, setReceiveOrderSearchScrollTop] = useState(0)

  const receiveOrderSearchContainerRef = useRef<HTMLDivElement | null>(null)
  const receiveOrderSearchListRef = useRef<HTMLDivElement | null>(null)
  const receiveOrderSearchAbortRef = useRef<AbortController | null>(null)
  const receiveOrderSearchLoadMoreOffsetRef = useRef<number | null>(null)

  const [orderDraftNonce, setOrderDraftNonce] = useState(() => createDraftNonce('purchase-order'))
  const [receiveDraftNonce, setReceiveDraftNonce] = useState(() => createDraftNonce('purchase-receive'))
  const [activeStep, setActiveStep] = useState<'order' | 'receive' | 'list' | 'xml'>('order')
  const [allOrders, setAllOrders] = useState<PurchaseOrderLookup[]>([])
  const [allOrdersLoading, setAllOrdersLoading] = useState(false)
  const [orderStatusFilter, setOrderStatusFilter] = useState<'all' | 'draft' | 'approved' | 'received'>('all')

  const [purchaseOrderForm, setPurchaseOrderForm] = useState({
    supplierId: '',
    warehouseId: '',
    notes: '',
    expectedDeliveryDate: '',
    items: [createEmptyItem()],
  })

  const [purchaseReceiveForm, setPurchaseReceiveForm] = useState({
    purchaseOrderId: '',
    supplierId: '',
    warehouseId: '',
    notes: '',
    items: [createEmptyItem()],
  })

  const [receiveContext, setReceiveContext] = useState<PurchaseOrderReceiveContext | null>(null)
  const [receiveContextLoading, setReceiveContextLoading] = useState(false)
  const [recentPendingOrders, setRecentPendingOrders] = useState<PurchaseOrderLookup[]>([])
  const [recentPendingOrdersLoading, setRecentPendingOrdersLoading] = useState(false)
  const [showOrderNotes, setShowOrderNotes] = useState(false)
  const [showReceiveNotes, setShowReceiveNotes] = useState(false)
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false)
  const purchaseDefaultsScope = useMemo(
    () => (organizationId ? getPurchaseDefaultsScope(organizationId, profile?.id) : null),
    [organizationId, profile?.id],
  )

  useEffect(() => {
    if (!purchaseToast) return
    const handle = window.setTimeout(() => setPurchaseToast(null), 2200)
    return () => window.clearTimeout(handle)
  }, [purchaseToast])

  useEffect(() => {
    const handleGlobalShortcutsHelp = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (!isShortcutsHelpToggleHotkey(event)) return
      event.preventDefault()
      setShowShortcutsHelp((state) => !state)
    }

    window.addEventListener('keydown', handleGlobalShortcutsHelp)
    return () => window.removeEventListener('keydown', handleGlobalShortcutsHelp)
  }, [])

  useEffect(() => {
    if (!organizationId) {
      setSupplierCatalogById({})
      setWarehouseCatalogById({})
      setHasSuppliersCatalog(false)
      setHasWarehousesCatalog(false)
      setCatalogLoading(false)
      setCatalogStatus('Selecione uma organização válida para carregar fornecedores e depósitos.')
      return
    }

    let cancelled = false
    setCatalogLoading(true)
    setCatalogStatus('')

    void Promise.all([
      fetchSuppliers({ limit: LOOKUP_PAGE_SIZE * 2 }),
      fetchWarehouses({ limit: LOOKUP_PAGE_SIZE * 2 }),
    ])
      .then(([supplierRows, warehouseRows]) => {
        if (cancelled) return

        const supplierOptions = supplierRows.map((supplier) => ({ id: supplier.id, name: supplier.name }))
        const warehouseOptions = warehouseRows.map((warehouse) => ({ id: warehouse.id, name: warehouse.name }))

        setSupplierCatalogById((state) => mergeCatalogById(state, supplierOptions))
        setWarehouseCatalogById((state) => mergeCatalogById(state, warehouseOptions))
        setHasSuppliersCatalog(supplierRows.length > 0)
        setHasWarehousesCatalog(warehouseRows.length > 0)

        if (warehouseRows.length === 1) {
          const warehouseId = warehouseRows[0].id
          setPurchaseOrderForm((state) =>
            state.warehouseId ? state : { ...state, warehouseId },
          )
          setPurchaseReceiveForm((state) =>
            state.warehouseId ? state : { ...state, warehouseId },
          )
        }
      })
      .catch((error) => {
        if (cancelled) return
        const message = error instanceof Error ? error.message : 'Falha ao carregar catálogos.'
        setCatalogStatus(message)
      })
      .finally(() => {
        if (!cancelled) {
          setCatalogLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [organizationId])

  const rememberSuppliers = useCallback((options: CatalogLookupItem[]) => {
    if (options.length > 0) {
      setHasSuppliersCatalog(true)
    }
    setSupplierCatalogById((state) => mergeCatalogById(state, options))
  }, [])

  const rememberWarehouses = useCallback((options: CatalogLookupItem[]) => {
    if (options.length > 0) {
      setHasWarehousesCatalog(true)
    }
    setWarehouseCatalogById((state) => mergeCatalogById(state, options))
  }, [])

  useEffect(() => {
    if (!purchaseDefaultsScope) return
    const defaults = readPurchaseDefaults(purchaseDefaultsScope)
    if (defaults.supplier) {
      rememberSuppliers([defaults.supplier])
    }
    if (defaults.warehouse) {
      rememberWarehouses([defaults.warehouse])
    }
    if (!defaults.supplier && !defaults.warehouse) return

    setPurchaseOrderForm((state) => ({
      ...state,
      supplierId: state.supplierId || defaults.supplier?.id || '',
      warehouseId: state.warehouseId || defaults.warehouse?.id || '',
    }))
    setPurchaseReceiveForm((state) => ({
      ...state,
      supplierId: state.supplierId || defaults.supplier?.id || '',
      warehouseId: state.warehouseId || defaults.warehouse?.id || '',
    }))
  }, [purchaseDefaultsScope, rememberSuppliers, rememberWarehouses])

  useEffect(() => {
    if (!purchaseDefaultsScope) return
    const supplierId = purchaseOrderForm.supplierId.trim() || purchaseReceiveForm.supplierId.trim()
    if (!supplierId) return
    const supplierName = supplierCatalogById[supplierId]?.name
    if (!supplierName) return
    writePurchaseDefaults(purchaseDefaultsScope, {
      supplier: { id: supplierId, name: supplierName },
    })
  }, [
    purchaseDefaultsScope,
    purchaseOrderForm.supplierId,
    purchaseReceiveForm.supplierId,
    supplierCatalogById,
  ])

  useEffect(() => {
    if (!purchaseDefaultsScope) return
    const warehouseId = purchaseOrderForm.warehouseId.trim() || purchaseReceiveForm.warehouseId.trim()
    if (!warehouseId) return
    const warehouseName = warehouseCatalogById[warehouseId]?.name
    if (!warehouseName) return
    writePurchaseDefaults(purchaseDefaultsScope, {
      warehouse: { id: warehouseId, name: warehouseName },
    })
  }, [
    purchaseDefaultsScope,
    purchaseOrderForm.warehouseId,
    purchaseReceiveForm.warehouseId,
    warehouseCatalogById,
  ])

  const supplierCatalogOptions = useMemo(
    () => Object.values(supplierCatalogById),
    [supplierCatalogById],
  )
  const warehouseCatalogOptions = useMemo(
    () => Object.values(warehouseCatalogById),
    [warehouseCatalogById],
  )

  const searchSuppliersCatalog = useCallback(
    async ({ query, offset, limit, signal }: { query: string; offset: number; limit: number; signal?: AbortSignal }) => {
      const normalized = normalizeLookupQuery(query)
      const cacheKey = `${getLookupCacheScope()}::${normalized}::${offset}::${limit}`
      const totalCacheKey = `${getLookupCacheScope()}::${normalized}`

      const cached = supplierLookupCache.get(cacheKey)
      if (cached && !(normalized === '' && offset === 0)) {
        return {
          rows: cached,
          totalCount: supplierLookupTotalCountCache.get(totalCacheKey) ?? null,
        }
      }

      const page = await fetchSuppliersPaged({ query: query.trim(), offset, limit, signal })
      if (typeof page.totalCount === 'number') {
        supplierLookupTotalCountCache.set(totalCacheKey, page.totalCount)
      }
      let mapped = page.rows.map((supplier) => ({ id: supplier.id, name: supplier.name }))

      if (mapped.length === 0 && supplierCatalogOptions.length > 0) {
        mapped = filterCatalogOptions(supplierCatalogOptions, normalized).slice(offset, offset + limit)
      }

      if (mapped.length > 0 || normalized !== '' || offset > 0) {
        supplierLookupCache.set(cacheKey, mapped)
      }

      return {
        rows: mapped,
        totalCount: supplierLookupTotalCountCache.get(totalCacheKey) ?? page.totalCount,
      }
    },
    [supplierCatalogOptions],
  )

  const searchWarehousesCatalog = useCallback(
    async ({ query, offset, limit, signal }: { query: string; offset: number; limit: number; signal?: AbortSignal }) => {
      const normalized = normalizeLookupQuery(query)
      const cacheKey = `${getLookupCacheScope()}::${normalized}::${offset}::${limit}`
      const totalCacheKey = `${getLookupCacheScope()}::${normalized}`

      const cached = warehouseLookupCache.get(cacheKey)
      if (cached && !(normalized === '' && offset === 0)) {
        return {
          rows: cached,
          totalCount: warehouseLookupTotalCountCache.get(totalCacheKey) ?? null,
        }
      }

      const page = await fetchWarehousesPaged({ query: query.trim(), offset, limit, signal })
      if (typeof page.totalCount === 'number') {
        warehouseLookupTotalCountCache.set(totalCacheKey, page.totalCount)
      }
      let mapped = page.rows.map((warehouse) => ({ id: warehouse.id, name: warehouse.name }))

      if (mapped.length === 0 && warehouseCatalogOptions.length > 0) {
        mapped = filterCatalogOptions(warehouseCatalogOptions, normalized).slice(offset, offset + limit)
      }

      if (mapped.length > 0 || normalized !== '' || offset > 0) {
        warehouseLookupCache.set(cacheKey, mapped)
      }

      return {
        rows: mapped,
        totalCount: warehouseLookupTotalCountCache.get(totalCacheKey) ?? page.totalCount,
      }
    },
    [warehouseCatalogOptions],
  )

  const orderSupplierLabel = purchaseOrderForm.supplierId
    ? supplierCatalogById[purchaseOrderForm.supplierId]?.name ?? ''
    : ''
  const orderWarehouseLabel = purchaseOrderForm.warehouseId
    ? warehouseCatalogById[purchaseOrderForm.warehouseId]?.name ?? ''
    : ''
  const receiveSupplierLabel = purchaseReceiveForm.supplierId
    ? supplierCatalogById[purchaseReceiveForm.supplierId]?.name ?? ''
    : ''
  const receiveWarehouseLabel = purchaseReceiveForm.warehouseId
    ? warehouseCatalogById[purchaseReceiveForm.warehouseId]?.name ?? ''
    : ''
  const normalizedReceiveOrderId = purchaseReceiveForm.purchaseOrderId.trim()
  const linkedOrderMode = Boolean(normalizedReceiveOrderId)

  const rememberProducts = useCallback((products: PurchaseProductLookup[]) => {
    setKnownProductsById((state) => mergeProductsById(state, products))
  }, [])

  const productById = useMemo(
    () => new Map(Object.values(knownProductsById).map((product) => [product.id, product] as const)),
    [knownProductsById],
  )

  const orderItemsPreview = useMemo(
    () => getItemsPreview(purchaseOrderForm.items, productById),
    [purchaseOrderForm.items, productById],
  )
  const receiveItemsPreview = useMemo(
    () => getItemsPreview(purchaseReceiveForm.items, productById),
    [purchaseReceiveForm.items, productById],
  )
  const receiveSubmissionItemsPreview = useMemo(
    () =>
      linkedOrderMode
        ? receiveItemsPreview.filter((item) => item.quantity > 0.000001)
        : receiveItemsPreview,
    [linkedOrderMode, receiveItemsPreview],
  )

  const orderTotal = useMemo(
    () => orderItemsPreview.reduce((sum, item) => sum + item.quantity * item.unit_cost, 0),
    [orderItemsPreview],
  )
  const receiveTotal = useMemo(
    () => receiveSubmissionItemsPreview.reduce((sum, item) => sum + item.quantity * item.unit_cost, 0),
    [receiveSubmissionItemsPreview],
  )

  const orderIdempotencyKey = useMemo(() => {
    const payload = {
      supplierId: purchaseOrderForm.supplierId || null,
      warehouseId: purchaseOrderForm.warehouseId || null,
      notes: purchaseOrderForm.notes.trim() || null,
      items: orderItemsPreview,
    }
    return `${orderDraftNonce}-${hashIdempotencyPayload(payload)}`
  }, [
    orderDraftNonce,
    orderItemsPreview,
    purchaseOrderForm.notes,
    purchaseOrderForm.supplierId,
    purchaseOrderForm.warehouseId,
  ])

  const receiveIdempotencyKey = useMemo(() => {
    const payload = {
      purchaseOrderId: purchaseReceiveForm.purchaseOrderId || null,
      supplierId: purchaseReceiveForm.supplierId || null,
      warehouseId: purchaseReceiveForm.warehouseId || null,
      notes: purchaseReceiveForm.notes.trim() || null,
      items: receiveSubmissionItemsPreview,
    }
    return `${receiveDraftNonce}-${hashIdempotencyPayload(payload)}`
  }, [
    purchaseReceiveForm.notes,
    purchaseReceiveForm.purchaseOrderId,
    purchaseReceiveForm.supplierId,
    purchaseReceiveForm.warehouseId,
    receiveDraftNonce,
    receiveSubmissionItemsPreview,
  ])

  const setupMissingMessages = useMemo(() => {
    const messages: string[] = []
    if (!hasSuppliersCatalog) {
      messages.push('Cadastre ao menos um fornecedor para emitir ordens de compra. Use o botão "Adicionar Fornecedor" no campo de busca.')
    }
    if (!hasWarehousesCatalog) {
      messages.push('Cadastre ao menos um depósito para compra e recebimento. Use o botão "Adicionar Depósito" no campo de busca.')
    }
    return messages
  }, [hasSuppliersCatalog, hasWarehousesCatalog])

  const orderCatalogReady = setupMissingMessages.length === 0
  const receiveWarehouseReady = hasWarehousesCatalog
  const hasReceiveSubmissionItems = receiveSubmissionItemsPreview.length > 0
  const hasPendingReceiveItems =
    receiveContext?.items.some((item) => item.remainingQuantity > 0.000001) ?? true
  const receiveReadyForSubmit =
    receiveWarehouseReady &&
    !receiveContextLoading &&
    hasReceiveSubmissionItems &&
    (!linkedOrderMode || (Boolean(receiveContext) && hasPendingReceiveItems))
  const pendingReceiveLineCount =
    receiveContext?.items.filter((item) => item.remainingQuantity > 0.000001).length ?? 0
  const receiveModeLabel = linkedOrderMode ? 'Recebimento vinculado' : 'Recebimento avulso'
  const activeSupplierLabel =
    activeStep === 'order'
      ? orderSupplierLabel || 'Não selecionado'
      : receiveSupplierLabel || 'Não selecionado'
  const activeWarehouseLabel =
    activeStep === 'order'
      ? orderWarehouseLabel || 'Não selecionado'
      : receiveWarehouseLabel || 'Não selecionado'
  const activeItemsCount =
    activeStep === 'order' ? orderItemsPreview.length : receiveSubmissionItemsPreview.length
  const activeTotalAmount = activeStep === 'order' ? orderTotal : receiveTotal

  const normalizedReceiveOrderSearchQuery = useMemo(
    () => normalizeLookupQuery(receiveOrderSearchQuery),
    [receiveOrderSearchQuery],
  )
  const shouldIncludeReceivedInSearch = useMemo(
    () => looksLikeUuid(receiveOrderSearchQuery.trim()),
    [receiveOrderSearchQuery],
  )
  const receiveOrderSearchEstimatedTotalRows = useMemo(
    () =>
      getEstimatedTotalRowCount(
        receiveOrderSearchResults.length,
        receiveOrderSearchHasMore,
        LOOKUP_PAGE_SIZE,
      ),
    [
      receiveOrderSearchHasMore,
      receiveOrderSearchResults.length,
    ],
  )
  const receiveOrderSearchVirtualRows = useMemo(
    () =>
      createVirtualDropdownWindow(
        receiveOrderSearchEstimatedTotalRows,
        receiveOrderSearchScrollTop,
        LOOKUP_ROW_HEIGHT,
      ),
    [receiveOrderSearchEstimatedTotalRows, receiveOrderSearchScrollTop],
  )

  const runReceiveOrderSearch = useCallback(
    async (
      searchValue: string,
      offset: number,
      options?: {
        replace?: boolean
      },
    ) => {
      const cacheKey = `${getLookupCacheScope()}::${shouldIncludeReceivedInSearch ? 'all' : 'pending'}::${searchValue}::${offset}::${LOOKUP_PAGE_SIZE}`

      const applyRows = (rows: PurchaseOrderLookup[]) => {
        setReceiveOrderSearchResults((state) =>
          mergeLookupItemsById(state, rows, { replace: options?.replace }),
        )
        setReceiveOrderSearchHasMore(rows.length === LOOKUP_PAGE_SIZE)
        receiveOrderSearchLoadMoreOffsetRef.current = null
      }

      const cached = purchaseOrderSearchCache.get(cacheKey)
      if (cached) {
        applyRows(cached)
        setReceiveOrderSearchLoading(false)
        return
      }

      setReceiveOrderSearchLoading(true)
      receiveOrderSearchAbortRef.current?.abort()
      const controller = new AbortController()
      receiveOrderSearchAbortRef.current = controller

      try {
        const rows = await searchPurchaseOrders(searchValue, {
          includeReceived: shouldIncludeReceivedInSearch,
          limit: LOOKUP_PAGE_SIZE,
          offset,
          signal: controller.signal,
        })
        purchaseOrderSearchCache.set(cacheKey, rows)
        applyRows(rows)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (options?.replace) {
          setReceiveOrderSearchResults([])
        }
        setReceiveOrderSearchHasMore(false)
      } finally {
        if (!controller.signal.aborted) {
          setReceiveOrderSearchLoading(false)
        }
      }
    },
    [shouldIncludeReceivedInSearch],
  )

  const loadMoreReceiveOrderSearch = useCallback(() => {
    if (receiveOrderSearchLoading || !receiveOrderSearchHasMore) return
    if (!normalizedReceiveOrderSearchQuery) return
    if (receiveOrderSearchLoadMoreOffsetRef.current === receiveOrderSearchResults.length) return
    receiveOrderSearchLoadMoreOffsetRef.current = receiveOrderSearchResults.length
    void runReceiveOrderSearch(
      normalizedReceiveOrderSearchQuery,
      receiveOrderSearchResults.length,
    )
  }, [
    normalizedReceiveOrderSearchQuery,
    receiveOrderSearchHasMore,
    receiveOrderSearchLoading,
    receiveOrderSearchResults.length,
    runReceiveOrderSearch,
  ])

  useEffect(() => {
    if (activeStep !== 'list') return
    let cancelled = false
    setAllOrdersLoading(true)
    void searchPurchaseOrders('', { includeReceived: true, limit: 30, offset: 0 })
      .then((rows) => { if (!cancelled) setAllOrders(rows) })
      .catch(() => { if (!cancelled) setAllOrders([]) })
      .finally(() => { if (!cancelled) setAllOrdersLoading(false) })
    return () => { cancelled = true }
  }, [activeStep])

  useEffect(() => {
    if (activeStep !== 'receive') return
    if (normalizedReceiveOrderSearchQuery) return
    if (linkedOrderMode) return

    let cancelled = false
    const controller = new AbortController()
    setRecentPendingOrdersLoading(true)

    void searchPurchaseOrders('', {
      includeReceived: false,
      limit: LOOKUP_PAGE_SIZE,
      offset: 0,
      signal: controller.signal,
    })
      .then((rows) => {
        if (cancelled) return
        setRecentPendingOrders(rows)
      })
      .catch((error) => {
        if (cancelled) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        setRecentPendingOrders([])
      })
      .finally(() => {
        if (!cancelled) {
          setRecentPendingOrdersLoading(false)
        }
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [activeStep, linkedOrderMode, normalizedReceiveOrderSearchQuery])

  useEffect(() => {
    if (!receiveOrderSearchOpen || receiveOrderSearchLoading || !receiveOrderSearchHasMore) return
    if (receiveOrderSearchVirtualRows.end < receiveOrderSearchResults.length) return
    loadMoreReceiveOrderSearch()
  }, [
    loadMoreReceiveOrderSearch,
    receiveOrderSearchHasMore,
    receiveOrderSearchLoading,
    receiveOrderSearchOpen,
    receiveOrderSearchResults.length,
    receiveOrderSearchVirtualRows.end,
  ])

  const handleReceiveOrderSearchScroll = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    setReceiveOrderSearchScrollTop(element.scrollTop)
  }

  useEffect(() => {
    if (!receiveOrderSearchOpen) return
    const handleOutside = (event: MouseEvent) => {
      if (receiveOrderSearchContainerRef.current?.contains(event.target as Node)) return
      setReceiveOrderSearchOpen(false)
      setReceiveOrderSearchFocusedIndex(0)
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [receiveOrderSearchOpen])

  useEffect(() => {
    if (!receiveOrderSearchOpen) return
    if (!normalizedReceiveOrderSearchQuery) {
      setReceiveOrderSearchResults([])
      setReceiveOrderSearchLoading(false)
      setReceiveOrderSearchHasMore(true)
      setReceiveOrderSearchFocusedIndex(0)
      setReceiveOrderSearchScrollTop(0)
      receiveOrderSearchLoadMoreOffsetRef.current = null
      if (receiveOrderSearchListRef.current) {
        receiveOrderSearchListRef.current.scrollTop = 0
      }
      return
    }

    const timeoutId = globalThis.setTimeout(() => {
      setReceiveOrderSearchResults([])
      setReceiveOrderSearchFocusedIndex(0)
      setReceiveOrderSearchHasMore(true)
      setReceiveOrderSearchScrollTop(0)
      receiveOrderSearchLoadMoreOffsetRef.current = null
      if (receiveOrderSearchListRef.current) {
        receiveOrderSearchListRef.current.scrollTop = 0
      }
      void runReceiveOrderSearch(normalizedReceiveOrderSearchQuery, 0, {
        replace: true,
      })
    }, 80)

    return () => {
      globalThis.clearTimeout(timeoutId)
      receiveOrderSearchAbortRef.current?.abort()
    }
  }, [
    normalizedReceiveOrderSearchQuery,
    receiveOrderSearchOpen,
    runReceiveOrderSearch,
  ])

  const getItemSelectedLabel = (item: PurchaseItemDraft) => {
    if (!item.product_id) return ''
    const product = productById.get(item.product_id)
    if (product) {
      return formatProductOptionLabel(product)
    }
    return item.description.trim()
  }

  const loadReceiveContext = async (
    orderIdOverride?: string,
    options?: {
      suppressInfoToast?: boolean
    },
  ) => {
    const normalizedOrderId = (orderIdOverride ?? purchaseReceiveForm.purchaseOrderId).trim()

    if (!normalizedOrderId) {
      setReceiveContext(null)
      setPurchaseReceiveStatus('')
      return
    }
    if (!looksLikeUuid(normalizedOrderId)) {
      throw new Error('ID da ordem inválido. Informe um UUID válido.')
    }

    setReceiveContextLoading(true)

    try {
      const context = await fetchPurchaseOrderReceiveContext(normalizedOrderId)
      const pendingItems = context.items.filter((item) => item.remainingQuantity > 0.000001)

      if (context.supplierId && context.supplierName) {
        rememberSuppliers([{ id: context.supplierId, name: context.supplierName }])
      }
      if (context.warehouseId && context.warehouseName) {
        rememberWarehouses([{ id: context.warehouseId, name: context.warehouseName }])
      }

      setReceiveContext(context)
      setReceiveOrderSearchQuery(
        `${context.supplierName ?? 'Fornecedor não informado'} • ${context.orderId.slice(0, 8)} • ${mapOrderStatusLabel(context.status)}`,
      )
      setPurchaseReceiveForm((state) => ({
        ...state,
        purchaseOrderId: context.orderId,
        supplierId: context.supplierId ?? state.supplierId,
        warehouseId: context.warehouseId ?? state.warehouseId,
        items:
          pendingItems.length > 0
            ? pendingItems.map((item) => toDraftItemFromOrderContextItem(item))
            : [createEmptyItem('Sem saldo pendente')],
      }))

      if (pendingItems.length === 0) {
        setPurchaseReceiveStatus('')
        if (!options?.suppressInfoToast) {
          setPurchaseToast('Esta ordem já foi recebida. Não há saldo pendente.')
        }
        return
      }

      setPurchaseReceiveStatus('')
      if (!options?.suppressInfoToast) {
        setPurchaseToast(
          `Ordem carregada: ${pendingItems.length} item(ns) pendente(s) para recebimento.`,
        )
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao carregar ordem de compra.'
      setReceiveContext(null)
      setPurchaseReceiveStatus(message)
      throw error
    } finally {
      setReceiveContextLoading(false)
    }
  }

  const handleSelectReceiveOrder = async (order: PurchaseOrderLookup) => {
    setReceiveOrderSearchQuery(formatOrderLookupLabel(order))
    setReceiveOrderSearchOpen(false)
    setReceiveOrderSearchFocusedIndex(0)
    setReceiveOrderSearchScrollTop(0)
    setReceiveOrderSearchResults([])

    setPurchaseReceiveForm((state) => ({
      ...state,
      purchaseOrderId: order.id,
      supplierId: order.supplierId ?? state.supplierId,
      warehouseId: order.warehouseId ?? state.warehouseId,
    }))

    try {
      await loadReceiveContext(order.id)
    } catch {
      // feedback is already handled by loadReceiveContext
    }
  }

  const linkReceiveOrderByUuid = (rawValue: string) => {
    const normalizedOrderId = rawValue.trim()
    if (!looksLikeUuid(normalizedOrderId)) return false

    setReceiveContext(null)
    setReceiveOrderSearchOpen(false)
    setReceiveOrderSearchFocusedIndex(0)
    setReceiveOrderSearchScrollTop(0)
    setReceiveOrderSearchResults([])
    receiveOrderSearchLoadMoreOffsetRef.current = null
    setPurchaseReceiveForm((state) => ({
      ...state,
      purchaseOrderId: normalizedOrderId,
    }))
    void loadReceiveContext(normalizedOrderId).catch(() => {
      // feedback is already handled by loadReceiveContext
    })
    return true
  }

  const handleReceiveOrderSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const hasTypedUuid = looksLikeUuid(receiveOrderSearchQuery.trim())

    if (!receiveOrderSearchOpen) {
      if (event.key === 'Enter' && hasTypedUuid) {
        event.preventDefault()
        linkReceiveOrderByUuid(receiveOrderSearchQuery)
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'Enter') {
        event.preventDefault()
        setReceiveOrderSearchOpen(true)
      }
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (receiveOrderSearchResults.length === 0) {
        loadMoreReceiveOrderSearch()
        return
      }
      const nextIndex = Math.min(
        receiveOrderSearchFocusedIndex + 1,
        Math.max(receiveOrderSearchResults.length - 1, 0),
      )
      setReceiveOrderSearchFocusedIndex(nextIndex)
      ensureDropdownItemVisible(
        receiveOrderSearchListRef.current,
        nextIndex,
        LOOKUP_ROW_HEIGHT,
      )
      if (nextIndex >= receiveOrderSearchResults.length - 2) {
        loadMoreReceiveOrderSearch()
      }
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      const nextIndex = Math.max(receiveOrderSearchFocusedIndex - 1, 0)
      setReceiveOrderSearchFocusedIndex(nextIndex)
      ensureDropdownItemVisible(
        receiveOrderSearchListRef.current,
        nextIndex,
        LOOKUP_ROW_HEIGHT,
      )
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      setReceiveOrderSearchOpen(false)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      const focused = receiveOrderSearchResults[receiveOrderSearchFocusedIndex]
      if (focused) {
        void handleSelectReceiveOrder(focused)
        return
      }
      if (hasTypedUuid) {
        linkReceiveOrderByUuid(receiveOrderSearchQuery)
      }
    }
  }

  const updateOrderItem = (itemId: string, patch: Partial<Omit<PurchaseItemDraft, 'id'>>) => {
    setPurchaseOrderForm((state) => ({
      ...state,
      items: state.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
    }))
  }

  const updateReceiveItem = (itemId: string, patch: Partial<Omit<PurchaseItemDraft, 'id'>>) => {
    setPurchaseReceiveForm((state) => ({
      ...state,
      items: state.items.map((item) => (item.id === itemId ? { ...item, ...patch } : item)),
    }))
  }

  const handleOrderProductChange = (itemId: string, productId: string) => {
    const product = productId ? productById.get(productId) : undefined
    setPurchaseOrderForm((state) => ({
      ...state,
      items: state.items.map((item) => {
        if (item.id !== itemId) return item
        return {
          ...item,
          product_id: productId,
          description: item.description.trim() || product?.name || '',
          unit_cost: item.unit_cost > 0 ? item.unit_cost : toFiniteNumber(product?.cost ?? 0),
        }
      }),
    }))
  }

  const handleOrderProductSelect = (itemId: string, product: PurchaseProductLookup) => {
    rememberProducts([product])
    handleOrderProductChange(itemId, product.id)
  }

  const clearOrderProduct = (itemId: string) => {
    setPurchaseOrderForm((state) => ({
      ...state,
      items: state.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              product_id: '',
            }
          : item,
      ),
    }))
  }

  const handleReceiveProductChange = (itemId: string, productId: string) => {
    const product = productId ? productById.get(productId) : undefined
    setPurchaseReceiveForm((state) => ({
      ...state,
      items: state.items.map((item) => {
        if (item.id !== itemId) return item
        return {
          ...item,
          purchase_order_item_id: productId === item.product_id ? item.purchase_order_item_id : '',
          product_id: productId,
          description: item.description.trim() || product?.name || '',
          unit_cost: item.unit_cost > 0 ? item.unit_cost : toFiniteNumber(product?.cost ?? 0),
        }
      }),
    }))
  }

  const handleReceiveProductSelect = (itemId: string, product: PurchaseProductLookup) => {
    rememberProducts([product])
    handleReceiveProductChange(itemId, product.id)
  }

  const clearReceiveProduct = (itemId: string) => {
    setPurchaseReceiveForm((state) => ({
      ...state,
      items: state.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              purchase_order_item_id: '',
              product_id: '',
            }
          : item,
      ),
    }))
  }

  const addOrderItem = () => {
    setPurchaseOrderForm((state) => ({
      ...state,
      items: [...state.items, createEmptyItem()],
    }))
  }

  const addReceiveItem = () => {
    setPurchaseReceiveForm((state) => ({
      ...state,
      items: [...state.items, createEmptyItem()],
    }))
  }

  const insertOrderItemAfter = (itemId: string) => {
    setPurchaseOrderForm((state) => {
      const index = state.items.findIndex((item) => item.id === itemId)
      if (index < 0) return state
      const nextItems = [...state.items]
      nextItems.splice(index + 1, 0, createEmptyItem())
      return {
        ...state,
        items: nextItems,
      }
    })
  }

  const insertReceiveItemAfter = (itemId: string) => {
    setPurchaseReceiveForm((state) => {
      const index = state.items.findIndex((item) => item.id === itemId)
      if (index < 0) return state
      const nextItems = [...state.items]
      nextItems.splice(index + 1, 0, createEmptyItem())
      return {
        ...state,
        items: nextItems,
      }
    })
  }

  const duplicateOrderItem = (itemId: string) => {
    setPurchaseOrderForm((state) => {
      const index = state.items.findIndex((item) => item.id === itemId)
      if (index < 0) return state
      const currentItem = state.items[index]
      const duplicatedItem: PurchaseItemDraft = {
        ...currentItem,
        id: createLineId(),
      }
      const nextItems = [...state.items]
      nextItems.splice(index + 1, 0, duplicatedItem)
      return {
        ...state,
        items: nextItems,
      }
    })
  }

  const duplicateReceiveItem = (itemId: string) => {
    setPurchaseReceiveForm((state) => {
      const index = state.items.findIndex((item) => item.id === itemId)
      if (index < 0) return state
      const currentItem = state.items[index]
      const duplicatedItem: PurchaseItemDraft = {
        ...currentItem,
        id: createLineId(),
      }
      const nextItems = [...state.items]
      nextItems.splice(index + 1, 0, duplicatedItem)
      return {
        ...state,
        items: nextItems,
      }
    })
  }

  const removeOrderItem = (itemId: string) => {
    setPurchaseOrderForm((state) => ({
      ...state,
      items: state.items.length <= 1 ? state.items : state.items.filter((item) => item.id !== itemId),
    }))
  }

  const removeReceiveItem = (itemId: string) => {
    setPurchaseReceiveForm((state) => ({
      ...state,
      items: state.items.length <= 1 ? state.items : state.items.filter((item) => item.id !== itemId),
    }))
  }

  const clearReceiveItemQuantities = () => {
    setPurchaseReceiveForm((state) => ({
      ...state,
      items: state.items.map((item) => ({
        ...item,
        quantity: 0,
      })),
    }))
  }

  const applyPastedOrderItems = (itemId: string, pastedItems: PastedPurchaseItem[]) => {
    if (pastedItems.length === 0) return

    setPurchaseOrderForm((state) => {
      const targetIndex = state.items.findIndex((item) => item.id === itemId)
      if (targetIndex < 0) return state

      const targetItem = state.items[targetIndex]
      const mappedItems: PurchaseItemDraft[] = pastedItems.map((pastedItem, pastedIndex) => {
        if (pastedIndex === 0) {
          return {
            ...targetItem,
            purchase_order_item_id: '',
            product_id: '',
            description: pastedItem.description,
            quantity: pastedItem.quantity,
            unit_cost: pastedItem.unit_cost,
          }
        }

        return {
          ...createEmptyItem(),
          description: pastedItem.description,
          quantity: pastedItem.quantity,
          unit_cost: pastedItem.unit_cost,
        }
      })

      const nextItems = [...state.items]
      nextItems.splice(targetIndex, 1, ...mappedItems)

      return {
        ...state,
        items: nextItems,
      }
    })

    setPurchaseOrderStatus(
      ''
    )
    setPurchaseToast(
      pastedItems.length === 1
        ? 'Item atualizado via colagem.'
        : `${pastedItems.length} itens colados. Revise os valores antes de salvar.`,
    )
  }

  const handleOrderItemsPaste = (event: ClipboardEvent<HTMLInputElement>, itemId: string) => {
    const clipboardText = event.clipboardData.getData('text/plain')
    const likelyTablePaste =
      clipboardText.includes('\t') || clipboardText.includes('\n') || clipboardText.includes(';')
    if (!likelyTablePaste) return

    const pastedItems = parsePastedPurchaseItems(clipboardText)
    if (pastedItems.length === 0) return

    event.preventDefault()
    applyPastedOrderItems(itemId, pastedItems)
  }

  const handleOrderItemHotkeys = (
    event: KeyboardEvent<HTMLInputElement>,
    itemId: string,
    itemIndex: number,
    options?: {
      appendOnEnter?: boolean
    },
  ) => {
    const withCommand = event.ctrlKey || event.metaKey
    if (isShortcutsHelpToggleHotkey(event)) {
      event.preventDefault()
      setShowShortcutsHelp((state) => !state)
      return
    }
    if (withCommand && !event.shiftKey && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      duplicateOrderItem(itemId)
      return
    }
    if (withCommand && !event.shiftKey && event.key === 'Backspace') {
      event.preventDefault()
      removeOrderItem(itemId)
      return
    }
    if (event.shiftKey && event.key === 'Enter') {
      event.preventDefault()
      insertOrderItemAfter(itemId)
      return
    }
    if (!options?.appendOnEnter || event.key !== 'Enter' || event.shiftKey) return
    if (itemIndex !== purchaseOrderForm.items.length - 1) return
    event.preventDefault()
    addOrderItem()
  }

  const handleReceiveItemHotkeys = (
    event: KeyboardEvent<HTMLInputElement>,
    itemId: string,
    itemIndex: number,
    options?: {
      appendOnEnter?: boolean
    },
  ) => {
    const withCommand = event.ctrlKey || event.metaKey
    if (isShortcutsHelpToggleHotkey(event)) {
      event.preventDefault()
      setShowShortcutsHelp((state) => !state)
      return
    }
    if (withCommand && !event.shiftKey && event.key.toLowerCase() === 'd') {
      if (receiveContext) return
      event.preventDefault()
      duplicateReceiveItem(itemId)
      return
    }
    if (withCommand && !event.shiftKey && event.key === 'Backspace') {
      event.preventDefault()
      removeReceiveItem(itemId)
      return
    }
    if (event.shiftKey && event.key === 'Enter') {
      if (receiveContext) return
      event.preventDefault()
      insertReceiveItemAfter(itemId)
      return
    }
    if (!options?.appendOnEnter || event.key !== 'Enter' || event.shiftKey) return
    if (receiveContext || itemIndex !== purchaseReceiveForm.items.length - 1) return
    event.preventDefault()
    addReceiveItem()
  }

  const clearLinkedOrder = () => {
    receiveOrderSearchAbortRef.current?.abort()
    setReceiveContext(null)
    setReceiveOrderSearchQuery('')
    setReceiveOrderSearchOpen(false)
    setReceiveOrderSearchLoading(false)
    setReceiveOrderSearchHasMore(true)
    setReceiveOrderSearchFocusedIndex(0)
    setReceiveOrderSearchScrollTop(0)
    setReceiveOrderSearchResults([])
    setPurchaseReceiveForm((state) => ({
      ...state,
      purchaseOrderId: '',
      items: [createEmptyItem()],
    }))
    setPurchaseReceiveStatus('')
  }

  const fillReceiveItemsWithPending = () => {
    if (!receiveContext) return
    const pendingItems = receiveContext.items.filter((item) => item.remainingQuantity > 0.000001)
    if (pendingItems.length === 0) return
    setPurchaseReceiveForm((state) => ({
      ...state,
      items: pendingItems.map((item) => toDraftItemFromOrderContextItem(item)),
    }))
  }

  const handleCreatePurchaseOrder = async () => {
    if (orderSubmitting) return

    setOrderSubmitting(true)

    try {
      const normalizedSupplierId = purchaseOrderForm.supplierId.trim()
      const normalizedWarehouseId = purchaseOrderForm.warehouseId.trim()
      const normalizedNotes = purchaseOrderForm.notes.trim()

      if (!orderCatalogReady) {
        throw new Error('Cadastre fornecedor e depósito antes de emitir ordens de compra.')
      }
      if (!normalizedSupplierId) {
        throw new Error('Selecione um fornecedor para salvar a ordem de compra.')
      }
      if (hasWarehousesCatalog && !normalizedWarehouseId) {
        throw new Error('Selecione o depósito de destino da compra.')
      }

      const items = normalizeItemsForMutation(purchaseOrderForm.items, productById)

      const payload = {
        supplierId: normalizedSupplierId,
        warehouseId: normalizedWarehouseId,
        notes: normalizedNotes || undefined,
        items,
      }

      const result = await createPurchaseOrder(payload, {
        idempotencyKey: orderIdempotencyKey,
      })

      setPurchaseOrderStatus('')
      setPurchaseToast(
        `Ordem criada: ${result.orderId} • Total ${fmtCurrency(result.totalAmount)}`,
      )

      setPurchaseReceiveForm((state) => ({
        ...state,
        purchaseOrderId: result.orderId,
        supplierId: payload.supplierId,
        warehouseId: payload.warehouseId,
        items: items.map((item) => ({
          id: createLineId(),
          purchase_order_item_id: '',
          product_id: item.product_id ?? '',
          description: item.description,
          quantity: item.quantity,
          unit_cost: item.unit_cost,
        })),
      }))

      setPurchaseOrderForm((state) => ({
        ...state,
        notes: '',
        items: [createEmptyItem()],
      }))
      setShowOrderNotes(false)
      setOrderDraftNonce(createDraftNonce('purchase-order'))
      setActiveStep('receive')
      await loadReceiveContext(result.orderId, { suppressInfoToast: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao criar ordem de compra.'
      setPurchaseOrderStatus(message)
    } finally {
      setOrderSubmitting(false)
    }
  }

  const handleReceivePurchase = async () => {
    if (receiveSubmitting) return

    setReceiveSubmitting(true)

    try {
      const normalizedWarehouseId = purchaseReceiveForm.warehouseId.trim()
      if (!receiveWarehouseReady) {
        throw new Error('Cadastre ao menos um depósito para registrar recebimentos.')
      }
      if (!normalizedWarehouseId) {
        throw new Error('Selecione um depósito para registrar o recebimento.')
      }

      const normalizedPurchaseOrderId = purchaseReceiveForm.purchaseOrderId.trim()
      const normalizedSupplierId = purchaseReceiveForm.supplierId.trim()
      const normalizedNotes = purchaseReceiveForm.notes.trim()

      if (!normalizedPurchaseOrderId && !normalizedSupplierId) {
        throw new Error('Informe uma ordem de compra ou selecione o fornecedor para o recebimento.')
      }

      if (normalizedPurchaseOrderId && receiveContext?.orderId !== normalizedPurchaseOrderId) {
        throw new Error('Carregue a ordem vinculada antes de confirmar o recebimento.')
      }

      const receiveItemsDraft = linkedOrderMode
        ? purchaseReceiveForm.items.filter((item) => toFiniteNumber(item.quantity) > 0.000001)
        : purchaseReceiveForm.items

      if (linkedOrderMode && receiveItemsDraft.length === 0) {
        throw new Error('Informe quantidade maior que zero em pelo menos uma linha pendente.')
      }

      const items = normalizeItemsForMutation(receiveItemsDraft, productById)

      const payload = {
        purchaseOrderId: normalizedPurchaseOrderId || undefined,
        supplierId: normalizedSupplierId || undefined,
        warehouseId: normalizedWarehouseId,
        notes: normalizedNotes || undefined,
        items,
      }

      const result = await receivePurchase(payload, {
        idempotencyKey: receiveIdempotencyKey,
      })

      setPurchaseReceiveStatus('')
      setPurchaseToast(
        `Entrada criada: ${result.receiptId} • Total ${fmtCurrency(result.totalAmount)}`,
      )

      if (normalizedPurchaseOrderId) {
        await loadReceiveContext(normalizedPurchaseOrderId, { suppressInfoToast: true })
        setReceiveDraftNonce(createDraftNonce('purchase-receive'))
        return
      }

      setPurchaseReceiveForm((state) => ({
        ...state,
        notes: '',
        items: [createEmptyItem()],
      }))
      setShowReceiveNotes(false)
      setReceiveContext(null)
      setReceiveDraftNonce(createDraftNonce('purchase-receive'))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao registrar entrada.'
      setPurchaseReceiveStatus(message)
    } finally {
      setReceiveSubmitting(false)
    }
  }

  return (
    <div className="page-grid">
    <PageHeader />
    <div className="card fiscal-card purchase-flow-card">

      {purchaseToast && (
        <div className="quick-toast" role="status" aria-live="polite">
          {purchaseToast}
        </div>
      )}

      <Tabs
        tabs={[
          { key: 'order' as const, label: 'Emissão de Pedido' },
          { key: 'receive' as const, label: 'Entrada de Mercadoria' },
          { key: 'list' as const, label: 'Histórico' },
          { key: 'xml' as const, label: 'Importação XML' },
        ]}
        active={activeStep}
        onChange={(k) => setActiveStep(k as typeof activeStep)}
      />

      {showShortcutsHelp && (
        <div className="purchase-shortcuts-panel">
          <strong>Atalhos de itens</strong>
          <ul>
            <li>Enter: adiciona nova linha ao sair do último custo.</li>
            <li>Shift+Enter: insere linha abaixo da atual.</li>
            <li>Ctrl/Cmd+D: duplica linha atual.</li>
            <li>Ctrl/Cmd+Backspace: remove linha atual.</li>
            <li>Ctrl/Cmd+/: mostrar ou ocultar esta ajuda.</li>
          </ul>
        </div>
      )}

      {activeStep === 'order' && (
        <section className="purchase-section" aria-label="Passo 1 - Ordem de compra">
          <div className="fiscal-grid">
            <label>
              Fornecedor
              <CatalogLookupField
                value={purchaseOrderForm.supplierId}
                selectedLabel={orderSupplierLabel}
                placeholder="Buscar fornecedor"
                searchCatalog={searchSuppliersCatalog}
                onDiscoverOptions={rememberSuppliers}
                onChange={(value) =>
                  setPurchaseOrderForm((state) => ({ ...state, supplierId: value }))
                }
                emptyHint={{ label: 'Adicionar Fornecedor' }}
                renderCreateForm={(props) => <InlineCreateForm type="supplier" {...props} />}
              />
            </label>
            <label>
              Depósito de destino
              <CatalogLookupField
                value={purchaseOrderForm.warehouseId}
                selectedLabel={orderWarehouseLabel}
                placeholder="Buscar depósito"
                searchCatalog={searchWarehousesCatalog}
                onDiscoverOptions={rememberWarehouses}
                onChange={(value) =>
                  setPurchaseOrderForm((state) => ({ ...state, warehouseId: value }))
                }
                emptyHint={{ label: 'Adicionar Depósito' }}
                renderCreateForm={(props) => <InlineCreateForm type="warehouse" {...props} />}
              />
            </label>
            {showOrderNotes || purchaseOrderForm.notes.trim() !== '' ? (
              <label>
                Observações (opcional)
                <input
                  value={purchaseOrderForm.notes}
                  onChange={(event) =>
                    setPurchaseOrderForm((state) => ({ ...state, notes: event.target.value }))
                  }
                  placeholder="Condições comerciais, prazo ou observações"
                />
              </label>
            ) : (
              <button
                type="button"
                className="ghost purchase-inline-toggle"
                onClick={() => setShowOrderNotes(true)}
              >
                Adicionar observações
              </button>
            )}
            <label>
              Prazo de entrega (opcional)
              <DateInput
                value={purchaseOrderForm.expectedDeliveryDate}
                onChange={(event) =>
                  setPurchaseOrderForm((state) => ({ ...state, expectedDeliveryDate: event.target.value }))
                }
              />
            </label>
          </div>

          <div className="purchase-items">
            {purchaseOrderForm.items.map((item, itemIndex) => {
              const itemIssues = getItemValidationMessages(item, productById)
              return (
                <div key={item.id} className="purchase-item-row">
                  <div className="fiscal-grid">
                    <label>
                      Produto (opcional)
                      <ProductLookupField
                        value={item.product_id}
                        selectedLabel={getItemSelectedLabel(item)}
                        warehouseId={purchaseOrderForm.warehouseId}
                        onSelect={(product) => handleOrderProductSelect(item.id, product)}
                        onClear={() => clearOrderProduct(item.id)}
                        onDiscoverProducts={rememberProducts}
                        emptyHint={{ label: 'Adicionar Produto' }}
                        renderCreateForm={(props) => <InlineCreateForm type="product" {...props} />}
                      />
                    </label>
                    <label>
                      Descrição
                      <input
                        value={item.description}
                        onPaste={(event) => handleOrderItemsPaste(event, item.id)}
                        onKeyDown={(event) => handleOrderItemHotkeys(event, item.id, itemIndex)}
                        onChange={(event) =>
                          updateOrderItem(item.id, { description: event.target.value })
                        }
                        placeholder="Descrição comercial do item"
                      />
                    </label>
                    <label>
                      Quantidade
                      <NumericInput
                        value={item.quantity}
                        onKeyDown={(event) => handleOrderItemHotkeys(event, item.id, itemIndex)}
                        onChange={(event) =>
                          updateOrderItem(item.id, {
                            quantity: Math.max(toFiniteNumber(event.target.value), 0),
                          })
                        }
                      />
                    </label>
                    <label>
                      Custo unitário
                      <NumericInput
                        value={item.unit_cost}
                        currency
                        onKeyDown={(event) =>
                          handleOrderItemHotkeys(event, item.id, itemIndex, {
                            appendOnEnter: true,
                          })
                        }
                        onChange={(event) =>
                          updateOrderItem(item.id, {
                            unit_cost: Math.max(toFiniteNumber(event.target.value), 0),
                          })
                        }
                      />
                    </label>
                  </div>
                  {itemIssues.length > 0 && (
                    <div className="purchase-item-issues">
                      {itemIssues.map((issue) => (
                        <span key={issue} className="hint">{issue}</span>
                      ))}
                    </div>
                  )}
                  <div className="actions">
                    <span className="hint">
                      Subtotal: {fmtCurrency(Math.max(item.quantity, 0) * Math.max(item.unit_cost, 0))}
                    </span>
                    <button
                      type="button"
                      className="ghost"
                      disabled={purchaseOrderForm.items.length <= 1}
                      onClick={() => removeOrderItem(item.id)}
                    >
                      Remover item
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="purchase-totals">
            
            <strong>Total estimado: {fmtCurrency(orderTotal)}</strong>
          </div>

          <div className="actions">
            <button type="button" className="ghost" onClick={addOrderItem}>
              Adicionar item
            </button>
          </div>

          <p className="subtitle purchase-feedback" style={{ visibility: purchaseOrderStatus ? 'visible' : 'hidden', margin: purchaseOrderStatus ? undefined : 0, height: purchaseOrderStatus ? undefined : 0, overflow: 'hidden' }}>{purchaseOrderStatus}</p>

          <div className="actions" style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 16, justifyContent: 'space-between' }}>
            <button
              type="button"
              className="ghost"
              aria-expanded={showShortcutsHelp}
              onClick={() => setShowShortcutsHelp((state) => !state)}
            >
              Atalhos de teclado [?]
            </button>
            <button
              type="button"
              className="purchase-summary-action"
              onClick={() => void handleCreatePurchaseOrder()}
              disabled={orderSubmitting || !orderCatalogReady}
            >
              {orderSubmitting ? 'Processando...' : 'Confirmar ordem'}
            </button>
          </div>
        </section>
      )}

      {activeStep === 'list' && (
        <section className="purchase-section" aria-label="Passo 3 - Pedidos">
          <div className="cadastro-toolbar" style={{ marginBottom: 10 }}>
            <span style={{ flex: 1 }}>{allOrders.length} pedido(s)</span>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {(['all', 'draft', 'approved', 'received'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`purchase-step-pill${orderStatusFilter === s ? ' active' : ''}`}
                  style={{ fontSize: '0.78rem', padding: '4px 10px' }}
                  onClick={() => setOrderStatusFilter(s)}
                >
                  {s === 'all' ? 'Todos' : s === 'draft' ? 'Rascunho' : s === 'approved' ? 'Aprovados' : 'Recebidos'}
                </button>
              ))}
              <button
                type="button"
                className="ghost"
                style={{ fontSize: '0.78rem', padding: '4px 10px' }}
                disabled={allOrders.length === 0}
                onClick={() => {
                  const filtered = allOrders.filter((o) => orderStatusFilter === 'all' || o.status === orderStatusFilter)
                  if (filtered.length === 0 || globalThis.window === undefined) return
                  const header = 'id;fornecedor;deposito;status;total;criado_em\n'
                  const lines = filtered.map((o) => [
                    o.id.slice(0, 8),
                    o.supplierName ?? '',
                    o.warehouseName ?? '',
                    mapOrderStatusLabel(o.status),
                    Number(o.totalAmount).toFixed(2),
                    new Date(o.createdAt).toLocaleDateString('pt-BR'),
                  ].map((c) => `"${String(c).replaceAll('"', '""')}"`).join(';'))
                  const blob = new Blob([header + lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
                  const url = globalThis.URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = `pedidos-compra-${Date.now()}.csv`
                  document.body.appendChild(a)
                  a.click()
                  a.remove()
                  globalThis.URL.revokeObjectURL(url)
                }}
              >
                Exportar CSV
              </button>
            </div>
          </div>
          
          <div className="cadastro-list">
            {allOrders
              .filter((o) => orderStatusFilter === 'all' || o.status === orderStatusFilter)
              .map((o) => (
                <div key={o.id} className="cadastro-row">
                  <div>
                    <span className="cadastro-row-name">{o.supplierName ?? 'Fornecedor'}</span>
                    <span className="cadastro-row-meta"> — {o.warehouseName ?? ''} — {fmtCurrency(o.totalAmount)}</span>
                  </div>
                  <div className="row-actions">
                    <StatusBadge status={o.status} />
                    {o.status === 'draft' && (
                      <>
                        {can(userRole, 'purchase.order.approve') && (
                          <button type="button" className="btn-inline ok" onClick={async () => {
                            try {
                              await approvePurchaseOrder(o.id)
                              setAllOrders((prev) => prev.map((x) => x.id === o.id ? { ...x, status: 'approved' } : x))
                            } catch (e) { setPurchaseToast(e instanceof Error ? e.message : 'Erro.') }
                          }}>Aprovar</button>
                        )}
                        {can(userRole, 'purchase.order.cancel') && (
                          <button type="button" className="btn-inline off" onClick={async () => {
                            try {
                              await cancelPurchaseOrder(o.id)
                              setAllOrders((prev) => prev.map((x) => x.id === o.id ? { ...x, status: 'cancelled' } : x))
                            } catch (e) { setPurchaseToast(e instanceof Error ? e.message : 'Erro.') }
                          }}>Cancelar</button>
                        )}
                      </>
                    )}
                    {o.status === 'approved' && (
                      <button type="button" className="btn-inline" onClick={() => {
                        setActiveStep('receive')
                        setReceiveOrderSearchQuery(o.id)
                      }}>Receber</button>
                    )}
                  </div>
                </div>
              ))}
            {allOrders.filter((o) => orderStatusFilter === 'all' || o.status === orderStatusFilter).length === 0 && (
              <EmptyState />
            )}
          </div>
        </section>
      )}

      {activeStep === 'receive' && (
        <section className="purchase-section" aria-label="Passo 2 - Recebimento">
          <div className="fiscal-grid">
            <label className="purchase-order-lookup">
              Vincular ordem de compra (opcional)
              <div ref={receiveOrderSearchContainerRef} className="purchase-order-search">
                <input
                  value={receiveOrderSearchQuery}
                  onFocus={() => setReceiveOrderSearchOpen(true)}
                  onChange={(event) => {
                    const nextValue = event.target.value
                    setReceiveOrderSearchQuery(nextValue)
                    setReceiveOrderSearchOpen(true)
                    if (purchaseReceiveForm.purchaseOrderId) {
                      setReceiveContext(null)
                      setPurchaseReceiveForm((state) => ({
                        ...state,
                        purchaseOrderId: '',
                      }))
                    }
                  }}
                  onKeyDown={handleReceiveOrderSearchKeyDown}
                  placeholder="Buscar ordem pendente ou colar UUID"
                />
                {receiveOrderSearchOpen && (
                  <div className="purchase-order-search-dropdown">
                    {receiveOrderSearchResults.length > 0 && (
                      <div
                        ref={receiveOrderSearchListRef}
                        className="purchase-lookup-scroll"
                        onScroll={handleReceiveOrderSearchScroll}
                      >
                        <div style={{ height: receiveOrderSearchVirtualRows.offsetTop }} />
                        {Array.from(
                          {
                            length: Math.max(
                              receiveOrderSearchVirtualRows.end - receiveOrderSearchVirtualRows.start,
                              0,
                            ),
                          },
                          (_, localIndex) => {
                            const index = receiveOrderSearchVirtualRows.start + localIndex
                            const order = receiveOrderSearchResults[index]
                            if (!order) {
                              return (
                                <div
                                  key={`purchase-order-search-skeleton-${index}`}
                                  aria-hidden="true"
                                  className="purchase-order-option virtualized-dropdown-placeholder"
                                  style={{ height: LOOKUP_ROW_HEIGHT }}
                                />
                              )
                            }
                          return (
                            <button
                              key={order.id}
                              type="button"
                              style={{ height: LOOKUP_ROW_HEIGHT }}
                              className={`purchase-order-option virtualized-dropdown-fade${index === receiveOrderSearchFocusedIndex ? ' focused' : ''}`}
                              onMouseEnter={() => setReceiveOrderSearchFocusedIndex(index)}
                              onClick={() => {
                                void handleSelectReceiveOrder(order)
                              }}
                            >
                              <span className="result-title">{formatOrderLookupLabel(order)}</span>
                              <span className="result-meta">
                                Pendências: {order.pendingLines} linha(s) • {fmtCurrency(order.totalAmount)}
                              </span>
                            </button>
                          )
                        })}
                        <div style={{ height: receiveOrderSearchVirtualRows.offsetBottom }} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </label>
            <label>
              Fornecedor
              <CatalogLookupField
                value={purchaseReceiveForm.supplierId}
                selectedLabel={receiveSupplierLabel}
                placeholder="Buscar fornecedor"
                searchCatalog={searchSuppliersCatalog}
                onDiscoverOptions={rememberSuppliers}
                disabled={Boolean(receiveContext)}
                onChange={(value) =>
                  setPurchaseReceiveForm((state) => ({ ...state, supplierId: value }))
                }
                emptyHint={{ label: 'Adicionar Fornecedor' }}
                renderCreateForm={(props) => <InlineCreateForm type="supplier" {...props} />}
              />
            </label>
            <label>
              Depósito
              <CatalogLookupField
                value={purchaseReceiveForm.warehouseId}
                selectedLabel={receiveWarehouseLabel}
                placeholder="Buscar depósito"
                searchCatalog={searchWarehousesCatalog}
                onDiscoverOptions={rememberWarehouses}
                disabled={Boolean(receiveContext)}
                onChange={(value) =>
                  setPurchaseReceiveForm((state) => ({ ...state, warehouseId: value }))
                }
                emptyHint={{ label: 'Adicionar Depósito' }}
                renderCreateForm={(props) => <InlineCreateForm type="warehouse" {...props} />}
              />
            </label>
            {showReceiveNotes || purchaseReceiveForm.notes.trim() !== '' ? (
              <label>
                Observações (opcional)
                <input
                  value={purchaseReceiveForm.notes}
                  onChange={(event) =>
                    setPurchaseReceiveForm((state) => ({ ...state, notes: event.target.value }))
                  }
                  placeholder="NF, conferência, avarias ou observações"
                />
              </label>
            ) : (
              <button
                type="button"
                className="ghost purchase-inline-toggle"
                onClick={() => setShowReceiveNotes(true)}
              >
                Adicionar observações
              </button>
            )}
          </div>

          {!normalizedReceiveOrderSearchQuery && !linkedOrderMode && (recentPendingOrdersLoading || recentPendingOrders.length > 0) && (
            <details className="purchase-receive-quick-list" open>
              <summary>Ordens pendentes recentes</summary>
              <div className="actions">
                
                {recentPendingOrders.map((order) => (
                  <button
                    key={order.id}
                    type="button"
                    className="ghost purchase-receive-quick-order"
                    onClick={() => {
                      void handleSelectReceiveOrder(order)
                    }}
                  >
                    {formatOrderLookupLabel(order)}
                  </button>
                ))}
              </div>
            </details>
          )}

          <div className="actions">
            {linkedOrderMode && (
              <button type="button" className="ghost" onClick={clearLinkedOrder}>
                Limpar ordem vinculada
              </button>
            )}
            {!linkedOrderMode && !shouldIncludeReceivedInSearch && null}
            {!linkedOrderMode && shouldIncludeReceivedInSearch && null}
            {linkedOrderMode && (
              <span className="hint">
                {receiveContext
                  ? `Saldo pendente: ${pendingReceiveLineCount} item(ns).`
                  : receiveContextLoading
                    ? 'Aguardando ordem vinculada.'
                    : 'Aguardando carregamento da ordem vinculada.'}
              </span>
            )}
          </div>

          {receiveContext && (
            <div className="purchase-totals">
              <span className="hint">
                Ordem: {receiveContext.orderId.slice(0, 8)} • Status:{' '}
                {mapOrderStatusLabel(receiveContext.status)} • Pendências: {pendingReceiveLineCount}
              </span>
              <span className="hint">
                Fornecedor: {receiveContext.supplierName ?? 'Não informado'} • Depósito:{' '}
                {receiveContext.warehouseName ?? 'Não informado'}
              </span>
            </div>
          )}

          <div className="purchase-items">
            {purchaseReceiveForm.items.map((item, itemIndex) => {
              const isSkippedReceiveLine =
                Boolean(receiveContext) && toFiniteNumber(item.quantity) <= 0.000001
              const itemIssues = getItemValidationMessages(item, productById, {
                allowZeroQuantity: Boolean(receiveContext),
              })
              return (
                <div
                  key={item.id}
                  className={`purchase-item-row${isSkippedReceiveLine ? ' is-skipped' : ''}`}
                >
                  <div className="fiscal-grid">
                    <label>
                      Produto (opcional)
                      <ProductLookupField
                        value={item.product_id}
                        selectedLabel={getItemSelectedLabel(item)}
                        warehouseId={purchaseReceiveForm.warehouseId}
                        disabled={Boolean(receiveContext) && Boolean(item.purchase_order_item_id)}
                        onSelect={(product) => handleReceiveProductSelect(item.id, product)}
                        onClear={() => clearReceiveProduct(item.id)}
                        onDiscoverProducts={rememberProducts}
                        emptyHint={{ label: 'Adicionar Produto' }}
                        renderCreateForm={(props) => <InlineCreateForm type="product" {...props} />}
                      />
                    </label>
                    <label>
                      Descrição
                      <input
                        value={item.description}
                        onKeyDown={(event) => handleReceiveItemHotkeys(event, item.id, itemIndex)}
                        onChange={(event) =>
                          updateReceiveItem(item.id, { description: event.target.value })
                        }
                        placeholder="Descrição conferida no recebimento"
                      />
                    </label>
                    <label>
                      Quantidade
                      <NumericInput
                        value={item.quantity}
                        onKeyDown={(event) => handleReceiveItemHotkeys(event, item.id, itemIndex)}
                        onChange={(event) =>
                          updateReceiveItem(item.id, {
                            quantity: Math.max(toFiniteNumber(event.target.value), 0),
                          })
                        }
                      />
                    </label>
                    <label>
                      Custo unitário
                      <NumericInput
                        value={item.unit_cost}
                        currency
                        onKeyDown={(event) =>
                          handleReceiveItemHotkeys(event, item.id, itemIndex, {
                            appendOnEnter: true,
                          })
                        }
                        onChange={(event) =>
                          updateReceiveItem(item.id, {
                            unit_cost: Math.max(toFiniteNumber(event.target.value), 0),
                          })
                        }
                      />
                    </label>
                  </div>
                  {itemIssues.length > 0 && (
                    <div className="purchase-item-issues">
                      {itemIssues.map((issue) => (
                        <span key={issue} className="hint">{issue}</span>
                      ))}
                    </div>
                  )}
                  <div className="actions">

                    <span className="hint">
                      Subtotal: {fmtCurrency(Math.max(item.quantity, 0) * Math.max(item.unit_cost, 0))}
                    </span>
                    <button
                      type="button"
                      className="ghost"
                      disabled={purchaseReceiveForm.items.length <= 1}
                      onClick={() => removeReceiveItem(item.id)}
                    >
                      Remover item
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          <div className="purchase-totals">
            
            <strong>Total estimado: {fmtCurrency(receiveTotal)}</strong>
          </div>

          <div className="actions">
            {Boolean(receiveContext) && (
              <button
                type="button"
                className="ghost"
                disabled={pendingReceiveLineCount <= 0}
                onClick={fillReceiveItemsWithPending}
              >
                Receber tudo (pendente)
              </button>
            )}
            {Boolean(receiveContext) && (
              <button type="button" className="ghost" onClick={clearReceiveItemQuantities}>
                Zerar quantidades
              </button>
            )}
            <button
              type="button"
              className="ghost"
              disabled={Boolean(receiveContext)}
              onClick={addReceiveItem}
            >
              Adicionar item
            </button>
            <button type="button" className="ghost" onClick={() => setActiveStep('order')}>
              Voltar para ordem
            </button>
          </div>

          <p className="subtitle purchase-feedback" style={{ visibility: purchaseReceiveStatus ? 'visible' : 'hidden', margin: purchaseReceiveStatus ? undefined : 0, height: purchaseReceiveStatus ? undefined : 0, overflow: 'hidden' }}>{purchaseReceiveStatus}</p>
        </section>
      )}

      {activeStep === 'xml' && (
        <XmlImportPanel
          onImported={() => {
            setPurchaseToast('XML importado com sucesso.')
            setActiveStep('list')
          }}
        />
      )}

    </div>
    </div>
  )
}
