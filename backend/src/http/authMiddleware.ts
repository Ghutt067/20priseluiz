import type { PoolClient } from 'pg'
import type { User } from '@supabase/supabase-js'
import { supabaseAdmin } from '../supabaseAdmin'

const AUTH_CACHE_TTL_MS = 60_000
const authCache = new Map<string, { user: User; expiresAt: number }>()

export async function getAuthUser(authorizationHeader?: string | null) {
  if (!authorizationHeader) {
    throw new Error('Authorization header is required.')
  }

  const token = authorizationHeader.replace('Bearer ', '').trim()
  if (!token) {
    throw new Error('Authorization token is required.')
  }

  const cached = authCache.get(token)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.user
  }

  const { data, error } = await supabaseAdmin.auth.getUser(token)
  if (error || !data.user) {
    authCache.delete(token)
    throw new Error('Invalid auth token.')
  }

  authCache.set(token, { user: data.user, expiresAt: Date.now() + AUTH_CACHE_TTL_MS })

  if (authCache.size > 500) {
    const now = Date.now()
    for (const [k, v] of authCache) {
      if (v.expiresAt <= now) authCache.delete(k)
    }
  }

  return data.user
}

export async function assertOrgMember(client: PoolClient, organizationId: string, userId: string) {
  const memberResult = await client.query<{ role: string }>(
    `select role
     from organization_users
     where organization_id = $1
       and user_id = $2
     limit 1`,
    [organizationId, userId],
  )

  if ((memberResult.rowCount ?? 0) === 0) {
    throw new Error('Usuário autenticado sem acesso à organização informada.')
  }

  return { role: memberResult.rows[0].role }
}
