import { Router } from 'express'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { getOrganizationId } from './getOrganizationId'
import { getAuthUser } from './authMiddleware'

const router = Router()

router.get('/settings', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select id, name, legal_name as "legalName", cnpj, ie, im,
                tax_regime as "taxRegime", logo_url as "logoUrl",
                phone, email, website,
                address_street as "addressStreet", address_number as "addressNumber",
                address_complement as "addressComplement", address_neighborhood as "addressNeighborhood",
                address_city as "addressCity", address_state as "addressState", address_zip as "addressZip",
                settings
         from organizations where id = $1`,
        [organizationId],
      )
      return rows.rows[0] ?? null
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.put('/settings', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    await getAuthUser(request.header('authorization'))

    const schema = z.object({
      name: z.string().min(1).optional(),
      legalName: z.string().optional(),
      cnpj: z.string().optional(),
      ie: z.string().optional(),
      im: z.string().optional(),
      taxRegime: z.enum(['simples_nacional', 'lucro_presumido', 'lucro_real', 'mei']).optional(),
      logoUrl: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().optional(),
      website: z.string().optional(),
      addressStreet: z.string().optional(),
      addressNumber: z.string().optional(),
      addressComplement: z.string().optional(),
      addressNeighborhood: z.string().optional(),
      addressCity: z.string().optional(),
      addressState: z.string().optional(),
      addressZip: z.string().optional(),
      settings: z.record(z.string(), z.unknown()).optional(),
    })
    const data = schema.parse(request.body)

    await withOrgTransaction(organizationId, async (client) => {
      await client.query(
        `update organizations set
           name = coalesce($2, name),
           legal_name = coalesce($3, legal_name),
           cnpj = coalesce($4, cnpj),
           ie = coalesce($5, ie),
           im = coalesce($6, im),
           tax_regime = coalesce($7::tax_regime, tax_regime),
           logo_url = coalesce($8, logo_url),
           phone = coalesce($9, phone),
           email = coalesce($10, email),
           website = coalesce($11, website),
           address_street = coalesce($12, address_street),
           address_number = coalesce($13, address_number),
           address_complement = coalesce($14, address_complement),
           address_neighborhood = coalesce($15, address_neighborhood),
           address_city = coalesce($16, address_city),
           address_state = coalesce($17, address_state),
           address_zip = coalesce($18, address_zip),
           settings = coalesce($19::jsonb, settings),
           updated_at = now()
         where id = $1`,
        [
          organizationId,
          data.name ?? null,
          data.legalName ?? null,
          data.cnpj ?? null,
          data.ie ?? null,
          data.im ?? null,
          data.taxRegime ?? null,
          data.logoUrl ?? null,
          data.phone ?? null,
          data.email ?? null,
          data.website ?? null,
          data.addressStreet ?? null,
          data.addressNumber ?? null,
          data.addressComplement ?? null,
          data.addressNeighborhood ?? null,
          data.addressCity ?? null,
          data.addressState ?? null,
          data.addressZip ?? null,
          data.settings ? JSON.stringify(data.settings) : null,
        ],
      )
    })
    response.json({ ok: true })
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

export { router as settingsRoutes }
