import { getJson, getJsonWithHeaders, postJson } from './http'

export type ServiceOrderStatus = 'open' | 'in_progress' | 'completed' | 'cancelled'
export type ServiceTimeEntryType = 'labor' | 'diagnostic'

type PagedResult<T> = {
  rows: T[]
  totalCount: number | null
}

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

function parseTotalCount(headers: Headers) {
  const raw = headers.get('x-total-count')
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return null
  return Math.max(parsed, 0)
}

function appendNormalizedQueryValue(params: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null) return
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (!normalized) return
    params.set(key, normalized)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return
    if (key === 'limit') {
      params.set(key, String(Math.max(1, Math.floor(value))))
      return
    }
    if (key === 'offset') {
      params.set(key, String(Math.max(0, Math.floor(value))))
      return
    }
    params.set(key, String(value))
    return
  }
  if (typeof value === 'boolean') {
    params.set(key, String(value))
  }
}

function buildQueryParams(options?: Record<string, unknown>) {
  const params = new URLSearchParams()
  if (!options) return params

  for (const [key, value] of Object.entries(options)) {
    appendNormalizedQueryValue(params, key, value)
  }

  return params
}

export type ServiceOrderLookup = {
  id: string
  status: ServiceOrderStatus
  totalAmount: string | number
  notes: string | null
  scheduledAt: string | null
  createdAt: string
  updatedAt: string
  customerId: string | null
  customerName: string | null
  vehicleId: string | null
  vehiclePlate: string | null
  vehicleBrand: string | null
  vehicleModel: string | null
  invoiceId: string | null
  fiscalDocumentId: string | null
  receivableTitleId: string | null
  invoicedAt: string | null
}

export type ServiceOrderDetail = {
  order: ServiceOrderLookup & {
    vehicleYear: number | null
    vehicleColor: string | null
    vehicleVin: string | null
  }
  items: Array<{
    id: string
    productId: string | null
    productName: string | null
    productSku: string | null
    description: string | null
    quantity: string | number
    unitPrice: string | number
    totalPrice: string | number
    hoursWorked: string | number
  }>
  checklist: Array<{
    id: string
    item: string
    isDone: boolean
  }>
  technicians: Array<{
    id: string
    technicianId: string
    technicianName: string
    hoursWorked: string | number
  }>
}

export type ServiceVehicleLookup = {
  id: string
  name: string
  customerId: string | null
  customerName: string | null
  plate: string | null
  brand: string | null
  model: string | null
  year: number | null
  color: string | null
  vin: string | null
  createdAt: string
  updatedAt: string
}

export type ServiceTechnicianLookup = {
  id: string
  name: string
  email: string | null
  phone: string | null
  active: boolean
  createdAt: string
}

export async function fetchServiceOrdersPaged(options?: {
  status?: ServiceOrderStatus | ''
  query?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<PagedResult<ServiceOrderLookup>> {
  const params = buildQueryParams({
    status: options?.status,
    query: options?.query,
    limit: options?.limit,
    offset: options?.offset,
  })
  const path = params.size > 0 ? `/services/orders?${params.toString()}` : '/services/orders'
  const { data, headers } = await getJsonWithHeaders<ServiceOrderLookup[]>(path, {
    signal: options?.signal,
  })

  return {
    rows: data,
    totalCount: parseTotalCount(headers),
  }
}

export function fetchServiceOrderDetail(serviceOrderId: string) {
  return getJson<ServiceOrderDetail>(`/services/orders/${encodeURIComponent(serviceOrderId)}`)
}

export async function fetchServiceVehiclesPaged(options?: {
  query?: string
  customerId?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<PagedResult<ServiceVehicleLookup>> {
  const params = buildQueryParams({
    query: options?.query,
    customerId: options?.customerId,
    limit: options?.limit,
    offset: options?.offset,
  })
  const path = params.size > 0 ? `/services/vehicles?${params.toString()}` : '/services/vehicles'
  const { data, headers } = await getJsonWithHeaders<
    Array<{
      id: string
      customerId: string | null
      customerName: string | null
      plate: string | null
      brand: string | null
      model: string | null
      year: number | null
      color: string | null
      vin: string | null
      createdAt: string
      updatedAt: string
    }>
  >(path, {
    signal: options?.signal,
  })

  const rows: ServiceVehicleLookup[] = data.map((vehicle) => ({
    ...vehicle,
    name:
      vehicle.plate
      || [vehicle.brand, vehicle.model].filter(Boolean).join(' ').trim()
      || vehicle.id,
  }))

  return {
    rows,
    totalCount: parseTotalCount(headers),
  }
}

export async function fetchServiceTechniciansPaged(options?: {
  query?: string
  active?: boolean | null
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<PagedResult<ServiceTechnicianLookup>> {
  const params = buildQueryParams({
    query: options?.query,
    active: options?.active,
    limit: options?.limit,
    offset: options?.offset,
  })
  const path = params.size > 0
    ? `/services/technicians?${params.toString()}`
    : '/services/technicians'
  const { data, headers } = await getJsonWithHeaders<ServiceTechnicianLookup[]>(path, {
    signal: options?.signal,
  })

  return {
    rows: data,
    totalCount: parseTotalCount(headers),
  }
}

export function updateServiceOrderStatus(
  input: {
    serviceOrderId: string
    status: ServiceOrderStatus
  },
  options?: { idempotencyKey?: string },
) {
  return postJson<{ serviceOrderId: string; status: ServiceOrderStatus }>(
    `/services/orders/${encodeURIComponent(input.serviceOrderId)}/status`,
    {
      status: input.status,
    },
    {
      headers: idempotencyHeader('service-order-status-update', options?.idempotencyKey),
    },
  )
}

export function invoiceServiceOrder(
  input: {
    serviceOrderId: string
  },
  options?: { idempotencyKey?: string },
) {
  return postJson<{
    serviceOrderId: string
    status: ServiceOrderStatus
    invoiceId: string
    fiscalDocumentId: string
    receivableTitleId: string
    invoicedAt: string
    reused: boolean
  }>(
    `/services/orders/${encodeURIComponent(input.serviceOrderId)}/invoice`,
    {},
    {
      headers: idempotencyHeader('service-order-invoice', options?.idempotencyKey),
    },
  )
}

export function createVehicle(
  input: {
    customerId?: string
    plate?: string
    brand?: string
    model?: string
    year?: number
    color?: string
    vin?: string
  },
  options?: { idempotencyKey?: string },
) {
  return postJson<{ id: string }>('/services/vehicles', input, {
    headers: idempotencyHeader('service-vehicle-create', options?.idempotencyKey),
  })
}

export function createTechnician(
  input: {
    name: string
    email?: string
    phone?: string
  },
  options?: { idempotencyKey?: string },
) {
  return postJson<{ id: string }>('/services/technicians', input, {
    headers: idempotencyHeader('service-technician-create', options?.idempotencyKey),
  })
}

export function createServiceOrder(
  input: {
    customerId?: string
    vehicleId?: string
    scheduledAt?: string
    notes?: string
    items: Array<{
      product_id?: string
      description: string
      quantity: number
      unit_price: number
      hours_worked?: number
    }>
    checklist?: Array<{
      item: string
    }>
  },
  options?: { idempotencyKey?: string },
) {
  return postJson<{ serviceOrderId: string; totalAmount: number }>('/services/orders', input, {
    headers: idempotencyHeader('service-order-create', options?.idempotencyKey),
  })
}

export function assignTechnicianToOrder(
  input: {
    serviceOrderId: string
    technicianId: string
    hoursWorked?: number
  },
  options?: { idempotencyKey?: string },
) {
  return postJson<{ serviceOrderId: string }>(
    `/services/orders/${encodeURIComponent(input.serviceOrderId)}/technicians`,
    {
      technicianId: input.technicianId,
      hoursWorked: input.hoursWorked,
    },
    {
      headers: idempotencyHeader('service-order-assign-technician', options?.idempotencyKey),
    },
  )
}

export function logServiceTime(
  input: {
    serviceOrderId: string
    technicianId?: string
    entryType?: ServiceTimeEntryType
    hours: number
    notes?: string
  },
  options?: { idempotencyKey?: string },
) {
  return postJson<{ timeEntryId: string }>(
    `/services/orders/${encodeURIComponent(input.serviceOrderId)}/time`,
    {
      technicianId: input.technicianId,
      entryType: input.entryType,
      hours: input.hours,
      notes: input.notes,
    },
    {
      headers: idempotencyHeader('service-order-log-time', options?.idempotencyKey),
    },
  )
}
