import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { withOrgTransaction } from './db'
import { faturarPedido } from './use-cases/faturarPedido'
import { fiscalRoutes } from './http/fiscalRoutes'
import { getOrganizationId } from './http/getOrganizationId'
import { coreRoutes } from './http/coreRoutes'
import { financeRoutes } from './http/financeRoutes'
import { serviceRoutes } from './http/serviceRoutes'
import { crmRoutes } from './http/crmRoutes'
import { shippingRoutes } from './http/shippingRoutes'
import { posRoutes } from './http/posRoutes'
import { peopleRoutes } from './http/peopleRoutes'
import { reportRoutes } from './http/reportRoutes'
import { labelRoutes } from './http/labelRoutes'
import { bankRoutes } from './http/bankRoutes'
import { sintegraRoutes } from './http/sintegraRoutes'
import { fiscalTransmissionRoutes } from './http/fiscalTransmissionRoutes'
import { paymentsRoutes } from './http/paymentsRoutes'
import { authRoutes } from './http/authRoutes'
import { dashboardRoutes } from './http/dashboardRoutes'
import { settingsRoutes } from './http/settingsRoutes'
import { contractRoutes } from './http/contractRoutes'
import { fleetRoutes } from './http/fleetRoutes'
import { mrpRoutes } from './http/mrpRoutes'
import { wmsRoutes } from './http/wmsRoutes'
import { assetRoutes } from './http/assetRoutes'
import { advancedFinanceRoutes } from './http/advancedFinanceRoutes'
import { megaModulesRoutes } from './http/megaModulesRoutes'
import { aiRoutes } from './http/aiRoutes'

dotenv.config()

const app = express()
const port = Number(process.env.PORT ?? 4000)

app.use(
  cors({
    exposedHeaders: ['x-total-count'],
  }),
)
app.use(express.json())

app.use('/fiscal', fiscalRoutes)
app.use(coreRoutes)
app.use(financeRoutes)
app.use(serviceRoutes)
app.use(crmRoutes)
app.use(shippingRoutes)
app.use(posRoutes)
app.use(peopleRoutes)
app.use(reportRoutes)
app.use(labelRoutes)
app.use(bankRoutes)
app.use(sintegraRoutes)
app.use(fiscalTransmissionRoutes)
app.use(paymentsRoutes)
app.use(authRoutes)
app.use(dashboardRoutes)
app.use(settingsRoutes)
app.use(contractRoutes)
app.use(fleetRoutes)
app.use(mrpRoutes)
app.use(wmsRoutes)
app.use(assetRoutes)
app.use(advancedFinanceRoutes)
app.use(megaModulesRoutes)
app.use(aiRoutes)

app.get('/health', (_request, response) => {
  response.json({ status: 'ok' })
})

app.post('/orders/:id/invoice', async (request, response) => {
  try {
    const organizationId = getOrganizationId(request)

    const result = await withOrgTransaction(organizationId, (client) =>
      faturarPedido(client, { salesOrderId: request.params.id }),
    )

    response.status(201).json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro inesperado.'
    response.status(400).json({ error: message })
  }
})

app.listen(port, () => {
  console.log(`Backend ERP rodando em http://localhost:${port}`)
})
