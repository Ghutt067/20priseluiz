import { getJson, getJsonWithHeaders, postJson } from './http'

export type FiscalProfileType = 'default' | 'custom'
export type FiscalDocumentType = 'nfe' | 'nfce' | 'nfse'
export type FiscalDocumentStatus = 'draft' | 'authorized' | 'cancelled' | 'denied' | 'error'
export type FiscalTaxRegime = 'simples_nacional' | 'lucro_presumido' | 'lucro_real' | 'mei'
export type FiscalProvider = 'plugnotas'

export type FiscalProfile = {
  id: string
  name: string
  profile_type: FiscalProfileType
  created_at: string
}

export type FiscalDocumentListItem = {
  id: string
  invoiceId: string | null
  emitterId: string | null
  emitterName: string | null
  docType: FiscalDocumentType
  status: FiscalDocumentStatus
  environment: 'production' | 'homologation'
  series: number | null
  number: number | null
  accessKey: string | null
  issueDate: string | null
  totalInvoice: string | number
  createdAt: string
  recipientName: string | null
  transmissionId: string | null
  transmissionStatus: 'queued' | 'sent' | 'authorized' | 'rejected' | 'error' | null
  transmissionProvider: FiscalProvider | null
  transmissionProviderReference: string | null
  transmissionResponseCode: string | null
  transmissionResponseMessage: string | null
  transmissionUpdatedAt: string | null
}

export type FiscalPageResult<T> = {
  rows: T[]
  totalCount: number | null
}

function parseTotalCountHeader(headers: Headers) {
  const raw = headers.get('x-total-count')
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return null
  return Math.max(parsed, 0)
}

export type FiscalDraftInput = {
  emitterId?: string
  customerId: string
  profileId: string
  originState?: string
  destinationState?: string
  docType: 'nfe' | 'nfce'
  environment?: 'production' | 'homologation'
  items: Array<{
    product_id?: string
    description: string
    quantity: number
    unit_price: number
    ncm?: string
    cfop?: string
    uom?: string
  }>
}

export async function createFiscalDraft(input: FiscalDraftInput) {
  return postJson<{ documentId: string; xml?: string }>(`/fiscal/${input.docType}/draft`, input)
}

export type FiscalEmitter = {
  id: string
  name: string
  legalName: string | null
  cnpj: string
  ie: string | null
  im: string | null
  taxRegime: FiscalTaxRegime
  street: string | null
  number: string | null
  complement: string | null
  district: string | null
  city: string | null
  state: string | null
  postalCode: string | null
  country: string | null
  ibgeCityCode: string | null
  isDefault: boolean
  createdAt: string
}

export type FiscalEmitterInput = {
  name: string
  legalName?: string
  cnpj: string
  ie?: string
  im?: string
  taxRegime?: FiscalTaxRegime
  street?: string
  number?: string
  complement?: string
  district?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
  ibgeCityCode?: string
  isDefault?: boolean
}

export async function fetchFiscalEmittersPaged(options?: {
  query?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<FiscalPageResult<FiscalEmitter>> {
  const normalizedLimit =
    typeof options?.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(1, Math.floor(options.limit))
      : 20
  const normalizedOffset =
    typeof options?.offset === 'number' && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0

  const params = new URLSearchParams({
    limit: String(normalizedLimit),
    offset: String(normalizedOffset),
  })

  if (options?.query?.trim()) {
    params.set('query', options.query.trim())
  }

  const { data, headers } = await getJsonWithHeaders<FiscalEmitter[]>(
    `/fiscal/emitters?${params.toString()}`,
    {
      signal: options?.signal,
    },
  )

  return {
    rows: data,
    totalCount: parseTotalCountHeader(headers),
  }
}

export async function createFiscalEmitter(input: FiscalEmitterInput) {
  return postJson<FiscalEmitter>('/fiscal/emitters', input)
}

export type FiscalProviderConfig = {
  id: string
  provider: FiscalProvider
  environment: 'production' | 'homologation'
  apiBaseUrl: string | null
  apiKey: string | null
  companyApiKey: string | null
  integrationId: string | null
  active: boolean
  updatedAt: string
}

export type FiscalProviderConfigInput = {
  provider?: FiscalProvider
  environment?: 'production' | 'homologation'
  apiBaseUrl?: string
  apiKey?: string
  companyApiKey?: string
  integrationId?: string
  active?: boolean
}

export function fetchFiscalProviderConfig(provider: FiscalProvider = 'plugnotas') {
  const params = new URLSearchParams({ provider })
  return getJson<FiscalProviderConfig | null>(`/fiscal/provider-config?${params.toString()}`)
}

export async function upsertFiscalProviderConfig(input: FiscalProviderConfigInput) {
  return postJson<FiscalProviderConfig>('/fiscal/provider-config', input)
}

export function fetchFiscalProfiles() {
  return getJson<FiscalProfile[]>('/fiscal/profiles')
}

export function fetchFiscalRules(profileId: string) {
  const params = new URLSearchParams({ profileId })
  return getJson<
    Array<{
      id: string
      profile_id: string
      tax_type: string
      rate: string | number
      base_reduction: string | number
      st_margin: string | number
      cst: string | null
      csosn: string | null
      cfop: string | null
      origin_state: string | null
      destination_state: string | null
      created_at: string
    }>
  >(`/fiscal/rules?${params.toString()}`)
}

export async function fetchFiscalDocumentsPaged(options?: {
  query?: string
  status?: FiscalDocumentStatus | ''
  docType?: FiscalDocumentType | ''
  limit?: number
  offset?: number
  signal?: AbortSignal
}): Promise<FiscalPageResult<FiscalDocumentListItem>> {
  const normalizedLimit =
    typeof options?.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(1, Math.floor(options.limit))
      : 20
  const normalizedOffset =
    typeof options?.offset === 'number' && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0

  const params = new URLSearchParams({
    limit: String(normalizedLimit),
    offset: String(normalizedOffset),
  })

  if (options?.query?.trim()) {
    params.set('query', options.query.trim())
  }

  if (options?.status) {
    params.set('status', options.status)
  }

  if (options?.docType) {
    params.set('docType', options.docType)
  }

  const { data, headers } = await getJsonWithHeaders<FiscalDocumentListItem[]>(
    `/fiscal/documents?${params.toString()}`,
    {
      signal: options?.signal,
    },
  )

  return {
    rows: data,
    totalCount: parseTotalCountHeader(headers),
  }
}

export type FiscalProfileInput = {
  name: string
  profileType?: FiscalProfileType
}

export type FiscalRuleInput = {
  profileId: string
  taxType: 'icms' | 'icms_st' | 'icms_difal' | 'pis' | 'cofins' | 'ipi' | 'iss'
  rate: number
  baseReduction?: number
  stMargin?: number
  cst?: string
  csosn?: string
  cfop?: string
  originState?: string
  destinationState?: string
}

export async function createFiscalProfile(input: FiscalProfileInput) {
  return postJson<{ id: string }>('/fiscal/profiles', input)
}

export async function createFiscalRule(input: FiscalRuleInput) {
  return postJson<{ id: string }>('/fiscal/rules', input)
}

export type XmlImportResult = {
  importId: string
  supplierId: string | null
  supplierName: string | null
  items: Array<{
    productId: string | null
    description: string
    quantity: number
    unitCost: number
  }>
}

export function importPurchaseXml(input: { xml: string; warehouseId?: string }) {
  return postJson<XmlImportResult>('/fiscal/xml/import', input)
}

export function createCce(documentId: string, correction: string) {
  return postJson<{ eventId: string; documentId: string }>(`/fiscal/documents/${documentId}/cce`, { correction })
}

export function cancelFiscalDocument(documentId: string, justification: string) {
  return postJson<{ eventId: string; documentId: string }>(`/fiscal/documents/${documentId}/cancel`, { justification })
}

export type ManifestEventType = 'confirmacao' | 'ciencia' | 'desconhecimento' | 'nao_realizada'

export function manifestFiscalDocument(documentId: string, eventType: ManifestEventType, justification?: string) {
  return postJson<{ eventId: string; documentId: string }>(`/fiscal/documents/${documentId}/manifest`, { eventType, justification })
}

export type FiscalEvent = {
  id: string
  eventType: string
  protocol: string | null
  xml: string | null
  createdAt: string
}

export function fetchFiscalDocumentEvents(documentId: string) {
  return getJson<FiscalEvent[]>(`/fiscal/documents/${documentId}/events`)
}

export function fetchFiscalDocumentXml(documentId: string) {
  return getJson<string>(`/fiscal/documents/${documentId}/xml`)
}
