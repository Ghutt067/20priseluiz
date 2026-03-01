import type {
  FiscalProviderAdapter,
  FiscalProviderSendResult,
  FiscalTransmissionDocument,
} from './types'

const DEFAULT_PLUGNOTAS_BASE_URL = 'https://api.plugnotas.com.br'

function normalizeBaseUrl(value: string | null) {
  const normalized = value?.trim()
  if (!normalized) return DEFAULT_PLUGNOTAS_BASE_URL
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  return value as Record<string, unknown>
}

function pickString(record: Record<string, unknown> | null, keys: string[]) {
  if (!record) return null
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return String(value)
    }
  }
  return null
}

function inferStatus(payload: unknown): FiscalProviderSendResult['status'] {
  const record = asRecord(payload)
  const raw = pickString(record, ['status', 'situacao', 'state'])?.toLowerCase() ?? ''

  if (!raw) return 'sent'
  if (raw.includes('autoriz')) return 'authorized'
  if (raw.includes('aprova')) return 'authorized'
  if (raw.includes('rejeit')) return 'rejected'
  if (raw.includes('deneg')) return 'rejected'
  if (raw.includes('erro')) return 'error'
  if (raw.includes('fail')) return 'error'
  return 'sent'
}

async function readPayload(response: Response) {
  const text = await response.text()
  if (!text.trim()) return null

  try {
    return JSON.parse(text) as unknown
  } catch {
    return { raw: text }
  }
}

function endpointForDocument(document: FiscalTransmissionDocument) {
  if (document.docType === 'nfe') return '/nfe'
  if (document.docType === 'nfce') return '/nfce'
  return '/nfse'
}

export class PlugNotasAdapter implements FiscalProviderAdapter {
  async sendDocument(input: {
    config: {
      provider: 'plugnotas'
      environment: 'production' | 'homologation'
      apiBaseUrl: string | null
      apiKey: string | null
      companyApiKey: string | null
      integrationId: string | null
      active: boolean
    }
    document: FiscalTransmissionDocument
  }): Promise<FiscalProviderSendResult> {
    if (!input.config.active) {
      throw new Error('Configuração PlugNotas está inativa para esta organização.')
    }

    const xml = input.document.xml?.trim()
    if (!xml) {
      throw new Error('Documento fiscal sem XML para transmitir ao provedor.')
    }

    const token = input.config.companyApiKey?.trim() || input.config.apiKey?.trim()
    if (!token) {
      throw new Error('Configure a API key da PlugNotas antes de transmitir documentos fiscais.')
    }

    const requestPayload = {
      documentType: input.document.docType,
      environment: input.config.environment,
      integrationId: input.config.integrationId,
      xml,
    }

    const response = await fetch(
      `${normalizeBaseUrl(input.config.apiBaseUrl)}${endpointForDocument(input.document)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          'x-api-key': token,
        },
        body: JSON.stringify(requestPayload),
      },
    )

    const responsePayload = await readPayload(response)
    const responseRecord = asRecord(responsePayload)

    const providerReference = pickString(responseRecord, ['id', '_id', 'reference', 'protocolo'])
    const accessKey = pickString(responseRecord, ['accessKey', 'chaveAcesso', 'chave'])
    const responseCode =
      pickString(responseRecord, ['code', 'codigo', 'statusCode']) ?? String(response.status)
    const responseMessage =
      pickString(responseRecord, ['message', 'mensagem', 'description']) || response.statusText || null

    if (!response.ok) {
      return {
        provider: 'plugnotas',
        status: 'error',
        providerReference,
        responseCode,
        responseMessage,
        requestPayload,
        responsePayload,
        accessKey,
      }
    }

    return {
      provider: 'plugnotas',
      status: inferStatus(responsePayload),
      providerReference,
      responseCode,
      responseMessage,
      requestPayload,
      responsePayload,
      accessKey,
    }
  }
}
