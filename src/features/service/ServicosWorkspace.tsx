import { useCallback, useEffect, useMemo, useState } from 'react'
import { DateInput, NumericInput, Select, PageHeader, Tabs, TabPanel } from '../../components/ui'
import { searchCustomersPaged } from '../../services/core'
import {
  assignTechnicianToOrder,
  createServiceOrder,
  createTechnician,
  createVehicle,
  fetchServiceOrderDetail,
  fetchServiceOrdersPaged,
  fetchServiceTechniciansPaged,
  fetchServiceVehiclesPaged,
  invoiceServiceOrder,
  logServiceTime,
  updateServiceOrderStatus,
  type ServiceOrderDetail,
  type ServiceOrderLookup,
  type ServiceOrderStatus,
  type ServiceTimeEntryType,
  type ServiceVehicleLookup,
  type ServiceTechnicianLookup,
} from '../../services/service'
import {
  escapeHtml,
  printHtmlDocument,
  printPresetOptions,
  type PrintPreset,
} from '../../services/printing'
import { LookupField, type LookupItem, type LookupSearchParams } from '../inventory/LookupFields'
import { useStatusToast } from '../../hooks/useStatusToast'
import { usePermission } from '../../hooks/usePermission'
import { toNumber, fmtCurrency, fmtDateFull, fmtDateTime, fmtQty, canGoNextPage as canGoNext, mergeLookupById } from '../../lib/formatters'

const PAGE_SIZE = 10

type CustomerLookup = LookupItem & {
  email?: string
  phone?: string
}

type ServiceOrderLookupOption = LookupItem & {
  status: ServiceOrderStatus
  customerName: string | null
  vehiclePlate: string | null
}

const serviceOrderStatusFilterOptions: Array<{ value: ServiceOrderStatus | ''; label: string }> = [
  { value: '', label: 'Todos os status' },
  { value: 'open', label: 'Aberta' },
  { value: 'in_progress', label: 'Em andamento' },
  { value: 'completed', label: 'Concluída' },
  { value: 'cancelled', label: 'Cancelada' },
]

const serviceOrderStatusOptions: Array<{ value: ServiceOrderStatus; label: string }> = [
  { value: 'open', label: 'Aberta' },
  { value: 'in_progress', label: 'Em andamento' },
  { value: 'completed', label: 'Concluída' },
  { value: 'cancelled', label: 'Cancelada' },
]

const technicianActiveFilterOptions: Array<{ value: '' | 'true' | 'false'; label: string }> = [
  { value: '', label: 'Todos' },
  { value: 'true', label: 'Ativos' },
  { value: 'false', label: 'Inativos' },
]

const serviceTimeTypeOptions: Array<{ value: ServiceTimeEntryType; label: string }> = [
  { value: 'labor', label: 'Mão de obra' },
  { value: 'diagnostic', label: 'Diagnóstico' },
]

const serviceOrderPrintPresetOptions = printPresetOptions.filter(
  (option) => option.value === 'a4' || option.value === 'a5',
)

function normalizeOptionalText(value: string) {
  const normalized = value.trim()
  return normalized === '' ? undefined : normalized
}

function pageInfoLabel(offset: number, rowCount: number, totalCount: number | null, emptyMessage: string) {
  if (rowCount === 0) return emptyMessage
  const start = offset + 1
  const end = offset + rowCount
  if (typeof totalCount === 'number') {
    return `Exibindo ${start}-${end} de ${totalCount}`
  }
  return `Exibindo ${start}-${end}`
}

function serviceOrderStatusLabel(status: ServiceOrderStatus) {
  if (status === 'open') return 'Aberta'
  if (status === 'in_progress') return 'Em andamento'
  if (status === 'completed') return 'Concluída'
  return 'Cancelada'
}

function serviceOrderStatusTone(status: ServiceOrderStatus) {
  if (status === 'open') return 'pending'
  if (status === 'in_progress') return 'info'
  if (status === 'completed') return 'success'
  return 'muted'
}

function vehicleLabel(input: {
  plate: string | null
  brand: string | null
  model: string | null
}) {
  return input.plate || [input.brand, input.model].filter(Boolean).join(' ') || 'Sem identificação'
}

function toOrderLookupOption(row: ServiceOrderLookup): ServiceOrderLookupOption {
  const counterpart = row.customerName || row.vehiclePlate || 'Sem vínculo'
  return {
    id: row.id,
    name: `${row.id.slice(0, 8)} · ${counterpart}`,
    status: row.status,
    customerName: row.customerName,
    vehiclePlate: row.vehiclePlate,
  }
}

function toOrderLookupFromDetail(order: ServiceOrderDetail['order']): ServiceOrderLookupOption {
  const counterpart = order.customerName || order.vehiclePlate || 'Sem vínculo'
  return {
    id: order.id,
    name: `${order.id.slice(0, 8)} · ${counterpart}`,
    status: order.status,
    customerName: order.customerName,
    vehiclePlate: order.vehiclePlate,
  }
}

export function ServicosWorkspace() {
  const canCreateOrder = usePermission('service.order.create')
  const canInvoiceOrder = usePermission('service.order.invoice')
  const [knownCustomers, setKnownCustomers] = useState<CustomerLookup[]>([])
  const [knownVehicles, setKnownVehicles] = useState<ServiceVehicleLookup[]>([])
  const [knownTechnicians, setKnownTechnicians] = useState<ServiceTechnicianLookup[]>([])
  const [knownOrders, setKnownOrders] = useState<ServiceOrderLookupOption[]>([])

  const [vehicleStatus, setVehicleStatus] = useState('')
  const [technicianStatus, setTechnicianStatus] = useState('')
  const [serviceOrderStatus, setServiceOrderStatus] = useState('')
  const [serviceAssignStatus, setServiceAssignStatus] = useState('')
  const [serviceTimeStatus, setServiceTimeStatus] = useState('')
  const [statusUpdateStatus, setStatusUpdateStatus] = useState('')
  useStatusToast(statusUpdateStatus)
  const [orderInvoiceStatus, setOrderInvoiceStatus] = useState('')
  const [orderInvoiceBusy, setOrderInvoiceBusy] = useState(false)
  const [orderPrintPreset, setOrderPrintPreset] = useState<PrintPreset>('a4')
  const [orderPrintStatus, setOrderPrintStatus] = useState('')

  const [vehicleForm, setVehicleForm] = useState({
    customerId: '',
    plate: '',
    brand: '',
    model: '',
    year: '',
    color: '',
    vin: '',
  })
  const [technicianForm, setTechnicianForm] = useState({
    name: '',
    email: '',
    phone: '',
  })
  const [serviceOrderForm, setServiceOrderForm] = useState({
    customerId: '',
    vehicleId: '',
    scheduledAt: '',
    notes: '',
    description: 'Diagnóstico inicial',
    quantity: '1',
    unitPrice: '80',
    hoursWorked: '1',
    checklistText: 'Verificar freios\nChecar óleo',
  })
  const [serviceAssignForm, setServiceAssignForm] = useState({
    serviceOrderId: '',
    technicianId: '',
    hoursWorked: '1',
  })
  const [serviceTimeForm, setServiceTimeForm] = useState<{
    serviceOrderId: string
    technicianId: string
    entryType: ServiceTimeEntryType
    hours: string
    notes: string
  }>({
    serviceOrderId: '',
    technicianId: '',
    entryType: 'labor',
    hours: '1',
    notes: '',
  })

  const [ordersQuery, setOrdersQuery] = useState('')
  const [ordersStatusFilter, setOrdersStatusFilter] = useState<ServiceOrderStatus | ''>('')
  const [ordersOffset, setOrdersOffset] = useState(0)
  const [ordersRows, setOrdersRows] = useState<ServiceOrderLookup[]>([])
  const [ordersTotalCount, setOrdersTotalCount] = useState<number | null>(null)
  const [ordersLoading, setOrdersLoading] = useState(true)
  const [ordersStatusText, setOrdersStatusText] = useState('')
  const [ordersRefreshToken, setOrdersRefreshToken] = useState(0)

  const [selectedOrderId, setSelectedOrderId] = useState('')
  const [selectedOrderDetail, setSelectedOrderDetail] = useState<ServiceOrderDetail | null>(null)
  const [selectedOrderStatus, setSelectedOrderStatus] = useState<ServiceOrderStatus>('open')
  const [selectedOrderLoading, setSelectedOrderLoading] = useState(false)
  const [selectedOrderStatusText, setSelectedOrderStatusText] = useState('')
  const [selectedOrderRefreshToken, setSelectedOrderRefreshToken] = useState(0)

  const [vehiclesQuery, setVehiclesQuery] = useState('')
  const [vehiclesCustomerFilterId, setVehiclesCustomerFilterId] = useState('')
  const [vehiclesOffset, setVehiclesOffset] = useState(0)
  const [vehiclesRows, setVehiclesRows] = useState<ServiceVehicleLookup[]>([])
  const [vehiclesTotalCount, setVehiclesTotalCount] = useState<number | null>(null)
  const [vehiclesLoading, setVehiclesLoading] = useState(true)
  const [vehiclesStatusText, setVehiclesStatusText] = useState('')
  const [vehiclesRefreshToken, setVehiclesRefreshToken] = useState(0)

  const [techniciansQuery, setTechniciansQuery] = useState('')
  const [techniciansActiveFilter, setTechniciansActiveFilter] = useState<'' | 'true' | 'false'>('')
  const [techniciansOffset, setTechniciansOffset] = useState(0)
  const [techniciansRows, setTechniciansRows] = useState<ServiceTechnicianLookup[]>([])
  const [techniciansTotalCount, setTechniciansTotalCount] = useState<number | null>(null)
  const [techniciansLoading, setTechniciansLoading] = useState(true)
  const [techniciansStatusText, setTechniciansStatusText] = useState('')
  const [techniciansRefreshToken, setTechniciansRefreshToken] = useState(0)

  const customersById = useMemo(() => new Map(knownCustomers.map((row) => [row.id, row])), [knownCustomers])
  const vehiclesById = useMemo(() => new Map(knownVehicles.map((row) => [row.id, row])), [knownVehicles])
  const techniciansById = useMemo(
    () => new Map(knownTechnicians.map((row) => [row.id, row])),
    [knownTechnicians],
  )
  const ordersById = useMemo(() => new Map(knownOrders.map((row) => [row.id, row])), [knownOrders])

  const ordersPageInfo = useMemo(
    () => pageInfoLabel(ordersOffset, ordersRows.length, ordersTotalCount, 'Nenhuma OS encontrada.'),
    [ordersOffset, ordersRows.length, ordersTotalCount],
  )
  const vehiclesPageInfo = useMemo(
    () => pageInfoLabel(vehiclesOffset, vehiclesRows.length, vehiclesTotalCount, 'Nenhum veículo encontrado.'),
    [vehiclesOffset, vehiclesRows.length, vehiclesTotalCount],
  )
  const techniciansPageInfo = useMemo(
    () =>
      pageInfoLabel(techniciansOffset, techniciansRows.length, techniciansTotalCount, 'Nenhum técnico encontrado.'),
    [techniciansOffset, techniciansRows.length, techniciansTotalCount],
  )

  const searchCustomerOptions = useCallback(async ({ query, offset, limit, signal }: LookupSearchParams) => {
    const rows = await searchCustomersPaged(query, { offset, limit, signal })
    const normalized: CustomerLookup[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
    }))
    setKnownCustomers((state) => mergeLookupById(state, normalized))
    return {
      rows: normalized,
      totalCount: null,
    }
  }, [])

  const searchVehicleOptions = useCallback(
    async ({ query, offset, limit, signal }: LookupSearchParams) => {
      const result = await fetchServiceVehiclesPaged({
        query,
        customerId: normalizeOptionalText(serviceOrderForm.customerId),
        limit,
        offset,
        signal,
      })
      setKnownVehicles((state) => mergeLookupById(state, result.rows))
      return {
        rows: result.rows,
        totalCount: result.totalCount,
      }
    },
    [serviceOrderForm.customerId],
  )

  const searchTechnicianOptions = useCallback(async ({ query, offset, limit, signal }: LookupSearchParams) => {
    const result = await fetchServiceTechniciansPaged({ query, active: true, limit, offset, signal })
    setKnownTechnicians((state) => mergeLookupById(state, result.rows))
    return {
      rows: result.rows,
      totalCount: result.totalCount,
    }
  }, [])

  const searchOrderOptions = useCallback(async ({ query, offset, limit, signal }: LookupSearchParams) => {
    const result = await fetchServiceOrdersPaged({ query, limit, offset, signal })
    const mapped = result.rows.map(toOrderLookupOption)
    setKnownOrders((state) => mergeLookupById(state, mapped))
    return {
      rows: mapped,
      totalCount: result.totalCount,
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    void fetchServiceOrdersPaged({
      status: ordersStatusFilter,
      query: ordersQuery,
      offset: ordersOffset,
      limit: PAGE_SIZE,
      signal: controller.signal,
    })
      .then((result) => {
        if (cancelled) return
        setOrdersRows(result.rows)
        setOrdersTotalCount(result.totalCount)
        setKnownOrders((state) => mergeLookupById(state, result.rows.map(toOrderLookupOption)))
        setOrdersStatusText('')
      })
      .catch((error) => {
        if (cancelled) return
        setOrdersRows([])
        setOrdersTotalCount(null)
        setOrdersStatusText(error instanceof Error ? error.message : 'Erro ao carregar ordens de serviço.')
      })
      .finally(() => {
        if (!cancelled) setOrdersLoading(false)
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [ordersOffset, ordersQuery, ordersRefreshToken, ordersStatusFilter])

  useEffect(() => {
    if (!selectedOrderId) return

    let cancelled = false

    void fetchServiceOrderDetail(selectedOrderId)
      .then((detail) => {
        if (cancelled) return
        setSelectedOrderDetail(detail)
        setSelectedOrderStatus(detail.order.status)
        setKnownOrders((state) => mergeLookupById(state, [toOrderLookupFromDetail(detail.order)]))
        setSelectedOrderStatusText('')
      })
      .catch((error) => {
        if (cancelled) return
        setSelectedOrderDetail(null)
        setSelectedOrderStatusText(error instanceof Error ? error.message : 'Erro ao carregar detalhe da OS.')
      })
      .finally(() => {
        if (!cancelled) setSelectedOrderLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [selectedOrderId, selectedOrderRefreshToken])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    void fetchServiceVehiclesPaged({
      query: vehiclesQuery,
      customerId: normalizeOptionalText(vehiclesCustomerFilterId),
      offset: vehiclesOffset,
      limit: PAGE_SIZE,
      signal: controller.signal,
    })
      .then((result) => {
        if (cancelled) return
        setVehiclesRows(result.rows)
        setVehiclesTotalCount(result.totalCount)
        setKnownVehicles((state) => mergeLookupById(state, result.rows))
        setVehiclesStatusText('')
      })
      .catch((error) => {
        if (cancelled) return
        setVehiclesRows([])
        setVehiclesTotalCount(null)
        setVehiclesStatusText(error instanceof Error ? error.message : 'Erro ao carregar veículos.')
      })
      .finally(() => {
        if (!cancelled) setVehiclesLoading(false)
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [vehiclesCustomerFilterId, vehiclesOffset, vehiclesQuery, vehiclesRefreshToken])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    const activeFilter =
      techniciansActiveFilter === '' ? null : techniciansActiveFilter === 'true'

    void fetchServiceTechniciansPaged({
      query: techniciansQuery,
      active: activeFilter,
      offset: techniciansOffset,
      limit: PAGE_SIZE,
      signal: controller.signal,
    })
      .then((result) => {
        if (cancelled) return
        setTechniciansRows(result.rows)
        setTechniciansTotalCount(result.totalCount)
        setKnownTechnicians((state) => mergeLookupById(state, result.rows))
        setTechniciansStatusText('')
      })
      .catch((error) => {
        if (cancelled) return
        setTechniciansRows([])
        setTechniciansTotalCount(null)
        setTechniciansStatusText(error instanceof Error ? error.message : 'Erro ao carregar técnicos.')
      })
      .finally(() => {
        if (!cancelled) setTechniciansLoading(false)
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [techniciansActiveFilter, techniciansOffset, techniciansQuery, techniciansRefreshToken])

  const [serviceTab, setServiceTab] = useState<'orders' | 'register'>('orders')

  return (
    <div className="page-grid">
      <PageHeader />
      <Tabs
        tabs={[
          { key: 'orders' as const, label: 'Ordens de Serviço' },
          { key: 'register' as const, label: 'Cadastros e Apontamentos' },
        ]}
        active={serviceTab}
        onChange={(k) => setServiceTab(k as 'orders' | 'register')}
      />
      <TabPanel active={serviceTab === 'orders'}>
      <div className="card fiscal-card">

        <div className="fiscal-grid">
          <label>
            Busca
            <input
              value={ordersQuery}
              onChange={(event) => {
                setOrdersQuery(event.target.value)
                setOrdersLoading(true)
                setOrdersStatusText('')
                setOrdersOffset(0)
                setSelectedOrderId('')
                setSelectedOrderDetail(null)
                setSelectedOrderStatusText('')
                setSelectedOrderLoading(false)
                setOrderInvoiceBusy(false)
                setOrderInvoiceStatus('')
              }}
              placeholder="OS, cliente, placa ou observação"
            />
          </label>
          <label>
            Status
            <Select
              value={ordersStatusFilter}
              options={serviceOrderStatusFilterOptions}
              onChange={(value) => {
                setOrdersStatusFilter(value as ServiceOrderStatus | '')
                setOrdersLoading(true)
                setOrdersStatusText('')
                setOrdersOffset(0)
                setSelectedOrderId('')
                setSelectedOrderDetail(null)
                setSelectedOrderStatusText('')
                setSelectedOrderLoading(false)
                setOrderInvoiceBusy(false)
                setOrderInvoiceStatus('')
              }}
            />
          </label>
        </div>

        <div className="finance-table-wrapper">
          <table className="finance-table">
            <thead>
              <tr>
                <th>OS</th>
                <th>Status</th>
                <th>Cliente</th>
                <th>Veículo</th>
                <th>Agendamento</th>
                <th>Total</th>
                <th>Ação</th>
              </tr>
            </thead>
            <tbody>
              {ordersRows.length === 0 && (
                <tr>
                  <td colSpan={7}>Nenhum registro encontrado.</td>
                </tr>
              )}
              {ordersRows.map((row) => (
                <tr key={row.id}>
                  <td title={row.id}>{row.id.slice(0, 8)}...</td>
                  <td>
                    <span className={`fiscal-status-badge ${serviceOrderStatusTone(row.status)}`}>
                      {serviceOrderStatusLabel(row.status)}
                    </span>
                  </td>
                  <td>{row.customerName || 'Sem cliente'}</td>
                  <td>{vehicleLabel({ plate: row.vehiclePlate, brand: row.vehicleBrand, model: row.vehicleModel })}</td>
                  <td>{fmtDateFull(row.scheduledAt)}</td>
                  <td>{fmtCurrency(row.totalAmount)}</td>
                  <td>
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setSelectedOrderLoading(true)
                        setSelectedOrderStatusText('')
                        setOrderInvoiceBusy(false)
                        setOrderInvoiceStatus('')
                        setSelectedOrderId(row.id)
                      }}
                    >
                      {selectedOrderId === row.id ? 'Selecionada' : 'Selecionar'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="actions fiscal-pagination-row">
          <p className="hint fiscal-pagination-info">{ordersPageInfo}</p>
          <div className="actions">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setOrdersLoading(true)
                setOrdersOffset((value) => Math.max(value - PAGE_SIZE, 0))
              }}
              disabled={ordersLoading || ordersOffset === 0}
            >
              Página anterior
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setOrdersLoading(true)
                setOrdersOffset((value) => value + PAGE_SIZE)
              }}
              disabled={ordersLoading || !canGoNext(ordersOffset, ordersRows.length, ordersTotalCount, PAGE_SIZE)}
            >
              Próxima página
            </button>
          </div>
        </div>
      </div>

      <div className="card fiscal-card">

        {selectedOrderDetail && (
          <>
            <p className="subtitle">
              OS {selectedOrderDetail.order.id.slice(0, 8)}... ·{' '}
              <span className={`fiscal-status-badge ${serviceOrderStatusTone(selectedOrderDetail.order.status)}`}>
                {serviceOrderStatusLabel(selectedOrderDetail.order.status)}
              </span>
            </p>
            <div className="fiscal-grid">
              <label>
                Cliente
                <input value={selectedOrderDetail.order.customerName ?? 'Sem cliente'} disabled />
              </label>
              <label>
                Veículo
                <input
                  value={vehicleLabel({
                    plate: selectedOrderDetail.order.vehiclePlate,
                    brand: selectedOrderDetail.order.vehicleBrand,
                    model: selectedOrderDetail.order.vehicleModel,
                  })}
                  disabled
                />
              </label>
              <label>
                Agendamento
                <input value={fmtDateFull(selectedOrderDetail.order.scheduledAt)} disabled />
              </label>
              <label>
                Atualização
                <input value={fmtDateTime(selectedOrderDetail.order.updatedAt)} disabled />
              </label>
            </div>
            
            <p className="subtitle">
              Faturamento:{' '}
              {selectedOrderDetail.order.invoiceId
                ? `Fatura ${selectedOrderDetail.order.invoiceId.slice(0, 8)}... em ${fmtDateTime(selectedOrderDetail.order.invoicedAt)}`
                : 'Pendente'}
            </p>

            <div className="finance-table-wrapper">
              <table className="finance-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Qtd.</th>
                    <th>Unitário</th>
                    <th>Horas</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedOrderDetail.items.length === 0 && (
                    <tr>
                      <td colSpan={5}>Nenhum registro encontrado.</td>
                    </tr>
                  )}
                  {selectedOrderDetail.items.map((item) => (
                    <tr key={item.id}>
                      <td>{item.description || item.productName || 'Item sem descrição'}</td>
                      <td>{fmtQty(item.quantity, 3)}</td>
                      <td>{fmtCurrency(item.unitPrice)}</td>
                      <td>{fmtQty(item.hoursWorked, 2)}</td>
                      <td>{fmtCurrency(item.totalPrice)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h4>Checklist</h4>
            <div className="finance-table-wrapper">
              <table className="finance-table">
                <thead>
                  <tr>
                    <th>Item</th>
                    <th>Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedOrderDetail.checklist.length === 0 && (
                    <tr>
                      <td colSpan={2}>Nenhum registro encontrado.</td>
                    </tr>
                  )}
                  {selectedOrderDetail.checklist.map((item) => (
                    <tr key={item.id}>
                      <td>{item.item}</td>
                      <td>
                        <span className={`fiscal-status-badge ${item.isDone ? 'success' : 'pending'}`}>
                          {item.isDone ? 'Concluído' : 'Pendente'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h4>Alocação de Técnicos</h4>
            <div className="finance-table-wrapper">
              <table className="finance-table">
                <thead>
                  <tr>
                    <th>Técnico</th>
                    <th>Horas</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedOrderDetail.technicians.length === 0 && (
                    <tr>
                      <td colSpan={2}>Nenhum registro encontrado.</td>
                    </tr>
                  )}
                  {selectedOrderDetail.technicians.map((technician) => (
                    <tr key={technician.id}>
                      <td>{technician.technicianName}</td>
                      <td>{fmtQty(technician.hoursWorked, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="actions">
              <label>
                Formato da impressão
                <Select
                  value={orderPrintPreset}
                  options={serviceOrderPrintPresetOptions.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  onChange={(value) => setOrderPrintPreset(value as PrintPreset)}
                />
              </label>
              <button
                type="button"
                className="ghost"
                onClick={async () => {
                  setOrderPrintStatus('Preparando impressão da OS...')
                  try {
                    const printItemsRows = selectedOrderDetail.items
                      .map(
                        (item) =>
                          `<tr>
                            <td>${escapeHtml(item.description || item.productName || 'Item sem descrição')}</td>
                            <td>${escapeHtml(fmtQty(item.quantity, 3))}</td>
                            <td>${escapeHtml(fmtCurrency(item.unitPrice))}</td>
                            <td>${escapeHtml(fmtQty(item.hoursWorked, 2))}</td>
                            <td>${escapeHtml(fmtCurrency(item.totalPrice))}</td>
                          </tr>`,
                      )
                      .join('')

                    const checklistRows = selectedOrderDetail.checklist
                      .map(
                        (item) =>
                          `<tr>
                            <td>${escapeHtml(item.item)}</td>
                            <td>${escapeHtml(item.isDone ? 'Concluído' : 'Pendente')}</td>
                          </tr>`,
                      )
                      .join('')

                    const techniciansRows = selectedOrderDetail.technicians
                      .map(
                        (technician) =>
                          `<tr>
                            <td>${escapeHtml(technician.technicianName)}</td>
                            <td>${escapeHtml(fmtQty(technician.hoursWorked, 2))}</td>
                          </tr>`,
                      )
                      .join('')

                    await printHtmlDocument({
                      title: `Ordem de serviço ${selectedOrderDetail.order.id.slice(0, 8)}`,
                      subtitle: `Status: ${serviceOrderStatusLabel(selectedOrderDetail.order.status)} · Cliente: ${selectedOrderDetail.order.customerName || 'Sem cliente'}`,
                      preset: orderPrintPreset,
                      bodyHtml: `
                        <p><strong>OS:</strong> ${escapeHtml(selectedOrderDetail.order.id)}</p>
                        <p><strong>Veículo:</strong> ${escapeHtml(vehicleLabel({
                          plate: selectedOrderDetail.order.vehiclePlate,
                          brand: selectedOrderDetail.order.vehicleBrand,
                          model: selectedOrderDetail.order.vehicleModel,
                        }))}</p>
                        <p><strong>Agendamento:</strong> ${escapeHtml(fmtDateFull(selectedOrderDetail.order.scheduledAt))}</p>
                        <p><strong>Total:</strong> ${escapeHtml(fmtCurrency(selectedOrderDetail.order.totalAmount))}</p>
                        <p><strong>Observações:</strong> ${escapeHtml(selectedOrderDetail.order.notes || '—')}</p>

                        <h3>Itens</h3>
                        <table class="print-table">
                          <thead>
                            <tr>
                              <th>Item</th>
                              <th>Qtd.</th>
                              <th>Unitário</th>
                              <th>Horas</th>
                              <th>Total</th>
                            </tr>
                          </thead>
                          <tbody>
                            ${printItemsRows || '<tr><td colspan="5">Sem itens</td></tr>'}
                          </tbody>
                        </table>

                        <h3>Checklist</h3>
                        <table class="print-table">
                          <thead>
                            <tr>
                              <th>Item</th>
                              <th>Situação</th>
                            </tr>
                          </thead>
                          <tbody>
                            ${checklistRows || '<tr><td colspan="2">Sem checklist</td></tr>'}
                          </tbody>
                        </table>

                        <h3>Técnicos alocados</h3>
                        <table class="print-table">
                          <thead>
                            <tr>
                              <th>Técnico</th>
                              <th>Horas</th>
                            </tr>
                          </thead>
                          <tbody>
                            ${techniciansRows || '<tr><td colspan="2">Sem técnicos</td></tr>'}
                          </tbody>
                        </table>
                      `,
                      footerText: `Gerado em ${new Date().toLocaleString('pt-BR')}`,
                    })

                    setOrderPrintStatus('OS enviada para impressão.')
                  } catch (error) {
                    const message = error instanceof Error ? error.message : 'Erro ao imprimir OS.'
                    setOrderPrintStatus(message)
                  }
                }}
              >
                Imprimir OS
              </button>

              <button
                type="button"
                className="ghost"
                disabled={
                  orderInvoiceBusy
                  || !canInvoiceOrder
                  || selectedOrderDetail.order.status === 'cancelled'
                  || Boolean(selectedOrderDetail.order.invoiceId)
                }
                onClick={async () => {
                  setOrderInvoiceBusy(true)
                  setOrderInvoiceStatus('Faturando OS...')
                  try {
                    const result = await invoiceServiceOrder(
                      {
                        serviceOrderId: selectedOrderDetail.order.id,
                      },
                      {
                        idempotencyKey: `service-order-invoice-${selectedOrderDetail.order.id}`,
                      },
                    )

                    if (result.reused) {
                      setOrderInvoiceStatus(`OS já faturada. Fatura ${result.invoiceId.slice(0, 8)}...`)
                    } else {
                      setOrderInvoiceStatus(`OS faturada com sucesso. Fatura ${result.invoiceId.slice(0, 8)}...`)
                    }

                    setOrdersLoading(true)
                    setOrdersRefreshToken((value) => value + 1)
                    setSelectedOrderLoading(true)
                    setSelectedOrderRefreshToken((value) => value + 1)
                  } catch (error) {
                    const message = error instanceof Error ? error.message : 'Erro ao faturar OS.'
                    setOrderInvoiceStatus(message)
                  } finally {
                    setOrderInvoiceBusy(false)
                  }
                }}
              >
                {orderInvoiceBusy
                  ? 'Faturando...'
                  : selectedOrderDetail.order.invoiceId
                    ? 'OS faturada'
                    : 'Faturar OS'}
              </button>

              <label>
                Status
                <Select
                  value={selectedOrderStatus}
                  options={serviceOrderStatusOptions}
                  onChange={(value) => setSelectedOrderStatus(value as ServiceOrderStatus)}
                />
              </label>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await updateServiceOrderStatus({
                      serviceOrderId: selectedOrderDetail.order.id,
                      status: selectedOrderStatus,
                    })
                    setStatusUpdateStatus('Status atualizado com sucesso.')
                    setOrdersLoading(true)
                    setOrdersRefreshToken((value) => value + 1)
                    setSelectedOrderLoading(true)
                    setSelectedOrderRefreshToken((value) => value + 1)
                  } catch (error) {
                    const message = error instanceof Error ? error.message : 'Erro ao atualizar status.'
                    setStatusUpdateStatus(message)
                  }
                }}
              >
                Atualizar status
              </button>
            </div>

          </>
        )}
      </div>
      </TabPanel>

      <TabPanel active={serviceTab === 'register'}>
      <div className="card fiscal-card">
        <div className="fiscal-grid">
          <label className="purchase-order-lookup">
            Cliente do veículo
            <LookupField<CustomerLookup>
              value={vehicleForm.customerId}
              selectedLabel={customersById.get(vehicleForm.customerId)?.name ?? ''}
              placeholder="Buscar cliente..."
              searchOptions={searchCustomerOptions}
              onSelect={(row) => setVehicleForm((state) => ({ ...state, customerId: row.id }))}
              onClear={() => setVehicleForm((state) => ({ ...state, customerId: '' }))}
              renderMeta={(row) => row.email ?? row.phone ?? null}
            />
          </label>
          <label>
            Placa
            <input value={vehicleForm.plate} onChange={(event) => setVehicleForm((state) => ({ ...state, plate: event.target.value }))} />
          </label>
          <label>
            Marca
            <input value={vehicleForm.brand} onChange={(event) => setVehicleForm((state) => ({ ...state, brand: event.target.value }))} />
          </label>
          <label>
            Modelo
            <input value={vehicleForm.model} onChange={(event) => setVehicleForm((state) => ({ ...state, model: event.target.value }))} />
          </label>
          <label>
            Ano
            <NumericInput value={vehicleForm.year} decimals={0} onChange={(event) => setVehicleForm((state) => ({ ...state, year: event.target.value }))} />
          </label>
          <label>
            Cor
            <input value={vehicleForm.color} onChange={(event) => setVehicleForm((state) => ({ ...state, color: event.target.value }))} />
          </label>
          <label>
            Chassi / VIN
            <input value={vehicleForm.vin} onChange={(event) => setVehicleForm((state) => ({ ...state, vin: event.target.value }))} />
          </label>
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={async () => {
              try {
                const result = await createVehicle({
                  customerId: normalizeOptionalText(vehicleForm.customerId),
                  plate: normalizeOptionalText(vehicleForm.plate),
                  brand: normalizeOptionalText(vehicleForm.brand),
                  model: normalizeOptionalText(vehicleForm.model),
                  year: normalizeOptionalText(vehicleForm.year) ? Number(vehicleForm.year) : undefined,
                  color: normalizeOptionalText(vehicleForm.color),
                  vin: normalizeOptionalText(vehicleForm.vin),
                })
                setVehicleStatus(`Veículo criado: ${result.id}`)
                setServiceOrderForm((state) => ({ ...state, vehicleId: result.id }))
                setVehiclesLoading(true)
                setVehiclesRefreshToken((value) => value + 1)
              } catch (error) {
                setVehicleStatus(error instanceof Error ? error.message : 'Erro ao criar veículo.')
              }
            }}
          >
            Criar veículo
          </button>
        </div>

        <div className="divider" />

        <div className="fiscal-grid">
          <label>
            Nome técnico
            <input value={technicianForm.name} onChange={(event) => setTechnicianForm((state) => ({ ...state, name: event.target.value }))} />
          </label>
          <label>
            Email
            <input value={technicianForm.email} onChange={(event) => setTechnicianForm((state) => ({ ...state, email: event.target.value }))} />
          </label>
          <label>
            Telefone
            <input value={technicianForm.phone} onChange={(event) => setTechnicianForm((state) => ({ ...state, phone: event.target.value }))} />
          </label>
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={async () => {
              try {
                const result = await createTechnician({
                  name: technicianForm.name.trim(),
                  email: normalizeOptionalText(technicianForm.email),
                  phone: normalizeOptionalText(technicianForm.phone),
                })
                setTechnicianStatus(`Técnico criado: ${result.id}`)
                setServiceAssignForm((state) => ({ ...state, technicianId: result.id }))
                setServiceTimeForm((state) => ({ ...state, technicianId: result.id }))
                setTechniciansLoading(true)
                setTechniciansRefreshToken((value) => value + 1)
              } catch (error) {
                setTechnicianStatus(error instanceof Error ? error.message : 'Erro ao criar técnico.')
              }
            }}
          >
            Criar técnico
          </button>
        </div>

        <div className="divider" />

        <div className="fiscal-grid">
          <label className="purchase-order-lookup">
            Cliente da OS
            <LookupField<CustomerLookup>
              value={serviceOrderForm.customerId}
              selectedLabel={customersById.get(serviceOrderForm.customerId)?.name ?? ''}
              placeholder="Buscar cliente..."
              searchOptions={searchCustomerOptions}
              onSelect={(row) => setServiceOrderForm((state) => ({ ...state, customerId: row.id }))}
              onClear={() => setServiceOrderForm((state) => ({ ...state, customerId: '' }))}
              renderMeta={(row) => row.email ?? row.phone ?? null}
            />
          </label>
          <label className="purchase-order-lookup">
            Veículo
            <LookupField<ServiceVehicleLookup>
              value={serviceOrderForm.vehicleId}
              selectedLabel={vehiclesById.get(serviceOrderForm.vehicleId)?.name ?? ''}
              placeholder="Buscar veículo..."
              searchOptions={searchVehicleOptions}
              onSelect={(row) => setServiceOrderForm((state) => ({ ...state, vehicleId: row.id }))}
              onClear={() => setServiceOrderForm((state) => ({ ...state, vehicleId: '' }))}
              renderMeta={(row) => row.customerName || row.plate || null}
            />
          </label>
          <label>
            Agendamento
            <DateInput value={serviceOrderForm.scheduledAt} onChange={(event) => setServiceOrderForm((state) => ({ ...state, scheduledAt: event.target.value }))} />
          </label>
          <label>
            Observações
            <input value={serviceOrderForm.notes} onChange={(event) => setServiceOrderForm((state) => ({ ...state, notes: event.target.value }))} />
          </label>
          <label>
            Serviço
            <input value={serviceOrderForm.description} onChange={(event) => setServiceOrderForm((state) => ({ ...state, description: event.target.value }))} />
          </label>
          <label>
            Quantidade
            <NumericInput value={serviceOrderForm.quantity} onChange={(event) => setServiceOrderForm((state) => ({ ...state, quantity: event.target.value }))} />
          </label>
          <label>
            Preço unitário
            <NumericInput value={serviceOrderForm.unitPrice} onChange={(event) => setServiceOrderForm((state) => ({ ...state, unitPrice: event.target.value }))} />
          </label>
          <label>
            Horas estimadas
            <NumericInput value={serviceOrderForm.hoursWorked} onChange={(event) => setServiceOrderForm((state) => ({ ...state, hoursWorked: event.target.value }))} />
          </label>
        </div>
        <label className="fiscal-textarea">
          Itens do checklist
          <textarea value={serviceOrderForm.checklistText} onChange={(event) => setServiceOrderForm((state) => ({ ...state, checklistText: event.target.value }))} />
        </label>
        <div className="actions">
          <button
            type="button"
            disabled={!canCreateOrder}
            onClick={async () => {
              try {
                const checklist = serviceOrderForm.checklistText
                  .split('\n')
                  .map((row) => row.trim())
                  .filter(Boolean)
                  .map((item) => ({ item }))

                const result = await createServiceOrder({
                  customerId: normalizeOptionalText(serviceOrderForm.customerId),
                  vehicleId: normalizeOptionalText(serviceOrderForm.vehicleId),
                  scheduledAt: normalizeOptionalText(serviceOrderForm.scheduledAt),
                  notes: normalizeOptionalText(serviceOrderForm.notes),
                  items: [
                    {
                      description: serviceOrderForm.description.trim() || 'Serviço geral',
                      quantity: Math.max(toNumber(serviceOrderForm.quantity), 1),
                      unit_price: Math.max(toNumber(serviceOrderForm.unitPrice), 0),
                      hours_worked: Math.max(toNumber(serviceOrderForm.hoursWorked), 0),
                    },
                  ],
                  checklist: checklist.length > 0 ? checklist : undefined,
                })

                setServiceOrderStatus(`OS criada: ${result.serviceOrderId}`)
                setServiceAssignForm((state) => ({ ...state, serviceOrderId: result.serviceOrderId }))
                setServiceTimeForm((state) => ({ ...state, serviceOrderId: result.serviceOrderId }))
                setSelectedOrderLoading(true)
                setOrderInvoiceBusy(false)
                setOrderInvoiceStatus('')
                setSelectedOrderId(result.serviceOrderId)
                setOrdersLoading(true)
                setOrdersRefreshToken((value) => value + 1)
                setSelectedOrderRefreshToken((value) => value + 1)
              } catch (error) {
                setServiceOrderStatus(error instanceof Error ? error.message : 'Erro ao criar OS.')
              }
            }}
          >
            {canCreateOrder ? 'Criar ordem de serviço' : 'Sem permissão'}
          </button>
        </div>

        <div className="divider" />

        <div className="fiscal-grid">
          <label className="purchase-order-lookup">
            OS
            <LookupField<ServiceOrderLookupOption>
              value={serviceAssignForm.serviceOrderId}
              selectedLabel={ordersById.get(serviceAssignForm.serviceOrderId)?.name ?? ''}
              placeholder="Buscar OS..."
              searchOptions={searchOrderOptions}
              onSelect={(row) => {
                setServiceAssignForm((state) => ({ ...state, serviceOrderId: row.id }))
                setServiceTimeForm((state) => ({ ...state, serviceOrderId: row.id }))
              }}
              onClear={() => setServiceAssignForm((state) => ({ ...state, serviceOrderId: '' }))}
              renderMeta={(row) => serviceOrderStatusLabel(row.status)}
            />
          </label>
          <label className="purchase-order-lookup">
            Técnico
            <LookupField<ServiceTechnicianLookup>
              value={serviceAssignForm.technicianId}
              selectedLabel={techniciansById.get(serviceAssignForm.technicianId)?.name ?? ''}
              placeholder="Buscar técnico..."
              searchOptions={searchTechnicianOptions}
              onSelect={(row) => {
                setServiceAssignForm((state) => ({ ...state, technicianId: row.id }))
                setServiceTimeForm((state) => ({ ...state, technicianId: row.id }))
              }}
              onClear={() => setServiceAssignForm((state) => ({ ...state, technicianId: '' }))}
              renderMeta={(row) => row.email ?? row.phone ?? null}
            />
          </label>
          <label>
            Horas alocadas
            <NumericInput value={serviceAssignForm.hoursWorked} onChange={(event) => setServiceAssignForm((state) => ({ ...state, hoursWorked: event.target.value }))} />
          </label>
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={async () => {
              setServiceAssignStatus('Vinculando técnico...')
              try {
                const result = await assignTechnicianToOrder({
                  serviceOrderId: serviceAssignForm.serviceOrderId,
                  technicianId: serviceAssignForm.technicianId,
                  hoursWorked: Math.max(toNumber(serviceAssignForm.hoursWorked), 0),
                })
                setServiceAssignStatus(`Técnico vinculado na OS ${result.serviceOrderId}.`)
                setSelectedOrderLoading(true)
                setSelectedOrderRefreshToken((value) => value + 1)
              } catch (error) {
                setServiceAssignStatus(error instanceof Error ? error.message : 'Erro ao vincular técnico.')
              }
            }}
          >
            Vincular técnico
          </button>
        </div>

        <div className="fiscal-grid">
          <label>
            Tipo de apontamento
            <Select
              value={serviceTimeForm.entryType}
              options={serviceTimeTypeOptions}
              onChange={(value) => setServiceTimeForm((state) => ({ ...state, entryType: value as ServiceTimeEntryType }))}
            />
          </label>
          <label>
            Horas
            <NumericInput value={serviceTimeForm.hours} onChange={(event) => setServiceTimeForm((state) => ({ ...state, hours: event.target.value }))} />
          </label>
          <label>
            Observações
            <input value={serviceTimeForm.notes} onChange={(event) => setServiceTimeForm((state) => ({ ...state, notes: event.target.value }))} />
          </label>
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={async () => {
              try {
                const result = await logServiceTime({
                  serviceOrderId: serviceTimeForm.serviceOrderId,
                  technicianId: normalizeOptionalText(serviceTimeForm.technicianId),
                  entryType: serviceTimeForm.entryType,
                  hours: Math.max(toNumber(serviceTimeForm.hours), 0.1),
                  notes: normalizeOptionalText(serviceTimeForm.notes),
                })
                setServiceTimeStatus(`Horas registradas: ${result.timeEntryId}`)
                setSelectedOrderLoading(true)
                setSelectedOrderRefreshToken((value) => value + 1)
              } catch (error) {
                setServiceTimeStatus(error instanceof Error ? error.message : 'Erro ao registrar horas.')
              }
            }}
          >
            Registrar horas
          </button>
        </div>
        
      </div>

      <div className="card fiscal-card">
        <div className="fiscal-grid">
          <label>
            Buscar veículo
            <input
              value={vehiclesQuery}
              onChange={(event) => {
                setVehiclesQuery(event.target.value)
                setVehiclesLoading(true)
                setVehiclesStatusText('')
                setVehiclesOffset(0)
              }}
            />
          </label>
          <label className="purchase-order-lookup">
            Cliente
            <LookupField<CustomerLookup>
              value={vehiclesCustomerFilterId}
              selectedLabel={customersById.get(vehiclesCustomerFilterId)?.name ?? ''}
              placeholder="Filtrar por cliente..."
              searchOptions={searchCustomerOptions}
              onSelect={(row) => {
                setVehiclesCustomerFilterId(row.id)
                setVehiclesLoading(true)
                setVehiclesStatusText('')
                setVehiclesOffset(0)
              }}
              onClear={() => {
                setVehiclesCustomerFilterId('')
                setVehiclesLoading(true)
                setVehiclesStatusText('')
                setVehiclesOffset(0)
              }}
              renderMeta={(row) => row.email ?? row.phone ?? null}
            />
          </label>
        </div>
        
        <div className="finance-table-wrapper">
          <table className="finance-table">
            <thead>
              <tr>
                <th>Veículo</th>
                <th>Cliente</th>
                <th>Placa</th>
                <th>Atualização</th>
              </tr>
            </thead>
            <tbody>
              {vehiclesRows.length === 0 && (
                <tr>
                  <td colSpan={4}>Nenhum veículo encontrado.</td>
                </tr>
              )}
              {vehiclesRows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>{row.customerName || 'Sem cliente'}</td>
                  <td>{row.plate || '—'}</td>
                  <td>{fmtDateFull(row.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="actions fiscal-pagination-row">
          <p className="hint fiscal-pagination-info">{vehiclesPageInfo}</p>
          <div className="actions">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setVehiclesLoading(true)
                setVehiclesOffset((value) => Math.max(value - PAGE_SIZE, 0))
              }}
              disabled={vehiclesLoading || vehiclesOffset === 0}
            >
              Página anterior
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setVehiclesLoading(true)
                setVehiclesOffset((value) => value + PAGE_SIZE)
              }}
              disabled={vehiclesLoading || !canGoNext(vehiclesOffset, vehiclesRows.length, vehiclesTotalCount, PAGE_SIZE)}
            >
              Próxima página
            </button>
          </div>
        </div>

        <div className="divider" />

        <div className="fiscal-grid">
          <label>
            Buscar técnico
            <input
              value={techniciansQuery}
              onChange={(event) => {
                setTechniciansQuery(event.target.value)
                setTechniciansLoading(true)
                setTechniciansStatusText('')
                setTechniciansOffset(0)
              }}
            />
          </label>
          <label>
            Situação
            <Select
              value={techniciansActiveFilter}
              options={technicianActiveFilterOptions}
              onChange={(value) => {
                setTechniciansActiveFilter(value as '' | 'true' | 'false')
                setTechniciansLoading(true)
                setTechniciansStatusText('')
                setTechniciansOffset(0)
              }}
            />
          </label>
        </div>
        
        <div className="finance-table-wrapper">
          <table className="finance-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Contato</th>
                <th>Status</th>
                <th>Criação</th>
              </tr>
            </thead>
            <tbody>
              {techniciansRows.length === 0 && (
                <tr>
                  <td colSpan={4}>Nenhum técnico encontrado.</td>
                </tr>
              )}
              {techniciansRows.map((row) => (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>{row.email || row.phone || '—'}</td>
                  <td>
                    <span className={`fiscal-status-badge ${row.active ? 'success' : 'muted'}`}>
                      {row.active ? 'Ativo' : 'Inativo'}
                    </span>
                  </td>
                  <td>{fmtDateFull(row.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="actions fiscal-pagination-row">
          <p className="hint fiscal-pagination-info">{techniciansPageInfo}</p>
          <div className="actions">
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setTechniciansLoading(true)
                setTechniciansOffset((value) => Math.max(value - PAGE_SIZE, 0))
              }}
              disabled={techniciansLoading || techniciansOffset === 0}
            >
              Página anterior
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setTechniciansLoading(true)
                setTechniciansOffset((value) => value + PAGE_SIZE)
              }}
              disabled={techniciansLoading || !canGoNext(techniciansOffset, techniciansRows.length, techniciansTotalCount, PAGE_SIZE)}
            >
              Próxima página
            </button>
          </div>
        </div>
      </div>
      </TabPanel>
    </div>
  )
}
