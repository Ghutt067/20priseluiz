const baseUrl = process.env.API_URL || 'http://localhost:4000'
const smokeOrgId = process.env.SMOKE_ORG_ID || process.env.APP_ORG_ID || ''
const smokeAuthTokenRaw = process.env.SMOKE_AUTH_TOKEN || process.env.AUTH_TOKEN || ''

function normalizeAuthToken(token) {
  if (!token) return ''
  if (token.toLowerCase().startsWith('bearer ')) return token
  return `Bearer ${token}`
}

const smokeAuthToken = normalizeAuthToken(smokeAuthTokenRaw)

function buildDefaultHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  if (smokeOrgId) {
    headers['x-organization-id'] = smokeOrgId
  }
  if (smokeAuthToken) {
    headers.authorization = smokeAuthToken
  }
  return headers
}

async function request(path, options = {}) {
  const headers = options.headers
    ? { ...buildDefaultHeaders(), ...options.headers }
    : buildDefaultHeaders()

  const response = await fetch(`${baseUrl}${path}`, {
    headers,
    ...options,
  })
  const text = await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(data)}`)
  }
  return data
}

async function run() {
  const results = []
  const ok = (name) => results.push({ name, status: 'ok' })
  const fail = (name, error) => results.push({ name, status: 'fail', error: error.message })

  const today = new Date().toISOString().slice(0, 10)
  const runId = Date.now()

  if (!smokeOrgId) {
    console.warn('[SMOKE WARN] SMOKE_ORG_ID/APP_ORG_ID não definido; APIs multi-tenant podem falhar.')
  }
  if (!smokeAuthToken) {
    console.warn('[SMOKE WARN] SMOKE_AUTH_TOKEN/AUTH_TOKEN não definido; rotas com auth obrigatória podem falhar.')
  }

  let customerId
  let supplierId
  let productId
  let warehouseId
  let warehouse2Id
  let salesOrderId
  let quoteId
  let titleId
  let installmentId
  let bankTransactionId
  let profileId
  let fiscalDocumentId
  let transmissionId
  let posSessionId
  let serviceOrderId
  let technicianId
  let vehicleId
  let shipmentId
  let agentId
  let accountId

  try {
    const customer = await request('/customers', {
      method: 'POST',
      body: JSON.stringify({ personType: 'legal', name: 'Cliente Smoke', cpfCnpj: '11111111000111' }),
    })
    customerId = customer.id
    ok('customers.create')
  } catch (error) {
    fail('customers.create', error)
  }

  try {
    const supplier = await request('/suppliers', {
      method: 'POST',
      body: JSON.stringify({ personType: 'legal', name: 'Fornecedor Smoke', cpfCnpj: '22222222000122' }),
    })
    supplierId = supplier.id
    ok('suppliers.create')
  } catch (error) {
    fail('suppliers.create', error)
  }

  try {
    const product = await request('/products', {
      method: 'POST',
      body: JSON.stringify({
        sku: `SKU-SMOKE-${runId}`,
        name: `Produto Smoke ${runId}`,
        price: 100,
        cost: 60,
      }),
    })
    productId = product.id
    ok('products.create')
  } catch (error) {
    fail('products.create', error)
  }

  try {
    const warehouse = await request('/warehouses', {
      method: 'POST',
      body: JSON.stringify({ name: 'Depósito A' }),
    })
    warehouseId = warehouse.id
    const warehouse2 = await request('/warehouses', {
      method: 'POST',
      body: JSON.stringify({ name: 'Depósito B' }),
    })
    warehouse2Id = warehouse2.id
    ok('warehouses.create')
  } catch (error) {
    fail('warehouses.create', error)
  }

  try {
    const employee = await request('/people/employees', {
      method: 'POST',
      body: JSON.stringify({ name: 'Vendedor Smoke', role: 'Vendas' }),
    })
    const agent = await request('/people/agents', {
      method: 'POST',
      body: JSON.stringify({ employeeId: employee.id, name: 'Agente Smoke', commissionRate: 5 }),
    })
    agentId = agent.id
    ok('people.agent')
  } catch (error) {
    fail('people.agent', error)
  }

  try {
    const quote = await request('/quotes', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        items: [{ product_id: productId, description: 'Item cotação', quantity: 1, unit_price: 50 }],
      }),
    })
    quoteId = quote.quoteId
    ok('quotes.create')
  } catch (error) {
    fail('quotes.create', error)
  }

  try {
    const converted = await request(`/quotes/${quoteId}/convert`, {
      method: 'POST',
      body: JSON.stringify({ warehouseId }),
    })
    salesOrderId = converted.orderId
    ok('quotes.convert')
  } catch (error) {
    fail('quotes.convert', error)
  }

  try {
    const salesOrder = await request('/sales/orders', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        warehouseId,
        salesAgentId: agentId,
        items: [{ product_id: productId, description: 'Item venda', quantity: 1, unit_price: 120 }],
      }),
    })
    salesOrderId = salesOrder.orderId
    ok('sales.create')
  } catch (error) {
    fail('sales.create', error)
  }

  try {
    await request('/purchases/orders', {
      method: 'POST',
      body: JSON.stringify({
        supplierId,
        warehouseId,
        items: [{ product_id: productId, description: 'Item compra', quantity: 5, unit_cost: 20 }],
      }),
    })
    ok('purchases.order')
  } catch (error) {
    fail('purchases.order', error)
  }

  try {
    await request('/purchases/receive', {
      method: 'POST',
      body: JSON.stringify({
        supplierId,
        warehouseId,
        items: [{ product_id: productId, description: 'Item recebido', quantity: 5, unit_cost: 20 }],
      }),
    })
    ok('purchases.receive')
  } catch (error) {
    fail('purchases.receive', error)
  }

  try {
    await request('/stock/transfers', {
      method: 'POST',
      body: JSON.stringify({
        originWarehouseId: warehouseId,
        destinationWarehouseId: warehouse2Id,
        items: [{ product_id: productId, quantity: 1 }],
      }),
    })
    ok('stock.transfer')
  } catch (error) {
    fail('stock.transfer', error)
  }

  try {
    const account = await request('/finance/accounts', {
      method: 'POST',
      body: JSON.stringify({ name: 'Conta Caixa' }),
    })
    accountId = account.id
    ok('finance.account')
  } catch (error) {
    fail('finance.account', error)
  }

  try {
    const title = await request('/finance/titles', {
      method: 'POST',
      body: JSON.stringify({
        titleType: 'receivable',
        customerId,
        description: 'Venda teste',
        totalAmount: 120,
        installmentCount: 1,
        firstDueDate: today,
      }),
    })
    titleId = title.titleId
    const installments = await request(`/finance/titles/${titleId}/installments`)
    installmentId = installments[0]?.id
    ok('finance.title')
  } catch (error) {
    fail('finance.title', error)
  }

  try {
    await request('/finance/installments/pay', {
      method: 'POST',
      body: JSON.stringify({
        installmentId,
        accountId,
        amount: 120,
        method: 'pix',
      }),
    })
    ok('finance.pay')
  } catch (error) {
    fail('finance.pay', error)
  }

  try {
    const bankTx = await request('/finance/bank-transactions', {
      method: 'POST',
      body: JSON.stringify({
        accountId,
        direction: 'in',
        amount: 120,
        description: 'Entrada',
      }),
    })
    bankTransactionId = bankTx.bankTransactionId
    ok('finance.bankTx')
  } catch (error) {
    fail('finance.bankTx', error)
  }

  try {
    await request('/finance/reconcile', {
      method: 'POST',
      body: JSON.stringify({ bankTransactionId, installmentId }),
    })
    ok('finance.reconcile')
  } catch (error) {
    fail('finance.reconcile', error)
  }

  try {
    await request('/finance/reconcile/auto', {
      method: 'POST',
      body: JSON.stringify({ tolerance: 0.01 }),
    })
    ok('finance.reconcileAuto')
  } catch (error) {
    fail('finance.reconcileAuto', error)
  }

  try {
    await request('/finance/payment-requests', {
      method: 'POST',
      body: JSON.stringify({
        titleId,
        provider: 'pix',
        amount: 120,
        payload: { key: 'test' },
      }),
    })
    ok('finance.paymentRequest')
  } catch (error) {
    fail('finance.paymentRequest', error)
  }

  try {
    const ofxText = '<OFX><STMTTRN><TRNAMT>10.00<DTPOSTED>20250101<NAME>Teste</STMTTRN></OFX>'
    await request('/finance/ofx/import', {
      method: 'POST',
      body: JSON.stringify({ accountId, rawText: ofxText }),
    })
    ok('finance.ofx')
  } catch (error) {
    fail('finance.ofx', error)
  }

  try {
    await request('/payments/cheques', {
      method: 'POST',
      body: JSON.stringify({ titleId, amount: 50, bank: '001', chequeNumber: '123' }),
    })
    ok('payments.cheque')
  } catch (error) {
    fail('payments.cheque', error)
  }

  try {
    await request('/payments/cards', {
      method: 'POST',
      body: JSON.stringify({ titleId, amount: 50, brand: 'VISA', last4: '1234' }),
    })
    ok('payments.card')
  } catch (error) {
    fail('payments.card', error)
  }

  try {
    const profile = await request('/fiscal/profiles', {
      method: 'POST',
      body: JSON.stringify({ name: `Perfil Smoke ${runId}`, profileType: 'default' }),
    })
    profileId = profile.id
    await request('/fiscal/rules', {
      method: 'POST',
      body: JSON.stringify({
        profileId,
        taxType: 'icms',
        rate: 18,
        cfop: '5102',
      }),
    })
    const draft = await request('/fiscal/nfe/draft', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        profileId,
        originState: 'SP',
        destinationState: 'SP',
        docType: 'nfe',
        items: [{ description: 'Item fiscal', quantity: 1, unit_price: 10, cfop: '5102' }],
      }),
    })
    fiscalDocumentId = draft.documentId
    ok('fiscal.draft')
  } catch (error) {
    fail('fiscal.draft', error)
  }

  try {
    const tx = await request('/fiscal/transmissions', {
      method: 'POST',
      body: JSON.stringify({ documentId: fiscalDocumentId }),
    })
    transmissionId = tx.id
    await request(`/fiscal/transmissions/${transmissionId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'sent' }),
    })
    ok('fiscal.transmission')
  } catch (error) {
    fail('fiscal.transmission', error)
  }

  try {
    await request('/crm/appointments', {
      method: 'POST',
      body: JSON.stringify({ customerId, subject: 'Agenda', scheduledAt: `${today}T10:00:00Z` }),
    })
    await request('/crm/calls', {
      method: 'POST',
      body: JSON.stringify({ customerId, phone: '999999999', outcome: 'ok' }),
    })
    const campaign = await request('/crm/campaigns', {
      method: 'POST',
      body: JSON.stringify({ name: 'Campanha Smoke', channel: 'email' }),
    })
    await request(`/crm/campaigns/${campaign.id}/contacts`, {
      method: 'POST',
      body: JSON.stringify({ customerId }),
    })
    await request('/crm/promotions', {
      method: 'POST',
      body: JSON.stringify({ productId, name: 'Promo', promoPrice: 80 }),
    })
    await request('/inventory/counts', {
      method: 'POST',
      body: JSON.stringify({
        warehouseId,
        items: [{ product_id: productId, expected_qty: 10, counted_qty: 9 }],
      }),
    })
    await request('/returns', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        reason: 'Troca',
        items: [{ product_id: productId, quantity: 1 }],
      }),
    })
    ok('crm')
  } catch (error) {
    fail('crm', error)
  }

  try {
    const vehicle = await request('/services/vehicles', {
      method: 'POST',
      body: JSON.stringify({ customerId, plate: 'ABC1234', brand: 'VW', model: 'Gol' }),
    })
    vehicleId = vehicle.id
    const technician = await request('/services/technicians', {
      method: 'POST',
      body: JSON.stringify({ name: 'Tecnico Smoke' }),
    })
    technicianId = technician.id
    const order = await request('/services/orders', {
      method: 'POST',
      body: JSON.stringify({
        customerId,
        vehicleId,
        items: [{ description: 'Serviço', quantity: 1, unit_price: 80 }],
        checklist: [{ item: 'Check' }],
      }),
    })
    serviceOrderId = order.serviceOrderId
    await request(`/services/orders/${serviceOrderId}/technicians`, {
      method: 'POST',
      body: JSON.stringify({ technicianId, hoursWorked: 1 }),
    })
    await request(`/services/orders/${serviceOrderId}/time`, {
      method: 'POST',
      body: JSON.stringify({ technicianId, hours: 1, entryType: 'labor' }),
    })
    ok('services')
  } catch (error) {
    fail('services', error)
  }

  try {
    const shipment = await request('/shipping/shipments', {
      method: 'POST',
      body: JSON.stringify({
        salesOrderId,
        customerId,
        items: [{ product_id: productId, quantity: 1 }],
      }),
    })
    shipmentId = shipment.shipmentId
    await request(`/shipping/shipments/${shipmentId}/dispatch`, { method: 'POST' })
    await request(`/shipping/shipments/${shipmentId}/deliver`, { method: 'POST' })
    ok('shipping')
  } catch (error) {
    fail('shipping', error)
  }

  try {
    const session = await request('/pos/sessions/open', { method: 'POST', body: JSON.stringify({}) })
    posSessionId = session.sessionId
    await request('/pos/sales', {
      method: 'POST',
      body: JSON.stringify({
        posSessionId,
        customerId,
        items: [{ product_id: productId, quantity: 1, unit_price: 10 }],
        payments: [{ method: 'cash', amount: 10 }],
      }),
    })
    await request(`/pos/sessions/${posSessionId}/close`, { method: 'POST' })
    ok('pos')
  } catch (error) {
    fail('pos', error)
  }

  try {
    await request('/labels', {
      method: 'POST',
      body: JSON.stringify({ productId, quantity: 2, payload: { sku: 'SKU-SMOKE' } }),
    })
    ok('labels')
  } catch (error) {
    fail('labels', error)
  }

  try {
    await request('/bank/integrations', {
      method: 'POST',
      body: JSON.stringify({ provider: 'pix', name: 'Integração Smoke', config: { key: 'x' } }),
    })
    await request('/bank/webhooks', {
      method: 'POST',
      body: JSON.stringify({ eventType: 'payment.updated', payload: { status: 'paid' } }),
    })
    await request('/bank/webhooks/process-payment', {
      method: 'POST',
      body: JSON.stringify({ installmentId, amount: 120, method: 'pix' }),
    })
    ok('bank.webhooks')
  } catch (error) {
    fail('bank.webhooks', error)
  }

  try {
    const sintegra = await request('/sintegra/exports', {
      method: 'POST',
      body: JSON.stringify({ periodStart: today, periodEnd: today }),
    })
    await request(`/sintegra/exports/${sintegra.id}/generate`, { method: 'POST' })
    ok('sintegra')
  } catch (error) {
    fail('sintegra', error)
  }

  try {
    await request('/reports/cashflow')
    await request('/reports/dre')
    await request('/reports/sales')
    await request('/reports/top-customers')
    await request('/reports/inventory-value')
    await request('/reports/margin-by-product')
    await request('/reports/inventory-turnover')
    await request('/reports/commissions')
    await request('/reports/aging')
    ok('reports')
  } catch (error) {
    fail('reports', error)
  }

  console.log('SMOKE TEST RESULTS')
  for (const result of results) {
    console.log(`${result.status.toUpperCase()} - ${result.name}${result.error ? `: ${result.error}` : ''}`)
  }

  const failed = results.filter((result) => result.status === 'fail')
  if (failed.length) {
    process.exitCode = 1
  }
}

run().catch((error) => {
  console.error('Fatal error', error)
  process.exit(1)
})
