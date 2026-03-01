import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { DateInput, NumericInput, Select, PageHeader, Tabs } from '../../components/ui'
import { useStatusToast } from '../../hooks/useStatusToast'
import { usePermission } from '../../hooks/usePermission'
import { toNumber, fmtQty, fmtDateTime } from '../../lib/formatters'
import {
  createStockAdjustment,
  fetchStockLevelsPaged,
  fetchStockMovementsPaged,
  fetchStockReplenishmentSuggestionsPaged,
  fetchWarehousesPaged,
  searchProductsPaged,
  transferStock,
  updateStockLevelMinMax,
  type StockLevelLookup,
  type StockMovementLookup,
  type StockReplenishmentSuggestion,
} from '../../services/core'
import { createInventoryCount } from '../../services/crm'
import {
  createLabel,
  fetchLabelsPaged,
  markLabelAsPrinted,
  type LabelLookup,
} from '../../services/labels'
import {
  dispatchShipment,
  deliverShipment,
  fetchShipmentsPaged,
  type ShipmentLookup,
} from '../../services/shipping'
import {
  escapeHtml,
  printHtmlDocument,
  printPresetOptions,
  type PrintPreset,
} from '../../services/printing'
import { LookupField, type LookupItem, type LookupSearchParams } from './LookupFields'
import { InlineCreateForm } from '../../components/InlineCreateForm'

const COMPRAS_HREF = '/compras'
const VENDAS_HREF = '/vendas'

const PAGE_SIZE = 20

type AreaId = 'overview' | 'consult' | 'movements' | 'operations' | 'utilities'
type OpsId = 'transfer' | 'adjustment' | 'inventory' | 'replenishment' | 'returns'
type WarehouseLookupOption = LookupItem

type ProductLookupOption = LookupItem & {
  sku: string | null
  stockAvailable: number
}

type RowDraft = {
  id: string
  productId: string
  quantity: string
}

type InventoryRowDraft = {
  id: string
  productId: string
  expectedQty: string
  countedQty: string
}

function createDraftId() {
  if (globalThis.crypto !== undefined && 'randomUUID' in globalThis.crypto) {
    return globalThis.crypto.randomUUID()
  }
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function createRowDraft(): RowDraft {
  return { id: createDraftId(), productId: '', quantity: '1' }
}

function createInventoryRowDraft(): InventoryRowDraft {
  return { id: createDraftId(), productId: '', expectedQty: '0', countedQty: '0' }
}

function roundQty(value: number) {
  return Number(toNumber(value).toFixed(4))
}

function movementLabel(value: string) {
  if (value === 'in') return 'Entrada'
  if (value === 'out') return 'Saída'
  if (value === 'adjust') return 'Ajuste'
  if (value === 'transfer') return 'Transferência'
  return value
}

function shipmentLabel(value: ShipmentLookup['status']) {
  if (value === 'pending') return 'Pendente'
  if (value === 'dispatched') return 'Despachado'
  if (value === 'delivered') return 'Entregue'
  if (value === 'cancelled') return 'Cancelado'
  return value
}

function mergeLookupMap<T extends { id: string }>(current: Record<string, T>, incoming: T[]) {
  if (incoming.length === 0) return current
  const next = { ...current }
  for (const row of incoming) next[row.id] = row
  return next
}

function normalizeTransferItems(items: RowDraft[]) {
  const grouped = new Map<string, number>()

  for (const [index, row] of items.entries()) {
    const productId = row.productId.trim()
    const qty = roundQty(toNumber(row.quantity))
    if (!productId) throw new Error(`Item ${index + 1}: selecione o produto.`)
    if (qty <= 0) throw new Error(`Item ${index + 1}: quantidade deve ser maior que zero.`)
    grouped.set(productId, roundQty((grouped.get(productId) ?? 0) + qty))
  }

  if (grouped.size === 0) throw new Error('Adicione ao menos um item.')
  return Array.from(grouped.entries()).map(([product_id, quantity]) => ({ product_id, quantity }))
}

function normalizeAdjustmentItems(items: RowDraft[], type: 'in' | 'out' | 'adjust') {
  const parsed = items.map((row, index) => {
    const product_id = row.productId.trim()
    const quantity = roundQty(toNumber(row.quantity))
    if (!product_id) throw new Error(`Item ${index + 1}: selecione o produto.`)
    if (type === 'adjust') {
      if (Math.abs(quantity) <= 0.0001) {
        throw new Error(`Item ${index + 1}: em ajuste, quantidade não pode ser zero.`)
      }
    } else if (quantity <= 0) {
      throw new Error(`Item ${index + 1}: quantidade deve ser maior que zero.`)
    }
    return { product_id, quantity }
  })

  if (parsed.length === 0) throw new Error('Adicione ao menos um item.')
  return parsed
}

function parsePasteRows(raw: string) {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) throw new Error('Cole ao menos uma linha.')
  return lines.map((line, index) => {
    const [productIdRaw, qtyRaw = '1'] = line.split(/[\t;]/)
    const productId = (productIdRaw ?? '').trim()
    const quantity = roundQty(toNumber(qtyRaw))
    if (!productId) throw new Error(`Linha ${index + 1}: informe o product_id.`)
    if (quantity <= 0) throw new Error(`Linha ${index + 1}: quantidade deve ser maior que zero.`)
    return { id: createDraftId(), productId, quantity: String(quantity) }
  })
}

function parseInventoryPasteRows(raw: string) {
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) throw new Error('Cole ao menos uma linha.')
  return lines.map((line, index) => {
    const [productIdRaw, countedRaw = '0'] = line.split(/[\t;]/)
    const productId = (productIdRaw ?? '').trim()
    const countedQty = roundQty(toNumber(countedRaw))
    if (!productId) throw new Error(`Linha ${index + 1}: informe o product_id.`)
    if (countedQty < 0) throw new Error(`Linha ${index + 1}: contado não pode ser negativo.`)
    return { id: createDraftId(), productId, expectedQty: '0', countedQty: String(countedQty) }
  })
}

type PagerProps = {
  total: number
  offset: number
  loading: boolean
  onPrevious: () => void
  onNext: () => void
}

function Pager({ total, offset, loading, onPrevious, onNext }: PagerProps) {
  if (total <= PAGE_SIZE) return null
  const current = Math.floor(offset / PAGE_SIZE) + 1
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1)
  return (
    <div className="inventory-pagination">
      <button type="button" className="ghost" disabled={offset === 0 || loading} onClick={onPrevious}>
        Anterior
      </button>
      <span>Página {current} de {pages}</span>
      <button
        type="button"
        className="ghost"
        disabled={offset + PAGE_SIZE >= total || loading}
        onClick={onNext}
      >
        Próxima
      </button>
    </div>
  )
}

function movementReferenceHref(refTable: string | null) {
  if (!refTable) return null
  if (refTable.includes('purchase')) return COMPRAS_HREF
  if (refTable.includes('shipment') || refTable.includes('sales')) return VENDAS_HREF
  return '/estoque'
}

export function EstoqueWorkspace() {
  const canTransfer = usePermission('stock.transfer')
  const canAdjust = usePermission('stock.adjust')
  const canInventory = usePermission('stock.inventory.count')
  const [activeArea, setActiveArea] = useState<AreaId>('overview')
  const [activeOps, setActiveOps] = useState<OpsId>('transfer')
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [status, setStatus] = useState('')
  useStatusToast(status)
  const ADD_WAREHOUSE_HINT = { label: 'Adicionar Depósito' }
  const ADD_PRODUCT_HINT = { label: 'Adicionar Produto' }
  const renderWarehouseCreate = (props: { initialName: string; onCreated: (e: { id: string; name: string }) => void; onCancel: () => void }) => <InlineCreateForm type="warehouse" {...props} />
  const renderProductCreate = (props: { initialName: string; onCreated: (e: { id: string; name: string }) => void; onCancel: () => void }) => <InlineCreateForm type="product" {...props} />

  const [warehousesById, setWarehousesById] = useState<Record<string, WarehouseLookupOption>>({})
  const [productsById, setProductsById] = useState<Record<string, ProductLookupOption>>({})

  const [alerts, setAlerts] = useState<StockLevelLookup[]>([])
  const [alertsLoading, setAlertsLoading] = useState(false)

  const [consultFilters, setConsultFilters] = useState({ warehouseId: '', productId: '', query: '', onlyAlerts: false })
  const [consultRows, setConsultRows] = useState<StockLevelLookup[]>([])
  const [consultTotal, setConsultTotal] = useState(0)
  const [consultOffset, setConsultOffset] = useState(0)
  const [consultLoading, setConsultLoading] = useState(false)

  const [movementFilters, setMovementFilters] = useState({ warehouseId: '', productId: '', movementType: '' as '' | 'in' | 'out' | 'adjust' | 'transfer', from: '', to: '', query: '' })
  const [movementRows, setMovementRows] = useState<StockMovementLookup[]>([])
  const [movementTotal, setMovementTotal] = useState(0)
  const [movementOffset, setMovementOffset] = useState(0)
  const [movementLoading, setMovementLoading] = useState(false)

  const [transferForm, setTransferForm] = useState({ originWarehouseId: '', destinationWarehouseId: '', notes: '', items: [createRowDraft()] })
  const [transferPaste, setTransferPaste] = useState('')
  const [focusedTransferItemId, setFocusedTransferItemId] = useState('')
  const [transferSubmitting, setTransferSubmitting] = useState(false)

  const [adjustmentForm, setAdjustmentForm] = useState({ warehouseId: '', adjustmentType: 'adjust' as 'in' | 'out' | 'adjust', reason: '', items: [createRowDraft()] })
  const [adjustmentSubmitting, setAdjustmentSubmitting] = useState(false)

  const [inventoryForm, setInventoryForm] = useState({ warehouseId: '', items: [createInventoryRowDraft()] })
  const [inventoryPaste, setInventoryPaste] = useState('')
  const [inventorySubmitting, setInventorySubmitting] = useState(false)

  const [replenishmentFilters, setReplenishmentFilters] = useState({ warehouseId: '', productId: '', query: '' })
  const [replenishmentRows, setReplenishmentRows] = useState<StockReplenishmentSuggestion[]>([])
  const [replenishmentTotal, setReplenishmentTotal] = useState(0)
  const [replenishmentOffset, setReplenishmentOffset] = useState(0)
  const [replenishmentLoading, setReplenishmentLoading] = useState(false)

  const [minMaxForm, setMinMaxForm] = useState({ warehouseId: '', productId: '', minQty: '0', maxQty: '0' })
  const [minMaxSubmitting, setMinMaxSubmitting] = useState(false)

  const [returnsForm, setReturnsForm] = useState({ warehouseId: '', protocol: '', items: [createRowDraft()] })
  const [returnsSubmitting, setReturnsSubmitting] = useState(false)

  const [shipmentFilters, setShipmentFilters] = useState({ status: '' as '' | 'pending' | 'dispatched' | 'delivered' | 'cancelled', query: '' })
  const [shipmentRows, setShipmentRows] = useState<ShipmentLookup[]>([])
  const [shipmentTotal, setShipmentTotal] = useState(0)
  const [shipmentOffset, setShipmentOffset] = useState(0)
  const [shipmentLoading, setShipmentLoading] = useState(false)

  const [labelForm, setLabelForm] = useState({ warehouseId: '', productId: '', quantity: '1', payloadJson: '' })
  const [labelFilters, setLabelFilters] = useState({ status: 'pending' as '' | 'pending' | 'printed', query: '' })
  const [labelRows, setLabelRows] = useState<LabelLookup[]>([])
  const [labelTotal, setLabelTotal] = useState(0)
  const [labelOffset, setLabelOffset] = useState(0)
  const [labelLoading, setLabelLoading] = useState(false)
  const [labelSubmitting, setLabelSubmitting] = useState(false)
  const [labelPrintPreset, setLabelPrintPreset] = useState<PrintPreset>('label_60x40')

  const [movementTypeOptions] = useState([
    { value: '', label: 'Todos os tipos' },
    { value: 'in', label: 'Entrada' },
    { value: 'out', label: 'Saída' },
    { value: 'adjust', label: 'Ajuste' },
    { value: 'transfer', label: 'Transferência' },
  ])
  const [shipmentStatusOptions] = useState([
    { value: '', label: 'Todos os status' },
    { value: 'pending', label: 'Pendente' },
    { value: 'dispatched', label: 'Despachado' },
    { value: 'delivered', label: 'Entregue' },
    { value: 'cancelled', label: 'Cancelado' },
  ])
  const [labelStatusOptions] = useState([
    { value: '', label: 'Todas' },
    { value: 'pending', label: 'Pendentes' },
    { value: 'printed', label: 'Impressas' },
  ])
  const [labelPrintPresetOptions] = useState(() =>
    printPresetOptions.filter(
      (option) =>
        option.value.startsWith('label_')
        || option.value.startsWith('thermal_')
        || option.value === 'jewelry_label',
    ),
  )

  const searchWarehouses = useCallback(async (params: LookupSearchParams) => {
    const result = await fetchWarehousesPaged({
      query: params.query,
      limit: params.limit,
      offset: params.offset,
      signal: params.signal,
    })
    const rows = result.rows.map((row) => ({ id: row.id, name: row.name }))
    setWarehousesById((state) => mergeLookupMap(state, rows))
    return { rows, totalCount: result.totalCount ?? null }
  }, [])

  const runProductLookup = useCallback(async (warehouseId: string, params: LookupSearchParams) => {
    if (!warehouseId.trim()) return { rows: [] as ProductLookupOption[], totalCount: 0 }
    const result = await searchProductsPaged(params.query, warehouseId, params.signal, {
      limit: params.limit,
      offset: params.offset,
    })
    const rows = result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      sku: row.sku,
      stockAvailable: toNumber(row.stock_available),
    }))
    setProductsById((state) => mergeLookupMap(state, rows))
    return { rows, totalCount: result.totalCount ?? null }
  }, [])

  const searchConsultProducts = useCallback((p: LookupSearchParams) => runProductLookup(consultFilters.warehouseId, p), [consultFilters.warehouseId, runProductLookup])
  const searchMovementProducts = useCallback((p: LookupSearchParams) => runProductLookup(movementFilters.warehouseId, p), [movementFilters.warehouseId, runProductLookup])
  const searchTransferProducts = useCallback((p: LookupSearchParams) => runProductLookup(transferForm.originWarehouseId, p), [transferForm.originWarehouseId, runProductLookup])
  const searchAdjustmentProducts = useCallback((p: LookupSearchParams) => runProductLookup(adjustmentForm.warehouseId, p), [adjustmentForm.warehouseId, runProductLookup])
  const searchInventoryProducts = useCallback((p: LookupSearchParams) => runProductLookup(inventoryForm.warehouseId, p), [inventoryForm.warehouseId, runProductLookup])
  const searchReplenishmentProducts = useCallback((p: LookupSearchParams) => runProductLookup(replenishmentFilters.warehouseId, p), [replenishmentFilters.warehouseId, runProductLookup])
  const searchMinMaxProducts = useCallback((p: LookupSearchParams) => runProductLookup(minMaxForm.warehouseId, p), [minMaxForm.warehouseId, runProductLookup])
  const searchReturnsProducts = useCallback((p: LookupSearchParams) => runProductLookup(returnsForm.warehouseId, p), [returnsForm.warehouseId, runProductLookup])
  const searchLabelProducts = useCallback((p: LookupSearchParams) => runProductLookup(labelForm.warehouseId, p), [labelForm.warehouseId, runProductLookup])

  const fetchAlerts = useCallback(async () => {
    setAlertsLoading(true)
    setStatus('')
    try {
      const result = await fetchStockLevelsPaged({ onlyAlerts: true, limit: 10, offset: 0 })
      setAlerts(result.rows)
      setStatus(result.rows.length > 0 ? `${result.rows.length} alerta(s) carregados.` : 'Sem alertas críticos.')
    } catch (error) {
      setStatus(`Falha ao atualizar alertas: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
    } finally {
      setAlertsLoading(false)
    }
  }, [])

  const fetchConsult = useCallback(async (offset: number, filters = consultFilters) => {
    setConsultLoading(true)
    setStatus('')
    try {
      const result = await fetchStockLevelsPaged({
        warehouseId: filters.warehouseId,
        productId: filters.productId,
        query: filters.query,
        onlyAlerts: filters.onlyAlerts,
        limit: PAGE_SIZE,
        offset,
      })
      setConsultRows(result.rows)
      setConsultTotal(result.totalCount ?? result.rows.length)
      setConsultOffset(offset)
      setStatus(result.rows.length > 0 ? `${result.rows.length} nível(is) exibido(s).` : 'Nenhum nível encontrado.')
    } catch (error) {
      setStatus(`Falha na consulta: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
    } finally {
      setConsultLoading(false)
    }
  }, [consultFilters])

  const fetchMovements = useCallback(async (offset: number, filters = movementFilters) => {
    setMovementLoading(true)
    setStatus('')
    try {
      const result = await fetchStockMovementsPaged({
        warehouseId: filters.warehouseId,
        productId: filters.productId,
        movementType: filters.movementType || undefined,
        from: filters.from,
        to: filters.to,
        query: filters.query,
        limit: PAGE_SIZE,
        offset,
      })
      setMovementRows(result.rows)
      setMovementTotal(result.totalCount ?? result.rows.length)
      setMovementOffset(offset)
      setStatus(result.rows.length > 0 ? `${result.rows.length} movimentação(ões) exibida(s).` : 'Nenhuma movimentação encontrada.')
    } catch (error) {
      setStatus(`Falha em movimentações: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
    } finally {
      setMovementLoading(false)
    }
  }, [movementFilters])

  const fetchReplenishment = useCallback(async (offset: number, filters = replenishmentFilters) => {
    setReplenishmentLoading(true)
    setStatus('')
    try {
      const result = await fetchStockReplenishmentSuggestionsPaged({
        warehouseId: filters.warehouseId,
        productId: filters.productId,
        query: filters.query,
        limit: PAGE_SIZE,
        offset,
      })
      setReplenishmentRows(result.rows)
      setReplenishmentTotal(result.totalCount ?? result.rows.length)
      setReplenishmentOffset(offset)
      setStatus(result.rows.length > 0 ? `${result.rows.length} sugestão(ões) carregada(s).` : 'Sem sugestões para os filtros atuais.')
    } catch (error) {
      setStatus(`Falha em reposição: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
    } finally {
      setReplenishmentLoading(false)
    }
  }, [replenishmentFilters])

  const fetchShipments = useCallback(async (offset: number, filters = shipmentFilters) => {
    setShipmentLoading(true)
    setStatus('')
    try {
      const result = await fetchShipmentsPaged({
        status: filters.status,
        query: filters.query,
        limit: PAGE_SIZE,
        offset,
      })
      setShipmentRows(result.rows)
      setShipmentTotal(result.totalCount ?? result.rows.length)
      setShipmentOffset(offset)
      setStatus(result.rows.length > 0 ? `${result.rows.length} expedição(ões) exibida(s).` : 'Nenhuma expedição encontrada.')
    } catch (error) {
      setStatus(`Falha em expedições: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
    } finally {
      setShipmentLoading(false)
    }
  }, [shipmentFilters])

  const fetchLabels = useCallback(async (offset: number, filters = labelFilters) => {
    setLabelLoading(true)
    setStatus('')
    try {
      const result = await fetchLabelsPaged({
        status: filters.status,
        query: filters.query,
        limit: PAGE_SIZE,
        offset,
      })
      setLabelRows(result.rows)
      setLabelTotal(result.totalCount ?? result.rows.length)
      setLabelOffset(offset)
      setStatus(result.rows.length > 0 ? `${result.rows.length} etiqueta(s) exibida(s).` : 'Nenhuma etiqueta encontrada.')
    } catch (error) {
      setStatus(`Falha em etiquetas: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
    } finally {
      setLabelLoading(false)
    }
  }, [labelFilters])

  useEffect(() => {
    void fetchAlerts()
    void fetchShipments(0)
  }, [fetchAlerts, fetchShipments])

  function openTransferFromLevel(row: StockLevelLookup, suggestedQty?: number) {
    const quantity = Math.max(roundQty(suggestedQty ?? 1), 1)
    setTransferForm((state) => ({
      ...state,
      destinationWarehouseId: row.warehouseId,
      notes: `Reposição para ${row.productName}`,
      items: [{ id: createDraftId(), productId: row.productId, quantity: String(quantity) }],
    }))
    setActiveArea('operations')
    setActiveOps('transfer')
    setStatus('Transferência rápida preenchida. Selecione a origem e confirme.')
  }

  function openAdjustmentFromLevel(row: StockLevelLookup) {
    const suggested = Math.max(roundQty(toNumber(row.minQty) - toNumber(row.qtyAvailable)), 1)
    setAdjustmentForm((state) => ({
      ...state,
      warehouseId: row.warehouseId,
      adjustmentType: 'adjust',
      reason: `Correção rápida para ${row.productName}`,
      items: [{ id: createDraftId(), productId: row.productId, quantity: String(suggested) }],
    }))
    setActiveArea('operations')
    setActiveOps('adjustment')
    setStatus('Ajuste rápido preenchido. Revise e confirme.')
  }

  function openMovementFromLevel(row: StockLevelLookup) {
    const nextFilters = {
      warehouseId: row.warehouseId,
      productId: row.productId,
      movementType: '' as '' | 'in' | 'out' | 'adjust' | 'transfer',
      from: '',
      to: '',
      query: '',
    }
    setMovementFilters(nextFilters)
    setActiveArea('movements')
    void fetchMovements(0, nextFilters)
  }

  function openTransferFromReplenishment(row: StockReplenishmentSuggestion) {
    const suggested = Math.max(roundQty(toNumber(row.qtyToReplenish)), 1)
    setTransferForm((state) => ({
      ...state,
      destinationWarehouseId: row.warehouseId,
      notes: `Reposição mín/máx para ${row.productName}`,
      items: [{ id: createDraftId(), productId: row.productId, quantity: String(suggested) }],
    }))
    setActiveArea('operations')
    setActiveOps('transfer')
    setStatus('Transferência de reposição preenchida. Escolha a origem e confirme.')
  }

  function applyTransferPaste() {
    try {
      const rows = parsePasteRows(transferPaste)
      setTransferForm((state) => ({ ...state, items: rows }))
      setStatus(`Colagem aplicada em ${rows.length} item(ns).`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Falha ao aplicar colagem.')
    }
  }

  function applyInventoryPaste() {
    try {
      const rows = parseInventoryPasteRows(inventoryPaste)
      setInventoryForm((state) => ({ ...state, items: rows }))
      setStatus(`Colagem aplicada em ${rows.length} item(ns).`)
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Falha ao aplicar colagem.')
    }
  }

  const handleTransferShortcuts = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.shiftKey && event.key === 'Enter') {
      event.preventDefault()
      setTransferForm((state) => ({
        ...state,
        items: [...state.items, createRowDraft()],
      }))
      return
    }
    if (!(event.ctrlKey || event.metaKey)) return
    const key = event.key.toLowerCase()
    if (key === 'd') {
      event.preventDefault()
      if (!focusedTransferItemId) return
      setTransferForm((state) => {
        const idx = state.items.findIndex((it) => it.id === focusedTransferItemId)
        if (idx < 0) return state
        const clone = { ...state.items[idx], id: createDraftId() }
        const next = [...state.items]
        next.splice(idx + 1, 0, clone)
        return { ...state, items: next }
      })
      return
    }
    if (event.key === 'Backspace') {
      event.preventDefault()
      if (!focusedTransferItemId) return
      setTransferForm((state) => ({
        ...state,
        items: state.items.length <= 1 ? state.items : state.items.filter((it) => it.id !== focusedTransferItemId),
      }))
      return
    }
    if (key === '/') {
      event.preventDefault()
      setShowShortcuts((state) => !state)
    }
  }

  async function submitTransfer() {
    setTransferSubmitting(true)
    setStatus('Transferindo estoque...')
    try {
      const originWarehouseId = transferForm.originWarehouseId.trim()
      const destinationWarehouseId = transferForm.destinationWarehouseId.trim()
      if (!originWarehouseId) throw new Error('Selecione o depósito de origem.')
      if (!destinationWarehouseId) throw new Error('Selecione o depósito de destino.')
      if (originWarehouseId === destinationWarehouseId) throw new Error('Origem e destino não podem ser iguais.')
      const result = await transferStock({
        originWarehouseId,
        destinationWarehouseId,
        notes: transferForm.notes.trim() || undefined,
        items: normalizeTransferItems(transferForm.items),
      })
      setStatus(`Transferência registrada: ${result.transferId}.`)
      setTransferForm((state) => ({ ...state, notes: '', items: [createRowDraft()] }))
      setTransferPaste('')
      void fetchAlerts()
      void fetchConsult(0)
      void fetchMovements(0)
    } catch (error) {
      setStatus(`Falha na transferência: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
    } finally {
      setTransferSubmitting(false)
    }
  }

  async function submitAdjustment() {
    setAdjustmentSubmitting(true)
    setStatus('Aplicando ajuste manual...')
    try {
      const warehouseId = adjustmentForm.warehouseId.trim()
      if (!warehouseId) throw new Error('Selecione o depósito.')
      const result = await createStockAdjustment({
        warehouseId,
        adjustmentType: adjustmentForm.adjustmentType,
        reason: adjustmentForm.reason.trim() || undefined,
        items: normalizeAdjustmentItems(adjustmentForm.items, adjustmentForm.adjustmentType),
      })
      setStatus(`Ajuste aplicado (${result.adjustedItems} itens, delta ${fmtQty(result.totalDelta)}).`)
      setAdjustmentForm((state) => ({ ...state, reason: '', items: [createRowDraft()] }))
      void fetchAlerts()
      void fetchConsult(0)
      void fetchMovements(0)
    } catch (error) {
      setStatus(`Falha no ajuste: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
    } finally {
      setAdjustmentSubmitting(false)
    }
  }

  async function submitInventory() {
    setInventorySubmitting(true)
    setStatus('Aplicando inventário...')
    try {
      const warehouseId = inventoryForm.warehouseId.trim()
      if (!warehouseId) throw new Error('Selecione o depósito.')

      const payloadItems = inventoryForm.items.map((row, index) => {
        const productId = row.productId.trim()
        const countedQty = roundQty(toNumber(row.countedQty))
        const expectedQty = roundQty(productsById[row.productId]?.stockAvailable ?? toNumber(row.expectedQty))

        if (!productId) throw new Error(`Item ${index + 1}: selecione o produto.`)
        if (countedQty < 0) throw new Error(`Item ${index + 1}: contado não pode ser negativo.`)
        if (expectedQty < 0) throw new Error(`Item ${index + 1}: esperado inválido.`)

        return {
          product_id: productId,
          expected_qty: expectedQty,
          counted_qty: countedQty,
        }
      })

      if (payloadItems.length === 0) {
        throw new Error('Adicione ao menos um item.')
      }

      const result = await createInventoryCount({ warehouseId, items: payloadItems })
      setStatus(`Inventário aplicado: ${result.countId} (${result.adjustedItems} item(ns)).`)
      setInventoryForm((state) => ({ ...state, items: [createInventoryRowDraft()] }))
      setInventoryPaste('')
      void fetchAlerts()
      void fetchConsult(0)
      void fetchMovements(0)
    } catch (error) {
      setStatus(`Falha no inventário: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
    } finally {
      setInventorySubmitting(false)
    }
  }

  async function submitMinMax() {
    setMinMaxSubmitting(true)
    setStatus('')
    try {
      const warehouseId = minMaxForm.warehouseId.trim()
      const productId = minMaxForm.productId.trim()
      const minQty = roundQty(toNumber(minMaxForm.minQty))
      const maxQty = roundQty(toNumber(minMaxForm.maxQty))
      if (!warehouseId) throw new Error('Selecione o depósito.')
      if (!productId) throw new Error('Selecione o produto.')
      if (maxQty < minQty) throw new Error('Máximo deve ser maior ou igual ao mínimo.')
      await updateStockLevelMinMax({ warehouseId, productId, minQty, maxQty })
      setStatus('Parâmetro mínimo/máximo atualizado.')
      void fetchAlerts()
      void fetchConsult(0)
      void fetchReplenishment(0)
    } catch (error) {
      setStatus(`Falha no mín/máx: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
    } finally {
      setMinMaxSubmitting(false)
    }
  }

  async function submitReturnEffect() {
    setReturnsSubmitting(true)
    setStatus('Recebendo devolução no estoque...')
    try {
      const warehouseId = returnsForm.warehouseId.trim()
      if (!warehouseId) throw new Error('Selecione o depósito.')
      const reason = returnsForm.protocol.trim()
        ? `Recebimento de devolução (${returnsForm.protocol.trim()})`
        : 'Recebimento de devolução'
      const result = await createStockAdjustment({
        warehouseId,
        adjustmentType: 'in',
        reason,
        items: normalizeAdjustmentItems(returnsForm.items, 'in'),
      })
      setStatus(`Devolução recebida (${result.adjustedItems} itens, +${fmtQty(result.totalDelta)}).`)
      setReturnsForm((state) => ({ ...state, protocol: '', items: [createRowDraft()] }))
      void fetchAlerts()
      void fetchConsult(0)
      void fetchMovements(0)
    } catch (error) {
      setStatus(`Falha no recebimento da devolução: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
    } finally {
      setReturnsSubmitting(false)
    }
  }

  async function submitLabel() {
    setLabelSubmitting(true)
    setStatus('Criando etiqueta...')
    try {
      const productId = labelForm.productId.trim()
      const quantity = Math.floor(toNumber(labelForm.quantity))
      if (!productId) throw new Error('Selecione o produto.')
      if (quantity <= 0) throw new Error('Quantidade inválida.')
      const payload = labelForm.payloadJson.trim()
        ? JSON.parse(labelForm.payloadJson) as Record<string, unknown>
        : undefined
      const result = await createLabel({ productId, quantity, payload })
      setStatus(`Etiqueta criada: ${result.id}.`)
      setLabelForm((state) => ({ ...state, quantity: '1', payloadJson: '' }))
      void fetchLabels(0)
    } catch (error) {
      setStatus(`Falha ao criar etiqueta: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
    } finally {
      setLabelSubmitting(false)
    }
  }

  async function handleDispatch(shipmentId: string) {
    setStatus('Despachando expedição...')
    try {
      await dispatchShipment(shipmentId)
      setStatus('Expedição despachada.')
      void fetchShipments(shipmentOffset)
      void fetchMovements(movementOffset)
    } catch (error) {
      setStatus(`Falha ao despachar: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
    }
  }

  async function handleDeliver(shipmentId: string) {
    setStatus('Finalizando entrega...')
    try {
      await deliverShipment(shipmentId)
      setStatus('Entrega finalizada.')
      void fetchShipments(shipmentOffset)
      void fetchMovements(movementOffset)
    } catch (error) {
      setStatus(`Falha ao entregar: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
    }
  }

  async function handleLabelPrinted(id: string) {
    setStatus('Marcando etiqueta como impressa...')
    try {
      await markLabelAsPrinted(id)
      setStatus('Etiqueta marcada como impressa.')
      void fetchLabels(labelOffset)
    } catch (error) {
      setStatus(`Falha ao marcar etiqueta: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
    }
  }

  async function handlePrint(label: LabelLookup) {
    setStatus('Preparando impressão da etiqueta...')

    try {
      await printHtmlDocument({
        title: 'Etiqueta de produto',
        subtitle: `ID ${label.id}`,
        preset: labelPrintPreset,
        bodyHtml: `
          <p><strong>${escapeHtml(label.productName ?? 'Produto não encontrado')}</strong></p>
          <p>SKU: ${escapeHtml(label.productSku ?? '—')}</p>
          <p>Quantidade de etiquetas: ${escapeHtml(String(label.quantity))}</p>
          <p>Status: ${escapeHtml(label.status === 'printed' ? 'Impressa' : 'Pendente')}</p>
        `,
        footerText: `Gerado em ${new Date().toLocaleString('pt-BR')}`,
      })
      setStatus('Etiqueta enviada para impressão.')
      return true
    } catch (error) {
      setStatus(`Falha ao imprimir etiqueta: ${error instanceof Error ? error.message : 'Erro inesperado.'}`)
      return false
    }
  }

  async function handlePrintAndMarkLabel(label: LabelLookup) {
    const printed = await handlePrint(label)
    if (!printed || label.status === 'printed') {
      return
    }

    await handleLabelPrinted(label.id)
  }

  function exportMovementCsv() {
    if (movementRows.length === 0 || globalThis.window === undefined) {
      setStatus('Nada para exportar.')
      return
    }
    const header = 'data;produto;sku;deposito;tipo;quantidade;motivo;referencia\n'
    const lines = movementRows.map((row) => {
      const ref = row.refTable && row.refId ? `${row.refTable}:${row.refId}` : ''
      return [
        fmtDateTime(row.occurredAt),
        row.productName,
        row.productSku ?? '',
        row.warehouseName,
        movementLabel(row.movementType),
        fmtQty(row.quantity),
        row.reason ?? '',
        ref,
      ].map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(';')
    })
    const blob = new Blob([header + lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = globalThis.URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `movimentacoes-${Date.now()}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    globalThis.URL.revokeObjectURL(url)
  }

  const alertsBelowMin = alerts.filter((row) => row.belowMin).length
  const alertsInconsistent = alerts.filter((row) => row.inconsistent).length
  const inventoryDifferenceTotal = inventoryForm.items.reduce((sum, row) => {
    const expected = toNumber(productsById[row.productId]?.stockAvailable ?? row.expectedQty)
    const counted = toNumber(row.countedQty)
    return sum + roundQty(counted - expected)
  }, 0)

  return (
    <div className="page-grid">
      <PageHeader />
      <div className="card fiscal-card purchase-flow-card inventory-workspace-card">

        <Tabs
          tabs={[
            { key: 'overview' as const, label: 'Visão e Alertas' },
            { key: 'consult' as const, label: 'Posição de Estoque' },
            { key: 'movements' as const, label: 'Movimentações (Kardex)' },
            { key: 'operations' as const, label: 'Operações Físicas' },
            { key: 'utilities' as const, label: 'Utilitários' },
          ]}
          active={activeArea}
          onChange={(k) => { setActiveArea(k as AreaId); if (k === 'utilities') void fetchLabels(0) }}
        />

        {activeArea === 'overview' && (
          <section className="purchase-section">
            <div className="inventory-kpi-grid">
              <article className="inventory-kpi-card">
                <small>Alertas ativos</small>
                <strong>{alerts.length}</strong>
              </article>
              <article className="inventory-kpi-card">
                <small>Abaixo do mínimo</small>
                <strong>{alertsBelowMin}</strong>
              </article>
              <article className="inventory-kpi-card">
                <small>Inconsistências</small>
                <strong>{alertsInconsistent}</strong>
              </article>
            </div>

            

            {(
              <div className="purchase-items">
                {alerts.map((row) => {
                  const suggestedQty = Math.max(
                    roundQty(toNumber(row.minQty) - toNumber(row.qtyAvailable)),
                    1,
                  )
                  return (
                    <div key={`${row.productId}:${row.warehouseId}`} className="purchase-item-row">
                      <strong>{row.productName}</strong>
                      
                      <div className="inventory-inline-metrics">
                        <span>Disponível: {fmtQty(row.qtyAvailable)}</span>
                        <span>Reservado: {fmtQty(row.qtyReserved)}</span>
                        <span>Livre: {fmtQty(row.qtyFree)}</span>
                        <span>Mínimo: {fmtQty(row.minQty)}</span>
                        <span>Máximo: {fmtQty(row.maxQty)}</span>
                      </div>
                      <div className="inventory-inline-actions">
                        <button type="button" className="ghost" onClick={() => openTransferFromLevel(row, suggestedQty)}>
                          Transferir
                        </button>
                        <button type="button" className="ghost" onClick={() => openAdjustmentFromLevel(row)}>
                          Ajustar
                        </button>
                        <button type="button" className="ghost" onClick={() => openMovementFromLevel(row)}>
                          Ver extrato
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>
        )}

        {activeArea === 'consult' && (
          <section className="purchase-section">
            <div className="fiscal-grid">
              <label className="purchase-order-lookup">
                Depósito
                <LookupField<WarehouseLookupOption>
                  value={consultFilters.warehouseId}
                  selectedLabel={warehousesById[consultFilters.warehouseId]?.name ?? ''}
                  placeholder="Buscar depósito..."
                  searchOptions={searchWarehouses}
                  emptyHint={ADD_WAREHOUSE_HINT}
                      renderCreateForm={renderWarehouseCreate}
                  onSelect={(option) =>
                    setConsultFilters((state) => ({
                      ...state,
                      warehouseId: option.id,
                      productId: '',
                    }))
                  }
                  onClear={() =>
                    setConsultFilters((state) => ({
                      ...state,
                      warehouseId: '',
                      productId: '',
                    }))
                  }
                />
              </label>

              <label className="purchase-order-lookup">
                Produto
                <LookupField<ProductLookupOption>
                  value={consultFilters.productId}
                  selectedLabel={productsById[consultFilters.productId]?.name ?? ''}
                  placeholder="Localizar produto (selecione o depósito primeiro)"
                  searchOptions={searchConsultProducts}
                  emptyHint={ADD_PRODUCT_HINT}
                      renderCreateForm={renderProductCreate}
                  disabled={!consultFilters.warehouseId}
                  onSelect={(option) =>
                    setConsultFilters((state) => ({
                      ...state,
                      productId: option.id,
                    }))
                  }
                  onClear={() =>
                    setConsultFilters((state) => ({
                      ...state,
                      productId: '',
                    }))
                  }
                  renderMeta={(option) => `SKU ${option.sku ?? '—'} • Livre ${fmtQty(option.stockAvailable)}`}
                />
              </label>

              <label>
                Busca Livre
                <input
                  value={consultFilters.query}
                  onChange={(event) =>
                    setConsultFilters((state) => ({
                      ...state,
                      query: event.target.value,
                    }))
                  }
                  placeholder="Nome, SKU ou código..."
                />
              </label>

              <label>
                Filtro
                <Select
                  value={consultFilters.onlyAlerts ? 'alerts' : ''}
                  options={[
                    { value: '', label: 'Todos os níveis' },
                    { value: 'alerts', label: 'Somente alertas (abaixo do mínimo)' },
                  ]}
                  onChange={(v) =>
                    setConsultFilters((state) => ({
                      ...state,
                      onlyAlerts: v === 'alerts',
                    }))
                  }
                />
              </label>
            </div>

            <div className="inventory-inline-actions">
              <button type="button" disabled={consultLoading} onClick={() => void fetchConsult(0)}>
                Consultar Posição
              </button>
            </div>

            {(
              <div className="purchase-items">
                {consultRows.map((row) => {
                  const suggestedQty = Math.max(
                    roundQty(toNumber(row.minQty) - toNumber(row.qtyAvailable)),
                    1,
                  )
                  return (
                    <div key={`${row.productId}:${row.warehouseId}`} className="purchase-item-row">
                      <strong>{row.productName}</strong>
                      
                      <div className="inventory-inline-metrics">
                        <span>Disponível: {fmtQty(row.qtyAvailable)}</span>
                        <span>Reservado: {fmtQty(row.qtyReserved)}</span>
                        <span>Livre: {fmtQty(row.qtyFree)}</span>
                        <span>Mínimo: {fmtQty(row.minQty)}</span>
                        <span>Máximo: {fmtQty(row.maxQty)}</span>
                      </div>
                      <div className="inventory-inline-actions">
                        <button type="button" className="ghost" onClick={() => openTransferFromLevel(row, suggestedQty)}>
                          Transferir
                        </button>
                        <button type="button" className="ghost" onClick={() => openAdjustmentFromLevel(row)}>
                          Ajustar
                        </button>
                        <button type="button" className="ghost" onClick={() => openMovementFromLevel(row)}>
                          Ver extrato
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <Pager
              total={consultTotal}
              offset={consultOffset}
              loading={consultLoading}
              onPrevious={() => void fetchConsult(Math.max(consultOffset - PAGE_SIZE, 0))}
              onNext={() => void fetchConsult(consultOffset + PAGE_SIZE)}
            />

            <div className="divider" />

            <div className="fiscal-grid">
              <label>
                Status
                <Select
                  value={shipmentFilters.status}
                  options={shipmentStatusOptions}
                  onChange={(value) =>
                    setShipmentFilters((state) => ({
                      ...state,
                      status: value as '' | 'pending' | 'dispatched' | 'delivered' | 'cancelled',
                    }))
                  }
                />
              </label>

              <label>
                Busca livre
                <input
                  value={shipmentFilters.query}
                  onChange={(event) =>
                    setShipmentFilters((state) => ({
                      ...state,
                      query: event.target.value,
                    }))
                  }
                  placeholder="ID, pedido, cliente ou rastreio..."
                />
              </label>
            </div>

            <div className="inventory-inline-actions">
              <button type="button" disabled={shipmentLoading} onClick={() => void fetchShipments(0)}>
                Consultar Expedições
              </button>
            </div>

            {(
              <div className="purchase-items">
                {shipmentRows.map((shipment) => (
                  <div key={shipment.id} className="purchase-item-row">
                    <strong>Expedição {shipment.id.slice(0, 8)}</strong>
                    
                    <div className="inventory-inline-metrics">
                      <span>Status: {shipmentLabel(shipment.status)}</span>
                      <span>Itens: {shipment.itemsCount}</span>
                      <span>Quantidade: {fmtQty(shipment.totalQuantity)}</span>
                      <span>Criado em: {fmtDateTime(shipment.createdAt)}</span>
                    </div>
                    <div className="inventory-inline-actions">
                      {shipment.status === 'pending' && (
                        <button type="button" className="ghost" onClick={() => void handleDispatch(shipment.id)}>
                          Despachar
                        </button>
                      )}
                      {shipment.status === 'dispatched' && (
                        <button type="button" className="ghost" onClick={() => void handleDeliver(shipment.id)}>
                          Marcar entregue
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <Pager
              total={shipmentTotal}
              offset={shipmentOffset}
              loading={shipmentLoading}
              onPrevious={() => void fetchShipments(Math.max(shipmentOffset - PAGE_SIZE, 0))}
              onNext={() => void fetchShipments(shipmentOffset + PAGE_SIZE)}
            />
          </section>
        )}

        {activeArea === 'movements' && (
          <section className="purchase-section">
            <div className="fiscal-grid">
              <label className="purchase-order-lookup">
                Depósito
                <LookupField<WarehouseLookupOption>
                  value={movementFilters.warehouseId}
                  selectedLabel={warehousesById[movementFilters.warehouseId]?.name ?? ''}
                  placeholder="Buscar depósito..."
                  searchOptions={searchWarehouses}
                  emptyHint={ADD_WAREHOUSE_HINT}
                      renderCreateForm={renderWarehouseCreate}
                  onSelect={(option) =>
                    setMovementFilters((state) => ({
                      ...state,
                      warehouseId: option.id,
                      productId: '',
                    }))
                  }
                  onClear={() =>
                    setMovementFilters((state) => ({
                      ...state,
                      warehouseId: '',
                      productId: '',
                    }))
                  }
                />
              </label>

              <label className="purchase-order-lookup">
                Produto
                <LookupField<ProductLookupOption>
                  value={movementFilters.productId}
                  selectedLabel={productsById[movementFilters.productId]?.name ?? ''}
                  placeholder={movementFilters.warehouseId ? 'Buscar produto...' : 'Selecione o depósito primeiro'}
                  searchOptions={searchMovementProducts}
                  emptyHint={ADD_PRODUCT_HINT}
                      renderCreateForm={renderProductCreate}
                  disabled={!movementFilters.warehouseId}
                  onSelect={(option) =>
                    setMovementFilters((state) => ({
                      ...state,
                      productId: option.id,
                    }))
                  }
                  onClear={() =>
                    setMovementFilters((state) => ({
                      ...state,
                      productId: '',
                    }))
                  }
                />
              </label>

              <label>
                Tipo
                <Select
                  value={movementFilters.movementType}
                  options={movementTypeOptions}
                  onChange={(value) =>
                    setMovementFilters((state) => ({
                      ...state,
                      movementType: value as '' | 'in' | 'out' | 'adjust' | 'transfer',
                    }))
                  }
                />
              </label>

              <label>
                De
                <DateInput
                  value={movementFilters.from}
                  onChange={(event) =>
                    setMovementFilters((state) => ({
                      ...state,
                      from: event.target.value,
                    }))
                  }
                />
              </label>

              <label>
                Até
                <DateInput
                  value={movementFilters.to}
                  onChange={(event) =>
                    setMovementFilters((state) => ({
                      ...state,
                      to: event.target.value,
                    }))
                  }
                />
              </label>

              <label>
                Busca livre
                <input
                  value={movementFilters.query}
                  onChange={(event) =>
                    setMovementFilters((state) => ({
                      ...state,
                      query: event.target.value,
                    }))
                  }
                  placeholder="Produto, SKU ou motivo"
                />
              </label>
            </div>

            <div className="inventory-inline-actions">
              <button type="button" disabled={movementLoading} onClick={() => void fetchMovements(0)}>
                Consultar extrato
              </button>
              <button type="button" className="ghost" onClick={exportMovementCsv}>Exportar CSV</button>
            </div>

            {(
              <div className="purchase-items">
                {movementRows.map((row) => {
                  const href = movementReferenceHref(row.refTable)
                  const reference = row.refTable && row.refId ? `${row.refTable}:${row.refId}` : null

                  return (
                    <div key={row.id} className="purchase-item-row">
                      <strong>{row.productName} • {movementLabel(row.movementType)}</strong>
                      
                      <div className="inventory-inline-metrics">
                        <span>Quantidade: {fmtQty(row.quantity)}</span>
                        <span>Motivo: {row.reason ?? '—'}</span>
                        <span>Data: {fmtDateTime(row.occurredAt)}</span>
                        {href && reference && (
                          <a href={href}>{reference}</a>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            <Pager
              total={movementTotal}
              offset={movementOffset}
              loading={movementLoading}
              onPrevious={() => void fetchMovements(Math.max(movementOffset - PAGE_SIZE, 0))}
              onNext={() => void fetchMovements(movementOffset + PAGE_SIZE)}
            />
          </section>
        )}

        {activeArea === 'operations' && (
          <section className="purchase-section">
            <div className="purchase-stepper inventory-substepper">
              <button type="button" className={`purchase-step-pill${activeOps === 'transfer' ? ' active' : ''}`} onClick={() => setActiveOps('transfer')}>Transferência</button>
              <button type="button" className={`purchase-step-pill${activeOps === 'adjustment' ? ' active' : ''}`} onClick={() => setActiveOps('adjustment')}>Ajuste manual</button>
              <button type="button" className={`purchase-step-pill${activeOps === 'inventory' ? ' active' : ''}`} onClick={() => setActiveOps('inventory')}>Inventário</button>
              <button type="button" className={`purchase-step-pill${activeOps === 'replenishment' ? ' active' : ''}`} onClick={() => { setActiveOps('replenishment'); void fetchReplenishment(0) }}>Reposição mín/máx</button>
              <button type="button" className={`purchase-step-pill${activeOps === 'returns' ? ' active' : ''}`} onClick={() => setActiveOps('returns')}>Receber devolução</button>
            </div>

            {activeOps === 'transfer' && (
              <div onKeyDown={handleTransferShortcuts}>
                <div className="fiscal-grid">
                  <label className="purchase-order-lookup">
                    Depósito origem
                    <LookupField<WarehouseLookupOption>
                      value={transferForm.originWarehouseId}
                      selectedLabel={warehousesById[transferForm.originWarehouseId]?.name ?? ''}
                      placeholder="Buscar depósito de origem..."
                      searchOptions={searchWarehouses}
                      emptyHint={ADD_WAREHOUSE_HINT}
                      renderCreateForm={renderWarehouseCreate}
                      onSelect={(option) =>
                        setTransferForm((state) => ({
                          ...state,
                          originWarehouseId: option.id,
                          items: state.items.map((item) => ({ ...item, productId: '' })),
                        }))
                      }
                      onClear={() =>
                        setTransferForm((state) => ({
                          ...state,
                          originWarehouseId: '',
                          items: state.items.map((item) => ({ ...item, productId: '' })),
                        }))
                      }
                    />
                  </label>

                  <label className="purchase-order-lookup">
                    Depósito destino
                    <LookupField<WarehouseLookupOption>
                      value={transferForm.destinationWarehouseId}
                      selectedLabel={warehousesById[transferForm.destinationWarehouseId]?.name ?? ''}
                      placeholder="Buscar depósito de destino..."
                      searchOptions={searchWarehouses}
                      emptyHint={ADD_WAREHOUSE_HINT}
                      renderCreateForm={renderWarehouseCreate}
                      onSelect={(option) =>
                        setTransferForm((state) => ({
                          ...state,
                          destinationWarehouseId: option.id,
                        }))
                      }
                      onClear={() =>
                        setTransferForm((state) => ({
                          ...state,
                          destinationWarehouseId: '',
                        }))
                      }
                    />
                  </label>

                  <label>
                    Observação
                    <input
                      value={transferForm.notes}
                      onChange={(event) =>
                        setTransferForm((state) => ({
                          ...state,
                          notes: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>

                <button type="button" className="ghost" onClick={() => setShowShortcuts((state) => !state)}>
                  {showShortcuts ? 'Ocultar atalhos' : 'Mostrar atalhos'}
                </button>

                {showShortcuts && (
                  <div className="inventory-shortcut-panel">
                    <p><strong>Atalhos de transferência</strong></p>
                    <p>Shift+Enter: nova linha</p>
                    <p>Ctrl/Cmd+D: duplicar linha focada</p>
                    <p>Ctrl/Cmd+Backspace: remover linha focada</p>
                    <p>Ctrl/Cmd+/: abrir ajuda</p>
                  </div>
                )}

                <div className="purchase-items">
                  {transferForm.items.map((item, index) => (
                    <div key={item.id} className="purchase-item-row" onFocusCapture={() => setFocusedTransferItemId(item.id)}>
                      <div className="fiscal-grid">
                        <label className="purchase-order-lookup">
                          Produto #{index + 1}
                          <LookupField<ProductLookupOption>
                            value={item.productId}
                            selectedLabel={productsById[item.productId]?.name ?? ''}
                            placeholder={transferForm.originWarehouseId ? 'Buscar produto...' : 'Selecione a origem primeiro'}
                            searchOptions={searchTransferProducts}
                            emptyHint={ADD_PRODUCT_HINT}
                      renderCreateForm={renderProductCreate}
                            disabled={!transferForm.originWarehouseId}
                            onSelect={(option) =>
                              setTransferForm((state) => ({
                                ...state,
                                items: state.items.map((row) =>
                                  row.id === item.id
                                    ? {
                                        ...row,
                                        productId: option.id,
                                      }
                                    : row,
                                ),
                              }))
                            }
                            onClear={() =>
                              setTransferForm((state) => ({
                                ...state,
                                items: state.items.map((row) =>
                                  row.id === item.id
                                    ? {
                                        ...row,
                                        productId: '',
                                      }
                                    : row,
                                ),
                              }))
                            }
                            renderMeta={(option) => `SKU ${option.sku ?? '—'} • Livre ${fmtQty(option.stockAvailable)}`}
                          />
                        </label>

                        <label>
                          Quantidade
                          <NumericInput
                            value={item.quantity}
                            decimals={4}
                            onChange={(event) =>
                              setTransferForm((state) => ({
                                ...state,
                                items: state.items.map((row) =>
                                  row.id === item.id
                                    ? {
                                        ...row,
                                        quantity: event.target.value,
                                      }
                                    : row,
                                ),
                              }))
                            }
                          />
                        </label>
                      </div>

                      <button
                        type="button"
                        className="ghost"
                        onClick={() =>
                          setTransferForm((state) => ({
                            ...state,
                            items: state.items.length <= 1
                              ? state.items
                              : state.items.filter((row) => row.id !== item.id),
                          }))
                        }
                      >
                        Remover item
                      </button>
                    </div>
                  ))}
                </div>

                <label>
                  Importar via Excel
                  <textarea
                    rows={4}
                    value={transferPaste}
                    onChange={(event) => setTransferPaste(event.target.value)}
                    placeholder="3f3d...\t5"
                  />
                </label>

                <div className="inventory-inline-actions">
                  <button type="button" className="ghost" onClick={() => setTransferForm((state) => ({ ...state, items: [...state.items, createRowDraft()] }))}>Adicionar item</button>
                  <button type="button" className="ghost" onClick={applyTransferPaste}>Aplicar colagem</button>
                  <button type="button" disabled={transferSubmitting || !canTransfer} onClick={() => void submitTransfer()}>{transferSubmitting ? 'Transferindo...' : canTransfer ? 'Transferir estoque' : 'Sem permissão'}</button>
                </div>
              </div>
            )}

            {activeOps === 'adjustment' && (
              <div>
                <div className="fiscal-grid">
                  <label className="purchase-order-lookup">
                    Depósito
                    <LookupField<WarehouseLookupOption>
                      value={adjustmentForm.warehouseId}
                      selectedLabel={warehousesById[adjustmentForm.warehouseId]?.name ?? ''}
                      placeholder="Buscar depósito..."
                      searchOptions={searchWarehouses}
                      emptyHint={ADD_WAREHOUSE_HINT}
                      renderCreateForm={renderWarehouseCreate}
                      onSelect={(option) =>
                        setAdjustmentForm((state) => ({
                          ...state,
                          warehouseId: option.id,
                          items: state.items.map((item) => ({ ...item, productId: '' })),
                        }))
                      }
                      onClear={() =>
                        setAdjustmentForm((state) => ({
                          ...state,
                          warehouseId: '',
                          items: state.items.map((item) => ({ ...item, productId: '' })),
                        }))
                      }
                    />
                  </label>

                  <label>
                    Tipo
                    <Select
                      value={adjustmentForm.adjustmentType}
                      options={[
                        { value: 'in', label: 'Entrada manual' },
                        { value: 'out', label: 'Saída manual' },
                        { value: 'adjust', label: 'Ajuste por diferença' },
                      ]}
                      onChange={(value) =>
                        setAdjustmentForm((state) => ({
                          ...state,
                          adjustmentType: value as 'in' | 'out' | 'adjust',
                        }))
                      }
                    />
                  </label>

                  <label>
                    Motivo
                    <input
                      value={adjustmentForm.reason}
                      onChange={(event) =>
                        setAdjustmentForm((state) => ({
                          ...state,
                          reason: event.target.value,
                        }))
                      }
                      placeholder="Ex.: avaria, perda, correção"
                    />
                  </label>
                </div>

                <div className="purchase-items">
                  {adjustmentForm.items.map((item, index) => (
                    <div key={item.id} className="purchase-item-row">
                      <div className="fiscal-grid">
                        <label className="purchase-order-lookup">
                          Produto #{index + 1}
                          <LookupField<ProductLookupOption>
                            value={item.productId}
                            selectedLabel={productsById[item.productId]?.name ?? ''}
                            placeholder={adjustmentForm.warehouseId ? 'Buscar produto...' : 'Selecione o depósito primeiro'}
                            searchOptions={searchAdjustmentProducts}
                            emptyHint={ADD_PRODUCT_HINT}
                      renderCreateForm={renderProductCreate}
                            disabled={!adjustmentForm.warehouseId}
                            onSelect={(option) =>
                              setAdjustmentForm((state) => ({
                                ...state,
                                items: state.items.map((row) =>
                                  row.id === item.id
                                    ? {
                                        ...row,
                                        productId: option.id,
                                      }
                                    : row,
                                ),
                              }))
                            }
                            onClear={() =>
                              setAdjustmentForm((state) => ({
                                ...state,
                                items: state.items.map((row) =>
                                  row.id === item.id
                                    ? {
                                        ...row,
                                        productId: '',
                                      }
                                    : row,
                                ),
                              }))
                            }
                          />
                        </label>

                        <label>
                          Quantidade {adjustmentForm.adjustmentType === 'adjust' ? '(aceita negativa)' : ''}
                          <NumericInput
                            value={item.quantity}
                            decimals={4}
                            onChange={(event) =>
                              setAdjustmentForm((state) => ({
                                ...state,
                                items: state.items.map((row) =>
                                  row.id === item.id
                                    ? {
                                        ...row,
                                        quantity: event.target.value,
                                      }
                                    : row,
                                ),
                              }))
                            }
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="inventory-inline-actions">
                  <button type="button" className="ghost" onClick={() => setAdjustmentForm((state) => ({ ...state, items: [...state.items, createRowDraft()] }))}>Adicionar item</button>
                  <button type="button" disabled={adjustmentSubmitting || !canAdjust} onClick={() => void submitAdjustment()}>{adjustmentSubmitting ? 'Aplicando...' : canAdjust ? 'Aplicar ajuste manual' : 'Sem permissão'}</button>
                </div>
              </div>
            )}

            {activeOps === 'inventory' && (
              <div>
                <div className="fiscal-grid">
                  <label className="purchase-order-lookup">
                    Depósito
                    <LookupField<WarehouseLookupOption>
                      value={inventoryForm.warehouseId}
                      selectedLabel={warehousesById[inventoryForm.warehouseId]?.name ?? ''}
                      placeholder="Buscar depósito..."
                      searchOptions={searchWarehouses}
                      emptyHint={ADD_WAREHOUSE_HINT}
                      renderCreateForm={renderWarehouseCreate}
                      onSelect={(option) =>
                        setInventoryForm((state) => ({
                          ...state,
                          warehouseId: option.id,
                          items: state.items.map((item) => ({ ...item, productId: '', expectedQty: '0' })),
                        }))
                      }
                      onClear={() =>
                        setInventoryForm((state) => ({
                          ...state,
                          warehouseId: '',
                          items: state.items.map((item) => ({ ...item, productId: '', expectedQty: '0' })),
                        }))
                      }
                    />
                  </label>
                </div>

                <div className="purchase-items">
                  {inventoryForm.items.map((item, index) => {
                    const expectedQty = toNumber(productsById[item.productId]?.stockAvailable ?? item.expectedQty)
                    const countedQty = toNumber(item.countedQty)
                    const diffQty = roundQty(countedQty - expectedQty)

                    return (
                      <div key={item.id} className="purchase-item-row">
                        <div className="fiscal-grid">
                          <label className="purchase-order-lookup">
                            Produto #{index + 1}
                            <LookupField<ProductLookupOption>
                              value={item.productId}
                              selectedLabel={productsById[item.productId]?.name ?? ''}
                              placeholder={inventoryForm.warehouseId ? 'Buscar produto...' : 'Selecione o depósito primeiro'}
                              searchOptions={searchInventoryProducts}
                              emptyHint={ADD_PRODUCT_HINT}
                      renderCreateForm={renderProductCreate}
                              disabled={!inventoryForm.warehouseId}
                              onSelect={(option) =>
                                setInventoryForm((state) => ({
                                  ...state,
                                  items: state.items.map((row) =>
                                    row.id === item.id
                                      ? {
                                          ...row,
                                          productId: option.id,
                                          expectedQty: String(roundQty(option.stockAvailable)),
                                        }
                                      : row,
                                  ),
                                }))
                              }
                              onClear={() =>
                                setInventoryForm((state) => ({
                                  ...state,
                                  items: state.items.map((row) =>
                                    row.id === item.id
                                      ? {
                                          ...row,
                                          productId: '',
                                          expectedQty: '0',
                                        }
                                      : row,
                                  ),
                                }))
                              }
                              renderMeta={(option) => `SKU ${option.sku ?? '—'} • Livre ${fmtQty(option.stockAvailable)}`}
                            />
                          </label>

                          <label>
                            Esperado (sistema)
                            <input value={fmtQty(expectedQty)} readOnly className="inventory-readonly" />
                          </label>

                          <label>
                            Contado
                            <NumericInput
                              value={item.countedQty}
                              decimals={4}
                              onChange={(event) =>
                                setInventoryForm((state) => ({
                                  ...state,
                                  items: state.items.map((row) =>
                                    row.id === item.id
                                      ? {
                                          ...row,
                                          countedQty: event.target.value,
                                        }
                                      : row,
                                  ),
                                }))
                              }
                            />
                          </label>

                          <label>
                            Diferença
                            <input value={fmtQty(diffQty)} readOnly className="inventory-readonly" />
                          </label>
                        </div>
                      </div>
                    )
                  })}
                </div>

                <label>
                  Importar via Excel
                  <textarea
                    rows={4}
                    value={inventoryPaste}
                    onChange={(event) => setInventoryPaste(event.target.value)}
                    placeholder="3f3d...\t12"
                  />
                </label>

                <div className="inventory-inline-actions">
                  <button type="button" className="ghost" onClick={() => setInventoryForm((state) => ({ ...state, items: [...state.items, createInventoryRowDraft()] }))}>Adicionar item</button>
                  <button type="button" className="ghost" onClick={applyInventoryPaste}>Aplicar colagem</button>
                  <button type="button" disabled={inventorySubmitting || !canInventory} onClick={() => void submitInventory()}>{inventorySubmitting ? 'Aplicando...' : canInventory ? 'Aplicar inventário' : 'Sem permissão'}</button>
                </div>
              </div>
            )}

            {activeOps === 'replenishment' && (
              <div>
                <div className="fiscal-grid">
                  <label className="purchase-order-lookup">
                    Depósito
                    <LookupField<WarehouseLookupOption>
                      value={replenishmentFilters.warehouseId}
                      selectedLabel={warehousesById[replenishmentFilters.warehouseId]?.name ?? ''}
                      placeholder="Buscar depósito..."
                      searchOptions={searchWarehouses}
                      emptyHint={ADD_WAREHOUSE_HINT}
                      renderCreateForm={renderWarehouseCreate}
                      onSelect={(option) =>
                        setReplenishmentFilters((state) => ({
                          ...state,
                          warehouseId: option.id,
                          productId: '',
                        }))
                      }
                      onClear={() =>
                        setReplenishmentFilters((state) => ({
                          ...state,
                          warehouseId: '',
                          productId: '',
                        }))
                      }
                    />
                  </label>

                  <label className="purchase-order-lookup">
                    Produto
                    <LookupField<ProductLookupOption>
                      value={replenishmentFilters.productId}
                      selectedLabel={productsById[replenishmentFilters.productId]?.name ?? ''}
                      placeholder={replenishmentFilters.warehouseId ? 'Buscar produto...' : 'Selecione o depósito primeiro'}
                      searchOptions={searchReplenishmentProducts}
                      emptyHint={ADD_PRODUCT_HINT}
                      renderCreateForm={renderProductCreate}
                      disabled={!replenishmentFilters.warehouseId}
                      onSelect={(option) =>
                        setReplenishmentFilters((state) => ({
                          ...state,
                          productId: option.id,
                        }))
                      }
                      onClear={() =>
                        setReplenishmentFilters((state) => ({
                          ...state,
                          productId: '',
                        }))
                      }
                    />
                  </label>

                  <label>
                    Busca livre
                    <input
                      value={replenishmentFilters.query}
                      onChange={(event) =>
                        setReplenishmentFilters((state) => ({
                          ...state,
                          query: event.target.value,
                        }))
                      }
                      placeholder="Nome ou SKU"
                    />
                  </label>
                </div>

                <div className="inventory-inline-actions">
                  <button type="button" disabled={replenishmentLoading} onClick={() => void fetchReplenishment(0)}>
                    'Buscar sugestões'
                  </button>
                </div>

                {(
                  <div className="purchase-items">
                    {replenishmentRows.map((row) => (
                      <div key={`${row.productId}:${row.warehouseId}`} className="purchase-item-row">
                        <strong>{row.productName}</strong>
                        
                        <div className="inventory-inline-metrics">
                          <span>Disponível: {fmtQty(row.qtyAvailable)}</span>
                          <span>Livre: {fmtQty(row.qtyFree)}</span>
                          <span>Mínimo: {fmtQty(row.minQty)}</span>
                          <span>Máximo: {fmtQty(row.maxQty)}</span>
                          <span>Sugestão: {fmtQty(row.qtyToReplenish)}</span>
                        </div>
                        <div className="inventory-inline-actions">
                          <button type="button" className="ghost" onClick={() => openTransferFromReplenishment(row)}>
                            Gerar transferência
                          </button>
                          <a href={COMPRAS_HREF} className="ghost inventory-link-button">Gerar ordem de compra</a>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <Pager
                  total={replenishmentTotal}
                  offset={replenishmentOffset}
                  loading={replenishmentLoading}
                  onPrevious={() => void fetchReplenishment(Math.max(replenishmentOffset - PAGE_SIZE, 0))}
                  onNext={() => void fetchReplenishment(replenishmentOffset + PAGE_SIZE)}
                />

                <div className="divider" />

                <div className="fiscal-grid">
                  <label className="purchase-order-lookup">
                    Depósito
                    <LookupField<WarehouseLookupOption>
                      value={minMaxForm.warehouseId}
                      selectedLabel={warehousesById[minMaxForm.warehouseId]?.name ?? ''}
                      placeholder="Buscar depósito..."
                      searchOptions={searchWarehouses}
                      emptyHint={ADD_WAREHOUSE_HINT}
                      renderCreateForm={renderWarehouseCreate}
                      onSelect={(option) =>
                        setMinMaxForm((state) => ({
                          ...state,
                          warehouseId: option.id,
                          productId: '',
                        }))
                      }
                      onClear={() =>
                        setMinMaxForm((state) => ({
                          ...state,
                          warehouseId: '',
                          productId: '',
                        }))
                      }
                    />
                  </label>

                  <label className="purchase-order-lookup">
                    Produto
                    <LookupField<ProductLookupOption>
                      value={minMaxForm.productId}
                      selectedLabel={productsById[minMaxForm.productId]?.name ?? ''}
                      placeholder={minMaxForm.warehouseId ? 'Buscar produto...' : 'Selecione o depósito primeiro'}
                      searchOptions={searchMinMaxProducts}
                      emptyHint={ADD_PRODUCT_HINT}
                      renderCreateForm={renderProductCreate}
                      disabled={!minMaxForm.warehouseId}
                      onSelect={(option) =>
                        setMinMaxForm((state) => ({
                          ...state,
                          productId: option.id,
                        }))
                      }
                      onClear={() =>
                        setMinMaxForm((state) => ({
                          ...state,
                          productId: '',
                        }))
                      }
                    />
                  </label>

                  <label>
                    Mínimo
                    <NumericInput
                      value={minMaxForm.minQty}
                      decimals={4}
                      onChange={(event) =>
                        setMinMaxForm((state) => ({
                          ...state,
                          minQty: event.target.value,
                        }))
                      }
                    />
                  </label>

                  <label>
                    Máximo
                    <NumericInput
                      value={minMaxForm.maxQty}
                      decimals={4}
                      onChange={(event) =>
                        setMinMaxForm((state) => ({
                          ...state,
                          maxQty: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>

                <div className="inventory-inline-actions">
                  <button type="button" disabled={minMaxSubmitting} onClick={() => void submitMinMax()}>
                    {minMaxSubmitting ? 'Processando...' : 'Confirmar mínimo/máximo'}
                  </button>
                </div>
              </div>
            )}

            {activeOps === 'returns' && (
              <div>
                <div className="fiscal-grid">
                  <label className="purchase-order-lookup">
                    Depósito de recebimento
                    <LookupField<WarehouseLookupOption>
                      value={returnsForm.warehouseId}
                      selectedLabel={warehousesById[returnsForm.warehouseId]?.name ?? ''}
                      placeholder="Buscar depósito..."
                      searchOptions={searchWarehouses}
                      emptyHint={ADD_WAREHOUSE_HINT}
                      renderCreateForm={renderWarehouseCreate}
                      onSelect={(option) =>
                        setReturnsForm((state) => ({
                          ...state,
                          warehouseId: option.id,
                          items: state.items.map((item) => ({ ...item, productId: '' })),
                        }))
                      }
                      onClear={() =>
                        setReturnsForm((state) => ({
                          ...state,
                          warehouseId: '',
                          items: state.items.map((item) => ({ ...item, productId: '' })),
                        }))
                      }
                    />
                  </label>

                  <label>
                    Protocolo (opcional)
                    <input
                      value={returnsForm.protocol}
                      onChange={(event) =>
                        setReturnsForm((state) => ({
                          ...state,
                          protocol: event.target.value,
                        }))
                      }
                      placeholder="Ex.: DEV-2026-0001"
                    />
                  </label>
                </div>

                <div className="purchase-items">
                  {returnsForm.items.map((item, index) => (
                    <div key={item.id} className="purchase-item-row">
                      <div className="fiscal-grid">
                        <label className="purchase-order-lookup">
                          Produto #{index + 1}
                          <LookupField<ProductLookupOption>
                            value={item.productId}
                            selectedLabel={productsById[item.productId]?.name ?? ''}
                            placeholder={returnsForm.warehouseId ? 'Buscar produto...' : 'Selecione o depósito primeiro'}
                            searchOptions={searchReturnsProducts}
                            emptyHint={ADD_PRODUCT_HINT}
                      renderCreateForm={renderProductCreate}
                            disabled={!returnsForm.warehouseId}
                            onSelect={(option) =>
                              setReturnsForm((state) => ({
                                ...state,
                                items: state.items.map((row) =>
                                  row.id === item.id
                                    ? {
                                        ...row,
                                        productId: option.id,
                                      }
                                    : row,
                                ),
                              }))
                            }
                            onClear={() =>
                              setReturnsForm((state) => ({
                                ...state,
                                items: state.items.map((row) =>
                                  row.id === item.id
                                    ? {
                                        ...row,
                                        productId: '',
                                      }
                                    : row,
                                ),
                              }))
                            }
                          />
                        </label>

                        <label>
                          Quantidade
                          <NumericInput
                            value={item.quantity}
                            decimals={4}
                            onChange={(event) =>
                              setReturnsForm((state) => ({
                                ...state,
                                items: state.items.map((row) =>
                                  row.id === item.id
                                    ? {
                                        ...row,
                                        quantity: event.target.value,
                                      }
                                    : row,
                                ),
                              }))
                            }
                          />
                        </label>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="inventory-inline-actions">
                  <button type="button" className="ghost" onClick={() => setReturnsForm((state) => ({ ...state, items: [...state.items, createRowDraft()] }))}>Adicionar item</button>
                  <button type="button" disabled={returnsSubmitting} onClick={() => void submitReturnEffect()}>{returnsSubmitting ? 'Recebendo...' : 'Receber devolução no estoque'}</button>
                </div>
              </div>
            )}
          </section>
        )}

        {activeArea === 'utilities' && (
          <section className="purchase-section">
            <div className="fiscal-grid">
              <label className="purchase-order-lookup">
                Depósito
                <LookupField<WarehouseLookupOption>
                  value={labelForm.warehouseId}
                  selectedLabel={warehousesById[labelForm.warehouseId]?.name ?? ''}
                  placeholder="Buscar depósito..."
                  searchOptions={searchWarehouses}
                  emptyHint={ADD_WAREHOUSE_HINT}
                      renderCreateForm={renderWarehouseCreate}
                  onSelect={(option) =>
                    setLabelForm((state) => ({
                      ...state,
                      warehouseId: option.id,
                      productId: '',
                    }))
                  }
                  onClear={() =>
                    setLabelForm((state) => ({
                      ...state,
                      warehouseId: '',
                      productId: '',
                    }))
                  }
                />
              </label>

              <label className="purchase-order-lookup">
                Produto
                <LookupField<ProductLookupOption>
                  value={labelForm.productId}
                  selectedLabel={productsById[labelForm.productId]?.name ?? ''}
                  placeholder={labelForm.warehouseId ? 'Buscar produto...' : 'Selecione o depósito primeiro'}
                  searchOptions={searchLabelProducts}
                  emptyHint={ADD_PRODUCT_HINT}
                      renderCreateForm={renderProductCreate}
                  disabled={!labelForm.warehouseId}
                  onSelect={(option) =>
                    setLabelForm((state) => ({
                      ...state,
                      productId: option.id,
                    }))
                  }
                  onClear={() =>
                    setLabelForm((state) => ({
                      ...state,
                      productId: '',
                    }))
                  }
                />
              </label>

              <label>
                Quantidade de etiquetas
                <NumericInput
                  value={labelForm.quantity}
                  decimals={0}
                  onChange={(event) =>
                    setLabelForm((state) => ({
                      ...state,
                      quantity: event.target.value,
                    }))
                  }
                />
              </label>

              <label>
                Formato de impressão
                <Select
                  value={labelPrintPreset}
                  options={labelPrintPresetOptions.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  onChange={(value) => setLabelPrintPreset(value as PrintPreset)}
                />
              </label>
            </div>

            <label>
              Dados avançados (opcional)
              <textarea
                rows={4}
                value={labelForm.payloadJson}
                onChange={(event) =>
                  setLabelForm((state) => ({
                    ...state,
                    payloadJson: event.target.value,
                  }))
                }
                placeholder='{"layout":"gondola"}'
              />
            </label>

            <div className="inventory-inline-actions">
              <button type="button" disabled={labelSubmitting} onClick={() => void submitLabel()}>{labelSubmitting ? 'Criando...' : 'Criar etiqueta'}</button>
            </div>

            <div className="divider" />

            <div className="fiscal-grid">
              <label>
                Status
                <Select
                  value={labelFilters.status}
                  options={labelStatusOptions}
                  onChange={(value) =>
                    setLabelFilters((state) => ({
                      ...state,
                      status: value as '' | 'pending' | 'printed',
                    }))
                  }
                />
              </label>

              <label>
                Busca livre
                <input
                  value={labelFilters.query}
                  onChange={(event) =>
                    setLabelFilters((state) => ({
                      ...state,
                      query: event.target.value,
                    }))
                  }
                  placeholder="ID, nome, SKU"
                />
              </label>
            </div>

            <div className="inventory-inline-actions">
              <button type="button" disabled={labelLoading} onClick={() => void fetchLabels(0)}>Atualizar fila</button>
            </div>

            {(
              <div className="purchase-items">
                {labelRows.map((label) => (
                  <div key={label.id} className="purchase-item-row">
                    <strong>{label.productName ?? 'Produto não encontrado'}</strong>
                    
                    <div className="inventory-inline-metrics">
                      <span>Qtd etiquetas: {label.quantity}</span>
                      <span>Criado em: {fmtDateTime(label.createdAt)}</span>
                      <span>ID: {label.id}</span>
                    </div>
                    <div className="inventory-inline-actions">
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          void handlePrint(label)
                        }}
                      >
                        Imprimir
                      </button>
                      {label.status !== 'printed' && (
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => {
                            void handlePrintAndMarkLabel(label)
                          }}
                        >
                          Imprimir e marcar
                        </button>
                      )}
                      {label.status !== 'printed' && (
                        <button type="button" className="ghost" onClick={() => void handleLabelPrinted(label.id)}>
                          Marcar como impressa
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <Pager
              total={labelTotal}
              offset={labelOffset}
              loading={labelLoading}
              onPrevious={() => void fetchLabels(Math.max(labelOffset - PAGE_SIZE, 0))}
              onNext={() => void fetchLabels(labelOffset + PAGE_SIZE)}
            />
          </section>
        )}
      </div>

    </div>
  )
}
