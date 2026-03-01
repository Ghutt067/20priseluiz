import { getJsonWithHeaders, postJson } from './http'

export type FiscalTransmissionProvider = 'plugnotas'
export type FiscalTransmissionStatus = 'queued' | 'sent' | 'authorized' | 'rejected' | 'error'
export type FiscalDocumentTransmissionStatus =
  | 'draft'
  | 'authorized'
  | 'cancelled'
  | 'denied'
  | 'error'

export type FiscalTransmissionOperationResult = {
  id: string
  status: FiscalTransmissionStatus
  provider: FiscalTransmissionProvider | null
  providerReference: string | null
  responseCode: string | null
  responseMessage: string | null
  documentId: string
  documentStatus: FiscalDocumentTransmissionStatus
}

export type FiscalTransmissionStatusUpdateResult = {
  id: string
  status: FiscalTransmissionStatus
  provider: FiscalTransmissionProvider | null
  providerReference: string | null
  responseCode: string | null
  responseMessage: string | null
  documentId: string
  documentStatus: FiscalDocumentTransmissionStatus | null
}

export type FiscalTransmissionListItem = {
  id: string
  documentId: string
  status: FiscalTransmissionStatus
  provider: FiscalTransmissionProvider | null
  providerReference: string | null
  responseCode: string | null
  responseMessage: string | null
  sentAt: string | null
  authorizedAt: string | null
  createdAt: string
  updatedAt: string
}

function parseTotalCountHeader(headers: Headers) {
  const raw = headers.get('x-total-count')
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed)) return null
  return Math.max(parsed, 0)
}

export function createFiscalTransmission(input: {
  documentId: string
  provider?: FiscalTransmissionProvider
}) {
  return postJson<{ id: string; provider: FiscalTransmissionProvider | null }>('/fiscal/transmissions', input)
}

export function processFiscalTransmission(input: {
  id: string
  provider?: FiscalTransmissionProvider
}) {
  return postJson<FiscalTransmissionOperationResult>(`/fiscal/transmissions/${input.id}/process`, {
    provider: input.provider,
  })
}

export function updateFiscalTransmission(input: {
  id: string
  status: FiscalTransmissionStatus
  responseCode?: string
  responseMessage?: string
}) {
  return postJson<FiscalTransmissionStatusUpdateResult>(`/fiscal/transmissions/${input.id}/status`, {
    status: input.status,
    responseCode: input.responseCode,
    responseMessage: input.responseMessage,
  })
}

export async function fetchFiscalTransmissionsPaged(options: {
  documentId?: string
  limit?: number
  offset?: number
  signal?: AbortSignal
}) {
  const limit =
    typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.max(1, Math.floor(options.limit))
      : 10
  const offset =
    typeof options.offset === 'number' && Number.isFinite(options.offset)
      ? Math.max(0, Math.floor(options.offset))
      : 0

  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
  })

  if (options.documentId?.trim()) {
    params.set('documentId', options.documentId.trim())
  }

  const { data, headers } = await getJsonWithHeaders<FiscalTransmissionListItem[]>(
    `/fiscal/transmissions?${params.toString()}`,
    {
      signal: options.signal,
    },
  )

  return {
    rows: data,
    totalCount: parseTotalCountHeader(headers),
  }
}
