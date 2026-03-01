import type { PoolClient } from 'pg'

type InvoiceServiceOrderInput = {
  organizationId: string
  serviceOrderId: string
}

type ServiceOrderStatus = 'open' | 'in_progress' | 'completed' | 'cancelled'

type InvoiceServiceOrderResult = {
  serviceOrderId: string
  status: ServiceOrderStatus
  invoiceId: string
  fiscalDocumentId: string
  receivableTitleId: string
  invoicedAt: string
  reused: boolean
  previousStatus: ServiceOrderStatus
  previousInvoiceId: string | null
  previousFiscalDocumentId: string | null
  previousReceivableTitleId: string | null
  previousInvoicedAt: string | null
}

function toNumber(value: unknown) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function parseServiceOrderStatus(value: unknown): ServiceOrderStatus {
  const normalized = typeof value === 'string' ? value : ''
  if (
    normalized === 'open'
    || normalized === 'in_progress'
    || normalized === 'completed'
    || normalized === 'cancelled'
  ) {
    return normalized
  }
  throw new Error('Status atual da OS é inválido.')
}

function toIsoDateTime(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
    return value
  }
  return null
}

function billingDescriptionForServiceOrder(serviceOrderId: string) {
  return `Faturamento da OS ${serviceOrderId}`
}

async function consumeStockForProduct(params: {
  client: PoolClient
  organizationId: string
  warehouseId: string
  productId: string
  quantity: number
  description: string
}) {
  const { client, organizationId, warehouseId, productId, quantity, description } = params

  const stockRowsResult = await client.query(
    `select id, qty_available, qty_reserved
     from stock_levels
     where organization_id = $1
       and warehouse_id = $2
       and product_id = $3
     order by id asc
     for update`,
    [organizationId, warehouseId, productId],
  )

  const stockRows = stockRowsResult.rows.map((row) => ({
    id: row.id as string,
    qtyAvailable: toNumber(row.qty_available),
    qtyReserved: toNumber(row.qty_reserved),
  }))

  const totalAvailable = stockRows.reduce((sum, row) => sum + row.qtyAvailable, 0)
  if (totalAvailable + 0.0001 < quantity) {
    throw new Error(
      `Estoque indisponível para faturar "${description}". Disponível: ${totalAvailable.toFixed(4)} | Necessário: ${quantity.toFixed(4)}.`,
    )
  }

  let remaining = quantity

  for (const row of stockRows) {
    if (remaining <= 0) break
    if (row.qtyReserved <= 0) continue

    const consumeReserved = Math.min(row.qtyReserved, remaining)
    await client.query(
      `update stock_levels
       set qty_reserved = qty_reserved - $1,
           qty_available = qty_available - $1,
           updated_at = now()
       where id = $2`,
      [consumeReserved, row.id],
    )

    row.qtyReserved -= consumeReserved
    row.qtyAvailable -= consumeReserved
    remaining -= consumeReserved
  }

  for (const row of stockRows) {
    if (remaining <= 0) break

    const freeQty = Math.max(row.qtyAvailable - row.qtyReserved, 0)
    if (freeQty <= 0) continue

    const consumeFree = Math.min(freeQty, remaining)
    await client.query(
      `update stock_levels
       set qty_available = qty_available - $1,
           updated_at = now()
       where id = $2`,
      [consumeFree, row.id],
    )

    row.qtyAvailable -= consumeFree
    remaining -= consumeFree
  }

  if (remaining > 0.0001) {
    throw new Error(`Não foi possível consumir estoque para "${description}" no faturamento.`)
  }
}

export async function invoiceServiceOrder(
  client: PoolClient,
  input: InvoiceServiceOrderInput,
): Promise<InvoiceServiceOrderResult> {
  const orderResult = await client.query<{
    id: string
    status: string
    customerId: string | null
  }>(
    `select
       so.id,
       so.status::text as status,
       so.customer_id as "customerId"
     from service_orders so
     where so.organization_id = $1
       and so.id = $2
     limit 1
     for update`,
    [input.organizationId, input.serviceOrderId],
  )

  if ((orderResult.rowCount ?? 0) === 0) {
    throw new Error('Ordem de serviço não encontrada para a organização informada.')
  }

  const order = orderResult.rows[0]
  const currentStatus = parseServiceOrderStatus(order.status)
  if (currentStatus === 'cancelled') {
    throw new Error('Ordem de serviço cancelada não pode ser faturada.')
  }

  const billingDescription = billingDescriptionForServiceOrder(input.serviceOrderId)

  const existingBillingResult = await client.query<{
    invoiceId: string
    fiscalDocumentId: string | null
    receivableTitleId: string
    invoicedAt: string | Date | null
  }>(
    `select
       ft.invoice_id as "invoiceId",
       fd.id as "fiscalDocumentId",
       ft.id as "receivableTitleId",
       i.issued_at as "invoicedAt"
     from financial_titles ft
     join invoices i
       on i.id = ft.invoice_id
      and i.organization_id = ft.organization_id
     left join fiscal_documents fd
       on fd.organization_id = ft.organization_id
      and fd.invoice_id = ft.invoice_id
     where ft.organization_id = $1
       and ft.title_type = 'receivable'
       and ft.description = $2
       and ft.invoice_id is not null
     order by ft.created_at desc, fd.created_at desc
     limit 1`,
    [input.organizationId, billingDescription],
  )

  const previousBilling = existingBillingResult.rows[0]
  if (previousBilling?.invoiceId && previousBilling.receivableTitleId) {
    if (!previousBilling.fiscalDocumentId) {
      throw new Error('Faturamento existente da OS sem documento fiscal vinculado.')
    }

    const statusAfter =
      currentStatus === 'completed'
        ? currentStatus
        : await client
          .query<{ status: string }>(
            `update service_orders
             set status = 'completed',
                 updated_at = now()
             where organization_id = $1
               and id = $2
             returning status::text as status`,
            [input.organizationId, input.serviceOrderId],
          )
          .then((result) => parseServiceOrderStatus(result.rows[0]?.status))

    return {
      serviceOrderId: input.serviceOrderId,
      status: statusAfter,
      invoiceId: previousBilling.invoiceId,
      fiscalDocumentId: previousBilling.fiscalDocumentId,
      receivableTitleId: previousBilling.receivableTitleId,
      invoicedAt: toIsoDateTime(previousBilling.invoicedAt) ?? new Date().toISOString(),
      reused: true,
      previousStatus: currentStatus,
      previousInvoiceId: previousBilling.invoiceId,
      previousFiscalDocumentId: previousBilling.fiscalDocumentId,
      previousReceivableTitleId: previousBilling.receivableTitleId,
      previousInvoicedAt: toIsoDateTime(previousBilling.invoicedAt),
    }
  }

  const itemsResult = await client.query<{
    id: string
    productId: string | null
    productType: string | null
    description: string | null
    quantity: string | number
    unitPrice: string | number
    totalPrice: string | number
    ncm: string | null
    cfop: string | null
  }>(
    `select
       soi.id,
       soi.product_id as "productId",
       p.product_type::text as "productType",
       soi.description,
       soi.quantity,
       soi.unit_price as "unitPrice",
       soi.total_price as "totalPrice",
       p.ncm,
       p.cfop
     from service_order_items soi
     left join products p
       on p.id = soi.product_id
      and p.organization_id = soi.organization_id
     where soi.organization_id = $1
       and soi.service_order_id = $2
     order by soi.id asc`,
    [input.organizationId, input.serviceOrderId],
  )

  if ((itemsResult.rowCount ?? 0) === 0) {
    throw new Error('Ordem de serviço não possui itens para faturamento.')
  }

  const items = itemsResult.rows
  const totalAmount = Number(
    items.reduce((sum, item) => sum + toNumber(item.totalPrice), 0).toFixed(2),
  )

  const stockItems = items.filter((item) => item.productType === 'product')
  let stockWarehouseId: string | null = null

  if (stockItems.length > 0) {
    const warehouseResult = await client.query<{ id: string }>(
      `select id
       from warehouses
       where organization_id = $1
       order by created_at asc
       limit 1`,
      [input.organizationId],
    )

    if ((warehouseResult.rowCount ?? 0) === 0) {
      throw new Error('Não há depósito cadastrado para baixar estoque dos produtos da OS.')
    }

    stockWarehouseId = warehouseResult.rows[0]?.id ?? null
    if (!stockWarehouseId) {
      throw new Error('Não foi possível determinar o depósito para baixa de estoque.')
    }
  }

  for (const item of stockItems) {
    if (!stockWarehouseId) {
      throw new Error('Depósito de estoque inválido para faturamento da OS.')
    }
    if (!item.productId) {
      throw new Error('Item de produto sem referência de product_id no faturamento.')
    }

    await consumeStockForProduct({
      client,
      organizationId: input.organizationId,
      warehouseId: stockWarehouseId,
      productId: item.productId,
      quantity: toNumber(item.quantity),
      description: item.description ?? 'Item sem descrição',
    })

    await client.query(
      `insert into stock_movements
        (organization_id, product_id, warehouse_id, movement_type, quantity, reason, ref_table, ref_id)
       values ($1, $2, $3, 'out', $4, 'Faturamento OS', 'service_orders', $5)`,
      [
        input.organizationId,
        item.productId,
        stockWarehouseId,
        item.quantity,
        input.serviceOrderId,
      ],
    )
  }

  const invoiceResult = await client.query<{ id: string }>(
    `insert into invoices
      (organization_id, sales_order_id, customer_id, origin, total_amount, status, issued_at)
     values ($1, null, $2, 'service_order', $3, 'open', now())
     returning id`,
    [input.organizationId, order.customerId ?? null, totalAmount],
  )

  const invoiceId = invoiceResult.rows[0]?.id
  if (!invoiceId) {
    throw new Error('Falha ao gerar fatura da ordem de serviço.')
  }

  const fiscalResult = await client.query<{ id: string }>(
    `insert into fiscal_documents (organization_id, invoice_id, doc_type, status, issue_date)
     values ($1, $2, 'nfe', 'draft', now())
     returning id`,
    [input.organizationId, invoiceId],
  )

  const fiscalDocumentId = fiscalResult.rows[0]?.id
  if (!fiscalDocumentId) {
    throw new Error('Falha ao gerar documento fiscal da OS.')
  }

  for (const item of items) {
    await client.query(
      `insert into fiscal_document_items
        (organization_id, document_id, product_id, description, quantity, unit_price, total_price, ncm, cfop)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.organizationId,
        fiscalDocumentId,
        item.productId,
        item.description ?? 'Item de serviço',
        item.quantity,
        item.unitPrice,
        item.totalPrice,
        item.ncm,
        item.cfop,
      ],
    )
  }

  const titleResult = await client.query<{ id: string }>(
    `insert into financial_titles
      (organization_id, title_type, customer_id, invoice_id, description, total_amount, status)
     values ($1, 'receivable', $2, $3, $4, $5, 'open')
     returning id`,
    [
      input.organizationId,
      order.customerId ?? null,
      invoiceId,
      billingDescription,
      totalAmount,
    ],
  )

  const receivableTitleId = titleResult.rows[0]?.id
  if (!receivableTitleId) {
    throw new Error('Falha ao gerar título financeiro da OS.')
  }

  await client.query(
    `insert into financial_installments
      (organization_id, title_id, due_date, amount, status)
     values ($1, $2, current_date + interval '30 day', $3, 'open')`,
    [input.organizationId, receivableTitleId, totalAmount],
  )

  const orderUpdateResult = await client.query<{
    status: string
    invoicedAt: string | Date | null
  }>(
    `update service_orders
     set status = 'completed',
         updated_at = now()
     where organization_id = $1
       and id = $2
     returning status::text as status, now() as "invoicedAt"`,
    [input.organizationId, input.serviceOrderId],
  )

  const nextStatus = parseServiceOrderStatus(orderUpdateResult.rows[0]?.status)
  const invoicedAt = toIsoDateTime(orderUpdateResult.rows[0]?.invoicedAt) ?? new Date().toISOString()

  return {
    serviceOrderId: input.serviceOrderId,
    status: nextStatus,
    invoiceId,
    fiscalDocumentId,
    receivableTitleId,
    invoicedAt,
    reused: false,
    previousStatus: currentStatus,
    previousInvoiceId: null,
    previousFiscalDocumentId: null,
    previousReceivableTitleId: null,
    previousInvoicedAt: null,
  }
}
