import { buildApiHeaders, getJson, getJsonWithHeaders, patchJson, postJson, putJson } from './http'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

function generateIdempotencyKey(prefix: string) {
  if (globalThis.crypto !== undefined && 'randomUUID' in globalThis.crypto) {
    return `${prefix}-${globalThis.crypto.randomUUID()}`
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function idempotencyHeader(prefix: string, idempotencyKey?: string): HeadersInit {
  return {
    'Idempotency-Key': idempotencyKey?.trim() || generateIdempotencyKey(prefix),
  }
}

export function createCustomer(input: {
  personType: 'legal' | 'natural'
  name: string
  legalName?: string
  cpfCnpj?: string
  ie?: string
  email?: string
  phone?: string
}) {
  return postJson<{ id: string }>('/customers', input)
}

export function createSupplier(input: {
  personType: 'legal' | 'natural'
  name: string
  legalName?: string
  cpfCnpj?: string
  ie?: string
  email?: string
  phone?: string
}) {
  return postJson<{ id: string }>('/suppliers', input)
}

export function createProduct(input: {
  sku?: string
  name: string
  description?: string
  productType?: 'product' | 'service'
  ncm?: string
  uom?: string
  price?: number
  cost?: number
}) {
  return postJson<{ id: string }>('/products', input)
}

export function createWarehouse(input: { name: string }) {
  return postJson<{ id: string }>('/warehouses', input)
}

export function updateCustomer(id: string, input: Partial<{
  personType: 'legal' | 'natural'
  name: string
  legalName: string
  cpfCnpj: string
  ie: string
  email: string
  phone: string
}>) {
  return putJson<{ id: string }>(`/customers/${id}`, input)
}

export function deactivateCustomer(id: string) {
  return patchJson<{ id: string }>(`/customers/${id}/deactivate`)
}

export function updateSupplier(id: string, input: Partial<{
  personType: 'legal' | 'natural'
  name: string
  legalName: string
  cpfCnpj: string
  ie: string
  email: string
  phone: string
}>) {
  return putJson<{ id: string }>(`/suppliers/${id}`, input)
}

export function deactivateSupplier(id: string) {
  return patchJson<{ id: string }>(`/suppliers/${id}/deactivate`)
}

export function updateProduct(id: string, input: Partial<{
  name: string
  sku: string
  description: string
  productType: 'product' | 'service'
  ncm: string
  uom: string
  price: number
  cost: number
}>) {
  return putJson<{ id: string }>(`/products/${id}`, input)
}

export function deactivateProduct(id: string) {
  return patchJson<{ id: string }>(`/products/${id}/deactivate`)
}

export function updateWarehouse(id: string, input: Partial<{ name: string }>) {
  return putJson<{ id: string }>(`/warehouses/${id}`, input)
}

export type CustomerLookup = {
  id: string
  name: string
  person_type: 'legal' | 'natural'
  legal_name: string | null
  cpf_cnpj: string | null
  ie: string | null
  email: string | null
  phone: string | null
  active: boolean
  created_at: string
}

export type SupplierLookup = {
  id: string
  name: string
  legal_name: string | null
  cpf_cnpj: string | null
  email: string | null
  phone: string | null
  created_at: string
}

export type WarehouseLookup = {
  id: string
  name: string
  created_at: string
}

export type ProductLookup = {
  id: string
  sku: string | null
  name: string
  product_type: 'product' | 'service' | null
  price: string | number
  cost: string | number
  created_at: string
}

type LookupQueryOptions = {
  query?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}

export type LookupPageResult<T> = {
  rows: T[]
  totalCount: number | null
}

function parseLookupTotalCountHeader(headers: Headers) {
  const raw = headers.get('x-total-count')
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return null
  return Math.max(parsed, 0)
}

function buildLookupQueryParams(options?: LookupQueryOptions) {
  const params = new URLSearchParams()
  const normalizedQuery = options?.query?.trim() ?? ''

  if (normalizedQuery) {
    params.set('query', normalizedQuery)
  }

  if (typeof options?.limit === 'number' && Number.isFinite(options.limit)) {
    params.set('limit', String(Math.max(1, Math.floor(options.limit))))
  }

  if (typeof options?.offset === 'number' && Number.isFinite(options.offset)) {
    params.set('offset', String(Math.max(0, Math.floor(options.offset))))
  }

  return params
}

export function fetchSuppliers(options?: LookupQueryOptions) {
  return fetchSuppliersPaged(options).then((result) => result.rows)
}

export async function fetchSuppliersPaged(
  options?: LookupQueryOptions,
): Promise<LookupPageResult<SupplierLookup>> {
  const params = buildLookupQueryParams(options)
  const path = params.size > 0 ? `/suppliers?${params.toString()}` : '/suppliers'
  const { data, headers } = await getJsonWithHeaders<SupplierLookup[]>(path, {
    signal: options?.signal,
  })
  return {
    rows: data,
    totalCount: parseLookupTotalCountHeader(headers),
  }
}

export function fetchWarehouses(options?: LookupQueryOptions) {
  return fetchWarehousesPaged(options).then((result) => result.rows)
}

export async function fetchWarehousesPaged(
  options?: LookupQueryOptions,
): Promise<LookupPageResult<WarehouseLookup>> {
  const params = buildLookupQueryParams(options)
  const path = params.size > 0 ? `/warehouses?${params.toString()}` : '/warehouses'
  const { data, headers } = await getJsonWithHeaders<WarehouseLookup[]>(path, {
    signal: options?.signal,
  })
  return {
    rows: data,
    totalCount: parseLookupTotalCountHeader(headers),
  }
}

export function fetchProducts() {
  return getJson<ProductLookup[]>('/products')
}

export function createPurchaseOrder(input: {
  supplierId: string
  warehouseId: string
  notes?: string
  items: Array<{
    product_id?: string
    description: string
    quantity: number
    unit_cost: number
  }>
}, options?: { idempotencyKey?: string }) {
  return postJson<{ orderId: string; totalAmount: number }>('/purchases/orders', input, {
    headers: idempotencyHeader('purchase-order-create', options?.idempotencyKey),
  })
}

export type PurchaseOrderReceiveContext = {
  orderId: string
  status: string
  supplierId: string | null
  supplierName: string | null
  warehouseId: string | null
  warehouseName: string | null
  totalAmount: number
  notes: string | null
  items: Array<{
    purchaseOrderItemId: string
    productId: string | null
    description: string
    quantity: number
    unitCost: number
    receivedQuantity: number
    remainingQuantity: number
  }>
}

export function fetchPurchaseOrderReceiveContext(orderId: string) {
  return getJson<PurchaseOrderReceiveContext>(
    `/purchases/orders/${encodeURIComponent(orderId)}/receive-context`,
  )
}

export function receivePurchase(input: {
  purchaseOrderId?: string
  supplierId?: string
  warehouseId: string
  notes?: string
  items: Array<{
    purchase_order_item_id?: string
    product_id?: string
    description: string
    quantity: number
    unit_cost: number
  }>
}, options?: { idempotencyKey?: string }) {
  return postJson<{ receiptId: string; totalAmount: number }>('/purchases/receive', input, {
    headers: idempotencyHeader('purchase-receive', options?.idempotencyKey),
  })
}

export function createSalesOrder(input: {
  customerId?: string
  warehouseId?: string
  salesAgentId?: string
  notes?: string
  paymentCondition?: string
  discountPercent?: number
  items: Array<{
    product_id?: string
    description: string
    quantity: number
    unit_price: number
    ncm?: string
    cfop?: string
  }>
}, options?: { idempotencyKey?: string }) {
  return postJson<{ orderId: string; totalAmount: number }>('/sales/orders', input, {
    headers: idempotencyHeader('sales-order-create', options?.idempotencyKey),
  })
}

export type SalesOrderWorkflow = {
  orderId: string
  orderStatus: string
  totalAmount: number
  customerName: string
  stage:
    | 'waiting_cashier'
    | 'waiting_packing'
    | 'packing'
    | 'ready_pickup'
    | 'picked_up'
  stageLabel: string
  shipmentId: string | null
  shipmentStatus: string | null
}

export type SalesOrderListItem = {
  id: string
  status: string
  totalAmount: number
  notes: string | null
  createdAt: string
  updatedAt: string
  customerId: string | null
  customerName: string
  warehouseId: string | null
}

export async function fetchSalesOrdersPaged(options?: {
  status?: string
  query?: string
  dateFrom?: string
  dateTo?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<{ rows: SalesOrderListItem[]; totalCount: number | null }> {
  const params = new URLSearchParams()
  if (options?.status) params.set('status', options.status)
  if (options?.query) params.set('query', options.query)
  if (options?.dateFrom) params.set('dateFrom', options.dateFrom)
  if (options?.dateTo) params.set('dateTo', options.dateTo)
  if (options?.limit) params.set('limit', String(options.limit))
  if (options?.offset) params.set('offset', String(options.offset))
  const path = params.size > 0 ? `/sales/orders?${params.toString()}` : '/sales/orders'
  const { data, headers } = await getJsonWithHeaders<SalesOrderListItem[]>(path, { signal: options?.signal })
  const raw = headers.get('x-total-count')
  const totalCount = raw ? Math.max(Number.parseInt(raw, 10), 0) : null
  return { rows: data, totalCount }
}

export type SalesOrderDetail = {
  id: string
  status: string
  totalAmount: number
  notes: string | null
  paymentCondition: string | null
  discountPercent: number
  customerId: string | null
  customerName: string
  warehouseId: string | null
  salesAgentId: string | null
  createdAt: string
  updatedAt: string
  items: Array<{
    id: string
    productId: string | null
    description: string
    quantity: number
    unitPrice: number
    totalPrice: number
    ncm: string | null
    cfop: string | null
  }>
}

export function fetchSalesOrder(orderId: string) {
  return getJson<SalesOrderDetail>(`/sales/orders/${orderId}`)
}

export function updateSalesOrder(orderId: string, input: {
  customerId?: string
  notes?: string
  paymentCondition?: string
  discountPercent?: number
  status?: 'open' | 'pending' | 'cancelled'
}, options?: { idempotencyKey?: string }) {
  return putJson<{ orderId: string; updated: boolean }>(`/sales/orders/${orderId}`, input, {
    headers: idempotencyHeader('sales-order-update', options?.idempotencyKey),
  })
}

export function fetchSalesOrderWorkflow(orderId: string) {
  return getJson<SalesOrderWorkflow>(`/sales/orders/${orderId}/workflow`)
}

export function invoiceSalesOrder(orderId: string, options?: { idempotencyKey?: string }) {
  return postJson<{
    invoiceId: string
    fiscalDocumentId: string
    workflow: SalesOrderWorkflow
  }>(`/sales/orders/${orderId}/invoice`, {}, {
    headers: idempotencyHeader('sales-order-invoice', options?.idempotencyKey),
  })
}

export function createPickupForOrder(orderId: string, options?: { idempotencyKey?: string }) {
  return postJson<{
    shipmentId: string
    reused: boolean
    workflow: SalesOrderWorkflow
  }>(`/sales/orders/${orderId}/pickup`, {}, {
    headers: idempotencyHeader('sales-order-pickup-create', options?.idempotencyKey),
  })
}

export function dispatchPickupForOrder(orderId: string, options?: { idempotencyKey?: string }) {
  return postJson<{
    shipmentId: string
    workflow: SalesOrderWorkflow
  }>(`/sales/orders/${orderId}/pickup/dispatch`, {}, {
    headers: idempotencyHeader('sales-order-pickup-dispatch', options?.idempotencyKey),
  })
}

export function completePickupForOrder(orderId: string, options?: { idempotencyKey?: string }) {
  return postJson<{
    shipmentId: string
    workflow: SalesOrderWorkflow
  }>(`/sales/orders/${orderId}/pickup/deliver`, {}, {
    headers: idempotencyHeader('sales-order-pickup-deliver', options?.idempotencyKey),
  })
}

export function fetchSalesDefaults() {
  return getJson<{
    customerId: string
    warehouseId: string
    salesAgentId: string
  }>('/sales/defaults')
}

export function searchProducts(
  query: string,
  warehouseId: string,
  signal?: AbortSignal,
  pagination?: { limit?: number; offset?: number },
) {
  return searchProductsPaged(query, warehouseId, signal, pagination).then((result) => result.rows)
}

type ProductSearchApiRow = {
  id: string
  name: string
  sku: string | null
  brand: string | null
  barcode: string | null
  image_url: string | null
  price: string | number
  cost: string | number
  stock_available: string | number
}

export async function searchProductsPaged(
  query: string,
  warehouseId: string,
  signal?: AbortSignal,
  pagination?: { limit?: number; offset?: number },
): Promise<LookupPageResult<ProductSearchApiRow>> {
  const params = new URLSearchParams({
    query,
    warehouseId,
  })

  if (typeof pagination?.limit === 'number' && Number.isFinite(pagination.limit)) {
    params.set('limit', String(Math.max(1, Math.floor(pagination.limit))))
  }

  if (typeof pagination?.offset === 'number' && Number.isFinite(pagination.offset)) {
    params.set('offset', String(Math.max(0, Math.floor(pagination.offset))))
  }

  const { data, headers } = await getJsonWithHeaders<ProductSearchApiRow[]>(
    `/products/search?${params.toString()}`,
    { signal },
  )

  return {
    rows: data,
    totalCount: parseLookupTotalCountHeader(headers),
  }
}

export type PurchaseOrderLookup = {
  id: string
  status: string
  createdAt: string
  totalAmount: number
  supplierId: string | null
  supplierName: string | null
  warehouseId: string | null
  warehouseName: string | null
  pendingLines: number
  pendingQuantity: number
}

export type CategoryLookup = { id: string; name: string; parentId: string | null; createdAt: string }
export type CarrierLookup = { id: string; name: string; cnpj: string | null; modal: string | null; avgDays: number | null; active: boolean; createdAt: string }

export function fetchCategories() { return getJson<CategoryLookup[]>('/categories') }
export function createCategory(input: { name: string; parentId?: string }) { return postJson<{ id: string }>('/categories', input) }
export function fetchCarriers() { return getJson<CarrierLookup[]>('/carriers') }
export function createCarrier(input: { name: string; cnpj?: string; modal?: string; avgDays?: number }) { return postJson<{ id: string }>('/carriers', input) }
export function toggleCarrier(id: string) { return patchJson<{ id: string; active: boolean }>(`/carriers/${id}/toggle`, {}) }

export function approvePurchaseOrder(orderId: string) {
  return patchJson<{ orderId: string }>(`/purchases/orders/${orderId}/approve`, {})
}

export function cancelPurchaseOrder(orderId: string) {
  return patchJson<{ orderId: string }>(`/purchases/orders/${orderId}/cancel`, {})
}

export function searchPurchaseOrders(
  query: string,
  options?: {
    includeReceived?: boolean
    limit?: number
    offset?: number
    signal?: AbortSignal
  },
) {
  const normalizedLimit =
    typeof options?.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(1, Math.floor(options.limit))
      : 15
  const normalizedOffset =
    typeof options?.offset === 'number' && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0

  const params = new URLSearchParams({
    query,
    includeReceived: String(options?.includeReceived ?? false),
    limit: String(normalizedLimit),
    offset: String(normalizedOffset),
  })

  return getJson<PurchaseOrderLookup[]>(`/purchases/orders/search?${params.toString()}`, {
    signal: options?.signal,
  })
}

export function fetchCustomers() {
  return getJson<Array<{ id: string; name: string }>>('/customers')
}

export function searchCustomers(query: string) {
  const params = new URLSearchParams({ query })
  return getJson<Array<{ id: string; name: string; email?: string; phone?: string }>>(
    `/customers/search?${params.toString()}`,
  )
}

export function searchCustomersPaged(
  query: string,
  options?: { limit?: number; offset?: number; signal?: AbortSignal },
) {
  const normalizedLimit =
    typeof options?.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(1, Math.floor(options.limit))
      : 5
  const normalizedOffset =
    typeof options?.offset === 'number' && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0

  const params = new URLSearchParams({
    query,
    limit: String(normalizedLimit),
    offset: String(normalizedOffset),
  })

  return getJson<Array<{ id: string; name: string; email?: string; phone?: string }>>(
    `/customers/search?${params.toString()}`,
    { signal: options?.signal },
  )
}

export function createQuote(input: {
  customerId?: string
  notes?: string
  validUntil?: string
  items: Array<{
    product_id?: string
    description: string
    quantity: number
    unit_price: number
  }>
}, options?: { idempotencyKey?: string }) {
  return postJson<{ quoteId: string; totalAmount: number; status: string; validUntil?: string }>(
    '/quotes',
    input,
    {
      headers: idempotencyHeader('quote-create', options?.idempotencyKey),
    },
  )
}

export function fetchRecentQuotes(limit = 10) {
  const params = new URLSearchParams({ limit: String(limit) })
  return getJson<
    Array<{
      id: string
      status: string
      totalAmount: number
      customerName: string
      createdAt: string
      validUntil: string | null
    }>
  >(`/quotes/recent?${params.toString()}`)
}

export type SalesAiChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

export function sendSalesAiChat(input: { messages: SalesAiChatMessage[] }) {
  return postJson<{ message: string; model: string | null; responseId: string | null }>(
    '/ai/sales-chat',
    input,
  )
}

export function cancelQuote(quoteId: string, options?: { idempotencyKey?: string }) {
  return postJson<{ id: string; status: string }>(`/quotes/${quoteId}/cancel`, {}, {
    headers: idempotencyHeader('quote-cancel', options?.idempotencyKey),
  })
}

export type QuoteDetail = {
  id: string
  status: string
  totalAmount: number
  customerName: string
  createdAt: string
  items: { id: string; productId: string | null; description: string; quantity: number; unitPrice: number; totalPrice: number }[]
}

export function fetchQuoteDetail(quoteId: string) {
  return getJson<QuoteDetail>(`/quotes/${quoteId}`)
}

export function duplicateQuote(quoteId: string, options?: { idempotencyKey?: string }) {
  return postJson<{ quoteId: string; totalAmount: number; status: string }>(
    `/quotes/${quoteId}/duplicate`,
    {},
    {
      headers: idempotencyHeader('quote-duplicate', options?.idempotencyKey),
    },
  )
}

export async function convertQuote(input: {
  quoteId: string
  warehouseId?: string
  forceConfirm?: boolean
  idempotencyKey?: string
}) {
  const headers = await buildApiHeaders({
    json: true,
    extra: idempotencyHeader('quote-convert', input.idempotencyKey),
  })
  const response = await fetch(`${apiUrl}/quotes/${input.quoteId}/convert`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      warehouseId: input.warehouseId,
      forceConfirm: input.forceConfirm ?? false,
    }),
  })

  if (response.status === 409) {
    return (await response.json()) as {
      reviewRequired: true
      message: string
      divergences: Array<{
        productId: string | null
        description: string
        type: 'price' | 'stock'
        quoted: number
        current: number
      }>
    }
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error ?? 'Falha ao converter cotação.')
  }

  return (await response.json()) as {
    orderId: string
    reviewRequired: false
    divergences: Array<{
      productId: string | null
      description: string
      type: 'price' | 'stock'
      quoted: number
      current: number
    }>
  }
}

export type StockLevelLookup = {
  productId: string
  productName: string
  productSku: string | null
  warehouseId: string
  warehouseName: string
  qtyAvailable: string | number
  qtyReserved: string | number
  qtyFree: string | number
  minQty: string | number
  maxQty: string | number
  belowMin: boolean
  inconsistent: boolean
}

export async function fetchStockLevelsPaged(options?: {
  productId?: string
  warehouseId?: string
  query?: string
  onlyAlerts?: boolean
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<LookupPageResult<StockLevelLookup>> {
  const params = new URLSearchParams()
  const productId = options?.productId?.trim() ?? ''
  const warehouseId = options?.warehouseId?.trim() ?? ''
  const query = options?.query?.trim() ?? ''

  if (productId) params.set('productId', productId)
  if (warehouseId) params.set('warehouseId', warehouseId)
  if (query) params.set('query', query)
  if (options?.onlyAlerts) params.set('onlyAlerts', 'true')

  if (typeof options?.limit === 'number' && Number.isFinite(options.limit)) {
    params.set('limit', String(Math.max(1, Math.floor(options.limit))))
  }
  if (typeof options?.offset === 'number' && Number.isFinite(options.offset)) {
    params.set('offset', String(Math.max(0, Math.floor(options.offset))))
  }

  const path = params.size > 0 ? `/stock/levels?${params.toString()}` : '/stock/levels'
  const { data, headers } = await getJsonWithHeaders<StockLevelLookup[]>(path, {
    signal: options?.signal,
  })

  return {
    rows: data,
    totalCount: parseLookupTotalCountHeader(headers),
  }
}

export type StockMovementLookup = {
  id: string
  productId: string
  productName: string
  productSku: string | null
  warehouseId: string
  warehouseName: string
  movementType: 'in' | 'out' | 'adjust' | 'transfer'
  quantity: string | number
  reason: string | null
  refTable: string | null
  refId: string | null
  occurredAt: string
}

export async function fetchStockMovementsPaged(options?: {
  productId?: string
  warehouseId?: string
  movementType?: 'in' | 'out' | 'adjust' | 'transfer'
  from?: string
  to?: string
  query?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<LookupPageResult<StockMovementLookup>> {
  const params = new URLSearchParams()
  const productId = options?.productId?.trim() ?? ''
  const warehouseId = options?.warehouseId?.trim() ?? ''
  const movementType = options?.movementType?.trim() ?? ''
  const from = options?.from?.trim() ?? ''
  const to = options?.to?.trim() ?? ''
  const query = options?.query?.trim() ?? ''

  if (productId) params.set('productId', productId)
  if (warehouseId) params.set('warehouseId', warehouseId)
  if (movementType) params.set('movementType', movementType)
  if (from) params.set('from', from)
  if (to) params.set('to', to)
  if (query) params.set('query', query)

  if (typeof options?.limit === 'number' && Number.isFinite(options.limit)) {
    params.set('limit', String(Math.max(1, Math.floor(options.limit))))
  }
  if (typeof options?.offset === 'number' && Number.isFinite(options.offset)) {
    params.set('offset', String(Math.max(0, Math.floor(options.offset))))
  }

  const path = params.size > 0 ? `/stock/movements?${params.toString()}` : '/stock/movements'
  const { data, headers } = await getJsonWithHeaders<StockMovementLookup[]>(path, {
    signal: options?.signal,
  })

  return {
    rows: data,
    totalCount: parseLookupTotalCountHeader(headers),
  }
}

export function transferStock(input: {
  originWarehouseId: string
  destinationWarehouseId: string
  notes?: string
  items: Array<{
    product_id: string
    quantity: number
  }>
}, options?: { idempotencyKey?: string }) {
  return postJson<{ transferId: string }>('/stock/transfers', input, {
    headers: idempotencyHeader('stock-transfer-create', options?.idempotencyKey),
  })
}

export function createStockAdjustment(input: {
  warehouseId: string
  adjustmentType: 'in' | 'out' | 'adjust'
  reason?: string
  items: Array<{
    product_id: string
    quantity: number
  }>
}, options?: { idempotencyKey?: string }) {
  return postJson<{
    adjustmentId: string
    adjustedItems: number
    totalDelta: number
  }>('/stock/adjustments', input, {
    headers: idempotencyHeader('stock-adjustment-create', options?.idempotencyKey),
  })
}

export function updateStockLevelMinMax(input: {
  productId: string
  warehouseId: string
  minQty: number
  maxQty: number
}, options?: { idempotencyKey?: string }) {
  return postJson<{
    productId: string
    warehouseId: string
    minQty: number
    maxQty: number
  }>('/stock/levels/minmax', input, {
    headers: idempotencyHeader('stock-level-minmax-update', options?.idempotencyKey),
  })
}

export type StockReplenishmentSuggestion = {
  productId: string
  productName: string
  productSku: string | null
  warehouseId: string
  warehouseName: string
  qtyAvailable: string | number
  qtyReserved: string | number
  qtyFree: string | number
  minQty: string | number
  maxQty: string | number
  qtyToReplenish: string | number
}

export async function fetchStockReplenishmentSuggestionsPaged(options?: {
  productId?: string
  warehouseId?: string
  query?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<LookupPageResult<StockReplenishmentSuggestion>> {
  const params = new URLSearchParams()
  const productId = options?.productId?.trim() ?? ''
  const warehouseId = options?.warehouseId?.trim() ?? ''
  const query = options?.query?.trim() ?? ''

  if (productId) params.set('productId', productId)
  if (warehouseId) params.set('warehouseId', warehouseId)
  if (query) params.set('query', query)

  if (typeof options?.limit === 'number' && Number.isFinite(options.limit)) {
    params.set('limit', String(Math.max(1, Math.floor(options.limit))))
  }
  if (typeof options?.offset === 'number' && Number.isFinite(options.offset)) {
    params.set('offset', String(Math.max(0, Math.floor(options.offset))))
  }

  const path = params.size > 0
    ? `/stock/replenishment/suggestions?${params.toString()}`
    : '/stock/replenishment/suggestions'
  const { data, headers } = await getJsonWithHeaders<StockReplenishmentSuggestion[]>(path, {
    signal: options?.signal,
  })

  return {
    rows: data,
    totalCount: parseLookupTotalCountHeader(headers),
  }
}
