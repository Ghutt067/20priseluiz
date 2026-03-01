import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'

type MutationResult<T> = {
  status: number
  body: T
}

type IdempotentMutationArgs<T> = {
  client: PoolClient
  organizationId: string
  actorUserId: string
  operation: string
  idempotencyKey?: string | null
  requestBody: unknown
  execute: () => Promise<MutationResult<T>>
}

type AuditLogEntry = {
  client: PoolClient
  organizationId: string
  actorUserId?: string | null
  operation: string
  tableName: string
  recordId?: string | null
  oldData?: unknown
  newData?: unknown
  metadata?: unknown
}

export type MutationOutcome<T> = MutationResult<T> & {
  replayed: boolean
}

function isPgErrorWithCode(error: unknown, code: string) {
  if (typeof error !== 'object' || error === null) return false
  return 'code' in error && (error as { code?: string }).code === code
}

function isMissingIdempotencyTable(error: unknown) {
  if (!isPgErrorWithCode(error, '42P01')) return false
  if (typeof error !== 'object' || error === null) return false
  const message =
    'message' in error && typeof (error as { message?: unknown }).message === 'string'
      ? (error as { message: string }).message
      : ''
  return message.includes('request_idempotency')
}

function normalizeIdempotencyKey(value?: string | null): string | null {
  if (!value) return null
  const normalized = value.trim()
  if (!normalized) return null
  if (normalized.length > 128) {
    throw new Error('Idempotency-Key deve ter no máximo 128 caracteres.')
  }
  return normalized
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'symbol') return JSON.stringify(value.description ?? 'symbol')
  if (typeof value === 'function') return JSON.stringify('[function]')
  if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(',')}}`
  }
  return 'null'
}

function requestHash(payload: unknown) {
  return createHash('sha256').update(stableSerialize(payload)).digest('hex')
}

function toJson(value: unknown) {
  if (value === undefined) return null
  return JSON.stringify(value)
}

export async function runIdempotentMutation<T>(
  args: IdempotentMutationArgs<T>,
): Promise<MutationOutcome<T>> {
  const {
    client,
    organizationId,
    actorUserId,
    operation,
    idempotencyKey,
    requestBody,
    execute,
  } = args

  const normalizedKey = normalizeIdempotencyKey(idempotencyKey)
  if (!normalizedKey) {
    const result = await execute()
    return { ...result, replayed: false }
  }

  const hash = requestHash(requestBody)

  try {
    await client.query(`select pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [
      operation,
      `${organizationId}:${actorUserId}:${normalizedKey}`,
    ])

    const existingResult = await client.query(
      `select request_hash, response_status, response_body
       from request_idempotency
       where organization_id = $1
         and actor_user_id = $2
         and operation = $3
         and idempotency_key = $4
       limit 1
       for update`,
      [organizationId, actorUserId, operation, normalizedKey],
    )

    if ((existingResult.rowCount ?? 0) > 0) {
      const existing = existingResult.rows[0] as {
        request_hash: string
        response_status: number
        response_body: T
      }

      if (existing.request_hash !== hash) {
        throw new Error('Idempotency-Key já foi usada com um payload diferente.')
      }

      return {
        status: Number(existing.response_status ?? 200),
        body: existing.response_body,
        replayed: true,
      }
    }
  } catch (error) {
    if (isMissingIdempotencyTable(error)) {
      const result = await execute()
      return { ...result, replayed: false }
    }
    throw error
  }

  const result = await execute()

  try {
    await client.query(
      `insert into request_idempotency
         (organization_id, actor_user_id, operation, idempotency_key, request_hash, response_status, response_body)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        organizationId,
        actorUserId,
        operation,
        normalizedKey,
        hash,
        result.status,
        JSON.stringify(result.body),
      ],
    )
  } catch (error) {
    if (!isMissingIdempotencyTable(error)) {
      throw error
    }
  }

  return { ...result, replayed: false }
}

export async function recordAuditLog(entry: AuditLogEntry) {
  try {
    await entry.client.query(
      `insert into audit_log
        (organization_id, actor_user_id, operation, table_name, record_id, old_data, new_data, metadata)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)`,
      [
        entry.organizationId,
        entry.actorUserId ?? null,
        entry.operation,
        entry.tableName,
        entry.recordId ?? null,
        toJson(entry.oldData),
        toJson(entry.newData),
        toJson(entry.metadata),
      ],
    )
  } catch (error) {
    if (isPgErrorWithCode(error, '42P01')) {
      return
    }
    throw error
  }
}
