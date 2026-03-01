import type { PoolClient } from 'pg'

type OfxTransaction = {
  fitId?: string | null
  postedAt?: string | null
  amount: number
  memo?: string | null
  name?: string | null
}

type ImportOfxInput = {
  organizationId: string
  accountId?: string | null
  rawText: string
}

function normalizeText(value?: string | null) {
  const normalizedSpaces = (value ?? '')
    .replaceAll('\r', ' ')
    .replaceAll('\n', ' ')
    .replaceAll('\t', ' ')
    .replaceAll('\f', ' ')
    .replaceAll('\v', ' ')
    .trim()
    .toLowerCase()

  if (!normalizedSpaces) return ''

  return normalizedSpaces
    .split(' ')
    .filter((part) => part.length > 0)
    .join(' ')
}

async function isDuplicateBankTransaction(
  client: PoolClient,
  input: {
    organizationId: string
    accountId: string | null
    fitId: string | null
    direction: 'in' | 'out'
    amount: number
    postedAt: string | null
    description: string
  },
) {
  if (input.fitId) {
    const byExternalRef = await client.query(
      `select 1
       from bank_transactions bt
       where bt.organization_id = $1
         and bt.account_id is not distinct from $2::uuid
         and bt.external_ref = $3
       limit 1`,
      [input.organizationId, input.accountId, input.fitId],
    )
    return (byExternalRef.rowCount ?? 0) > 0
  }

  const normalizedDescription = normalizeText(input.description)

  const byFingerprint = await client.query<{ description: string | null }>(
    `select bt.description
     from bank_transactions bt
     where bt.organization_id = $1
       and bt.account_id is not distinct from $2::uuid
       and bt.direction::text = $3
       and abs(bt.amount - $4::numeric) <= 0.01
       and ($5::date is null or bt.occurred_at::date = $5::date)
     limit 50`,
    [input.organizationId, input.accountId, input.direction, input.amount, input.postedAt],
  )

  return byFingerprint.rows.some((row) => normalizeText(row.description) === normalizedDescription)
}

function parseTag(block: string, tag: string) {
  const pattern = new RegExp(String.raw`<${tag}>([^<\r\n]+)`, 'i')
  const match = pattern.exec(block)
  return match?.[1]?.trim() ?? null
}

function parseOfx(text: string): OfxTransaction[] {
  const statements = text.split(/<STMTTRN>/i).slice(1)

  return statements.map((statement) => {
    const amount = Number(parseTag(statement, 'TRNAMT') ?? 0)
    const rawDate = parseTag(statement, 'DTPOSTED')
    const postedAt = rawDate
      ? `${rawDate.substring(0, 4)}-${rawDate.substring(4, 6)}-${rawDate.substring(6, 8)}`
      : null

    return {
      fitId: parseTag(statement, 'FITID'),
      postedAt,
      amount,
      memo: parseTag(statement, 'MEMO'),
      name: parseTag(statement, 'NAME'),
    }
  })
}

export async function importOfx(client: PoolClient, input: ImportOfxInput) {
  const importResult = await client.query(
    `insert into ofx_imports
      (organization_id, account_id, status, raw_text)
     values ($1, $2, 'processed', $3)
     returning id`,
    [input.organizationId, input.accountId ?? null, input.rawText],
  )

  const importId = importResult.rows[0].id as string
  const transactions = parseOfx(input.rawText)
  let importedCount = 0
  let ignoredCount = 0

  for (const transaction of transactions) {
    const direction = transaction.amount >= 0 ? 'in' : 'out'
    const absoluteAmount = Math.abs(transaction.amount)
    const description = transaction.memo ?? transaction.name ?? 'OFX'

    await client.query(
      `insert into ofx_transactions
        (organization_id, import_id, account_id, fit_id, posted_at, amount, memo, name)
       values ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8)`,
      [
        input.organizationId,
        importId,
        input.accountId ?? null,
        transaction.fitId ?? null,
        transaction.postedAt ?? null,
        transaction.amount,
        transaction.memo ?? null,
        transaction.name ?? null,
      ],
    )

    const duplicated = await isDuplicateBankTransaction(client, {
      organizationId: input.organizationId,
      accountId: input.accountId ?? null,
      fitId: transaction.fitId ?? null,
      direction,
      amount: absoluteAmount,
      postedAt: transaction.postedAt ?? null,
      description,
    })

    if (duplicated) {
      ignoredCount += 1
      continue
    }

    await client.query(
      `insert into bank_transactions
        (organization_id, account_id, direction, amount, description, external_ref, occurred_at, status)
       values ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now()), 'pending')`,
      [
        input.organizationId,
        input.accountId ?? null,
        direction,
        absoluteAmount,
        description,
        transaction.fitId ?? null,
        transaction.postedAt ?? null,
      ],
    )

    importedCount += 1
  }

  return {
    importId,
    totalCount: transactions.length,
    importedCount,
    ignoredCount,
  }
}
