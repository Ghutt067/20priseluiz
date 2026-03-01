import type { Request } from 'express'
import { z } from 'zod'

const orgIdSchema = z.string().uuid()

export function getOrganizationId(request: Request) {
  const headerOrgId = request.header('x-organization-id')
  const envOrgId = process.env.APP_ORG_ID
  const orgId = headerOrgId ?? envOrgId

  if (!orgId) {
    throw new Error('x-organization-id header or APP_ORG_ID is required.')
  }

  return orgIdSchema.parse(orgId)
}
