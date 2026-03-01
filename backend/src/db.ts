import { Pool, type PoolClient } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

const databaseUrl = process.env.DATABASE_URL

if (!databaseUrl) {
  throw new Error('DATABASE_URL is missing. Check backend/.env')
}

export const pool = new Pool({
  connectionString: databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
})

/**
 * Read-only helper: sets org context in a lightweight READ ONLY transaction.
 * Uses a single BEGIN READ ONLY + set_config instead of full read-write transaction.
 */
export async function withOrgRead<T>(
  organizationId: string,
  fn: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect()
  try {
    await client.query('begin read only')
    await client.query('select set_config($1, $2, true)', [
      'app.organization_id',
      organizationId,
    ])
    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}

/**
 * Read-write transaction helper: sets org context in a full transaction with rollback support.
 */
export async function withOrgTransaction<T>(
  organizationId: string,
  fn: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect()

  try {
    await client.query('begin')
    await client.query('select set_config($1, $2, true)', [
      'app.organization_id',
      organizationId,
    ])

    const result = await fn(client)
    await client.query('commit')
    return result
  } catch (error) {
    await client.query('rollback')
    throw error
  } finally {
    client.release()
  }
}
