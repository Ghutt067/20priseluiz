import { Router } from 'express'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { getOrganizationId } from './getOrganizationId'
import { emitirNfeDraft } from '../use-cases/fiscal/emitirNfeDraft'
import { importarXmlCompra } from '../use-cases/fiscal/importarXmlCompra'
import { calculateTaxes, type TaxRule } from '../domain/taxes/calculateTaxes'
import { getAuthUser, assertOrgMember } from './authMiddleware'

const router = Router()

function normalizeOptionalQueryValue(value: unknown) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

function normalizeOptionalBodyText(value: string | undefined) {
  const normalized = value?.trim() ?? ''
  return normalized.length > 0 ? normalized : null
}

function normalizeStateBodyText(value: string | undefined) {
  const normalized = normalizeOptionalBodyText(value)
  if (!normalized) return null
  return normalized.toUpperCase().slice(0, 2)
}

function parseLimitOffset(
  query: Record<string, unknown>,
  options?: { limit?: number; maxLimit?: number },
) {
  const defaultLimit = options?.limit ?? 20
  const maxLimit = options?.maxLimit ?? 100
  const parsedLimit = Number.parseInt(typeof query.limit === 'string' ? query.limit : '', 10)
  const parsedOffset = Number.parseInt(typeof query.offset === 'string' ? query.offset : '', 10)

  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), maxLimit)
    : defaultLimit
  const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0

  return { limit, offset }
}

const profileSchema = z.object({
  name: z.string().min(1),
  profileType: z.enum(['default', 'custom']).optional(),
})

const taxRegimeValues = ['simples_nacional', 'lucro_presumido', 'lucro_real', 'mei'] as const
const fiscalProviderValues = ['plugnotas'] as const

const emitterSchema = z.object({
  name: z.string().min(1),
  legalName: z.string().optional(),
  cnpj: z.string().min(11),
  ie: z.string().optional(),
  im: z.string().optional(),
  taxRegime: z.enum(taxRegimeValues).optional(),
  street: z.string().optional(),
  number: z.string().optional(),
  complement: z.string().optional(),
  district: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  ibgeCityCode: z.string().optional(),
  isDefault: z.boolean().optional(),
})

const providerConfigSchema = z.object({
  provider: z.enum(fiscalProviderValues).optional(),
  environment: z.enum(['production', 'homologation']).optional(),
  apiBaseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  companyApiKey: z.string().optional(),
  integrationId: z.string().optional(),
  active: z.boolean().optional(),
})

const ruleSchema = z.object({
  profileId: z.uuid(),
  taxType: z.enum(['icms', 'icms_st', 'icms_difal', 'pis', 'cofins', 'ipi', 'iss']),
  rate: z.number().nonnegative(),
  baseReduction: z.number().nonnegative().optional(),
  stMargin: z.number().nonnegative().optional(),
  cst: z.string().optional(),
  csosn: z.string().optional(),
  cfop: z.string().optional(),
  originState: z.string().optional(),
  destinationState: z.string().optional(),
})

router.get('/emitters', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const query = normalizeOptionalQueryValue(request.query.query)
    const likeQuery = `%${query}%`
    const { limit, offset } = parseLimitOffset(request.query as Record<string, unknown>, {
      limit: 20,
      maxLimit: 100,
    })

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total
         from fiscal_emitters fe
         where fe.organization_id = $1
           and (
             $2 = ''
             or fe.name ilike $3
             or fe.cnpj ilike $3
             or coalesce(fe.city, '') ilike $3
           )`,
        [organizationId, query, likeQuery],
      )

      const rowsResult = await client.query(
        `select fe.id,
                fe.name,
                fe.legal_name as "legalName",
                fe.cnpj,
                fe.ie,
                fe.im,
                fe.tax_regime::text as "taxRegime",
                fe.street,
                fe.number,
                fe.complement,
                fe.district,
                fe.city,
                fe.state,
                fe.postal_code as "postalCode",
                fe.country,
                fe.ibge_city_code as "ibgeCityCode",
                fe.is_default as "isDefault",
                fe.created_at as "createdAt"
         from fiscal_emitters fe
         where fe.organization_id = $1
           and (
             $2 = ''
             or fe.name ilike $3
             or fe.cnpj ilike $3
             or coalesce(fe.city, '') ilike $3
           )
         order by fe.is_default desc, fe.created_at desc
         limit $4
         offset $5`,
        [organizationId, query, likeQuery, limit, offset],
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

router.post('/emitters', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const data = emitterSchema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const totalEmittersResult = await client.query<{ total: number }>(
        `select count(*)::int as total
         from fiscal_emitters
         where organization_id = $1`,
        [organizationId],
      )

      const shouldBeDefault =
        data.isDefault
        ?? Number(totalEmittersResult.rows[0]?.total ?? 0) === 0

      if (shouldBeDefault) {
        await client.query(
          `update fiscal_emitters
           set is_default = false,
               updated_at = now()
           where organization_id = $1
             and is_default = true`,
          [organizationId],
        )
      }

      const insertResult = await client.query(
        `insert into fiscal_emitters
          (
            organization_id,
            name,
            legal_name,
            cnpj,
            ie,
            im,
            tax_regime,
            street,
            number,
            complement,
            district,
            city,
            state,
            postal_code,
            country,
            ibge_city_code,
            is_default
          )
         values
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8,
            $9,
            $10,
            $11,
            $12,
            $13,
            $14,
            $15,
            $16,
            $17
          )
         returning id,
                   name,
                   legal_name as "legalName",
                   cnpj,
                   ie,
                   im,
                   tax_regime::text as "taxRegime",
                   street,
                   number,
                   complement,
                   district,
                   city,
                   state,
                   postal_code as "postalCode",
                   country,
                   ibge_city_code as "ibgeCityCode",
                   is_default as "isDefault",
                   created_at as "createdAt"`,
        [
          organizationId,
          data.name.trim(),
          normalizeOptionalBodyText(data.legalName),
          data.cnpj.trim(),
          normalizeOptionalBodyText(data.ie),
          normalizeOptionalBodyText(data.im),
          data.taxRegime ?? 'simples_nacional',
          normalizeOptionalBodyText(data.street),
          normalizeOptionalBodyText(data.number),
          normalizeOptionalBodyText(data.complement),
          normalizeOptionalBodyText(data.district),
          normalizeOptionalBodyText(data.city),
          normalizeStateBodyText(data.state),
          normalizeOptionalBodyText(data.postalCode),
          normalizeOptionalBodyText(data.country) ?? 'BR',
          normalizeOptionalBodyText(data.ibgeCityCode),
          shouldBeDefault,
        ],
      )

      return insertResult
    })

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/provider-config', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const requestedProvider = normalizeOptionalQueryValue(request.query.provider)
    if (requestedProvider && requestedProvider !== 'plugnotas') {
      response.status(400).json({ error: 'Provedor fiscal não suportado.' })
      return
    }
    const provider = 'plugnotas'

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return client.query(
        `select id,
                provider::text as provider,
                environment::text as environment,
                api_base_url as "apiBaseUrl",
                api_key as "apiKey",
                company_api_key as "companyApiKey",
                integration_id as "integrationId",
                active,
                updated_at as "updatedAt"
         from fiscal_provider_configs
         where organization_id = $1
           and provider = $2
         limit 1`,
        [organizationId, provider],
      )
    })

    response.json(result.rows[0] ?? null)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/provider-config', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const data = providerConfigSchema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return client.query(
        `insert into fiscal_provider_configs
          (
            organization_id,
            provider,
            environment,
            api_base_url,
            api_key,
            company_api_key,
            integration_id,
            active
          )
         values
          (
            $1,
            $2,
            $3,
            $4,
            $5,
            $6,
            $7,
            $8
          )
         on conflict (organization_id, provider)
         do update
            set environment = excluded.environment,
                api_base_url = excluded.api_base_url,
                api_key = excluded.api_key,
                company_api_key = excluded.company_api_key,
                integration_id = excluded.integration_id,
                active = excluded.active,
                updated_at = now()
         returning id,
                   provider::text as provider,
                   environment::text as environment,
                   api_base_url as "apiBaseUrl",
                   api_key as "apiKey",
                   company_api_key as "companyApiKey",
                   integration_id as "integrationId",
                   active,
                   updated_at as "updatedAt"`,
        [
          organizationId,
          data.provider ?? 'plugnotas',
          data.environment ?? 'homologation',
          normalizeOptionalBodyText(data.apiBaseUrl),
          normalizeOptionalBodyText(data.apiKey),
          normalizeOptionalBodyText(data.companyApiKey),
          normalizeOptionalBodyText(data.integrationId),
          data.active ?? true,
        ],
      )
    })

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/documents', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const status = normalizeOptionalQueryValue(request.query.status)
    const docType = normalizeOptionalQueryValue(request.query.docType)
    const query = normalizeOptionalQueryValue(request.query.query)
    const likeQuery = `%${query}%`
    const { limit, offset } = parseLimitOffset(request.query as Record<string, unknown>, {
      limit: 20,
      maxLimit: 100,
    })

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const countResult = await client.query<{ total: number }>(
        `select count(*)::int as total
         from fiscal_documents fd
         left join fiscal_document_parties recipient
           on recipient.organization_id = fd.organization_id
          and recipient.document_id = fd.id
          and recipient.role = 'recipient'
         where fd.organization_id = $1
           and ($2 = '' or fd.status::text = $2)
           and ($3 = '' or fd.doc_type::text = $3)
           and (
             $4 = ''
             or coalesce(fd.access_key, '') ilike $5
             or coalesce(fd.number::text, '') ilike $5
             or coalesce(recipient.name, '') ilike $5
           )`,
        [organizationId, status, docType, query, likeQuery],
      )

      const rowsResult = await client.query(
        `select fd.id,
                fd.invoice_id as "invoiceId",
                fd.emitter_id as "emitterId",
                fd.doc_type::text as "docType",
                fd.status::text as status,
                fd.environment::text as environment,
                fd.series,
                fd.number,
                fd.access_key as "accessKey",
                fd.issue_date as "issueDate",
                fd.total_invoice as "totalInvoice",
                fd.created_at as "createdAt",
                recipient.name as "recipientName",
                emitter.name as "emitterName",
                lt.id as "transmissionId",
                lt.status as "transmissionStatus",
                lt.provider as "transmissionProvider",
                lt.provider_reference as "transmissionProviderReference",
                lt.response_code as "transmissionResponseCode",
                lt.response_message as "transmissionResponseMessage",
                lt.updated_at as "transmissionUpdatedAt"
         from fiscal_documents fd
         left join fiscal_document_parties recipient
           on recipient.organization_id = fd.organization_id
          and recipient.document_id = fd.id
          and recipient.role = 'recipient'
         left join fiscal_emitters emitter
           on emitter.organization_id = fd.organization_id
          and emitter.id = fd.emitter_id
         left join lateral (
           select ft.id,
                  ft.status::text as status,
                  ft.provider::text as provider,
                  ft.provider_reference,
                  ft.response_code,
                  ft.response_message,
                  ft.updated_at
           from fiscal_transmissions ft
           where ft.organization_id = fd.organization_id
             and ft.document_id = fd.id
           order by ft.updated_at desc
           limit 1
         ) lt on true
         where fd.organization_id = $1
           and ($2 = '' or fd.status::text = $2)
           and ($3 = '' or fd.doc_type::text = $3)
           and (
             $4 = ''
             or coalesce(fd.access_key, '') ilike $5
             or coalesce(fd.number::text, '') ilike $5
             or coalesce(recipient.name, '') ilike $5
           )
         order by coalesce(fd.issue_date, fd.created_at) desc, fd.created_at desc
         limit $6
         offset $7`,
        [organizationId, status, docType, query, likeQuery, limit, offset],
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

router.get('/profiles', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return client.query(
        `select id, name, profile_type, created_at
         from fiscal_tax_profiles
         where organization_id = $1
         order by created_at desc`,
        [organizationId],
      )
    })

    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/profiles', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const data = profileSchema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return client.query(
        `insert into fiscal_tax_profiles (organization_id, name, profile_type)
         values ($1, $2, $3)
         returning id, name, profile_type, created_at`,
        [organizationId, data.name, data.profileType ?? 'default'],
      )
    })

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/rules', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const profileId = request.query.profileId
    if (typeof profileId !== 'string') {
      response.status(400).json({ error: 'profileId é obrigatório.' })
      return
    }

    const result = await withOrgRead(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return client.query(
        `select id, profile_id, tax_type, rate, base_reduction, st_margin, cst, csosn, cfop,
                origin_state, destination_state, created_at
         from fiscal_tax_rules
         where organization_id = $1 and profile_id = $2
         order by created_at desc`,
        [organizationId, profileId],
      )
    })

    response.json(result.rows)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/rules', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const data = ruleSchema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return client.query(
        `insert into fiscal_tax_rules
          (organization_id, profile_id, tax_type, rate, base_reduction, st_margin, cst, csosn, cfop, origin_state, destination_state)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         returning id, profile_id, tax_type, rate, base_reduction, st_margin, cst, csosn, cfop, origin_state, destination_state, created_at`,
        [
          organizationId,
          data.profileId,
          data.taxType,
          data.rate,
          data.baseReduction ?? 0,
          data.stMargin ?? 0,
          data.cst ?? null,
          data.csosn ?? null,
          data.cfop ?? null,
          data.originState ?? null,
          data.destinationState ?? null,
        ],
      )
    })

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

const draftSchema = z.object({
  emitterId: z.uuid().optional(),
  customerId: z.uuid(),
  profileId: z.uuid(),
  originState: z.string().optional(),
  destinationState: z.string().optional(),
  docType: z.enum(['nfe', 'nfce']),
  environment: z.enum(['production', 'homologation']).optional(),
  items: z.array(
    z.object({
      product_id: z.uuid().optional(),
      description: z.string().min(1),
      quantity: z.number().positive(),
      unit_price: z.number().nonnegative(),
      ncm: z.string().optional(),
      cfop: z.string().optional(),
      uom: z.string().optional(),
    }),
  ),
})

router.post('/nfe/draft', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const data = draftSchema.parse({ ...request.body, docType: 'nfe' })

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return emitirNfeDraft(client, {
        organizationId,
        emitterId: data.emitterId ?? null,
        customerId: data.customerId,
        profileId: data.profileId,
        originState: data.originState ?? null,
        destinationState: data.destinationState ?? null,
        docType: 'nfe',
        environment: data.environment ?? 'homologation',
        items: data.items,
      })
    })

    response.status(201).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/nfce/draft', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const data = draftSchema.parse({ ...request.body, docType: 'nfce' })

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return emitirNfeDraft(client, {
        organizationId,
        emitterId: data.emitterId ?? null,
        customerId: data.customerId,
        profileId: data.profileId,
        originState: data.originState ?? null,
        destinationState: data.destinationState ?? null,
        docType: 'nfce',
        environment: data.environment ?? 'homologation',
        items: data.items,
      })
    })

    response.status(201).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/xml/import', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const schema = z.object({
      xml: z.string().min(1),
      warehouseId: z.uuid().optional(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      return importarXmlCompra(client, {
        organizationId,
        xml: data.xml,
        warehouseId: data.warehouseId ?? null,
      })
    })

    response.status(201).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/taxes/calculate', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const schema = z.object({
      profileId: z.uuid(),
      originState: z.string().optional(),
      destinationState: z.string().optional(),
      items: z.array(
        z.object({
          id: z.uuid(),
          total_price: z.number().nonnegative(),
          cfop: z.string().optional(),
        }),
      ),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)
      const rulesResult = await client.query(
        `select tax_type, rate, base_reduction, st_margin, cst, csosn, cfop, origin_state, destination_state
         from fiscal_tax_rules
         where organization_id = $1
           and profile_id = $2
           and (origin_state = $3 or origin_state is null)
           and (destination_state = $4 or destination_state is null)`,
        [organizationId, data.profileId, data.originState ?? null, data.destinationState ?? null],
      )

      const rules = rulesResult.rows as TaxRule[]
      return calculateTaxes(data.items, rules)
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

// ===== Carta de Correção (CC-e) =====
router.post('/documents/:id/cce', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const schema = z.object({ correction: z.string().min(15).max(1000) })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const docResult = await client.query(
        `SELECT id, status FROM fiscal_documents WHERE id = $1 AND organization_id = $2`,
        [request.params.id, organizationId],
      )
      if (docResult.rows.length === 0) throw new Error('Documento não encontrado.')
      if (docResult.rows[0].status !== 'authorized') throw new Error('Apenas documentos autorizados podem receber CC-e.')

      const eventResult = await client.query(
        `INSERT INTO fiscal_events (organization_id, document_id, event_type, xml)
         VALUES ($1, $2, 'cce', $3)
         RETURNING id`,
        [organizationId, request.params.id, data.correction],
      )

      return { eventId: eventResult.rows[0].id, documentId: request.params.id }
    })

    response.status(201).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

// ===== Cancelamento de NF-e =====
router.post('/documents/:id/cancel', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const schema = z.object({ justification: z.string().min(15).max(255) })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const docResult = await client.query(
        `SELECT id, status FROM fiscal_documents WHERE id = $1 AND organization_id = $2`,
        [request.params.id, organizationId],
      )
      if (docResult.rows.length === 0) throw new Error('Documento não encontrado.')
      if (docResult.rows[0].status !== 'authorized') throw new Error('Apenas documentos autorizados podem ser cancelados.')

      await client.query(
        `UPDATE fiscal_documents SET status = 'cancelled' WHERE id = $1 AND organization_id = $2`,
        [request.params.id, organizationId],
      )

      const eventResult = await client.query(
        `INSERT INTO fiscal_events (organization_id, document_id, event_type, xml)
         VALUES ($1, $2, 'cancelamento', $3)
         RETURNING id`,
        [organizationId, request.params.id, data.justification],
      )

      return { eventId: eventResult.rows[0].id, documentId: request.params.id }
    })

    response.status(201).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

// ===== Manifestação do Destinatário =====
router.post('/documents/:id/manifest', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const user = await getAuthUser(request.header('authorization'))
    const schema = z.object({
      eventType: z.enum(['confirmacao', 'ciencia', 'desconhecimento', 'nao_realizada']),
      justification: z.string().optional(),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, async (client) => {
      await assertOrgMember(client, organizationId, user.id)

      const docResult = await client.query(
        `SELECT id FROM fiscal_documents WHERE id = $1 AND organization_id = $2`,
        [request.params.id, organizationId],
      )
      if (docResult.rows.length === 0) throw new Error('Documento não encontrado.')

      const eventResult = await client.query(
        `INSERT INTO fiscal_events (organization_id, document_id, event_type, xml)
         VALUES ($1, $2, 'manifestacao', $3)
         RETURNING id`,
        [organizationId, request.params.id, JSON.stringify({ type: data.eventType, justification: data.justification })],
      )

      return { eventId: eventResult.rows[0].id, documentId: request.params.id }
    })

    response.status(201).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

// ===== Eventos fiscais de um documento =====
router.get('/documents/:id/events', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)

    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `SELECT id, event_type AS "eventType", protocol, xml, created_at AS "createdAt"
         FROM fiscal_events
         WHERE document_id = $1 AND organization_id = $2
         ORDER BY created_at DESC`,
        [request.params.id, organizationId],
      )
      return rows.rows
    })

    response.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

export { router as fiscalRoutes }
