import { Router } from 'express'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { getOrganizationId } from './getOrganizationId'
import { getAuthUser, assertOrgMember } from './authMiddleware'
import { processFiscalTransmission } from '../use-cases/fiscal/processFiscalTransmission'

const router = Router()
const fiscalProviderValues = ['plugnotas'] as const
const transmissionsListQuerySchema = z.object({
  documentId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
})

// getAuthUser and assertOrgMember imported from authMiddleware

router.get('/fiscal/transmissions', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const query = transmissionsListQuerySchema.parse({
      documentId: typeof request.query.documentId === 'string' ? request.query.documentId : undefined,
      limit: request.query.limit,
      offset: request.query.offset,
    })

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total
         from fiscal_transmissions
         where organization_id = $1
           and ($2::uuid is null or document_id = $2)`,
        [organizationId, query.documentId ?? null],
      )

      const rowsResult = await client.query(
        `select id,
                document_id as "documentId",
                status::text as status,
                provider::text as provider,
                provider_reference as "providerReference",
                response_code as "responseCode",
                response_message as "responseMessage",
                sent_at as "sentAt",
                authorized_at as "authorizedAt",
                created_at as "createdAt",
                updated_at as "updatedAt"
         from fiscal_transmissions
         where organization_id = $1
           and ($2::uuid is null or document_id = $2)
         order by updated_at desc, created_at desc
         limit $3
         offset $4`,
        [organizationId, query.documentId ?? null, query.limit, query.offset],
      )

      return {
        rows: rowsResult.rows,
        total: Number(countResult.rows[0]?.total ?? 0),
      }
    })

    response.setHeader('x-total-count', String(Math.max(result.total, 0)))
    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/fiscal/transmissions', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const schema = z.object({
      documentId: z.uuid(),
      provider: z.enum(fiscalProviderValues).optional(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const documentResult = await client.query<{ id: string; status: string }>(
        `select id,
                status::text as status
         from fiscal_documents
         where organization_id = $1
           and id = $2
         limit 1`,
        [organizationId, data.documentId],
      )

      if ((documentResult.rowCount ?? 0) === 0) {
        throw new Error('Documento fiscal não encontrado para enfileiramento.')
      }

      const document = documentResult.rows[0]
      if (document.status !== 'draft' && document.status !== 'error') {
        throw new Error('Somente documentos em rascunho ou com erro podem ser enfileirados.')
      }

      const activeTransmissionResult = await client.query(
        `select id
         from fiscal_transmissions
         where organization_id = $1
           and document_id = $2
           and status in ('queued', 'sent')
         order by updated_at desc
         limit 1`,
        [organizationId, data.documentId],
      )

      if ((activeTransmissionResult.rowCount ?? 0) > 0) {
        throw new Error('Já existe uma transmissão ativa para este documento fiscal.')
      }

      try {
        const insertResult = await client.query(
          `insert into fiscal_transmissions
            (organization_id, document_id, status, provider)
           values ($1, $2, 'queued', $3)
           returning id,
                     provider::text as provider`,
          [organizationId, data.documentId, data.provider ?? 'plugnotas'],
        )
        return insertResult
      } catch (error) {
        if (
          typeof error === 'object'
          && error !== null
          && 'code' in error
          && (error as { code?: string }).code === '23505'
        ) {
          throw new Error('Já existe uma transmissão ativa para este documento fiscal.')
        }
        throw error
      }
    })

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/fiscal/transmissions/:id/process', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const schema = z.object({
      id: z.uuid(),
      provider: z.enum(fiscalProviderValues).optional(),
    })
    const data = schema.parse({
      ...request.body,
      id: request.params.id,
    })

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return processFiscalTransmission(client, {
        organizationId,
        transmissionId: data.id,
        provider: data.provider,
      })
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/fiscal/transmissions/:id/status', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const schema = z.object({
      id: z.uuid(),
      status: z.enum(['queued', 'sent', 'authorized', 'rejected', 'error']),
      responseCode: z.string().optional(),
      responseMessage: z.string().optional(),
    })
    const data = schema.parse({
      ...request.body,
      id: request.params.id,
    })

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const updateResult = await client.query<{
        id: string
        documentId: string
        status: 'queued' | 'sent' | 'authorized' | 'rejected' | 'error'
        provider: 'plugnotas' | null
        providerReference: string | null
        responseCode: string | null
        responseMessage: string | null
      }>(
        `update fiscal_transmissions
         set status = $1,
             response_code = $2,
             response_message = $3,
             sent_at = case
               when $1 in ('sent', 'authorized', 'rejected', 'error')
                 then coalesce(sent_at, now())
               else sent_at
             end,
             authorized_at = case when $1 = 'authorized' then now() else authorized_at end,
             updated_at = now()
         where id = $4
           and organization_id = $5
         returning id,
                   document_id as "documentId",
                   status::text as status,
                   provider::text as provider,
                   provider_reference as "providerReference",
                   response_code as "responseCode",
                   response_message as "responseMessage"`,
        [
          data.status,
          data.responseCode ?? null,
          data.responseMessage ?? null,
          data.id,
          organizationId,
        ],
      )

      if ((updateResult.rowCount ?? 0) === 0) {
        throw new Error('Transmissão fiscal não encontrada.')
      }

      const transmission = updateResult.rows[0]

      if (data.status === 'authorized') {
        await client.query(
          `update fiscal_documents
           set status = 'authorized',
               issue_date = coalesce(issue_date, now()),
               updated_at = now()
           where organization_id = $1
             and id = $2`,
          [organizationId, transmission.documentId],
        )
      } else if (data.status === 'rejected') {
        await client.query(
          `update fiscal_documents
           set status = 'denied',
               updated_at = now()
           where organization_id = $1
             and id = $2`,
          [organizationId, transmission.documentId],
        )
      } else if (data.status === 'error') {
        await client.query(
          `update fiscal_documents
           set status = 'error',
               updated_at = now()
           where organization_id = $1
             and id = $2`,
          [organizationId, transmission.documentId],
        )
      }

      const documentResult = await client.query<{ status: string }>(
        `select status::text as status
         from fiscal_documents
         where organization_id = $1
           and id = $2
         limit 1`,
        [organizationId, transmission.documentId],
      )

      return {
        ...transmission,
        documentStatus: documentResult.rows[0]?.status ?? null,
      }
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

export { router as fiscalTransmissionRoutes }
