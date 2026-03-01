import type { PoolClient } from 'pg'
import { createFiscalProviderAdapter } from './providers'
import type { FiscalProviderConfigRecord, FiscalProviderName } from './providers/types'

type ProcessFiscalTransmissionInput = {
  organizationId: string
  transmissionId: string
  provider?: FiscalProviderName
}

type TransmissionRow = {
  id: string
  transmissionStatus: 'queued' | 'sent' | 'authorized' | 'rejected' | 'error'
  transmissionProvider: FiscalProviderName | null
  providerReference: string | null
  responseCode: string | null
  responseMessage: string | null
  documentId: string
  documentStatus: 'draft' | 'authorized' | 'cancelled' | 'denied' | 'error'
  docType: 'nfe' | 'nfce' | 'nfse'
  environment: 'production' | 'homologation'
  xml: string | null
  accessKey: string | null
}

async function loadTransmission(
  client: PoolClient,
  input: ProcessFiscalTransmissionInput,
): Promise<TransmissionRow> {
  const result = await client.query<TransmissionRow>(
    `select ft.id,
            ft.status::text as "transmissionStatus",
            ft.provider::text as "transmissionProvider",
            ft.provider_reference as "providerReference",
            ft.response_code as "responseCode",
            ft.response_message as "responseMessage",
            fd.id as "documentId",
            fd.status::text as "documentStatus",
            fd.doc_type::text as "docType",
            fd.environment::text as environment,
            fd.xml,
            fd.access_key as "accessKey"
     from fiscal_transmissions ft
     inner join fiscal_documents fd
       on fd.organization_id = ft.organization_id
      and fd.id = ft.document_id
     where ft.organization_id = $1
       and ft.id = $2
     limit 1
     for update of ft`,
    [input.organizationId, input.transmissionId],
  )

  if ((result.rowCount ?? 0) === 0) {
    throw new Error('Transmissão fiscal não encontrada para a organização.')
  }

  return result.rows[0]
}

async function loadProviderConfig(
  client: PoolClient,
  organizationId: string,
  provider: FiscalProviderName,
): Promise<FiscalProviderConfigRecord> {
  const result = await client.query<FiscalProviderConfigRecord>(
    `select provider::text as provider,
            environment::text as environment,
            api_base_url as "apiBaseUrl",
            api_key as "apiKey",
            company_api_key as "companyApiKey",
            integration_id as "integrationId",
            active
     from fiscal_provider_configs
     where organization_id = $1
       and provider = $2
     limit 1`,
    [organizationId, provider],
  )

  if ((result.rowCount ?? 0) === 0) {
    throw new Error('Configure o provedor fiscal antes de transmitir documentos.')
  }

  const config = result.rows[0]
  if (!config.active) {
    throw new Error('A configuração do provedor fiscal está inativa para esta organização.')
  }

  return config
}

export async function processFiscalTransmission(
  client: PoolClient,
  input: ProcessFiscalTransmissionInput,
) {
  const transmission = await loadTransmission(client, input)

  if (transmission.transmissionStatus === 'authorized' || transmission.transmissionStatus === 'sent') {
    return {
      id: transmission.id,
      status: transmission.transmissionStatus,
      providerReference: transmission.providerReference,
      responseCode: transmission.responseCode,
      responseMessage: transmission.responseMessage,
      documentId: transmission.documentId,
      documentStatus: transmission.documentStatus,
      provider: transmission.transmissionProvider,
    }
  }

  const provider = input.provider ?? transmission.transmissionProvider ?? 'plugnotas'
  const config = await loadProviderConfig(client, input.organizationId, provider)
  const adapter = createFiscalProviderAdapter(provider)

  const sendResult = await adapter.sendDocument({
    config,
    document: {
      id: transmission.documentId,
      docType: transmission.docType,
      environment: transmission.environment,
      xml: transmission.xml,
    },
  })

  const transmissionResult = await client.query<{
    id: string
    status: 'queued' | 'sent' | 'authorized' | 'rejected' | 'error'
    provider: FiscalProviderName | null
    providerReference: string | null
    responseCode: string | null
    responseMessage: string | null
  }>(
    `update fiscal_transmissions
     set status = $1,
         provider = $2,
         provider_reference = $3,
         request_payload = $4,
         response_payload = $5,
         response_code = $6,
         response_message = $7,
         sent_at = case
           when $1 in ('sent', 'authorized', 'rejected', 'error')
             then coalesce(sent_at, now())
           else sent_at
         end,
         authorized_at = case when $1 = 'authorized' then now() else authorized_at end,
         updated_at = now()
     where organization_id = $8
       and id = $9
     returning id,
               status::text as status,
               provider::text as provider,
               provider_reference as "providerReference",
               response_code as "responseCode",
               response_message as "responseMessage"`,
    [
      sendResult.status,
      sendResult.provider,
      sendResult.providerReference,
      sendResult.requestPayload,
      sendResult.responsePayload,
      sendResult.responseCode,
      sendResult.responseMessage,
      input.organizationId,
      transmission.id,
    ],
  )

  if (sendResult.status === 'authorized') {
    await client.query(
      `update fiscal_documents
       set status = 'authorized',
           access_key = coalesce($1, access_key),
           issue_date = coalesce(issue_date, now()),
           updated_at = now()
       where organization_id = $2
         and id = $3`,
      [sendResult.accessKey, input.organizationId, transmission.documentId],
    )
  } else if (sendResult.status === 'rejected') {
    await client.query(
      `update fiscal_documents
       set status = 'denied',
           updated_at = now()
       where organization_id = $1
         and id = $2`,
      [input.organizationId, transmission.documentId],
    )
  } else if (sendResult.status === 'error') {
    await client.query(
      `update fiscal_documents
       set status = 'error',
           updated_at = now()
       where organization_id = $1
         and id = $2`,
      [input.organizationId, transmission.documentId],
    )
  }

  const updatedDocumentResult = await client.query<{ status: string }>(
    `select status::text as status
     from fiscal_documents
     where organization_id = $1
       and id = $2
     limit 1`,
    [input.organizationId, transmission.documentId],
  )

  return {
    ...transmissionResult.rows[0],
    documentId: transmission.documentId,
    documentStatus: updatedDocumentResult.rows[0]?.status ?? transmission.documentStatus,
  }
}
