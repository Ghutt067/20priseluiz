import type { PoolClient } from 'pg'
import { calculateTaxes, type TaxRule } from '../../domain/taxes/calculateTaxes'

type DraftItemInput = {
  product_id?: string | null
  description: string
  quantity: number
  unit_price: number
  ncm?: string | null
  cfop?: string | null
  uom?: string | null
}

type EmitirNfeDraftInput = {
  organizationId: string
  emitterId?: string | null
  customerId: string
  profileId: string
  originState?: string | null
  destinationState?: string | null
  docType: 'nfe' | 'nfce'
  environment?: 'production' | 'homologation'
  items: DraftItemInput[]
}

function buildNfeXml(payload: {
  docType: string
  environment: string
  emitter: { name: string; cnpj?: string | null }
  recipient: { name: string; cpf_cnpj?: string | null }
  totals: { total_products: number; total_taxes: number; total_invoice: number }
}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<NFe>
  <infNFe versao="4.00">
    <ide>
      <mod>${payload.docType === 'nfce' ? '65' : '55'}</mod>
      <tpAmb>${payload.environment === 'production' ? '1' : '2'}</tpAmb>
    </ide>
    <emit>
      <xNome>${payload.emitter.name}</xNome>
      ${payload.emitter.cnpj ? `<CNPJ>${payload.emitter.cnpj}</CNPJ>` : ''}
    </emit>
    <dest>
      <xNome>${payload.recipient.name}</xNome>
      ${payload.recipient.cpf_cnpj ? `<CPF>${payload.recipient.cpf_cnpj}</CPF>` : ''}
    </dest>
    <total>
      <ICMSTot>
        <vProd>${payload.totals.total_products.toFixed(2)}</vProd>
        <vTotTrib>${payload.totals.total_taxes.toFixed(2)}</vTotTrib>
        <vNF>${payload.totals.total_invoice.toFixed(2)}</vNF>
      </ICMSTot>
    </total>
  </infNFe>
</NFe>`
}

export async function emitirNfeDraft(client: PoolClient, input: EmitirNfeDraftInput) {
  const organizationResult = await client.query(
    'select id, name, legal_name, cnpj, ie, im, tax_regime from organizations where id = $1',
    [input.organizationId],
  )

  if (organizationResult.rowCount === 0) {
    throw new Error('Organizacao nao encontrada.')
  }

  const organization = organizationResult.rows[0]

  const emitterResult = input.emitterId
    ? await client.query(
      `select id,
              name,
              legal_name,
              cnpj,
              ie,
              im,
              tax_regime
       from fiscal_emitters
       where organization_id = $1
         and id = $2
       limit 1`,
      [input.organizationId, input.emitterId],
    )
    : await client.query(
      `select id,
              name,
              legal_name,
              cnpj,
              ie,
              im,
              tax_regime
       from fiscal_emitters
       where organization_id = $1
         and is_default = true
       order by updated_at desc
       limit 1`,
      [input.organizationId],
    )

  if (input.emitterId && (emitterResult.rowCount ?? 0) === 0) {
    throw new Error('Emitente fiscal não encontrado para a organização informada.')
  }

  const emitter =
    (emitterResult.rows[0] as
      | {
        id?: string
        name?: string | null
        legal_name?: string | null
        cnpj?: string | null
        ie?: string | null
        im?: string | null
        tax_regime?: string | null
      }
      | undefined)
    ?? {
      id: null,
      name: organization.name as string,
      legal_name: (organization.legal_name as string | null) ?? null,
      cnpj: (organization.cnpj as string | null) ?? null,
      ie: (organization.ie as string | null) ?? null,
      im: (organization.im as string | null) ?? null,
      tax_regime: (organization.tax_regime as string | null) ?? null,
    }

  const customerResult = await client.query(
    `select id, name, legal_name, cpf_cnpj, ie
     from customers
     where organization_id = $1
       and id = $2`,
    [input.organizationId, input.customerId],
  )

  if (customerResult.rowCount === 0) {
    throw new Error('Cliente nao encontrado.')
  }

  const customer = customerResult.rows[0]

  const items = input.items.map((item) => ({
    ...item,
    total_price: Number((item.quantity * item.unit_price).toFixed(2)),
  }))

  const rulesResult = await client.query(
    `select tax_type, rate, base_reduction, st_margin, cst, csosn, cfop, origin_state, destination_state
     from fiscal_tax_rules
     where organization_id = $1
       and profile_id = $2
       and (origin_state = $3 or origin_state is null)
       and (destination_state = $4 or destination_state is null)`,
    [input.organizationId, input.profileId, input.originState ?? null, input.destinationState ?? null],
  )

  const rules = rulesResult.rows as TaxRule[]

  const documentResult = await client.query(
    `insert into fiscal_documents
      (organization_id, emitter_id, doc_type, environment, status, issue_date)
     values ($1, $2, $3, $4, 'draft', now())
     returning id`,
    [
      input.organizationId,
      (emitter.id as string | null) ?? null,
      input.docType,
      input.environment ?? 'homologation',
    ],
  )

  const documentId = documentResult.rows[0].id as string

  await client.query(
    `insert into fiscal_document_parties
      (organization_id, document_id, role, name, legal_name, cpf_cnpj, ie, im)
     values ($1, $2, 'emitter', $3, $4, $5, $6, $7)`,
    [
      input.organizationId,
      documentId,
      (emitter.legal_name as string | null) ?? (emitter.name as string),
      (emitter.legal_name as string | null) ?? null,
      (emitter.cnpj as string | null) ?? null,
      (emitter.ie as string | null) ?? null,
      (emitter.im as string | null) ?? null,
    ],
  )

  await client.query(
    `insert into fiscal_document_parties
      (organization_id, document_id, role, name, legal_name, cpf_cnpj, ie)
     values ($1, $2, 'recipient', $3, $4, $5, $6)`,
    [
      input.organizationId,
      documentId,
      customer.legal_name ?? customer.name,
      customer.legal_name,
      customer.cpf_cnpj,
      customer.ie,
    ],
  )

  const itemIds: { id: string; total_price: number; cfop?: string | null }[] = []

  for (const item of items) {
    const itemResult = await client.query(
      `insert into fiscal_document_items
        (organization_id, document_id, product_id, description, quantity, unit_price, total_price, ncm, cfop, uom)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       returning id`,
      [
        input.organizationId,
        documentId,
        item.product_id ?? null,
        item.description,
        item.quantity,
        item.unit_price,
        item.total_price,
        item.ncm ?? null,
        item.cfop ?? null,
        item.uom ?? null,
      ],
    )

    itemIds.push({
      id: itemResult.rows[0].id as string,
      total_price: item.total_price,
      cfop: item.cfop ?? null,
    })
  }

  const taxResult = calculateTaxes(itemIds, rules)

  await client.query(
    `insert into fiscal_tax_calculations
      (organization_id, document_id, profile_id, tax_regime, total_products, total_taxes, total_invoice)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.organizationId,
      documentId,
      input.profileId,
      (emitter.tax_regime as string | null) ?? (organization.tax_regime as string),
      taxResult.total_products,
      taxResult.total_taxes,
      taxResult.total_invoice,
    ],
  )

  for (const line of taxResult.lines) {
    await client.query(
      `insert into fiscal_tax_lines
        (organization_id, document_id, document_item_id, tax_type, base_value, rate, amount, cst, csosn)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.organizationId,
        documentId,
        line.document_item_id,
        line.tax_type,
        line.base_value,
        line.rate,
        line.amount,
        line.cst ?? null,
        line.csosn ?? null,
      ],
    )
  }

  const xml = buildNfeXml({
    docType: input.docType,
    environment: input.environment ?? 'homologation',
    emitter: {
      name: ((emitter.legal_name as string | null) ?? (emitter.name as string)) || 'Emitente',
      cnpj: (emitter.cnpj as string | null) ?? null,
    },
    recipient: {
      name: customer.legal_name ?? customer.name,
      cpf_cnpj: customer.cpf_cnpj,
    },
    totals: taxResult,
  })

  await client.query(
    `update fiscal_documents
     set xml = $1,
         total_products = $2,
         total_taxes = $3,
         total_invoice = $4,
         updated_at = now()
     where id = $5`,
    [
      xml,
      taxResult.total_products,
      taxResult.total_taxes,
      taxResult.total_invoice,
      documentId,
    ],
  )

  return {
    documentId,
    xml,
    totals: taxResult,
  }
}
