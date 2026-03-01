import { Router } from 'express'
import { z } from 'zod'
import { withOrgRead, withOrgTransaction } from '../db'
import { getOrganizationId } from './getOrganizationId'

const router = Router()

router.get('/sintegra/exports', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select id, period_start as "periodStart", period_end as "periodEnd",
                status, generated_at as "generatedAt", created_at as "createdAt"
         from sintegra_exports where organization_id = $1
         order by created_at desc limit 20`,
        [organizationId],
      )
      return rows.rows
    })
    response.json(result)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

router.post('/sintegra/exports', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const schema = z.object({
      periodStart: z.string().min(1),
      periodEnd: z.string().min(1),
    })
    const data = schema.parse(request.body)

    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `insert into sintegra_exports
          (organization_id, period_start, period_end, status)
         values ($1, $2::date, $3::date, 'draft')
         returning id`,
        [organizationId, data.periodStart, data.periodEnd],
      ),
    )

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/sintegra/exports/:id/generate', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgTransaction(organizationId, (client) =>
      client.query(
        `update sintegra_exports
         set status = 'generated',
             generated_at = now(),
             file_text = coalesce(file_text, '')
         where id = $1
         returning id`,
        [request.params.id],
      ),
    )

    response.status(201).json(result.rows[0])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/sintegra/exports/:id/download', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)
    const result = await withOrgRead(organizationId, async (client) => {
      const rows = await client.query(
        `select file_text as "fileText", period_start as "periodStart", period_end as "periodEnd"
         from sintegra_exports where organization_id = $1 and id = $2`,
        [organizationId, request.params.id],
      )
      if (rows.rows.length === 0) throw new Error('Exportação não encontrada.')
      return rows.rows[0] as { fileText: string | null; periodStart: string; periodEnd: string }
    })

    if (!result.fileText) throw new Error('Arquivo ainda não foi gerado.')

    response.setHeader('Content-Type', 'text/plain; charset=utf-8')
    response.setHeader('Content-Disposition', `attachment; filename="sintegra_${result.periodStart}_${result.periodEnd}.txt"`)
    response.send(result.fileText)
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : 'Erro inesperado.' })
  }
})

export { router as sintegraRoutes }
