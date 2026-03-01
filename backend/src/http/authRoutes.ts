import { Router } from 'express'
import { z } from 'zod'
import { pool } from '../db'
import { supabaseAdmin } from '../supabaseAdmin'
import { getAuthUser } from './authMiddleware'

const router = Router()

const signupSchema = z.object({
  storeName: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(6),
})

const inviteSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  role: z.enum(['vendedor', 'estoquista', 'financeiro']),
})

router.post('/auth/signup-chefe', async (request, response) => {
  try {
    const payload = signupSchema.parse(request.body)

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: payload.email,
      password: payload.password,
      email_confirm: true,
    })

    if (error || !data.user) {
      throw new Error(error?.message ?? 'Falha ao criar usuário.')
    }

    const userId = data.user.id
    const client = await pool.connect()

    try {
      await client.query('begin')
      const orgResult = await client.query(
        'insert into organizations (name) values ($1) returning id',
        [payload.storeName],
      )
      const organizationId = orgResult.rows[0].id as string

      await client.query(
        `insert into profiles (id, email, full_name, organization_id, role)
         values ($1, $2, $3, $4, 'chefe')`,
        [userId, payload.email, payload.storeName, organizationId],
      )

      await client.query(
        `insert into organization_users (organization_id, user_id, role)
         values ($1, $2, 'chefe')`,
        [organizationId, userId],
      )

      await client.query('commit')
      response.status(201).json({ userId, organizationId })
    } catch (dbError) {
      await client.query('rollback')
      await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => null)
      throw dbError
    } finally {
      client.release()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.post('/team/invite', async (request, response) => {
  try {
    const payload = inviteSchema.parse(request.body)
    const user = await getAuthUser(request.header('authorization'))

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single()

    if (profileError || !profile?.organization_id) {
      throw new Error('Perfil do Chefe não encontrado.')
    }

    if (profile.role !== 'chefe') {
      return response.status(403).json({ error: 'Apenas Chefe pode adicionar funcionários.' })
    }

    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email: payload.email,
      password: payload.password,
      email_confirm: true,
    })

    if (error || !data.user) {
      throw new Error(error?.message ?? 'Falha ao criar usuário.')
    }

    const userId = data.user.id
    const client = await pool.connect()

    try {
      await client.query('begin')
      await client.query(
        `insert into profiles (id, email, organization_id, role)
         values ($1, $2, $3, $4)`,
        [userId, payload.email, profile.organization_id, payload.role],
      )
      await client.query(
        `insert into organization_users (organization_id, user_id, role)
         values ($1, $2, $3)`,
        [profile.organization_id, userId, payload.role],
      )
      await client.query('commit')
      response.status(201).json({ userId })
    } catch (dbError) {
      await client.query('rollback')
      await supabaseAdmin.auth.admin.deleteUser(userId).catch(() => null)
      throw dbError
    } finally {
      client.release()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

router.get('/team/members', async (request, response) => {
  try {
    const user = await getAuthUser(request.header('authorization'))

    const { data: profile, error: profileError } = await supabaseAdmin
      .from('profiles')
      .select('organization_id, role')
      .eq('id', user.id)
      .single()

    if (profileError || !profile?.organization_id) {
      throw new Error('Perfil não encontrado.')
    }

    const client = await pool.connect()
    try {
      const result = await client.query(
        `select p.id, p.email, p.full_name as "fullName", ou.role, ou.created_at as "joinedAt"
         from organization_users ou
         join profiles p on p.id = ou.user_id
         where ou.organization_id = $1
         order by ou.created_at asc`,
        [profile.organization_id],
      )
      response.json(result.rows)
    } finally {
      client.release()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

export { router as authRoutes }
