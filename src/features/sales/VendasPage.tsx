import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from 'react'
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence'
import {
  DateInput,
  NumericInput,
  Select,
  createVirtualDropdownWindow,
  ensureDropdownItemVisible,
  getEstimatedTotalRowCount,
  PageHeader,
  Tabs,
  PaymentComboBox,
} from '../../components/ui'
import { useStatusToast } from '../../hooks/useStatusToast'
import { normalizeLookupQuery } from '../../lib/searchUtils'
import {
  cancelQuote,
  completePickupForOrder,
  createPickupForOrder,
  createSalesOrder,
  createQuote,
  convertQuote,
  dispatchPickupForOrder,
  duplicateQuote,
  fetchQuoteDetail,
  fetchSalesOrder,
  fetchSalesOrderWorkflow,
  fetchSalesOrdersPaged,
  fetchRecentQuotes,
  fetchSalesDefaults,
  invoiceSalesOrder,
  sendSalesAiChat,
  searchProducts,
  searchCustomersPaged,
  updateSalesOrder,
  type SalesOrderDetail,
  type SalesOrderWorkflow,
  type SalesOrderListItem,
} from '../../services/core'
import { escapeHtml, printHtmlDocument } from '../../services/printing'
import { fmtCurrency, fmtDateFull } from '../../lib/formatters'
import { InlineCreateForm } from '../../components/InlineCreateForm'

function createDraftNonce(prefix: 'order' | 'quote') {
  if (globalThis.crypto !== undefined && 'randomUUID' in globalThis.crypto) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function createTransientId(prefix: string) {
  if (globalThis.crypto !== undefined && 'randomUUID' in globalThis.crypto) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function hashIdempotencyPayload(payload: unknown) {
  const raw = JSON.stringify(payload) ?? ''
  let hash = 2166136261
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return (hash >>> 0).toString(16)
}

const fallbackProductImageDataUri =
  'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="100%" height="100%" fill="%23E6E6E6"/><text x="50%" y="50%" fill="%232B2B2B" font-size="11" text-anchor="middle" dominant-baseline="middle">Sem foto</text></svg>'

const LOOKUP_PAGE_SIZE = 5
const PRODUCT_RESULT_ROW_HEIGHT = 62
const CUSTOMER_RESULT_ROW_HEIGHT = 42
const SALES_AI_HISTORY_LIMIT = 12

type SalesCustomerLookup = {
  id: string
  name: string
  phone?: string
}

type SalesProductLookup = {
  id: string
  name: string
  price: number
  image_url: string | null
  stock_available: number
}

type SalesAiChatEntry = {
  id: string
  role: 'user' | 'assistant'
  content: string
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

function normalizeDiscountValue(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(value, 0)
}

function getDiscountedItems<
  T extends {
    price: number
    quantity: number
    discountValue?: number
    discountMode?: 'percent' | 'value'
  },
>(
  items: T[],
  discountMode: 'percent' | 'value',
  discountValue: number,
) {
  const lineTotals = items.map((item) => {
    const normalizedLineDiscount = normalizeDiscountValue(item.discountValue ?? 0)
    const lineDiscount =
      item.discountMode === 'percent'
        ? (item.price * normalizedLineDiscount) / 100
        : normalizedLineDiscount
    const unit = Math.max(item.price - lineDiscount, 0)
    return { ...item, unit, lineTotal: unit * item.quantity }
  })
  const baseTotal = lineTotals.reduce((sum, item) => sum + item.lineTotal, 0)
  const normalizedOrderDiscount = normalizeDiscountValue(discountValue)
  const orderDiscount =
    discountMode === 'percent' ? (baseTotal * normalizedOrderDiscount) / 100 : normalizedOrderDiscount
  const appliedDiscount = Math.min(orderDiscount, baseTotal)
  const adjustedItems = lineTotals.map((item) => {
    if (baseTotal === 0) {
      return { ...item, unit_price: item.unit }
    }
    const share = (appliedDiscount * item.lineTotal) / baseTotal
    const unit = Math.max(item.unit - share / item.quantity, 0)
    return { ...item, unit_price: unit }
  })
  return {
    items: adjustedItems,
    total: Math.max(baseTotal - appliedDiscount, 0),
  }
}

const HISTORY_PAGE_SIZE = 15

const salesStatusLabels: Record<string, string> = {
  open: 'Não pago',
  pending: 'Não pago',
  invoiced: 'Pago',
  shipped: 'Pago',
  delivered: 'Pago',
  cancelled: 'Reembolsado',
}

function salesStatusLabel(status: string) {
  return salesStatusLabels[status] ?? status
}

type HistoryItem = {
  kind: 'order' | 'quote'
  id: string
  status: string
  totalAmount: number
  customerName: string
  createdAt: string
  validUntil: string | null
}

export function VendasPage() {
  const [activeView, setActiveView] = useState<'new' | 'quote' | 'history'>('new')

  const [historyOrders, setHistoryOrders] = useState<SalesOrderListItem[]>([])
  const [historyTotal, setHistoryTotal] = useState(0)
  const [historyOffset, setHistoryOffset] = useState(0)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historySearch, setHistorySearch] = useState('')
  const [historyError, setHistoryError] = useState('')
  const [historyExpanded, setHistoryExpanded] = useState(false)
  const [expandedOrderId, setExpandedOrderId] = useState<string | null>(null)
  const [orderDetailsCache, setOrderDetailsCache] = useState<Record<string, SalesOrderDetail>>({})
  const [quoteDetailsCache, setQuoteDetailsCache] = useState<Record<string, { items: { id: string; description: string; quantity: number }[] }>>({})
  const [expandingOrderId, setExpandingOrderId] = useState<string | null>(null)
  const historyAbortRef = useRef<AbortController | null>(null)
  const historyEndRef = useRef<HTMLDivElement | null>(null)
  const historyRefreshRef = useRef(0)

  const loadHistory = useCallback(async (offset: number, append: boolean) => {
    historyAbortRef.current?.abort()
    const controller = new AbortController()
    historyAbortRef.current = controller
    setHistoryLoading(true)
    setHistoryError('')
    try {
      const result = await fetchSalesOrdersPaged({
        query: historySearch || undefined,
        limit: HISTORY_PAGE_SIZE,
        offset,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      setHistoryOrders((prev) => append ? [...prev, ...result.rows] : result.rows)
      setHistoryTotal(result.totalCount ?? 0)
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      if (controller.signal.aborted) return
      setHistoryError(e instanceof Error ? e.message : 'Erro ao carregar histórico.')
    } finally {
      if (!controller.signal.aborted) setHistoryLoading(false)
    }
  }, [historySearch])

  // Reload from scratch whenever tab becomes active or search changes
  useEffect(() => {
    if (activeView !== 'history') return
    setHistoryOffset(0)
    void loadHistory(0, false)
    void refreshRecentQuotes()
    return () => { historyAbortRef.current?.abort() }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeView, historySearch, historyRefreshRef.current])

  // Append when offset increases (load more)
  useEffect(() => {
    if (activeView !== 'history' || historyOffset === 0) return
    void loadHistory(historyOffset, true)
    return () => { historyAbortRef.current?.abort() }
  }, [activeView, historyOffset, loadHistory])

  // Infinite scroll: observe sentinel when expanded
  useEffect(() => {
    if (!historyExpanded) return
    const sentinel = historyEndRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          observer.disconnect()
          setHistoryOffset((o) => o + HISTORY_PAGE_SIZE)
        }
      },
      { threshold: 0 },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [historyExpanded, historyOrders.length])

  const toggleExpandOrder = useCallback(async (orderId: string) => {
    if (expandedOrderId === orderId) {
      setExpandedOrderId(null)
      return
    }
    setExpandedOrderId(orderId)
    if (!orderDetailsCache[orderId]) {
      setExpandingOrderId(orderId)
      try {
        const detail = await fetchSalesOrder(orderId)
        setOrderDetailsCache((prev) => ({ ...prev, [orderId]: detail }))
      } catch {
        // silently fail - will show empty items
      } finally {
        setExpandingOrderId(null)
      }
    }
  }, [expandedOrderId, orderDetailsCache])

  const toggleExpandQuote = useCallback(async (quoteId: string) => {
    if (expandedOrderId === quoteId) {
      setExpandedOrderId(null)
      return
    }
    setExpandedOrderId(quoteId)
    if (!quoteDetailsCache[quoteId]) {
      setExpandingOrderId(quoteId)
      try {
        const detail = await fetchQuoteDetail(quoteId)
        setQuoteDetailsCache((prev) => ({ ...prev, [quoteId]: { items: detail.items.map((i) => ({ id: i.id, description: i.description, quantity: Number(i.quantity) })) } }))
      } catch {
        // silently fail - will show empty items
      } finally {
        setExpandingOrderId(null)
      }
    }
  }, [expandedOrderId, quoteDetailsCache])

  const handlePrintOrder = async (order: Omit<SalesOrderListItem, 'warehouseId'> & { warehouseId?: string | null; paymentCondition?: string | null }) => {
    const bodyHtml = `
      <p><strong>Pedido #${escapeHtml(order.id.slice(0, 8))}</strong></p>
      <p>Cliente: ${escapeHtml(order.customerName)}</p>
      <p>Data: ${fmtDateFull(order.createdAt)}</p>
      <p>Status: ${escapeHtml(salesStatusLabel(order.status))}</p>
      ${order.paymentCondition ? `<p>Cond. Pagamento: ${escapeHtml(order.paymentCondition)}</p>` : ''}
      ${order.notes ? `<p>Obs: ${escapeHtml(order.notes)}</p>` : ''}
      <hr/>
      <p style="font-size:1.2em"><strong>Total: ${fmtCurrency(order.totalAmount)}</strong></p>
    `
    try {
      await printHtmlDocument({ title: `Pedido ${order.id.slice(0, 8)}`, preset: 'a5', bodyHtml })
    } catch { /* silent */ }
  }


  const [editingOrder, setEditingOrder] = useState<SalesOrderDetail | null>(null)
  const [editingField, setEditingField] = useState<{ notes: string; paymentCondition: string; status: string }>({ notes: '', paymentCondition: '', status: '' })
  const [editBusy, setEditBusy] = useState(false)
  const [editStatus, setEditStatus] = useState('')

  const handleLoadOrderForEdit = async (orderId: string) => {
    setEditBusy(true)
    try {
      const order = await fetchSalesOrder(orderId)
      setEditingOrder(order)
      setEditingField({
        notes: order.notes ?? '',
        paymentCondition: order.paymentCondition ?? '',
        status: order.status,
      })
      setEditStatus('')
    } catch (e) {
      setEditStatus(e instanceof Error ? e.message : 'Erro ao carregar pedido.')
    } finally {
      setEditBusy(false)
    }
  }

  const handleSaveEditOrder = async () => {
    if (!editingOrder || editBusy) return
    setEditBusy(true)
    try {
      await updateSalesOrder(editingOrder.id, {
        notes: editingField.notes || undefined,
        paymentCondition: editingField.paymentCondition || undefined,
        status: editingField.status as 'open' | 'pending' | 'cancelled',
      }, { idempotencyKey: `order-edit-${editingOrder.id}-${Date.now()}` })
      setEditStatus('Pedido atualizado com sucesso.')
      setEditingOrder(null)
      historyRefreshRef.current++
      void loadHistory(0, false)
    } catch (e) {
      setEditStatus(e instanceof Error ? e.message : 'Erro ao salvar.')
    } finally {
      setEditBusy(false)
    }
  }

  const [inlineCreateTarget, setInlineCreateTarget] = useState<'order-customer' | 'quote-customer' | null>(null)
  const [paymentCondition, setPaymentCondition] = useState('PIX')
  const [salesOrderStatus, setSalesOrderStatus] = useState('')
  const [quoteStatus, setQuoteStatus] = useState('')
  const [quoteValidUntil, setQuoteValidUntil] = useState('')
  const [quoteSavedStatus, setQuoteSavedStatus] = useState<
    'draft' | 'converted' | 'expired' | 'cancelled' | null
  >(null)
  const [quoteNeedsReview, setQuoteNeedsReview] = useState(false)
  const [quoteReviewItems, setQuoteReviewItems] = useState<
    Array<{ description: string; type: 'price' | 'stock'; quoted: number; current: number }>
  >([])
  const [recentQuotes, setRecentQuotes] = useState<
    Array<{
      id: string
      status: string
      totalAmount: number
      customerName: string
      createdAt: string
      validUntil: string | null
    }>
  >([])
  const [loadingRecentQuotes, setLoadingRecentQuotes] = useState(false)
  const [quickToast, setQuickToast] = useState<string | null>(null)
  useStatusToast(quickToast ?? '')
  const [lastOrderId, setLastOrderId] = useState<string | null>(null)
  const [orderWorkflow, setOrderWorkflow] = useState<SalesOrderWorkflow | null>(null)
  const [workflowStatus, setWorkflowStatus] = useState('')
  useStatusToast(workflowStatus)
  const [workflowBusy, setWorkflowBusy] = useState(false)
  const [creatingOrder, setCreatingOrder] = useState(false)
  const [orderSuccess, setOrderSuccess] = useState(false)
  const orderSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [quoteSuccess, setQuoteSuccess] = useState(false)
  const quoteSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [savingQuote, setSavingQuote] = useState(false)
  const [convertingQuote, setConvertingQuote] = useState(false)
  const [quoteRowBusyId, setQuoteRowBusyId] = useState<string | null>(null)
  const [customerLabel, setCustomerLabel] = useState('Consumidor Padrão')
  const [quoteCustomerLabel, setQuoteCustomerLabel] = useState('Consumidor Padrão')
  const [defaults, setDefaults] = useState<{
    customerId: string
    warehouseId: string
    salesAgentId: string
  } | null>(null)
  const [customerId, setCustomerId] = useState<string>('')
  const [quoteCustomerId, setQuoteCustomerId] = useState<string>('')
  const [quoteId, setQuoteId] = useState('')
  const [showCustomerSelect, setShowCustomerSelect] = useState(false)
  const [showQuoteCustomerSelect, setShowQuoteCustomerSelect] = useState(false)
  const { mounted: customerWrapperMounted, exiting: customerWrapperExiting } = useAnimatedPresence(showCustomerSelect, 180)
  const { mounted: quoteCustomerWrapperMounted, exiting: quoteCustomerWrapperExiting } = useAnimatedPresence(showQuoteCustomerSelect, 180)

  // Auto-focus customer inputs when wrapper appears
  useEffect(() => {
    if (customerWrapperMounted && !customerWrapperExiting) {
      customerSearchRef.current?.focus()
    }
  }, [customerWrapperMounted, customerWrapperExiting])

  useEffect(() => {
    if (quoteCustomerWrapperMounted && !quoteCustomerWrapperExiting) {
      quoteCustomerSearchRef.current?.focus()
    }
  }, [quoteCustomerWrapperMounted, quoteCustomerWrapperExiting])
  const [customerQuery, setCustomerQuery] = useState('')
  const [quoteCustomerQuery, setQuoteCustomerQuery] = useState('')
  const [customerResults, setCustomerResults] = useState<SalesCustomerLookup[]>([])
  const [quoteCustomerResults, setQuoteCustomerResults] = useState<SalesCustomerLookup[]>([])
  const [customerResultsLoading, setCustomerResultsLoading] = useState(false)
  const [quoteCustomerResultsLoading, setQuoteCustomerResultsLoading] = useState(false)
  const [customerResultsHasMore, setCustomerResultsHasMore] = useState(true)
  const [quoteCustomerResultsHasMore, setQuoteCustomerResultsHasMore] = useState(true)
  const [customerResultsScrollTop, setCustomerResultsScrollTop] = useState(0)
  const [quoteCustomerResultsScrollTop, setQuoteCustomerResultsScrollTop] = useState(0)

  const [query, setQuery] = useState('')
  const [quoteQuery, setQuoteQuery] = useState('')
  const [results, setResults] = useState<SalesProductLookup[]>([])
  const [quoteResults, setQuoteResults] = useState<SalesProductLookup[]>([])
  const [resultsLoading, setResultsLoading] = useState(false)
  const [quoteResultsLoading, setQuoteResultsLoading] = useState(false)
  const [resultsHasMore, setResultsHasMore] = useState(true)
  const [quoteResultsHasMore, setQuoteResultsHasMore] = useState(true)
  const [resultsScrollTop, setResultsScrollTop] = useState(0)
  const [quoteResultsScrollTop, setQuoteResultsScrollTop] = useState(0)
  const [cartItems, setCartItems] = useState<Array<{
    id: string
    name: string
    price: number
    image_url: string | null
    quantity: number
    stock_available?: number
    discountValue?: number
    discountMode?: 'percent' | 'value'
  }>>([])
  const [quoteItems, setQuoteItems] = useState<typeof cartItems>([])
  const [selectedResultIndex, setSelectedResultIndex] = useState(0)
  const [selectedQuoteResultIndex, setSelectedQuoteResultIndex] = useState(0)
  const [selectedCartIndex, setSelectedCartIndex] = useState(0)
  const [selectedQuoteCartIndex, setSelectedQuoteCartIndex] = useState(0)
  const [orderDiscountMode, setOrderDiscountMode] = useState<'percent' | 'value'>('percent')
  const [orderDiscountValue, setOrderDiscountValue] = useState(0)
  const [quoteDiscountMode, setQuoteDiscountMode] = useState<'percent' | 'value'>('percent')
  const [quoteDiscountValue, setQuoteDiscountValue] = useState(0)
  const [orderDraftNonce, setOrderDraftNonce] = useState(() => createDraftNonce('order'))
  const [quoteDraftNonce, setQuoteDraftNonce] = useState(() => createDraftNonce('quote'))
  const [aiChatMessages, setAiChatMessages] = useState<SalesAiChatEntry[]>([])
  const [aiChatInput, setAiChatInput] = useState('')
  const [aiChatError, setAiChatError] = useState('')
  const [aiChatLoading, setAiChatLoading] = useState(false)
  const aiChatLogRef = useRef<HTMLDivElement | null>(null)
  const salesPanelShellRef = useRef<HTMLDivElement | null>(null)
  const salesPanelContentRef = useRef<HTMLDivElement | null>(null)
  const salesPanelAnimationFrameRef = useRef<number | null>(null)
  const salesPanelAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const salesPanelPreviousHeightRef = useRef<number | null>(null)
  const [salesPanelHeight, setSalesPanelHeight] = useState<number | null>(null)
  const [salesPanelStretchDirection, setSalesPanelStretchDirection] = useState<'grow' | 'shrink' | null>(null)

  useLayoutEffect(() => {
    const contentEl = salesPanelContentRef.current
    if (!contentEl) return

    let shouldAnimateNextChange = true

    const clearPendingAnimationState = () => {
      if (salesPanelAnimationTimerRef.current) {
        clearTimeout(salesPanelAnimationTimerRef.current)
      }

      salesPanelAnimationTimerRef.current = setTimeout(() => {
        salesPanelAnimationTimerRef.current = null
        setSalesPanelHeight(null)
        setSalesPanelStretchDirection(null)
      }, 380)
    }

    const updatePanelHeight = (rawHeight: number) => {
      const nextHeight = Math.ceil(rawHeight)
      const previousMeasuredHeight = salesPanelPreviousHeightRef.current

      if (previousMeasuredHeight == null) {
        salesPanelPreviousHeightRef.current = nextHeight
        shouldAnimateNextChange = false
        return
      }

      const currentShellHeight = Math.ceil(
        salesPanelShellRef.current?.getBoundingClientRect().height ?? previousMeasuredHeight,
      )

      if (!shouldAnimateNextChange || Math.abs(currentShellHeight - nextHeight) < 2) {
        salesPanelPreviousHeightRef.current = nextHeight

        if (shouldAnimateNextChange) {
          shouldAnimateNextChange = false
          setSalesPanelHeight(null)
          setSalesPanelStretchDirection(null)
        }

        return
      }

      shouldAnimateNextChange = false
      salesPanelPreviousHeightRef.current = nextHeight
      setSalesPanelStretchDirection(nextHeight > currentShellHeight ? 'grow' : 'shrink')
      setSalesPanelHeight(currentShellHeight)

      if (salesPanelAnimationFrameRef.current != null) {
        cancelAnimationFrame(salesPanelAnimationFrameRef.current)
      }

      salesPanelAnimationFrameRef.current = requestAnimationFrame(() => {
        salesPanelAnimationFrameRef.current = requestAnimationFrame(() => {
          salesPanelAnimationFrameRef.current = null
          setSalesPanelHeight(nextHeight)
          clearPendingAnimationState()
        })
      })
    }

    updatePanelHeight(contentEl.getBoundingClientRect().height)

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        updatePanelHeight(entry.contentRect.height)
      }
    })

    observer.observe(contentEl)

    return () => {
      observer.disconnect()

      if (salesPanelAnimationFrameRef.current != null) {
        cancelAnimationFrame(salesPanelAnimationFrameRef.current)
        salesPanelAnimationFrameRef.current = null
      }

      if (salesPanelAnimationTimerRef.current) {
        clearTimeout(salesPanelAnimationTimerRef.current)
        salesPanelAnimationTimerRef.current = null
      }
    }
  }, [activeView])

  const handleChangeActiveView = useCallback((nextView: 'new' | 'quote' | 'history') => {
    if (nextView === activeView) return

    const currentShellHeight = salesPanelShellRef.current?.getBoundingClientRect().height

    if (currentShellHeight != null && currentShellHeight > 0) {
      const roundedHeight = Math.ceil(currentShellHeight)
      salesPanelPreviousHeightRef.current = roundedHeight
      setSalesPanelHeight(roundedHeight)
    }

    if (salesPanelAnimationFrameRef.current != null) {
      cancelAnimationFrame(salesPanelAnimationFrameRef.current)
      salesPanelAnimationFrameRef.current = null
    }

    if (salesPanelAnimationTimerRef.current) {
      clearTimeout(salesPanelAnimationTimerRef.current)
      salesPanelAnimationTimerRef.current = null
    }

    setSalesPanelStretchDirection(null)
    setHistoryExpanded(false)
    setActiveView(nextView)
  }, [activeView])

  const orderSearchRef = useRef<HTMLInputElement | null>(null)
  const quoteSearchRef = useRef<HTMLInputElement | null>(null)
  const customerSearchRef = useRef<HTMLInputElement | null>(null)
  const quoteCustomerSearchRef = useRef<HTMLInputElement | null>(null)
  const orderResultsListRef = useRef<HTMLDivElement | null>(null)
  const quoteResultsListRef = useRef<HTMLDivElement | null>(null)
  const customerResultsListRef = useRef<HTMLDivElement | null>(null)
  const quoteCustomerResultsListRef = useRef<HTMLDivElement | null>(null)
  const orderSearchAbortRef = useRef<AbortController | null>(null)
  const quoteSearchAbortRef = useRef<AbortController | null>(null)
  const customerSearchAbortRef = useRef<AbortController | null>(null)
  const quoteCustomerSearchAbortRef = useRef<AbortController | null>(null)
  const productSearchCacheRef = useRef(new Map<string, SalesProductLookup[]>())
  const quoteProductSearchCacheRef = useRef(new Map<string, SalesProductLookup[]>())
  const customerSearchCacheRef = useRef(new Map<string, SalesCustomerLookup[]>())
  const quoteCustomerSearchCacheRef = useRef(new Map<string, SalesCustomerLookup[]>())
  const orderResultsLoadMoreOffsetRef = useRef<number | null>(null)
  const quoteResultsLoadMoreOffsetRef = useRef<number | null>(null)
  const customerResultsLoadMoreOffsetRef = useRef<number | null>(null)
  const quoteCustomerResultsLoadMoreOffsetRef = useRef<number | null>(null)
  const storageKey = 'vinteenterprise.salesDraft'

  const itemsCount = useMemo(
    () => cartItems.reduce((sum, item) => sum + item.quantity, 0),
    [cartItems],
  )

  const mapQuoteSavedStatus = (
    status: string,
  ): 'draft' | 'converted' | 'expired' | 'cancelled' => {
    if (status === 'converted') return 'converted'
    if (status === 'expired') return 'expired'
    if (status === 'cancelled') return 'cancelled'
    return 'draft'
  }

  const getQuoteStatusLabel = (status: string) => {
    if (status === 'converted') return 'Convertida'
    if (status === 'expired') return 'Vencida'
    if (status === 'cancelled') return 'Cancelada'
    return 'Rascunho'
  }

  useEffect(() => {
    setSelectedCartIndex((index) => Math.max(0, Math.min(index, Math.max(cartItems.length - 1, 0))))
  }, [cartItems.length])

  useEffect(() => {
    setSelectedQuoteCartIndex((index) =>
      Math.max(0, Math.min(index, Math.max(quoteItems.length - 1, 0))),
    )
  }, [quoteItems.length])

  useEffect(() => {
    if (!quickToast) return
    const handle = window.setTimeout(() => setQuickToast(null), 2000)
    return () => window.clearTimeout(handle)
  }, [quickToast])

  useEffect(() => {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as {
        cartItems?: typeof cartItems
        customerId?: string
        customerLabel?: string
        quoteCustomerId?: string
        quoteCustomerLabel?: string
        quoteDiscountMode?: 'percent' | 'value'
        quoteDiscountValue?: number
        orderDiscountMode?: 'percent' | 'value'
        orderDiscountValue?: number
        orderDraftNonce?: string
        quoteDraftNonce?: string
      }
      if (parsed.cartItems) setCartItems(parsed.cartItems)
      if (parsed.customerId) setCustomerId(parsed.customerId)
      if (parsed.customerLabel) setCustomerLabel(parsed.customerLabel)
      if (parsed.quoteCustomerId) setQuoteCustomerId(parsed.quoteCustomerId)
      if (parsed.quoteCustomerLabel) setQuoteCustomerLabel(parsed.quoteCustomerLabel)
      if (parsed.orderDraftNonce) setOrderDraftNonce(parsed.orderDraftNonce)
      if (parsed.quoteDraftNonce) setQuoteDraftNonce(parsed.quoteDraftNonce)
      if ((parsed as { quoteValidUntil?: string }).quoteValidUntil) {
        setQuoteValidUntil((parsed as { quoteValidUntil?: string }).quoteValidUntil ?? '')
      }
      if (parsed.quoteDiscountMode) setQuoteDiscountMode(parsed.quoteDiscountMode)
      if (typeof parsed.quoteDiscountValue === 'number') {
        setQuoteDiscountValue(normalizeDiscountValue(parsed.quoteDiscountValue))
      }
      if (parsed.orderDiscountMode) setOrderDiscountMode(parsed.orderDiscountMode)
      if (typeof parsed.orderDiscountValue === 'number') {
        setOrderDiscountValue(parsed.orderDiscountValue)
      }
    } catch {
      window.localStorage.removeItem(storageKey)
    }
  }, [])

  useEffect(() => {
    const payload = {
      cartItems,
      customerId,
      customerLabel,
      quoteCustomerId,
      quoteCustomerLabel,
      quoteValidUntil,
      quoteDiscountMode,
      quoteDiscountValue,
      orderDiscountMode,
      orderDiscountValue,
      orderDraftNonce,
      quoteDraftNonce,
    }
    window.localStorage.setItem(storageKey, JSON.stringify(payload))
  }, [
    cartItems,
    customerId,
    customerLabel,
    quoteCustomerId,
    orderDiscountMode,
    orderDiscountValue,
    quoteDiscountMode,
    quoteDiscountValue,
    quoteCustomerLabel,
    quoteValidUntil,
    orderDraftNonce,
    quoteDraftNonce,
  ])

  useEffect(() => {
    orderSearchRef.current?.focus()
  }, [])

  useEffect(() => {
    const loadDefaults = async () => {
      try {
        const fetched = await fetchSalesDefaults()
        setDefaults(fetched)
        setCustomerId(fetched.customerId)
        setQuoteCustomerId(fetched.customerId)
        setCustomerLabel('Consumidor Padrão')
        setQuoteCustomerLabel('Consumidor Padrão')
      } catch {
        setDefaults(null)
      }
    }
    void loadDefaults()
  }, [])

  const refreshRecentQuotes = async () => {
    setLoadingRecentQuotes(true)
    try {
      const list = await fetchRecentQuotes(50)
      setRecentQuotes(list)
    } catch {
      setRecentQuotes([])
    } finally {
      setLoadingRecentQuotes(false)
    }
  }

  const historyItems = useMemo<HistoryItem[]>(() => {
    const orders: HistoryItem[] = historyOrders.map((o) => ({
      kind: 'order',
      id: o.id,
      status: o.status,
      totalAmount: o.totalAmount,
      customerName: o.customerName,
      createdAt: o.createdAt,
      validUntil: null,
    }))
    const quotes: HistoryItem[] = recentQuotes.map((q) => ({
      kind: 'quote',
      id: q.id,
      status: q.status,
      totalAmount: q.totalAmount,
      customerName: q.customerName,
      createdAt: q.createdAt,
      validUntil: q.validUntil,
    }))
    return [...orders, ...quotes].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
  }, [historyOrders, recentQuotes])

  const showSalesAiChat = activeView === 'new' || activeView === 'quote'

  const refreshWorkflow = useCallback(async (orderId: string, options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false
    if (!silent) {
      setWorkflowBusy(true)
      setWorkflowStatus('Atualizando fluxo do pedido...')
    }

    try {
      const workflow = await fetchSalesOrderWorkflow(orderId)
      setOrderWorkflow(workflow)
      if (!silent) {
        setWorkflowStatus(workflow.stageLabel)
      }
      return workflow
    } catch (error) {
      if (!silent) {
        const message = error instanceof Error ? error.message : 'Falha ao atualizar o fluxo.'
        setWorkflowStatus(message)
      }
      return null
    } finally {
      if (!silent) setWorkflowBusy(false)
    }
  }, [])

  useEffect(() => {
    void refreshRecentQuotes()
  }, [])

  useEffect(() => {
    if (!lastOrderId) return
    if (orderWorkflow?.stage === 'picked_up') return
    const handle = window.setInterval(() => {
      if (workflowBusy) return
      void refreshWorkflow(lastOrderId, { silent: true })
    }, 7000)
    return () => window.clearInterval(handle)
  }, [lastOrderId, orderWorkflow?.stage, refreshWorkflow, workflowBusy])

  const normalizedCustomerQuery = useMemo(
    () => normalizeLookupQuery(customerQuery),
    [customerQuery],
  )
  const normalizedQuoteCustomerQuery = useMemo(
    () => normalizeLookupQuery(quoteCustomerQuery),
    [quoteCustomerQuery],
  )
  const normalizedOrderProductQuery = useMemo(
    () => normalizeLookupQuery(query),
    [query],
  )
  const normalizedQuoteProductQuery = useMemo(
    () => normalizeLookupQuery(quoteQuery),
    [quoteQuery],
  )

  const { mounted: orderProductDropMounted, exiting: orderProductDropExiting } = useAnimatedPresence(!!normalizedOrderProductQuery && results.length > 0, 180)
  const { mounted: quoteProductDropMounted, exiting: quoteProductDropExiting } = useAnimatedPresence(!!normalizedQuoteProductQuery && quoteResults.length > 0, 180)
  const { mounted: orderCustomerDropMounted, exiting: orderCustomerDropExiting } = useAnimatedPresence(!!normalizedCustomerQuery, 180)
  const { mounted: quoteCustomerDropMounted, exiting: quoteCustomerDropExiting } = useAnimatedPresence(!!normalizedQuoteCustomerQuery, 180)

  const orderProductEstimatedTotalRows = useMemo(
    () => getEstimatedTotalRowCount(results.length, resultsHasMore, LOOKUP_PAGE_SIZE),
    [results.length, resultsHasMore],
  )
  const quoteProductEstimatedTotalRows = useMemo(
    () => getEstimatedTotalRowCount(quoteResults.length, quoteResultsHasMore, LOOKUP_PAGE_SIZE),
    [quoteResults.length, quoteResultsHasMore],
  )
  const customerEstimatedTotalRows = useMemo(
    () => getEstimatedTotalRowCount(customerResults.length, customerResultsHasMore, LOOKUP_PAGE_SIZE),
    [customerResults.length, customerResultsHasMore],
  )
  const quoteCustomerEstimatedTotalRows = useMemo(
    () =>
      getEstimatedTotalRowCount(
        quoteCustomerResults.length,
        quoteCustomerResultsHasMore,
        LOOKUP_PAGE_SIZE,
      ),
    [quoteCustomerResults.length, quoteCustomerResultsHasMore],
  )

  const orderProductVirtualRows = useMemo(
    () =>
      createVirtualDropdownWindow(
        orderProductEstimatedTotalRows,
        resultsScrollTop,
        PRODUCT_RESULT_ROW_HEIGHT,
      ),
    [orderProductEstimatedTotalRows, resultsScrollTop],
  )
  const quoteProductVirtualRows = useMemo(
    () =>
      createVirtualDropdownWindow(
        quoteProductEstimatedTotalRows,
        quoteResultsScrollTop,
        PRODUCT_RESULT_ROW_HEIGHT,
      ),
    [quoteProductEstimatedTotalRows, quoteResultsScrollTop],
  )
  const customerVirtualRows = useMemo(
    () =>
      createVirtualDropdownWindow(
        customerEstimatedTotalRows,
        customerResultsScrollTop,
        CUSTOMER_RESULT_ROW_HEIGHT,
      ),
    [customerEstimatedTotalRows, customerResultsScrollTop],
  )
  const quoteCustomerVirtualRows = useMemo(
    () =>
      createVirtualDropdownWindow(
        quoteCustomerEstimatedTotalRows,
        quoteCustomerResultsScrollTop,
        CUSTOMER_RESULT_ROW_HEIGHT,
      ),
    [quoteCustomerEstimatedTotalRows, quoteCustomerResultsScrollTop],
  )

  const runCustomerSearch = useCallback(
    async (searchValue: string, offset: number, options?: { replace?: boolean }) => {
      const cacheKey = `${searchValue}::${offset}::${LOOKUP_PAGE_SIZE}`

      const applyRows = (rows: SalesCustomerLookup[]) => {
        setCustomerResults((state) =>
          mergeLookupItemsById(state, rows, { replace: options?.replace }),
        )
        setCustomerResultsHasMore(rows.length === LOOKUP_PAGE_SIZE)
        customerResultsLoadMoreOffsetRef.current = null
      }

      const cached = customerSearchCacheRef.current.get(cacheKey)
      if (cached) {
        applyRows(cached)
        setCustomerResultsLoading(false)
        return
      }

      setCustomerResultsLoading(true)
      customerSearchAbortRef.current?.abort()
      const controller = new AbortController()
      customerSearchAbortRef.current = controller

      try {
        const rows = await searchCustomersPaged(searchValue, {
          limit: LOOKUP_PAGE_SIZE,
          offset,
          signal: controller.signal,
        })
        customerSearchCacheRef.current.set(cacheKey, rows)
        applyRows(rows)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (options?.replace) {
          setCustomerResults([])
        }
        setCustomerResultsHasMore(false)
      } finally {
        if (!controller.signal.aborted) {
          setCustomerResultsLoading(false)
        }
      }
    },
    [],
  )

  const runQuoteCustomerSearch = useCallback(
    async (searchValue: string, offset: number, options?: { replace?: boolean }) => {
      const cacheKey = `${searchValue}::${offset}::${LOOKUP_PAGE_SIZE}`

      const applyRows = (rows: SalesCustomerLookup[]) => {
        setQuoteCustomerResults((state) =>
          mergeLookupItemsById(state, rows, { replace: options?.replace }),
        )
        setQuoteCustomerResultsHasMore(rows.length === LOOKUP_PAGE_SIZE)
        quoteCustomerResultsLoadMoreOffsetRef.current = null
      }

      const cached = quoteCustomerSearchCacheRef.current.get(cacheKey)
      if (cached) {
        applyRows(cached)
        setQuoteCustomerResultsLoading(false)
        return
      }

      setQuoteCustomerResultsLoading(true)
      quoteCustomerSearchAbortRef.current?.abort()
      const controller = new AbortController()
      quoteCustomerSearchAbortRef.current = controller

      try {
        const rows = await searchCustomersPaged(searchValue, {
          limit: LOOKUP_PAGE_SIZE,
          offset,
          signal: controller.signal,
        })
        quoteCustomerSearchCacheRef.current.set(cacheKey, rows)
        applyRows(rows)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (options?.replace) {
          setQuoteCustomerResults([])
        }
        setQuoteCustomerResultsHasMore(false)
      } finally {
        if (!controller.signal.aborted) {
          setQuoteCustomerResultsLoading(false)
        }
      }
    },
    [],
  )

  const runOrderProductSearch = useCallback(
    async (searchValue: string, offset: number, options?: { replace?: boolean }) => {
      if (!defaults) return
      const cacheKey = `${defaults.warehouseId}::${searchValue}::${offset}::${LOOKUP_PAGE_SIZE}`

      const applyRows = (rows: SalesProductLookup[]) => {
        setResults((state) => mergeLookupItemsById(state, rows, { replace: options?.replace }))
        setResultsHasMore(rows.length === LOOKUP_PAGE_SIZE)
        orderResultsLoadMoreOffsetRef.current = null
      }

      const cached = productSearchCacheRef.current.get(cacheKey)
      if (cached) {
        applyRows(cached)
        setResultsLoading(false)
        return
      }

      setResultsLoading(true)
      orderSearchAbortRef.current?.abort()
      const controller = new AbortController()
      orderSearchAbortRef.current = controller

      try {
        const rows = await searchProducts(searchValue, defaults.warehouseId, controller.signal, {
          limit: LOOKUP_PAGE_SIZE,
          offset,
        })
        const mapped = rows.map((item) => ({
          id: item.id,
          name: item.name,
          price: Number(item.price ?? 0),
          image_url: item.image_url,
          stock_available: Number(item.stock_available ?? 0),
        }))
        productSearchCacheRef.current.set(cacheKey, mapped)
        applyRows(mapped)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (options?.replace) {
          setResults([])
        }
        setResultsHasMore(false)
      } finally {
        if (!controller.signal.aborted) {
          setResultsLoading(false)
        }
      }
    },
    [defaults],
  )

  const runQuoteProductSearch = useCallback(
    async (searchValue: string, offset: number, options?: { replace?: boolean }) => {
      if (!defaults) return
      const cacheKey = `${defaults.warehouseId}::${searchValue}::${offset}::${LOOKUP_PAGE_SIZE}`

      const applyRows = (rows: SalesProductLookup[]) => {
        setQuoteResults((state) => mergeLookupItemsById(state, rows, { replace: options?.replace }))
        setQuoteResultsHasMore(rows.length === LOOKUP_PAGE_SIZE)
        quoteResultsLoadMoreOffsetRef.current = null
      }

      const cached = quoteProductSearchCacheRef.current.get(cacheKey)
      if (cached) {
        applyRows(cached)
        setQuoteResultsLoading(false)
        return
      }

      setQuoteResultsLoading(true)
      quoteSearchAbortRef.current?.abort()
      const controller = new AbortController()
      quoteSearchAbortRef.current = controller

      try {
        const rows = await searchProducts(searchValue, defaults.warehouseId, controller.signal, {
          limit: LOOKUP_PAGE_SIZE,
          offset,
        })
        const mapped = rows.map((item) => ({
          id: item.id,
          name: item.name,
          price: Number(item.price ?? 0),
          image_url: item.image_url,
          stock_available: Number(item.stock_available ?? 0),
        }))
        quoteProductSearchCacheRef.current.set(cacheKey, mapped)
        applyRows(mapped)
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return
        if (options?.replace) {
          setQuoteResults([])
        }
        setQuoteResultsHasMore(false)
      } finally {
        if (!controller.signal.aborted) {
          setQuoteResultsLoading(false)
        }
      }
    },
    [defaults],
  )

  const loadMoreCustomerResults = useCallback(() => {
    if (customerResultsLoading || !customerResultsHasMore) return
    if (!normalizedCustomerQuery) return
    if (customerResultsLoadMoreOffsetRef.current === customerResults.length) return
    customerResultsLoadMoreOffsetRef.current = customerResults.length
    void runCustomerSearch(normalizedCustomerQuery, customerResults.length)
  }, [
    customerResults.length,
    customerResultsHasMore,
    customerResultsLoading,
    normalizedCustomerQuery,
    runCustomerSearch,
  ])

  const loadMoreQuoteCustomerResults = useCallback(() => {
    if (quoteCustomerResultsLoading || !quoteCustomerResultsHasMore) return
    if (!normalizedQuoteCustomerQuery) return
    if (quoteCustomerResultsLoadMoreOffsetRef.current === quoteCustomerResults.length) return
    quoteCustomerResultsLoadMoreOffsetRef.current = quoteCustomerResults.length
    void runQuoteCustomerSearch(normalizedQuoteCustomerQuery, quoteCustomerResults.length)
  }, [
    normalizedQuoteCustomerQuery,
    quoteCustomerResults.length,
    quoteCustomerResultsHasMore,
    quoteCustomerResultsLoading,
    runQuoteCustomerSearch,
  ])

  const loadMoreOrderProductResults = useCallback(() => {
    if (resultsLoading || !resultsHasMore) return
    if (!normalizedOrderProductQuery) return
    if (orderResultsLoadMoreOffsetRef.current === results.length) return
    orderResultsLoadMoreOffsetRef.current = results.length
    void runOrderProductSearch(normalizedOrderProductQuery, results.length)
  }, [
    normalizedOrderProductQuery,
    results.length,
    resultsHasMore,
    resultsLoading,
    runOrderProductSearch,
  ])

  const loadMoreQuoteProductResults = useCallback(() => {
    if (quoteResultsLoading || !quoteResultsHasMore) return
    if (!normalizedQuoteProductQuery) return
    if (quoteResultsLoadMoreOffsetRef.current === quoteResults.length) return
    quoteResultsLoadMoreOffsetRef.current = quoteResults.length
    void runQuoteProductSearch(normalizedQuoteProductQuery, quoteResults.length)
  }, [
    normalizedQuoteProductQuery,
    quoteResults.length,
    quoteResultsHasMore,
    quoteResultsLoading,
    runQuoteProductSearch,
  ])

  const handleOrderResultsScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    setResultsScrollTop(element.scrollTop)
  }, [])

  const handleQuoteResultsScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    setQuoteResultsScrollTop(element.scrollTop)
  }, [])

  const handleCustomerResultsScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    setCustomerResultsScrollTop(element.scrollTop)
  }, [])

  const handleQuoteCustomerResultsScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    setQuoteCustomerResultsScrollTop(element.scrollTop)
  }, [])

  useEffect(() => {
    if (!normalizedOrderProductQuery || resultsLoading || !resultsHasMore) return
    if (orderProductVirtualRows.end < results.length) return
    loadMoreOrderProductResults()
  }, [
    loadMoreOrderProductResults,
    normalizedOrderProductQuery,
    orderProductVirtualRows.end,
    results.length,
    resultsHasMore,
    resultsLoading,
  ])

  useEffect(() => {
    if (!normalizedQuoteProductQuery || quoteResultsLoading || !quoteResultsHasMore) return
    if (quoteProductVirtualRows.end < quoteResults.length) return
    loadMoreQuoteProductResults()
  }, [
    loadMoreQuoteProductResults,
    normalizedQuoteProductQuery,
    quoteProductVirtualRows.end,
    quoteResults.length,
    quoteResultsHasMore,
    quoteResultsLoading,
  ])

  useEffect(() => {
    if (!showCustomerSelect || !normalizedCustomerQuery || customerResultsLoading || !customerResultsHasMore) return
    if (customerVirtualRows.end < customerResults.length) return
    loadMoreCustomerResults()
  }, [
    customerResults.length,
    customerResultsHasMore,
    customerResultsLoading,
    customerVirtualRows.end,
    loadMoreCustomerResults,
    normalizedCustomerQuery,
    showCustomerSelect,
  ])

  useEffect(() => {
    if (
      !showQuoteCustomerSelect ||
      !normalizedQuoteCustomerQuery ||
      quoteCustomerResultsLoading ||
      !quoteCustomerResultsHasMore
    ) {
      return
    }
    if (quoteCustomerVirtualRows.end < quoteCustomerResults.length) return
    loadMoreQuoteCustomerResults()
  }, [
    loadMoreQuoteCustomerResults,
    normalizedQuoteCustomerQuery,
    quoteCustomerResults.length,
    quoteCustomerResultsHasMore,
    quoteCustomerResultsLoading,
    quoteCustomerVirtualRows.end,
    showQuoteCustomerSelect,
  ])

  useEffect(() => {
    if (!showCustomerSelect) return
    if (!normalizedCustomerQuery) {
      setCustomerResults([])
      setCustomerResultsLoading(false)
      setCustomerResultsHasMore(true)
      setCustomerResultsScrollTop(0)
      customerResultsLoadMoreOffsetRef.current = null
      if (customerResultsListRef.current) {
        customerResultsListRef.current.scrollTop = 0
      }
      return
    }

    const handle = window.setTimeout(() => {
      setCustomerResults([])
      setCustomerResultsHasMore(true)
      setCustomerResultsScrollTop(0)
      customerResultsLoadMoreOffsetRef.current = null
      if (customerResultsListRef.current) {
        customerResultsListRef.current.scrollTop = 0
      }
      void runCustomerSearch(normalizedCustomerQuery, 0, { replace: true })
    }, 60)

    return () => {
      window.clearTimeout(handle)
      customerSearchAbortRef.current?.abort()
    }
  }, [normalizedCustomerQuery, runCustomerSearch, showCustomerSelect])

  useEffect(() => {
    if (!showQuoteCustomerSelect) return
    if (!normalizedQuoteCustomerQuery) {
      setQuoteCustomerResults([])
      setQuoteCustomerResultsLoading(false)
      setQuoteCustomerResultsHasMore(true)
      setQuoteCustomerResultsScrollTop(0)
      quoteCustomerResultsLoadMoreOffsetRef.current = null
      if (quoteCustomerResultsListRef.current) {
        quoteCustomerResultsListRef.current.scrollTop = 0
      }
      return
    }

    const handle = window.setTimeout(() => {
      setQuoteCustomerResults([])
      setQuoteCustomerResultsHasMore(true)
      setQuoteCustomerResultsScrollTop(0)
      quoteCustomerResultsLoadMoreOffsetRef.current = null
      if (quoteCustomerResultsListRef.current) {
        quoteCustomerResultsListRef.current.scrollTop = 0
      }
      void runQuoteCustomerSearch(normalizedQuoteCustomerQuery, 0, { replace: true })
    }, 60)

    return () => {
      window.clearTimeout(handle)
      quoteCustomerSearchAbortRef.current?.abort()
    }
  }, [normalizedQuoteCustomerQuery, runQuoteCustomerSearch, showQuoteCustomerSelect])

  useEffect(() => {
    if (!defaults) return
    if (!normalizedOrderProductQuery) {
      setResults([])
      setResultsLoading(false)
      setResultsHasMore(true)
      setResultsScrollTop(0)
      orderResultsLoadMoreOffsetRef.current = null
      if (orderResultsListRef.current) {
        orderResultsListRef.current.scrollTop = 0
      }
      return
    }

    const handle = window.setTimeout(() => {
      setResults([])
      setSelectedResultIndex(0)
      setResultsHasMore(true)
      setResultsScrollTop(0)
      orderResultsLoadMoreOffsetRef.current = null
      if (orderResultsListRef.current) {
        orderResultsListRef.current.scrollTop = 0
      }
      void runOrderProductSearch(normalizedOrderProductQuery, 0, { replace: true })
    }, 60)

    return () => {
      window.clearTimeout(handle)
      orderSearchAbortRef.current?.abort()
    }
  }, [defaults, normalizedOrderProductQuery, runOrderProductSearch])

  useEffect(() => {
    if (!defaults) return
    if (!normalizedQuoteProductQuery) {
      setQuoteResults([])
      setQuoteResultsLoading(false)
      setQuoteResultsHasMore(true)
      setQuoteResultsScrollTop(0)
      quoteResultsLoadMoreOffsetRef.current = null
      if (quoteResultsListRef.current) {
        quoteResultsListRef.current.scrollTop = 0
      }
      return
    }

    const handle = window.setTimeout(() => {
      setQuoteResults([])
      setSelectedQuoteResultIndex(0)
      setQuoteResultsHasMore(true)
      setQuoteResultsScrollTop(0)
      quoteResultsLoadMoreOffsetRef.current = null
      if (quoteResultsListRef.current) {
        quoteResultsListRef.current.scrollTop = 0
      }
      void runQuoteProductSearch(normalizedQuoteProductQuery, 0, { replace: true })
    }, 60)

    return () => {
      window.clearTimeout(handle)
      quoteSearchAbortRef.current?.abort()
    }
  }, [defaults, normalizedQuoteProductQuery, runQuoteProductSearch])

  const orderDiscounted = useMemo(
    () => getDiscountedItems(cartItems, orderDiscountMode, orderDiscountValue),
    [cartItems, orderDiscountMode, orderDiscountValue],
  )
  const quoteDiscounted = useMemo(
    () => getDiscountedItems(quoteItems, quoteDiscountMode, quoteDiscountValue),
    [quoteItems, quoteDiscountMode, quoteDiscountValue],
  )

  const orderIdempotencyKey = useMemo(() => {
    const payload = {
      customerId,
      warehouseId: defaults?.warehouseId ?? null,
      salesAgentId: defaults?.salesAgentId ?? null,
      notes:
        orderDiscountValue > 0
          ? `Desconto aplicado: ${orderDiscountMode === 'percent' ? `${orderDiscountValue}%` : `R$ ${orderDiscountValue}`}`
          : null,
      items: orderDiscounted.items.map((item) => ({
        product_id: item.id,
        description: item.name,
        quantity: item.quantity,
        unit_price: item.unit_price,
      })),
    }
    return `${orderDraftNonce}-${hashIdempotencyPayload(payload)}`
  }, [
    customerId,
    defaults?.salesAgentId,
    defaults?.warehouseId,
    orderDiscountMode,
    orderDiscountValue,
    orderDiscounted.items,
    orderDraftNonce,
  ])

  const quoteIdempotencyKey = useMemo(() => {
    const payload = {
      customerId: quoteCustomerId,
      notes:
        quoteDiscountValue > 0
          ? `Desconto aplicado: ${quoteDiscountMode === 'percent' ? `${quoteDiscountValue}%` : `R$ ${quoteDiscountValue}`}`
          : null,
      validUntil: quoteValidUntil || null,
      items: quoteDiscounted.items.map((item) => ({
        product_id: item.id,
        description: item.name,
        quantity: item.quantity,
        unit_price: item.unit_price,
      })),
    }
    return `${quoteDraftNonce}-${hashIdempotencyPayload(payload)}`
  }, [
    quoteCustomerId,
    quoteDiscountMode,
    quoteDiscountValue,
    quoteDiscounted.items,
    quoteDraftNonce,
    quoteValidUntil,
  ])

  const handleBarcodeEnter = async (value: string) => {
    const normalized = value.trim()
    if (!normalized) return
    if (!/^\d+$/.test(normalized) || normalized.length < 8) return
    if (!defaults) return
    const data = await searchProducts(normalized, defaults.warehouseId)
    if (data.length > 0) {
      addToCart({
        id: data[0].id,
        name: data[0].name,
        price: Number(data[0].price ?? 0),
        image_url: data[0].image_url ?? null,
        stock_available: Number(data[0].stock_available ?? 0),
      })
      return true
    }
    setQuickToast('Codigo nao encontrado.')
    return false
  }

  const playBeep = useCallback((frequency: number) => {
    try {
      const context = new AudioContext()
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = frequency
      gain.gain.value = 0.04
      oscillator.connect(gain)
      gain.connect(context.destination)
      oscillator.start()
      oscillator.stop(context.currentTime + 0.08)
      window.setTimeout(() => context.close(), 200)
    } catch {
      // no-op if audio not available
    }
  }, [])

  const showToast = useCallback((message: string, isError = false) => {
    setQuickToast(message)
    playBeep(isError ? 180 : 520)
  }, [playBeep])

  const addToCart = useCallback((item: typeof results[number]) => {
    setCartItems((state) => {
      const existing = state.find((cart) => cart.id === item.id)
      if (existing) {
        return state.map((cart) =>
          cart.id === item.id ? { ...cart, quantity: cart.quantity + 1 } : cart,
        )
      }
      return [
        ...state,
        {
          id: item.id,
          name: item.name,
          price: item.price,
          image_url: item.image_url,
          quantity: 1,
          stock_available: item.stock_available,
          discountMode: 'value',
          discountValue: 0,
        },
      ]
    })
    if ((item.stock_available ?? 0) <= 0) {
      showToast('Sem estoque para este item.', true)
    } else if (item.stock_available <= 5) {
      showToast('Estoque baixo.', true)
    } else {
      showToast('Item adicionado.')
    }
    setQuery('')
    setResults([])
    setResultsHasMore(true)
    setResultsScrollTop(0)
    setSelectedResultIndex(0)
    orderSearchRef.current?.focus()
  }, [showToast])

  const addToQuote = useCallback((item: typeof results[number]) => {
    setQuoteItems((state) => {
      const existing = state.find((cart) => cart.id === item.id)
      if (existing) {
        return state.map((cart) =>
          cart.id === item.id ? { ...cart, quantity: cart.quantity + 1 } : cart,
        )
      }
      return [
        ...state,
        {
          id: item.id,
          name: item.name,
          price: item.price,
          image_url: item.image_url,
          quantity: 1,
          discountMode: 'value',
          discountValue: 0,
        },
      ]
    })
    setQuoteQuery('')
    setQuoteResults([])
    setQuoteResultsHasMore(true)
    setQuoteResultsScrollTop(0)
    setSelectedQuoteResultIndex(0)
    quoteSearchRef.current?.focus()
  }, [])

  useEffect(() => {
    return () => {
      orderSearchAbortRef.current?.abort()
      quoteSearchAbortRef.current?.abort()
      customerSearchAbortRef.current?.abort()
      quoteCustomerSearchAbortRef.current?.abort()
    }
  }, [])

  const handleCreateOrder = useCallback(async () => {
    if (!defaults || cartItems.length === 0 || creatingOrder) return
    setCreatingOrder(true)
    setSalesOrderStatus('Gerando pedido...')
    try {
      const discountPct = orderDiscountMode === 'percent' ? orderDiscountValue : 0
      const result = await createSalesOrder({
        customerId,
        warehouseId: defaults?.warehouseId,
        salesAgentId: defaults?.salesAgentId,
        paymentCondition: paymentCondition || undefined,
        discountPercent: discountPct || undefined,
        notes:
          orderDiscountValue > 0
            ? `Desconto aplicado: ${orderDiscountMode === 'percent' ? `${orderDiscountValue}%` : `R$ ${orderDiscountValue}`}`
            : undefined,
        items: orderDiscounted.items.map((item) => ({
          product_id: item.id,
          description: item.name,
          quantity: item.quantity,
          unit_price: item.unit_price,
        })),
      }, {
        idempotencyKey: orderIdempotencyKey,
      })
      setSalesOrderStatus(
        `Pedido ${result.orderId} gerado com sucesso! Encaminhe o cliente ao caixa.`,
      )
      setLastOrderId(result.orderId)
      setWorkflowStatus('Pedido criado no atendimento. Próximo passo: caixa.')
      void refreshWorkflow(result.orderId)
      setCartItems([])
      setQuery('')
      setOrderDiscountValue(0)
      setPaymentCondition('PIX')
      setOrderDraftNonce(createDraftNonce('order'))
      window.localStorage.removeItem(storageKey)
      historyRefreshRef.current++
      setOrderSuccess(true)
      if (orderSuccessTimerRef.current) clearTimeout(orderSuccessTimerRef.current)
      orderSuccessTimerRef.current = setTimeout(() => setOrderSuccess(false), 3000)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao criar pedido.'
      setSalesOrderStatus(message)
    } finally {
      setCreatingOrder(false)
    }
  }, [
    cartItems.length,
    creatingOrder,
    customerId,
    defaults,
    orderDiscountMode,
    orderDiscountValue,
    orderDiscounted.items,
    paymentCondition,
    orderIdempotencyKey,
    refreshWorkflow,
    storageKey,
  ])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const isInput = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
      const isOrderInput = target === orderSearchRef.current
      const isQuoteInput = target === quoteSearchRef.current
      if (event.key === 'F2') {
        event.preventDefault()
        setShowCustomerSelect(true)
        customerSearchRef.current?.focus()
      }
      if (event.key === 'Escape') {
        setShowCustomerSelect(false)
        setShowQuoteCustomerSelect(false)
        setCustomerResults([])
        setQuoteCustomerResults([])
        setCustomerResultsHasMore(true)
        setQuoteCustomerResultsHasMore(true)
        setCustomerResultsScrollTop(0)
        setQuoteCustomerResultsScrollTop(0)
        setCustomerQuery('')
        setQuoteCustomerQuery('')
        orderSearchRef.current?.focus()
      }
      if (event.key === 'F9') {
        event.preventDefault()
        if (cartItems.length > 0 && !creatingOrder) {
          void handleCreateOrder()
        }
      }
      if (isOrderInput && event.key === 'ArrowDown') {
        event.preventDefault()
        if (results.length === 0) {
          loadMoreOrderProductResults()
          return
        }
        const nextIndex = Math.min(selectedResultIndex + 1, Math.max(results.length - 1, 0))
        setSelectedResultIndex(nextIndex)
        ensureDropdownItemVisible(
          orderResultsListRef.current,
          nextIndex,
          PRODUCT_RESULT_ROW_HEIGHT,
        )
        if (nextIndex >= results.length - 2) {
          loadMoreOrderProductResults()
        }
      }
      if (isOrderInput && event.key === 'ArrowUp' && results.length > 0) {
        event.preventDefault()
        const nextIndex = Math.max(selectedResultIndex - 1, 0)
        setSelectedResultIndex(nextIndex)
        ensureDropdownItemVisible(
          orderResultsListRef.current,
          nextIndex,
          PRODUCT_RESULT_ROW_HEIGHT,
        )
      }
      if (isOrderInput && event.key === 'Enter' && results.length > 0) {
        event.preventDefault()
        const item = results[selectedResultIndex]
        if (item) {
          addToCart(item)
        }
      }
      if (isQuoteInput && event.key === 'ArrowDown') {
        event.preventDefault()
        if (quoteResults.length === 0) {
          loadMoreQuoteProductResults()
          return
        }
        const nextIndex = Math.min(
          selectedQuoteResultIndex + 1,
          Math.max(quoteResults.length - 1, 0),
        )
        setSelectedQuoteResultIndex(nextIndex)
        ensureDropdownItemVisible(
          quoteResultsListRef.current,
          nextIndex,
          PRODUCT_RESULT_ROW_HEIGHT,
        )
        if (nextIndex >= quoteResults.length - 2) {
          loadMoreQuoteProductResults()
        }
      }
      if (isQuoteInput && event.key === 'ArrowUp' && quoteResults.length > 0) {
        event.preventDefault()
        const nextIndex = Math.max(selectedQuoteResultIndex - 1, 0)
        setSelectedQuoteResultIndex(nextIndex)
        ensureDropdownItemVisible(
          quoteResultsListRef.current,
          nextIndex,
          PRODUCT_RESULT_ROW_HEIGHT,
        )
      }
      if (isQuoteInput && event.key === 'Enter' && quoteResults.length > 0) {
        event.preventDefault()
        const item = quoteResults[selectedQuoteResultIndex]
        if (item) {
          addToQuote(item)
        }
      }
      if (!isInput && event.key === '+') {
        event.preventDefault()
        const item = cartItems[selectedCartIndex]
        if (item) {
          setCartItems((state) =>
            state.map((cart, index) =>
              index === selectedCartIndex ? { ...cart, quantity: cart.quantity + 1 } : cart,
            ),
          )
        }
      }
      if (!isInput && event.key === '-') {
        event.preventDefault()
        const item = cartItems[selectedCartIndex]
        if (item) {
          setCartItems((state) =>
            state
              .map((cart, index) =>
                index === selectedCartIndex
                  ? { ...cart, quantity: cart.quantity - 1 }
                  : cart,
              )
              .filter((cart) => cart.quantity > 0),
          )
        }
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [
    addToCart,
    addToQuote,
    cartItems,
    creatingOrder,
    handleCreateOrder,
    loadMoreOrderProductResults,
    loadMoreQuoteProductResults,
    orderResultsListRef,
    quoteResultsListRef,
    quoteResults,
    results,
    selectedCartIndex,
    selectedQuoteResultIndex,
    selectedResultIndex,
  ])

  const handleConvertQuote = async (targetQuoteId: string, forceConfirm = false) => {
    if (convertingQuote) return
    setConvertingQuote(true)
    setQuoteStatus('Convertendo cotação...')
    try {
      const result = await convertQuote({
        quoteId: targetQuoteId,
        warehouseId: defaults?.warehouseId,
        forceConfirm,
        idempotencyKey: `quote-convert-${targetQuoteId}-${forceConfirm ? 'force' : 'check'}`,
      })
      if (result.reviewRequired) {
        setQuoteNeedsReview(true)
        setQuoteReviewItems(result.divergences)
        setQuoteId(targetQuoteId)
        setQuoteStatus(
          'Cotação com divergências. Revise abaixo e clique novamente para confirmar a conversão.',
        )
        return
      }
      setQuoteId(targetQuoteId)
      setQuoteStatus(`Pedido ${result.orderId} gerado com sucesso.`)
      setLastOrderId(result.orderId)
      setWorkflowStatus('Cotação convertida. Próximo passo: caixa.')
      void refreshWorkflow(result.orderId)
      setQuoteSavedStatus('converted')
      setQuoteNeedsReview(false)
      setQuoteReviewItems([])
      setQuoteDraftNonce(createDraftNonce('quote'))
      void refreshRecentQuotes()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao converter cotação.'
      setQuoteStatus(message)
    } finally {
      setConvertingQuote(false)
    }
  }

  const handleSaveQuote = async () => {
    if (!defaults || quoteItems.length === 0 || savingQuote || convertingQuote) return
    setSavingQuote(true)
    try {
      const result = await createQuote({
        customerId: quoteCustomerId,
        notes:
          quoteDiscountValue > 0
            ? `Desconto aplicado: ${quoteDiscountMode === 'percent' ? `${quoteDiscountValue}%` : `R$ ${quoteDiscountValue}`}`
            : undefined,
        validUntil: quoteValidUntil
          ? new Date(`${quoteValidUntil}T23:59:59`).toISOString()
          : undefined,
        items: quoteDiscounted.items.map((item) => ({
          product_id: item.id,
          description: item.name,
          quantity: item.quantity,
          unit_price: item.unit_price,
        })),
      }, {
        idempotencyKey: quoteIdempotencyKey,
      })
      setQuoteStatus(`Cotação ${result.quoteId} salva com sucesso.`)
      setQuoteId(result.quoteId)
      setQuoteSavedStatus('draft')
      setQuoteNeedsReview(false)
      setQuoteReviewItems([])
      setQuoteDraftNonce(createDraftNonce('quote'))
      void refreshRecentQuotes()
      setQuoteSuccess(true)
      if (quoteSuccessTimerRef.current) clearTimeout(quoteSuccessTimerRef.current)
      quoteSuccessTimerRef.current = setTimeout(() => setQuoteSuccess(false), 3000)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao criar cotação.'
      setQuoteStatus(message)
    } finally {
      setSavingQuote(false)
    }
  }

  const handleConvertRecentQuote = async (quote: (typeof recentQuotes)[number]) => {
    if (quoteRowBusyId || convertingQuote || savingQuote) return
    setQuoteRowBusyId(quote.id)
    try {
      setQuoteId(quote.id)
      setQuoteSavedStatus(mapQuoteSavedStatus(quote.status))
      await handleConvertQuote(quote.id, false)
    } finally {
      setQuoteRowBusyId(null)
    }
  }

  const handleDuplicateRecentQuote = async (quote: (typeof recentQuotes)[number]) => {
    if (quoteRowBusyId || convertingQuote || savingQuote) return
    setQuoteRowBusyId(quote.id)
    try {
      const duplicateAttemptKey = `${createDraftNonce('quote')}-duplicate-${quote.id}`
      const duplicated = await duplicateQuote(quote.id, {
        idempotencyKey: duplicateAttemptKey,
      })
      setQuoteId(duplicated.quoteId)
      setQuoteSavedStatus('draft')
      showToast(`Cotação duplicada com sucesso.`)
      setQuoteNeedsReview(false)
      setQuoteReviewItems([])
      setQuoteDraftNonce(createDraftNonce('quote'))
      void refreshRecentQuotes()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao duplicar cotação.'
      showToast(message, true)
    } finally {
      setQuoteRowBusyId(null)
    }
  }

  const handleCancelRecentQuote = async (quote: (typeof recentQuotes)[number]) => {
    if (quoteRowBusyId || convertingQuote || savingQuote) return
    setQuoteRowBusyId(quote.id)
    try {
      await cancelQuote(quote.id, {
        idempotencyKey: `quote-cancel-${quote.id}`,
      })
      showToast(`Cotação cancelada.`)
      if (quote.id === quoteId) {
        setQuoteSavedStatus('cancelled')
      }
      void refreshRecentQuotes()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao cancelar cotação.'
      showToast(message, true)
    } finally {
      setQuoteRowBusyId(null)
    }
  }

  const runWorkflowAction = async (
    action: () => Promise<{ workflow: SalesOrderWorkflow }>,
    busyMessage: string,
  ) => {
    setWorkflowBusy(true)
    setWorkflowStatus(busyMessage)
    try {
      const result = await action()
      setOrderWorkflow(result.workflow)
      setWorkflowStatus(result.workflow.stageLabel)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Falha ao atualizar o fluxo.'
      setWorkflowStatus(message)
    } finally {
      setWorkflowBusy(false)
    }
  }

  const handleInvoiceOrder = async () => {
    if (!lastOrderId) return
    await runWorkflowAction(
      () =>
        invoiceSalesOrder(lastOrderId, {
          idempotencyKey: `sales-order-invoice-${lastOrderId}`,
        }),
      'Caixa registrando pagamento...',
    )
  }

  const handleCreatePickup = async () => {
    if (!lastOrderId) return
    await runWorkflowAction(
      () =>
        createPickupForOrder(lastOrderId, {
          idempotencyKey: `sales-order-pickup-create-${lastOrderId}`,
        }),
      'Empacotador separando pedido...',
    )
  }

  const handleDispatchPickup = async () => {
    if (!lastOrderId) return
    await runWorkflowAction(
      () =>
        dispatchPickupForOrder(lastOrderId, {
          idempotencyKey: `sales-order-pickup-dispatch-${lastOrderId}`,
        }),
      'Marcando pedido como pronto para retirada...',
    )
  }

  const handleCompletePickup = async () => {
    if (!lastOrderId) return
    await runWorkflowAction(
      () =>
        completePickupForOrder(lastOrderId, {
          idempotencyKey: `sales-order-pickup-deliver-${lastOrderId}`,
        }),
      'Concluindo retirada no balcão...',
    )
  }

  const handleSubmitAiChat = useCallback(async () => {
    const content = aiChatInput.trim()
    if (!content || aiChatLoading) return

    const nextMessages: SalesAiChatEntry[] = [
      ...aiChatMessages,
      {
        id: createTransientId('sales-ai-user'),
        role: 'user',
        content,
      },
    ]

    setAiChatMessages(nextMessages)
    setAiChatInput('')
    setAiChatError('')
    setAiChatLoading(true)

    try {
      const result = await sendSalesAiChat({
        messages: nextMessages.slice(-SALES_AI_HISTORY_LIMIT).map((message) => ({
          role: message.role,
          content: message.content,
        })),
      })

      const assistantReply = result.message.trim() || 'A IA não retornou conteúdo.'
      setAiChatMessages((previous) => [
        ...previous,
        {
          id: createTransientId('sales-ai-assistant'),
          role: 'assistant',
          content: assistantReply,
        },
      ])
    } catch (error) {
      setAiChatError(error instanceof Error ? error.message : 'Erro ao consultar a IA.')
    } finally {
      setAiChatLoading(false)
    }
  }, [aiChatInput, aiChatLoading, aiChatMessages])

  useEffect(() => {
    const element = aiChatLogRef.current
    if (!element) return
    element.scrollTop = element.scrollHeight
  }, [aiChatMessages, aiChatLoading])

  return (
    <div className="page-grid">
      <PageHeader />
      {!historyExpanded && (
        <Tabs
          tabs={[{ key: 'new' as const, label: 'Novo Pedido' }, { key: 'quote' as const, label: 'Cotação' }, { key: 'history' as const, label: 'Histórico' }]}
          active={activeView}
          onChange={(k) => handleChangeActiveView(k as 'new' | 'quote' | 'history')}
        />
      )}
      <div
        ref={salesPanelShellRef}
        className={`sales-panel-shell${salesPanelStretchDirection ? ` sales-panel-shell-animating sales-panel-shell-${salesPanelStretchDirection}` : ''}`}
        style={salesPanelHeight == null ? undefined : { height: `${salesPanelHeight}px` }}
      >
        <div ref={salesPanelContentRef} className="sales-panel-shell-content">
      {activeView === 'new' && (
      <div className="card sales-panel">
        {orderSuccess && (
          <div className="sales-panel-success-overlay">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="11" stroke="#E5BA41" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <polyline points="6 13 9 16 17 8" stroke="#E5BA41" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            <span className="sales-panel-success-label">Pedido Gerado</span>
          </div>
        )}
        <div className={`sales-panel-content${orderSuccess ? ' sales-panel-content-hidden' : ''}`}>
        <div className="search-bar">
          <input
            ref={orderSearchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar produto"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void handleBarcodeEnter(query).then((handled) => {
                  if (handled) return
                  if (results[selectedResultIndex]) {
                    addToCart(results[selectedResultIndex])
                  }
                })
              }
            }}
          />
          {orderProductDropMounted && (
            <div className={`search-dropdown ${orderProductDropExiting ? 'dropdown-rubber-exit' : 'dropdown-rubber-enter'}`}>
              {results.length > 0 && (
                <div
                  ref={orderResultsListRef}
                  className="search-dropdown-scroll"
                  onScroll={handleOrderResultsScroll}
                >
                  <div style={{ height: orderProductVirtualRows.offsetTop }} />
                  {Array.from({ length: Math.max(orderProductVirtualRows.end - orderProductVirtualRows.start, 0) }, (_, localIndex) => {
                    const index = orderProductVirtualRows.start + localIndex
                    const item = results[index]
                    if (!item) {
                      return (
                        <div
                          key={`order-product-skeleton-${index}`}
                          aria-hidden="true"
                          className="search-result virtualized-dropdown-placeholder"
                          style={{ height: PRODUCT_RESULT_ROW_HEIGHT }}
                        />
                      )
                    }
                    return (
                      <button
                        key={item.id}
                        type="button"
                        style={{ height: PRODUCT_RESULT_ROW_HEIGHT }}
                        className={`search-result virtualized-dropdown-fade${index === selectedResultIndex ? ' selected' : ''}`}
                        onMouseEnter={() => setSelectedResultIndex(index)}
                        onClick={() => addToCart(item)}
                      >
                        <img
                          src={item.image_url ?? ''}
                          alt=""
                          onError={(event) => {
                            event.currentTarget.src = fallbackProductImageDataUri
                          }}
                        />
                        <div className="result-info">
                          <span className="result-title">{item.name}</span>
                          <span className="result-meta">R$ {item.price.toFixed(2)}</span>
                          <span className="result-meta">Estoque: {item.stock_available}</span>
                        </div>
                      </button>
                    )
                  })}
                  <div style={{ height: orderProductVirtualRows.offsetBottom }} />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="cart-list">
          {cartItems.map((item, index) => (
            <div
              className={`cart-card${index === selectedCartIndex ? ' selected' : ''}`}
              key={item.id}
              onClick={() => setSelectedCartIndex(index)}
            >
              <img
                src={item.image_url ?? ''}
                alt=""
                onError={(event) => {
                  event.currentTarget.src = fallbackProductImageDataUri
                }}
              />
              <div className="cart-info">
                <span>{item.name}</span>
                <span>
                  Subtotal: R${' '}
                  {(
                    Math.max(
                      item.price -
                        (item.discountMode === 'percent'
                          ? (item.price * (item.discountValue ?? 0)) / 100
                          : item.discountValue ?? 0),
                      0,
                    ) * item.quantity
                  ).toFixed(2)}
                </span>
                {(item.stock_available ?? 0) <= 0 && (
                  <span className="stock-alert">Sem estoque</span>
                )}
                {(item.stock_available ?? 0) > 0 && (item.stock_available ?? 0) <= 5 && (
                  <span className="stock-alert warn">Estoque baixo</span>
                )}
                <div className="discount-line">
                  <div className="input-group">
                    <Select
                      value={item.discountMode ?? 'percent'}
                      options={[{ value: 'value', label: 'R$' }, { value: 'percent', label: '%' }]}
                      onChange={(v) =>
                        setCartItems((state) =>
                          state.map((cart) =>
                            cart.id === item.id
                              ? { ...cart, discountMode: v as 'percent' | 'value', discountValue: 0 }
                              : cart,
                          ),
                        )
                      }
                    />
                    <NumericInput
                      value={item.discountValue ?? 0}
                      currency={(item.discountMode ?? 'percent') === 'value'}
                      decimals={(item.discountMode ?? 'percent') === 'percent' ? 0 : undefined}
                      onChange={(event) =>
                        setCartItems((state) =>
                          state.map((cart) =>
                            cart.id === item.id
                              ? {
                                  ...cart,
                                  discountValue: normalizeDiscountValue(Number(event.target.value)),
                                }
                              : cart,
                          ),
                        )
                      }
                    />
                  </div>
                  <span>Desconto</span>
                </div>
              </div>
              <div className="qty-controls">
                <button
                  type="button"
                  onClick={() =>
                    setCartItems((state) =>
                      state
                        .map((cart) =>
                          cart.id === item.id
                            ? { ...cart, quantity: cart.quantity - 1 }
                            : cart,
                        )
                        .filter((cart) => cart.quantity > 0),
                    )
                  }
                >
                  -
                </button>
                <span>{item.quantity}</span>
                <button
                  type="button"
                  onClick={() =>
                    setCartItems((state) =>
                      state.map((cart) =>
                        cart.id === item.id
                          ? { ...cart, quantity: cart.quantity + 1 }
                          : cart,
                      ),
                    )
                  }
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="customer-action-row">
          <div className="customer-line">
            <span>Cliente: {customerLabel}</span>
            <button
              type="button"
              className="ghost icon-btn"
              onClick={() => setShowCustomerSelect((state) => !state)}
              aria-label="Alterar cliente"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M20 17H4M4 17L8 13M4 17L8 21M4 7H20M20 7L16 3M20 7L16 11" stroke="#E5BA41" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            {customerWrapperMounted && (
              <div className={`customer-input-wrapper ${customerWrapperExiting ? 'rubber-h-exit' : 'rubber-h-enter'}`}>
                <input
                  ref={customerSearchRef}
                  value={customerQuery}
                  onChange={(event) => setCustomerQuery(event.target.value)}
                  placeholder="Buscar cliente"
                />
                {orderCustomerDropMounted && (
                  <div className={`customer-dropdown ${orderCustomerDropExiting ? 'dropdown-rubber-exit' : 'dropdown-rubber-enter'}`}>
                    {inlineCreateTarget === 'order-customer' ? (
                      <InlineCreateForm
                        type="customer"
                        initialName={customerQuery.trim()}
                        onCreated={(entity) => {
                          setInlineCreateTarget(null)
                          setCustomerId(entity.id)
                          setCustomerLabel(entity.name)
                          setShowCustomerSelect(false)
                          setCustomerQuery('')
                          setCustomerResults([])
                          setCustomerResultsHasMore(true)
                          setCustomerResultsScrollTop(0)
                          customerResultsLoadMoreOffsetRef.current = null
                        }}
                        onCancel={() => {
                          setInlineCreateTarget(null)
                          setCustomerQuery('')
                        }}
                      />
                    ) : (
                      <>
                        {!customerResults.some((c) => c.name.toLowerCase() === normalizedCustomerQuery.toLowerCase()) && (
                          <button type="button" className="customer-result" style={{ borderBottom: customerResults.length > 0 ? '1px solid var(--border)' : undefined, borderRadius: customerResults.length > 0 ? 0 : undefined }} onClick={() => setInlineCreateTarget('order-customer')}>
                            <span style={{ color: 'var(--text)', fontWeight: 500 }}>Adicionar Cliente</span>
                          </button>
                        )}
                        {customerResults.length > 0 && (
                          <div
                            ref={customerResultsListRef}
                            className="customer-dropdown-scroll"
                            onScroll={handleCustomerResultsScroll}
                          >
                            <div style={{ height: customerVirtualRows.offsetTop }} />
                            {Array.from({ length: Math.max(customerVirtualRows.end - customerVirtualRows.start, 0) }, (_, localIndex) => {
                              const index = customerVirtualRows.start + localIndex
                              const customer = customerResults[index]
                              if (!customer) {
                                return (
                                  <div
                                    key={`order-customer-skeleton-${index}`}
                                    aria-hidden="true"
                                    className="customer-result virtualized-dropdown-placeholder"
                                    style={{ height: CUSTOMER_RESULT_ROW_HEIGHT }}
                                  />
                                )
                              }
                              return (
                                <button
                                  key={customer.id}
                                  type="button"
                                  style={{ height: CUSTOMER_RESULT_ROW_HEIGHT }}
                                  className="customer-result virtualized-dropdown-fade"
                                  onClick={() => {
                                    setCustomerId(customer.id)
                                    setCustomerLabel(customer.name)
                                    setShowCustomerSelect(false)
                                    setCustomerQuery('')
                                    setCustomerResults([])
                                    setCustomerResultsHasMore(true)
                                    setCustomerResultsScrollTop(0)
                                    customerResultsLoadMoreOffsetRef.current = null
                                    orderSearchRef.current?.focus()
                                  }}
                                >
                                  <span>{customer.name}</span>
                                  {customer.phone && <span className="result-meta">{customer.phone}</span>}
                                </button>
                              )
                            })}
                            <div style={{ height: customerVirtualRows.offsetBottom }} />
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            className="action-primary"
            disabled={!defaults || cartItems.length === 0 || creatingOrder}
            onClick={handleCreateOrder}
          >
            {creatingOrder ? (
              'GERANDO...'
            ) : (
              <>
                GERAR PEDIDO
                <svg width="16" height="16" viewBox="0 0 32 32" style={{ transform: 'rotate(90deg)', marginLeft: '8px', flexShrink: 0 }}>
                  <path d="M29.9,28.6l-13-26c-0.3-0.7-1.4-0.7-1.8,0l-13,26c-0.2,0.4-0.1,0.8,0.2,1.1C2.5,30,3,30.1,3.4,29.9L16,25.1l12.6,4.9c0.1,0,0.2,0.1,0.4,0.1c0.3,0,0.5-0.1,0.7-0.3C30,29.4,30.1,28.9,29.9,28.6z" fill="#2B2B2B"/>
                </svg>
              </>
            )}
          </button>
        </div>

        <div className="order-footer-row">
          <div className="order-discount">
            <span>Desconto geral:</span>
            <div className="input-group">
              <Select
                value={orderDiscountMode}
                options={[{ value: 'value', label: 'R$' }, { value: 'percent', label: '%' }]}
                onChange={(v) => { setOrderDiscountMode(v as 'percent' | 'value'); setOrderDiscountValue(0) }}
              />
              <NumericInput
                value={orderDiscountValue}
                currency={orderDiscountMode === 'value'}
                decimals={orderDiscountMode === 'percent' ? 0 : undefined}
                onChange={(event) =>
                  setOrderDiscountValue(normalizeDiscountValue(Number(event.target.value)))
                }
              />
            </div>
          </div>
          <span className="order-total-label">Total: R$ {orderDiscounted.total.toFixed(2)}</span>
          <PaymentComboBox
            value={paymentCondition}
            onChange={setPaymentCondition}
          />
        </div>
        </div>
      </div>
      )}
      {activeView === 'quote' && (
      <div className="card sales-panel">
        {quoteSuccess && (
          <div className="sales-panel-success-overlay">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="12" cy="12" r="11" stroke="#E5BA41" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              <polyline points="6 13 9 16 17 8" stroke="#E5BA41" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            <span className="sales-panel-success-label">Cotação Salva</span>
          </div>
        )}
        <div className={`sales-panel-content${quoteSuccess ? ' sales-panel-content-hidden' : ''}`}>
        <div className="search-bar">
          <input
            ref={quoteSearchRef}
            value={quoteQuery}
            onChange={(event) => setQuoteQuery(event.target.value)}
            placeholder="Buscar produto"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && quoteResults[selectedQuoteResultIndex]) {
                event.preventDefault()
                addToQuote(quoteResults[selectedQuoteResultIndex])
              }
            }}
          />
          {quoteProductDropMounted && (
            <div className={`search-dropdown ${quoteProductDropExiting ? 'dropdown-rubber-exit' : 'dropdown-rubber-enter'}`}>
              {quoteResults.length > 0 && (
                <div
                  ref={quoteResultsListRef}
                  className="search-dropdown-scroll"
                  onScroll={handleQuoteResultsScroll}
                >
                  <div style={{ height: quoteProductVirtualRows.offsetTop }} />
                  {Array.from({ length: Math.max(quoteProductVirtualRows.end - quoteProductVirtualRows.start, 0) }, (_, localIndex) => {
                    const index = quoteProductVirtualRows.start + localIndex
                    const item = quoteResults[index]
                    if (!item) {
                      return (
                        <div
                          key={`quote-product-skeleton-${index}`}
                          aria-hidden="true"
                          className="search-result virtualized-dropdown-placeholder"
                          style={{ height: PRODUCT_RESULT_ROW_HEIGHT }}
                        />
                      )
                    }
                    return (
                      <button
                        key={item.id}
                        type="button"
                        style={{ height: PRODUCT_RESULT_ROW_HEIGHT }}
                        className={`search-result virtualized-dropdown-fade${index === selectedQuoteResultIndex ? ' selected' : ''}`}
                        onMouseEnter={() => setSelectedQuoteResultIndex(index)}
                        onClick={() => addToQuote(item)}
                      >
                        <img
                          src={item.image_url ?? ''}
                          alt=""
                          onError={(event) => {
                            event.currentTarget.src = fallbackProductImageDataUri
                          }}
                        />
                        <div className="result-info">
                          <span className="result-title">{item.name}</span>
                          <span className="result-meta">R$ {item.price.toFixed(2)}</span>
                          <span className="result-meta">Estoque: {item.stock_available}</span>
                        </div>
                      </button>
                    )
                  })}
                  <div style={{ height: quoteProductVirtualRows.offsetBottom }} />
                </div>
              )}
            </div>
          )}
        </div>

        <div className="cart-list">
          {quoteItems.map((item, index) => (
            <div
              className={`cart-card${index === selectedQuoteCartIndex ? ' selected' : ''}`}
              key={item.id}
              onClick={() => setSelectedQuoteCartIndex(index)}
            >
              <img
                src={item.image_url ?? ''}
                alt=""
                onError={(event) => {
                  event.currentTarget.src = fallbackProductImageDataUri
                }}
              />
              <div className="cart-info">
                <span>{item.name}</span>
                <span>
                  Subtotal: R${' '}
                  {(
                    Math.max(
                      item.price -
                        (item.discountMode === 'percent'
                          ? (item.price * (item.discountValue ?? 0)) / 100
                          : item.discountValue ?? 0),
                      0,
                    ) * item.quantity
                  ).toFixed(2)}
                </span>
                <div className="discount-line">
                  <div className="input-group">
                    <Select
                      value={item.discountMode ?? 'percent'}
                      options={[{ value: 'value', label: 'R$' }, { value: 'percent', label: '%' }]}
                      onChange={(v) =>
                        setQuoteItems((state) =>
                          state.map((cart) =>
                            cart.id === item.id
                              ? { ...cart, discountMode: v as 'percent' | 'value', discountValue: 0 }
                              : cart,
                          ),
                        )
                      }
                    />
                    <NumericInput
                      value={item.discountValue ?? 0}
                      currency={(item.discountMode ?? 'percent') === 'value'}
                      decimals={(item.discountMode ?? 'percent') === 'percent' ? 0 : undefined}
                      onChange={(event) =>
                        setQuoteItems((state) =>
                          state.map((cart) =>
                            cart.id === item.id
                              ? {
                                  ...cart,
                                  discountValue: normalizeDiscountValue(Number(event.target.value)),
                                }
                              : cart,
                          ),
                        )
                      }
                    />
                  </div>
                  <span>Desconto</span>
                </div>
              </div>
              <div className="qty-controls">
                <button
                  type="button"
                  onClick={() =>
                    setQuoteItems((state) =>
                      state
                        .map((cart) =>
                          cart.id === item.id
                            ? { ...cart, quantity: cart.quantity - 1 }
                            : cart,
                        )
                        .filter((cart) => cart.quantity > 0),
                    )
                  }
                >
                  -
                </button>
                <span>{item.quantity}</span>
                <button
                  type="button"
                  onClick={() =>
                    setQuoteItems((state) =>
                      state.map((cart) =>
                        cart.id === item.id
                          ? { ...cart, quantity: cart.quantity + 1 }
                          : cart,
                      ),
                    )
                  }
                >
                  +
                </button>
              </div>
            </div>
          ))}
        </div>

        <textarea
          className="visually-hidden"
          tabIndex={-1}
          aria-hidden="true"
          onFocus={(event) => event.currentTarget.blur()}
          value={JSON.stringify(
            quoteDiscounted.items.map((item) => ({
              product_id: item.id,
              description: item.name,
              quantity: item.quantity,
              unit_price: item.unit_price,
            })),
          )}
          readOnly
        />

        <div className="customer-action-row">
          <div className="customer-line">
            <span>Cliente: {quoteCustomerLabel}</span>
            <button
              type="button"
              className="ghost icon-btn"
              onClick={() => setShowQuoteCustomerSelect((state) => !state)}
              aria-label="Alterar cliente"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M20 17H4M4 17L8 13M4 17L8 21M4 7H20M20 7L16 3M20 7L16 11" stroke="#E5BA41" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            {quoteCustomerWrapperMounted && (
              <div className={`customer-input-wrapper ${quoteCustomerWrapperExiting ? 'rubber-h-exit' : 'rubber-h-enter'}`}>
                <input
                  ref={quoteCustomerSearchRef}
                  value={quoteCustomerQuery}
                  onChange={(event) => setQuoteCustomerQuery(event.target.value)}
                  placeholder="Buscar cliente"
                />
                {quoteCustomerDropMounted && (
                  <div className={`customer-dropdown ${quoteCustomerDropExiting ? 'dropdown-rubber-exit' : 'dropdown-rubber-enter'}`}>
                    {inlineCreateTarget === 'quote-customer' ? (
                      <InlineCreateForm
                        type="customer"
                        initialName={quoteCustomerQuery.trim()}
                        onCreated={(entity) => {
                          setInlineCreateTarget(null)
                          setQuoteCustomerId(entity.id)
                          setQuoteCustomerLabel(entity.name)
                          setShowQuoteCustomerSelect(false)
                          setQuoteCustomerQuery('')
                          setQuoteCustomerResults([])
                          setQuoteCustomerResultsHasMore(true)
                          setQuoteCustomerResultsScrollTop(0)
                          quoteCustomerResultsLoadMoreOffsetRef.current = null
                        }}
                        onCancel={() => {
                          setInlineCreateTarget(null)
                          setQuoteCustomerQuery('')
                        }}
                      />
                    ) : (
                      <>
                        {!quoteCustomerResults.some((c) => c.name.toLowerCase() === normalizedQuoteCustomerQuery.toLowerCase()) && (
                          <button type="button" className="customer-result" style={{ borderBottom: quoteCustomerResults.length > 0 ? '1px solid var(--border)' : undefined, borderRadius: quoteCustomerResults.length > 0 ? 0 : undefined }} onClick={() => setInlineCreateTarget('quote-customer')}>
                            <span style={{ color: 'var(--text)', fontWeight: 500 }}>Adicionar Cliente</span>
                          </button>
                        )}
                        {quoteCustomerResults.length > 0 && (
                          <div
                            ref={quoteCustomerResultsListRef}
                            className="customer-dropdown-scroll"
                            onScroll={handleQuoteCustomerResultsScroll}
                          >
                            <div style={{ height: quoteCustomerVirtualRows.offsetTop }} />
                            {Array.from({ length: Math.max(quoteCustomerVirtualRows.end - quoteCustomerVirtualRows.start, 0) }, (_, localIndex) => {
                              const index = quoteCustomerVirtualRows.start + localIndex
                              const customer = quoteCustomerResults[index]
                              if (!customer) {
                                return (
                                  <div
                                    key={`quote-customer-skeleton-${index}`}
                                    aria-hidden="true"
                                    className="customer-result virtualized-dropdown-placeholder"
                                    style={{ height: CUSTOMER_RESULT_ROW_HEIGHT }}
                                  />
                                )
                              }
                              return (
                                <button
                                  key={customer.id}
                                  type="button"
                                  style={{ height: CUSTOMER_RESULT_ROW_HEIGHT }}
                                  className="customer-result virtualized-dropdown-fade"
                                  onClick={() => {
                                    setQuoteCustomerId(customer.id)
                                    setQuoteCustomerLabel(customer.name)
                                    setShowQuoteCustomerSelect(false)
                                    setQuoteCustomerQuery('')
                                    setQuoteCustomerResults([])
                                    setQuoteCustomerResultsHasMore(true)
                                    setQuoteCustomerResultsScrollTop(0)
                                    quoteCustomerResultsLoadMoreOffsetRef.current = null
                                    quoteSearchRef.current?.focus()
                                  }}
                                >
                                  <span>{customer.name}</span>
                                  {customer.phone && <span className="result-meta">{customer.phone}</span>}
                                </button>
                              )
                            })}
                            <div style={{ height: quoteCustomerVirtualRows.offsetBottom }} />
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            className="action-primary"
            disabled={!defaults || quoteItems.length === 0 || savingQuote || convertingQuote}
            onClick={handleSaveQuote}
          >
            {savingQuote ? 'SALVANDO...' : 'SALVAR PEDIDO'}
          </button>
        </div>

        <div className="order-footer-row">
          <div className="order-discount">
            <span>Desconto geral:</span>
            <div className="input-group">
              <Select
                value={quoteDiscountMode}
                options={[{ value: 'value', label: 'R$' }, { value: 'percent', label: '%' }]}
                onChange={(v) => { setQuoteDiscountMode(v as 'percent' | 'value'); setQuoteDiscountValue(0) }}
              />
              <NumericInput
                value={quoteDiscountValue}
                currency={quoteDiscountMode === 'value'}
                decimals={quoteDiscountMode === 'percent' ? 0 : undefined}
                onChange={(event) =>
                  setQuoteDiscountValue(normalizeDiscountValue(Number(event.target.value)))
                }
              />
            </div>
          </div>
          <span className="order-total-label">Total: R$ {quoteDiscounted.total.toFixed(2)}</span>
          <button
            type="button"
            className="ghost"
            style={{ width: '200px', flexShrink: 0 }}
            disabled={
              !quoteId ||
              savingQuote ||
              convertingQuote ||
              (!!quoteSavedStatus && quoteSavedStatus !== 'draft' && !quoteNeedsReview)
            }
            onClick={() => {
              handleConvertQuote(quoteId, quoteNeedsReview)
            }}
          >
            {convertingQuote
              ? 'Convertendo...'
              : quoteNeedsReview
                ? 'Confirmar conversão com divergências'
                : 'Converter para pedido'}
          </button>
        </div>
        <div className="quote-meta">
          <label>
            Validade da cotação
            <DateInput
              value={quoteValidUntil}
              onChange={(event) => setQuoteValidUntil(event.target.value)}
            />
          </label>
          <span className="subtitle">
            Status:{' '}
            {quoteSavedStatus === 'converted'
              ? 'Convertida'
              : quoteSavedStatus === 'expired'
                ? 'Vencida'
                : quoteSavedStatus === 'cancelled'
                  ? 'Cancelada'
                  : 'Rascunho'}
          </span>
        </div>
        {quoteReviewItems.length > 0 && (
          <div className="quote-review">
            {quoteReviewItems.map((item, index) => (
              <p key={`${item.description}-${index}`} className="subtitle">
                {item.type === 'price'
                  ? `Preco mudou em "${item.description}": cotado R$ ${item.quoted.toFixed(2)} | atual R$ ${item.current.toFixed(2)}`
                  : `Estoque insuficiente em "${item.description}": necessário ${item.quoted} | disponível ${item.current}`}
              </p>
            ))}
          </div>
        )}
        </div>
      </div>
      )}
      {activeView === 'history' && (
        <div className="card sales-panel">
          {historyExpanded && (
            <div className="history-full-header">
              <span>Histórico</span>
              <button type="button" className="ghost" onClick={() => setHistoryExpanded(false)}>Voltar</button>
            </div>
          )}
          {historyExpanded && (
            <div className="search-bar">
              <input
                value={historySearch}
                onChange={(e) => { setHistorySearch(e.target.value); setHistoryOffset(0) }}
                placeholder="Buscar por cliente ou produto..."
              />
            </div>
          )}

          <div className={`history-table-wrap${!historyExpanded ? ' history-preview' : ''}`}>
            <table className="history-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Pedido</th>
                  <th>Cliente</th>
                  <th>Status</th>
                  <th>Total</th>
                  <th>Data</th>
                  <th>Validade</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {historyItems.map((item) => (
                  <>
                    <tr key={item.id} className={expandedOrderId === item.id ? 'expanded' : ''}>
                      <td className="history-cell-expand">
                        <button
                          type="button"
                          className="history-expand-btn"
                          onClick={() => item.kind === 'order' ? toggleExpandOrder(item.id) : toggleExpandQuote(item.id)}
                          aria-label={expandedOrderId === item.id ? 'Recolher' : 'Expandir'}
                        >
                          {expandedOrderId === item.id ? '▼' : '▶'}
                        </button>
                      </td>
                      <td className="history-cell-id">#{item.id.slice(0, 8)}</td>
                      <td className="history-cell-customer">{item.customerName}</td>
                      <td className="history-cell-status">
                        <span className="history-status-badge">
                          {item.kind === 'quote' ? getQuoteStatusLabel(item.status) : salesStatusLabel(item.status)}
                        </span>
                      </td>
                      <td className="history-cell-total">{fmtCurrency(item.totalAmount)}</td>
                      <td className="history-cell-date">{fmtDateFull(item.createdAt)}</td>
                      <td className="history-cell-date">{item.validUntil ? fmtDateFull(item.validUntil) : '—'}</td>
                      <td className="history-cell-actions">
                        {item.kind === 'order' ? (
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => {
                              const orig = historyOrders.find((o) => o.id === item.id)
                              if (orig) void handlePrintOrder(orig)
                            }}
                          >
                            Imprimir
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="ghost"
                              disabled={quoteRowBusyId !== null || convertingQuote || savingQuote}
                              onClick={() => void handleDuplicateRecentQuote(item)}
                            >
                              {quoteRowBusyId === item.id ? 'Processando...' : 'Duplicar'}
                            </button>
                            <button
                              type="button"
                              className="ghost"
                              disabled={
                                item.status === 'converted' ||
                                item.status === 'cancelled' ||
                                quoteRowBusyId !== null ||
                                convertingQuote ||
                                savingQuote
                              }
                              onClick={() => void handleCancelRecentQuote(item)}
                            >
                              {quoteRowBusyId === item.id ? 'Processando...' : 'Cancelar'}
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                    {expandedOrderId === item.id && (
                      <tr className="history-expanded-row">
                        <td colSpan={8} className="history-expanded-cell">
                          {expandingOrderId === item.id ? (
                            <p className="history-expanding">Carregando itens...</p>
                          ) : (
                            <div className="history-items">
                              <table className="history-items-table">
                                <thead>
                                  <tr>
                                    <th>Itens</th>
                                    <th>Quantidade</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {item.kind === 'order' ? (
                                    orderDetailsCache[item.id]?.items?.length > 0 ? (
                                      orderDetailsCache[item.id].items.map((detailItem) => (
                                        <tr key={detailItem.id}>
                                          <td>{detailItem.description}</td>
                                          <td>{Number(detailItem.quantity)}</td>
                                        </tr>
                                      ))
                                    ) : (
                                      <tr>
                                        <td colSpan={2} className="history-no-items">Nenhum item encontrado</td>
                                      </tr>
                                    )
                                  ) : (
                                    quoteDetailsCache[item.id]?.items?.length > 0 ? (
                                      quoteDetailsCache[item.id].items.map((detailItem) => (
                                        <tr key={detailItem.id}>
                                          <td>{detailItem.description}</td>
                                          <td>{detailItem.quantity}</td>
                                        </tr>
                                      ))
                                    ) : (
                                      <tr>
                                        <td colSpan={2} className="history-no-items">Nenhum item encontrado</td>
                                      </tr>
                                    )
                                  )}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
            {historyError && (
              <p className="history-empty" style={{ color: 'var(--danger, #dc2626)' }}>{historyError}</p>
            )}
            {historyItems.length === 0 && !historyLoading && !historyError && (
              <p className="history-empty">Nenhum registro encontrado.</p>
            )}
            {historyLoading && <p className="history-loading">Carregando...</p>}
            {historyExpanded && !historyLoading && historyOrders.length < historyTotal && (
              <div ref={historyEndRef} style={{ height: 1 }} />
            )}
          </div>

          {!historyExpanded && historyItems.length > 6 && (
            <button
              type="button"
              className="ghost history-load-more"
              onClick={() => setHistoryExpanded(true)}
            >
              Ver mais
            </button>
          )}

          {historyExpanded && editingOrder && (
            <div className="card" style={{ marginTop: 12, padding: 16 }}>
              <h3>Editar Pedido #{editingOrder.id.slice(0, 8)}</h3>
              
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
                <label style={{ flex: 1, minWidth: 200 }}>
                  Observações
                  <textarea
                    value={editingField.notes}
                    onChange={(e) => setEditingField((s) => ({ ...s, notes: e.target.value }))}
                    rows={2}
                    style={{ width: '100%' }}
                  />
                </label>
                <label style={{ flex: 1, minWidth: 200 }}>
                  Condição de Pagamento
                  <input
                    value={editingField.paymentCondition}
                    onChange={(e) => setEditingField((s) => ({ ...s, paymentCondition: e.target.value }))}
                    placeholder="Ex: 30/60/90, à vista, cartão..."
                    style={{ width: '100%' }}
                  />
                </label>
                <label style={{ minWidth: 140 }}>
                  Status
                  <Select
                    value={editingField.status}
                    options={[
                      { value: 'open', label: 'Não pago' },
                      { value: 'pending', label: 'Não pago' },
                      { value: 'invoiced', label: 'Pago' },
                      { value: 'cancelled', label: 'Reembolsado' },
                    ]}
                    onChange={(v) => setEditingField((s) => ({ ...s, status: v }))}
                  />
                </label>
              </div>
              {editingOrder.items.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <strong>Itens:</strong>
                  <table style={{ width: '100%', fontSize: '0.85rem', marginTop: 4 }}>
                    <thead>
                      <tr><th style={{ textAlign: 'left' }}>Descrição</th><th>Qtd</th><th>Unit</th><th>Total</th></tr>
                    </thead>
                    <tbody>
                      {editingOrder.items.map((it) => (
                        <tr key={it.id}>
                          <td>{it.description}</td>
                          <td style={{ textAlign: 'center' }}>{Number(it.quantity)}</td>
                          <td style={{ textAlign: 'right' }}>{fmtCurrency(Number(it.unitPrice))}</td>
                          <td style={{ textAlign: 'right' }}>{fmtCurrency(Number(it.totalPrice))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="actions" style={{ marginTop: 12 }}>
                <button type="button" className="action-primary" disabled={editBusy} onClick={() => void handleSaveEditOrder()}>
                  {editBusy ? 'Processando...' : 'Confirmar Alterações'}
                </button>
                <button type="button" className="ghost" disabled={editBusy} onClick={() => { setEditingOrder(null); setEditStatus('') }}>
                  Cancelar
                </button>
                <button type="button" className="ghost" disabled={editBusy} onClick={() => void handlePrintOrder({ id: editingOrder.id, status: editingOrder.status, totalAmount: editingOrder.totalAmount, notes: editingOrder.notes, createdAt: editingOrder.createdAt, updatedAt: editingOrder.updatedAt, customerId: editingOrder.customerId, customerName: editingOrder.customerName })}>
                  Imprimir
                </button>
              </div>
              
            </div>
          )}
        </div>
      )}
        </div>
      </div>

      {showSalesAiChat && (
        <div className="card sales-ai-chat">
          <div className="sales-ai-chat-header">
            <h3>Assistente de vendas</h3>
          </div>

          <div className="sales-ai-chat-body">
            <div ref={aiChatLogRef} className="sales-ai-chat-log" role="log" aria-live="polite" aria-busy={aiChatLoading}>
              {aiChatMessages.length === 0 && !aiChatLoading ? (
                <div className="sales-ai-chat-empty">
                  <p className="sales-ai-chat-empty-title">Faça uma pergunta para começar</p>
                  <p className="sales-ai-chat-empty-text">Vendas, clientes, pedidos ou negociação.</p>
                </div>
              ) : (
                aiChatMessages.map((message) => (
                  <div
                    key={message.id}
                    className={`sales-ai-chat-message sales-ai-chat-message-${message.role}`}
                  >
                    <div className={`sales-ai-chat-bubble sales-ai-chat-bubble-${message.role}`}>
                      {message.content}
                    </div>
                  </div>
                ))
              )}

              {aiChatLoading && (
                <div className="sales-ai-chat-message sales-ai-chat-message-assistant">
                  <div className="sales-ai-chat-bubble sales-ai-chat-bubble-assistant sales-ai-chat-bubble-loading">
                    <span className="sales-ai-chat-loading-dot" />
                    <span className="sales-ai-chat-loading-dot" />
                    <span className="sales-ai-chat-loading-dot" />
                  </div>
                </div>
              )}
            </div>

            <div className="sales-ai-chat-compose">
              <div className="sales-ai-chat-compose-row">
                <textarea
                  aria-label="Mensagem para o assistente de vendas"
                  rows={1}
                  value={aiChatInput}
                  onChange={(event) => {
                    setAiChatInput(event.target.value)
                    const el = event.target
                    el.style.height = 'auto'
                    el.style.height = `${el.scrollHeight}px`
                  }}
                  placeholder="Pergunte sobre vendas, clientes ou pedidos..."
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      void handleSubmitAiChat()
                    }
                  }}
                />
                <button
                  type="button"
                  className="action-primary sales-ai-chat-send"
                  disabled={aiChatLoading || !aiChatInput.trim()}
                  onClick={() => void handleSubmitAiChat()}
                  aria-label={aiChatLoading ? 'Enviando...' : 'Enviar'}
                >
                  {aiChatLoading ? (
                    '...'
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 32 32">
                      <path d="M29.9,28.6l-13-26c-0.3-0.7-1.4-0.7-1.8,0l-13,26c-0.2,0.4-0.1,0.8,0.2,1.1C2.5,30,3,30.1,3.4,29.9L16,25.1l12.6,4.9c0.1,0,0.2,0.1,0.4,0.1c0.3,0,0.5-0.1,0.7-0.3C30,29.4,30.1,28.9,29.9,28.6z" fill="#2B2B2B"/>
                    </svg>
                  )}
                </button>
              </div>

              {aiChatError && <p className="sales-ai-chat-error">{aiChatError}</p>}
            </div>
          </div>
        </div>
      )}
      {quickToast && <div className="quick-toast">{quickToast}</div>}
    </div>
  )
}
