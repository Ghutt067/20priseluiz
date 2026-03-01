import { useCallback, useEffect, useState } from 'react'
import {
  fetchContractsPaged,
  createContract,
  updateContractStatus,
  type ContractLookup,
} from '../../services/contracts'
import { searchCustomersPaged } from '../../services/core'
import {
  DataTable, Pagination, StatusBadge, useToast, type Column,
  DateInput, NumericInput, Select, SearchToolbar, PageHeader, KpiCard, KpiRow,
  SplitPane, DetailField, DetailGrid,
} from '../../components/ui'
import { useAuth } from '../../contexts/useAuth'
import { can } from '../../lib/permissions'
import { fmtDate, fmtCurrency } from '../../lib/formatters'

const PAGE_SIZE = 15

const statusLabels: Record<string, string> = { active: 'Ativo', paused: 'Pausado', cancelled: 'Cancelado' }

type ContractItem = { description: string; quantity: string; unitPrice: string }

export function ContratosPage() {
  const { toast } = useToast()
  const { role } = useAuth()
  const userRole = role ?? 'vendedor'
  const canCreateContract = can(userRole, 'contract.create')
  const canUpdateStatus = can(userRole, 'contract.status.update')
  const [contracts, setContracts] = useState<ContractLookup[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState('')

  const [selectedContract, setSelectedContract] = useState<ContractLookup | null>(null)
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [billingDay, setBillingDay] = useState('1')
  const [customerId, setCustomerId] = useState('')
  const [customerQuery, setCustomerQuery] = useState('')
  const [customerResults, setCustomerResults] = useState<Array<{ id: string; name: string }>>([])
  const [items, setItems] = useState<ContractItem[]>([{ description: '', quantity: '1', unitPrice: '0' }])

  const loadContracts = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetchContractsPaged({ status: statusFilter || undefined, limit: PAGE_SIZE, offset })
      setContracts(r.rows)
      setTotal(r.totalCount)
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro ao carregar contratos.', 'error') }
    setLoading(false)
  }, [statusFilter, offset])

  useEffect(() => { void loadContracts() }, [loadContracts])

  const searchCustomers = async (q: string) => {
    setCustomerQuery(q)
    if (!q.trim()) { setCustomerResults([]); return }
    try {
      const results = await searchCustomersPaged(q, { limit: 5 })
      setCustomerResults(results)
    } catch { setCustomerResults([]) }
  }

  const addItem = () => setItems((prev) => [...prev, { description: '', quantity: '1', unitPrice: '0' }])
  const removeItem = (index: number) => setItems((prev) => prev.filter((_, i) => i !== index))
  const updateItem = (index: number, field: keyof ContractItem, value: string) => {
    setItems((prev) => prev.map((item, i) => i === index ? { ...item, [field]: value } : item))
  }

  const openCreate = () => {
    setSelectedContract(null)
    setStartDate('')
    setEndDate('')
    setBillingDay('1')
    setCustomerId('')
    setCustomerQuery('')
    setCustomerResults([])
    setItems([{ description: '', quantity: '1', unitPrice: '0' }])
    setShowCreateForm(true)
  }

  const handleSave = async () => {
    if (!startDate || items.every((i) => !i.description.trim())) {
      toast('Preencha a data de início e ao menos um item.', 'warning')
      return
    }
    setSaving(true)
    try {
      await createContract({
        customerId: customerId || undefined,
        startDate,
        endDate: endDate || undefined,
        billingDay: Number(billingDay) || 1,
        items: items.filter((i) => i.description.trim()).map((i) => ({
          description: i.description,
          quantity: Number(i.quantity) || 1,
          unitPrice: Number(i.unitPrice) || 0,
        })),
      })
      toast('Contrato criado com sucesso.', 'success')
      setShowCreateForm(false)
      void loadContracts()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Erro ao criar contrato.', 'error')
    }
    setSaving(false)
  }

  const handleStatusChange = async (id: string, status: 'active' | 'paused' | 'cancelled') => {
    try {
      await updateContractStatus(id, status)
      toast('Status atualizado.', 'success')
      void loadContracts()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Erro.', 'error')
    }
  }

  const columns: Column<ContractLookup>[] = [
    { key: 'customerName', header: 'Cliente', render: (r) => <strong style={{ fontWeight: 500 }}>{r.customerName || 'Sem cliente'}</strong> },
    { key: 'startDate', header: 'Início', width: '90px', render: (r) => fmtDate(r.startDate) },
    { key: 'endDate', header: 'Fim', width: '90px', render: (r) => r.endDate ? fmtDate(r.endDate) : 'Indeterminado' },
    { key: 'billingDay', header: 'Dia cobrança', width: '100px', align: 'center', render: (r) => String(r.billingDay) },
    { key: 'totalAmount', header: 'Valor mensal', width: '110px', align: 'right', render: (r) => fmtCurrency(r.totalAmount) },
    { key: 'itemCount', header: 'Itens', width: '60px', align: 'center', render: (r) => String(r.itemCount) },
    { key: 'status', header: 'Status', width: '100px', render: (r) => <StatusBadge status={r.status} label={statusLabels[r.status] ?? r.status} /> },
    {
      key: 'actions', header: '', width: '130px', align: 'right',
      render: (r) => (
        <div className="row-actions">
          {canUpdateStatus && r.status === 'active' && (
            <>
              <button type="button" className="btn-inline" onClick={(e) => { e.stopPropagation(); void handleStatusChange(r.id, 'paused') }}>Pausar</button>
              <button type="button" className="btn-inline off" onClick={(e) => { e.stopPropagation(); void handleStatusChange(r.id, 'cancelled') }}>Cancelar</button>
            </>
          )}
          {canUpdateStatus && r.status === 'paused' && (
            <button type="button" className="btn-inline ok" onClick={(e) => { e.stopPropagation(); void handleStatusChange(r.id, 'active') }}>Reativar</button>
          )}
        </div>
      ),
    },
  ]

  const activeCount = contracts.filter((c) => c.status === 'active').length
  const monthlyValue = contracts.filter((c) => c.status === 'active').reduce((s, c) => s + Number(c.totalAmount), 0)

  const detailContent = showCreateForm ? (
    <div style={{ display: 'grid', gap: 14 }}>
      <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Novo Contrato</h3>
      <div className="fiscal-grid">
        <label>
          Cliente (opcional)
          <div style={{ position: 'relative' }}>
            <input value={customerQuery} onChange={(e) => void searchCustomers(e.target.value)} placeholder="Buscar cliente..." />
            {customerResults.length > 0 && (
              <div className="customer-dropdown" style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 10 }}>
                {customerResults.map((c) => (
                  <button key={c.id} type="button" className="customer-result" onClick={() => {
                    setCustomerId(c.id)
                    setCustomerQuery(c.name)
                    setCustomerResults([])
                  }}>{c.name}</button>
                ))}
              </div>
            )}
          </div>
        </label>
        <label>Data início * <DateInput value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
        <label>Data fim (opcional) <DateInput value={endDate} onChange={(e) => setEndDate(e.target.value)} /></label>
        <label>Dia de cobrança <NumericInput value={billingDay} onChange={(e) => setBillingDay(e.target.value)} /></label>
      </div>
      <h4 style={{ margin: 0, fontSize: '0.88rem' }}>Itens</h4>
      {items.map((item, index) => (
        <div key={index} style={{ display: 'flex', gap: 6, alignItems: 'end' }}>
          <label style={{ flex: 2 }}>Descrição <input value={item.description} onChange={(e) => updateItem(index, 'description', e.target.value)} /></label>
          <label style={{ width: 60 }}>Qtd <NumericInput value={item.quantity} onChange={(e) => updateItem(index, 'quantity', e.target.value)} /></label>
          <label style={{ width: 80 }}>Valor <NumericInput value={item.unitPrice} onChange={(e) => updateItem(index, 'unitPrice', e.target.value)} /></label>
          <button type="button" className="btn-inline off" onClick={() => removeItem(index)} disabled={items.length <= 1} style={{ marginBottom: 2 }}>✕</button>
        </div>
      ))}
      <button type="button" className="ghost" onClick={addItem} style={{ justifySelf: 'start', fontSize: '0.82rem' }}>+ Item</button>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <button type="button" className="ghost" onClick={() => setShowCreateForm(false)}>Cancelar</button>
        <button type="button" onClick={handleSave} disabled={saving}>{saving ? 'Processando...' : 'Confirmar'}</button>
      </div>
    </div>
  ) : selectedContract ? (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0, fontSize: '0.95rem' }}>{selectedContract.customerName || 'Sem cliente'}</h3>
        <StatusBadge status={selectedContract.status} label={statusLabels[selectedContract.status] ?? selectedContract.status} />
      </div>
      <DetailGrid columns={3}>
        <DetailField label="Início" value={fmtDate(selectedContract.startDate)} />
        <DetailField label="Fim" value={selectedContract.endDate ? fmtDate(selectedContract.endDate) : 'Indeterminado'} />
        <DetailField label="Dia cobrança" value={String(selectedContract.billingDay)} />
        <DetailField label="Valor mensal" value={fmtCurrency(selectedContract.totalAmount)} />
        <DetailField label="Itens" value={String(selectedContract.itemCount)} />
        <DetailField label="Status" value={statusLabels[selectedContract.status] ?? selectedContract.status} />
      </DetailGrid>
      {canUpdateStatus && (
        <div style={{ display: 'flex', gap: 6, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
          {selectedContract.status === 'active' && (
            <>
              <button type="button" className="ghost" onClick={() => void handleStatusChange(selectedContract.id, 'paused')}>Pausar</button>
              <button type="button" className="ghost" style={{ color: '#c44', borderColor: '#c44' }} onClick={() => void handleStatusChange(selectedContract.id, 'cancelled')}>Cancelar</button>
            </>
          )}
          {selectedContract.status === 'paused' && (
            <button type="button" onClick={() => void handleStatusChange(selectedContract.id, 'active')}>Reativar</button>
          )}
        </div>
      )}
    </div>
  ) : (
    <span>Selecione um contrato ou crie um novo</span>
  )

  return (
    <div className="page">
      <PageHeader />

      <KpiRow>
        <KpiCard label="Total" value={total} />
        <KpiCard label="Ativos" value={activeCount} tone="success" />
        <KpiCard label="Valor Mensal" value={fmtCurrency(monthlyValue)} />
      </KpiRow>

      <SplitPane
        hasSelection={showCreateForm || selectedContract !== null}
        list={
          <>
            <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
              <SearchToolbar query="" onQueryChange={() => {}} placeholder="Buscar contrato..." count={total}
                actions={
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Select value={statusFilter}
                      options={[
                        { value: '', label: 'Todos' },
                        { value: 'active', label: 'Ativos' },
                        { value: 'paused', label: 'Pausados' },
                        { value: 'cancelled', label: 'Cancelados' },
                      ]}
                      onChange={(v) => { setStatusFilter(v); setOffset(0) }}
                    />
                    {canCreateContract && <button type="button" onClick={openCreate}>+ Novo</button>}
                  </div>
                }
              />
            </div>
            <DataTable columns={columns} rows={contracts} rowKey={(r) => r.id} loading={loading}
              emptyMessage="Nenhum contrato encontrado."
              onRowClick={(r) => { setSelectedContract(r); setShowCreateForm(false) }} />
            <div style={{ padding: '8px 12px' }}>
              <Pagination total={total} offset={offset} limit={PAGE_SIZE} loading={loading} onPageChange={setOffset} />
            </div>
          </>
        }
        detail={detailContent}
      />
    </div>
  )
}
