import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../contexts/useAuth'
import {
  StatusBadge, Tabs, TabPanel, DataTable, type Column, Select,
  SearchToolbar, PageHeader, KpiCard, KpiRow,
  DetailPanel, DetailField, DetailGrid,
} from '../../components/ui'
import { useStatusToast } from '../../hooks/useStatusToast'
import { can } from '../../lib/permissions'
import { fmtCurrency, fmtDate } from '../../lib/formatters'
import {
  fetchProcesses, createProcess, addProcessCost, nationalizeProcess,
  updateProcessStatus, fetchContainers, createContainer, updateContainerStatus,
  type ImportProcess, type ImportContainer,
} from '../../services/comex'

type Tab = 'dashboard' | 'processes' | 'containers' | 'nationalization'

const processStatusLabel: Record<string, string> = {
  draft: 'Rascunho', shipped: 'Embarcado', in_transit: 'Em trânsito',
  customs: 'Alfândega', nationalized: 'Nacionalizado',
}
const containerStatusLabel: Record<string, string> = {
  pending: 'Pendente', shipped: 'Embarcado', in_transit: 'Em trânsito',
  at_port: 'No porto', cleared: 'Liberado',
}
// eslint-disable-next-line react-refresh/only-export-components
export const costTypeLabel: Record<string, string> = {
  freight_intl: 'Frete Internacional', insurance: 'Seguro', import_tax: 'II',
  ipi: 'IPI', icms: 'ICMS', pis_cofins: 'PIS/COFINS', port_fees: 'Taxas Portuárias',
  customs_broker: 'Despachante', inland_freight: 'Frete Interno', other: 'Outro',
}

function lbl(map: Record<string, string>, key: string | null | undefined): string {
  return map[key ?? ''] ?? key ?? '—'
}

export function ComexPage() {
  const { organizationId, role } = useAuth()
  const [tab, setTab] = useState<Tab>('dashboard')
  const [status, setStatus] = useState('')
  const [showForm, setShowForm] = useState(false)

  const [processes, setProcesses] = useState<ImportProcess[]>([])
  const [procStatusFilter, setProcStatusFilter] = useState('')
  const [procLoading, setProcLoading] = useState(false)
  const [selectedProcess, setSelectedProcess] = useState<ImportProcess | null>(null)
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null)

  const [containers, setContainers] = useState<ImportContainer[]>([])
  const [contLoading, setContLoading] = useState(false)

  useStatusToast(status)
  const canManage = can(role ?? '', 'comex.process.create')

  const tabItems = useMemo(() => [
    { key: 'dashboard' as const, label: 'Painel' },
    { key: 'processes' as const, label: 'Processos', count: processes.length },
    { key: 'containers' as const, label: 'Containers' },
    { key: 'nationalization' as const, label: 'Nacionalização' },
  ], [processes.length])

  const loadProc = useCallback(async () => {
    if (!organizationId) return
    setProcLoading(true)
    try { setProcesses(await fetchProcesses(procStatusFilter || undefined)) }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setProcLoading(false)
  }, [organizationId, procStatusFilter])

  const loadCont = useCallback(async () => {
    if (!selectedProcessId) return
    setContLoading(true)
    try { setContainers(await fetchContainers(selectedProcessId)) }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setContLoading(false)
  }, [selectedProcessId])

  useEffect(() => {
    if (tab === 'dashboard' || tab === 'processes') void loadProc()
    if (tab === 'containers') void loadCont()
  }, [tab, loadProc, loadCont])

  const handleProcessStatus = async (id: string, s: string) => {
    try { await updateProcessStatus(id, { status: s }); setStatus('Status atualizado.'); void loadProc() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }
  const handleContainerStatus = async (id: string, s: string) => {
    try { await updateContainerStatus(id, { status: s }); setStatus('Status atualizado.'); void loadCont() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }
  const handleNationalize = async (processId: string) => {
    try {
      const r = await nationalizeProcess(processId)
      setStatus(`Nacionalização concluída: ${fmtCurrency(r.totalNationalized)} — ${r.itemsProcessed} itens.`)
      void loadProc()
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const procCols: Column<ImportProcess>[] = useMemo(() => [
    { key: 'ref', header: 'Referência', render: (p) => <strong>{p.referenceNumber ?? '—'}</strong> },
    { key: 'supplier', header: 'Fornecedor', render: (p) => p.supplierName ?? '—' },
    { key: 'incoterm', header: 'Incoterm', render: (p) => p.incoterm },
    { key: 'currency', header: 'Moeda', render: (p) => p.currency },
    { key: 'fob', header: 'FOB Total', align: 'right', render: (p) => fmtCurrency(p.totalFob) },
    { key: 'nat', header: 'Nacionalizado', align: 'right', render: (p) => fmtCurrency(p.totalNationalized) },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} label={lbl(processStatusLabel, p.status)} /> },
    { key: 'actions', header: 'Ações', render: (p) => (
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button type="button" className="ghost" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); setSelectedProcessId(p.id); setTab('containers') }}>Containers</button>
        {canManage && p.status === 'draft' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={(e) => { e.stopPropagation(); void handleProcessStatus(p.id, 'shipped') }}>Embarcar</button>}
        {canManage && p.status === 'shipped' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={(e) => { e.stopPropagation(); void handleProcessStatus(p.id, 'in_transit') }}>Em Trânsito</button>}
        {canManage && p.status === 'in_transit' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={(e) => { e.stopPropagation(); void handleProcessStatus(p.id, 'customs') }}>Alfândega</button>}
        {canManage && p.status === 'customs' && <button type="button" className="ghost" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); void handleNationalize(p.id) }}>Nacionalizar</button>}
      </div>
    )},
  ], [canManage])

  const contCols: Column<ImportContainer>[] = useMemo(() => [
    { key: 'num', header: 'Nº Container', render: (c) => c.containerNumber ?? '—' },
    { key: 'type', header: 'Tipo', render: (c) => c.containerType },
    { key: 'bl', header: 'Bill of Lading', render: (c) => c.billOfLading ?? '—' },
    { key: 'ship', header: 'Embarque', render: (c) => fmtDate(c.shippingDate) },
    { key: 'eta', header: 'ETA Porto', render: (c) => fmtDate(c.etaPort) },
    { key: 'arrival', header: 'Chegada Real', render: (c) => fmtDate(c.actualArrival) },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} label={lbl(containerStatusLabel, c.status)} /> },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (c: ImportContainer) => (
        <div style={{ display: 'flex', gap: 4 }}>
          {c.status === 'pending' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleContainerStatus(c.id, 'shipped')}>Embarcar</button>}
          {c.status === 'shipped' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleContainerStatus(c.id, 'in_transit')}>Em Trânsito</button>}
          {c.status === 'in_transit' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleContainerStatus(c.id, 'at_port')}>No Porto</button>}
          {c.status === 'at_port' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleContainerStatus(c.id, 'cleared')}>Liberado</button>}
        </div>
      ),
    }] : []),
  ], [canManage])

  const procStatusOpts = [
    { value: '', label: 'Todos' }, { value: 'draft', label: 'Rascunho' },
    { value: 'shipped', label: 'Embarcado' }, { value: 'in_transit', label: 'Em trânsito' },
    { value: 'customs', label: 'Alfândega' }, { value: 'nationalized', label: 'Nacionalizado' },
  ]

  const dashOpen = useMemo(() => processes.filter(p => !['nationalized'].includes(p.status)).length, [processes])
  const dashTransit = useMemo(() => processes.filter(p => p.status === 'in_transit').length, [processes])
  const dashCustoms = useMemo(() => processes.filter(p => p.status === 'customs').length, [processes])
  const dashFob = useMemo(() => processes.reduce((s, p) => s + Number(p.totalFob), 0), [processes])

  return (
    <div className="page">
      <PageHeader />
      <Tabs tabs={tabItems} active={tab} onChange={(k) => { setTab(k); setShowForm(false); setSelectedProcess(null) }} />

      <TabPanel active={tab === 'dashboard'}>
        <KpiRow>
          <KpiCard label="Processos Abertos" value={dashOpen} />
          <KpiCard label="Em Trânsito" value={dashTransit} tone="warning" />
          <KpiCard label="Na Alfândega" value={dashCustoms} tone={dashCustoms > 0 ? 'danger' : 'default'} />
          <KpiCard label="FOB Total" value={fmtCurrency(dashFob)} />
        </KpiRow>
      </TabPanel>

      <TabPanel active={tab === 'processes'}>
        <SearchToolbar
          query="" onQueryChange={() => {}} placeholder="Buscar processo..."
          count={processes.length}
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              <Select value={procStatusFilter} options={procStatusOpts} onChange={setProcStatusFilter} />
              {canManage && <button type="button" onClick={() => setShowForm(true)}>+ Novo Processo</button>}
            </div>
          }
        />
        {showForm && <ProcessForm onSaved={() => { setShowForm(false); setStatus('Processo criado.'); void loadProc() }} onCancel={() => setShowForm(false)} />}
        <DataTable columns={procCols} rows={processes} rowKey={(p) => p.id} loading={procLoading}
          onRowClick={(p) => setSelectedProcess(selectedProcess?.id === p.id ? null : p)} />

        {selectedProcess && (
          <DetailPanel open onClose={() => setSelectedProcess(null)}
            title={`Processo ${selectedProcess.referenceNumber ?? selectedProcess.id.slice(0, 8)}`}
            subtitle={`${selectedProcess.supplierName ?? '—'} • ${selectedProcess.incoterm}`}>
            <DetailGrid columns={4}>
              <DetailField label="Status" value={lbl(processStatusLabel, selectedProcess.status)} />
              <DetailField label="Moeda" value={selectedProcess.currency} />
              <DetailField label="Câmbio" value={selectedProcess.exchangeRate ? `R$ ${selectedProcess.exchangeRate}` : '—'} />
              <DetailField label="FOB Total" value={fmtCurrency(selectedProcess.totalFob)} />
              <DetailField label="Nacionalizado" value={fmtCurrency(selectedProcess.totalNationalized)} />
              <DetailField label="Criação" value={fmtDate(selectedProcess.createdAt)} />
            </DetailGrid>
          </DetailPanel>
        )}
      </TabPanel>

      <TabPanel active={tab === 'containers'}>
        
        {selectedProcessId && (
          <>
            <SearchToolbar
              query="" onQueryChange={() => {}} placeholder="Buscar container..."
              count={containers.length}
              actions={canManage ? <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Container'}</button> : undefined}
            />
            {showForm && <ContainerForm processId={selectedProcessId} onSaved={() => { setShowForm(false); setStatus('Container registrado.'); void loadCont() }} onCancel={() => setShowForm(false)} />}
            <DataTable columns={contCols} rows={containers} rowKey={(c) => c.id} loading={contLoading} emptyMessage="Nenhum container registrado." />
          </>
        )}
      </TabPanel>

      <TabPanel active={tab === 'nationalization'}>
        
        {selectedProcessId && <CostForm processId={selectedProcessId} onSaved={() => { setStatus('Custo adicionado.') }} />}
        
      </TabPanel>
    </div>
  )
}

function ProcessForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [referenceNumber, setReferenceNumber] = useState('')
  const [incoterm, setIncoterm] = useState('FOB')
  const [currency, setCurrency] = useState('USD')
  const [exchangeRate, setExchangeRate] = useState('')
  const [productId, setProductId] = useState('')
  const [qty, setQty] = useState('')
  const [fobPrice, setFobPrice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!productId || !qty || !fobPrice) return
    setSubmitting(true); setError('')
    try {
      await createProcess({
        referenceNumber: referenceNumber || undefined, incoterm, currency,
        exchangeRate: exchangeRate ? Number(exchangeRate) : undefined,
        items: [{ productId, quantity: Number(qty), fobUnitPrice: Number(fobPrice) }],
      })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <label>Referência <input value={referenceNumber} onChange={e => setReferenceNumber(e.target.value)} /></label>
        <label>Incoterm <select value={incoterm} onChange={e => setIncoterm(e.target.value)}><option>FOB</option><option>CIF</option><option>EXW</option><option>DDP</option></select></label>
        <label>Moeda <input value={currency} onChange={e => setCurrency(e.target.value)} /></label>
        <label>Câmbio (R$) <input type="number" step="0.0001" value={exchangeRate} onChange={e => setExchangeRate(e.target.value)} /></label>
        <h4 style={{ margin: '8px 0 4px' }}>Item</h4>
        <label>ID Produto * <input value={productId} onChange={e => setProductId(e.target.value)} placeholder="Código" /></label>
        <label>Quantidade * <input type="number" value={qty} onChange={e => setQty(e.target.value)} /></label>
        <label>Preço FOB Unitário * <input type="number" step="0.01" value={fobPrice} onChange={e => setFobPrice(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={onCancel}>Cancelar</button>
        <button type="button" disabled={!productId || !qty || !fobPrice || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Criar Processo'}</button>
      </div>
    </div>
  )
}

function ContainerForm({ processId, onSaved, onCancel }: { processId: string; onSaved: () => void; onCancel: () => void }) {
  const [containerNumber, setContainerNumber] = useState('')
  const [containerType, setContainerType] = useState('40ft')
  const [billOfLading, setBillOfLading] = useState('')
  const [shippingDate, setShippingDate] = useState('')
  const [etaPort, setEtaPort] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    setSubmitting(true); setError('')
    try {
      await createContainer({ processId, containerNumber: containerNumber || undefined, containerType, billOfLading: billOfLading || undefined, shippingDate: shippingDate || undefined, etaPort: etaPort || undefined })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <label>Nº Container <input value={containerNumber} onChange={e => setContainerNumber(e.target.value)} /></label>
        <label>Tipo <select value={containerType} onChange={e => setContainerType(e.target.value)}><option value="20ft">20ft</option><option value="40ft">40ft</option><option value="40hc">40HC</option><option value="reefer">Reefer</option></select></label>
        <label>Bill of Lading <input value={billOfLading} onChange={e => setBillOfLading(e.target.value)} /></label>
        <label>Data Embarque <input type="date" value={shippingDate} onChange={e => setShippingDate(e.target.value)} /></label>
        <label>ETA Porto <input type="date" value={etaPort} onChange={e => setEtaPort(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={onCancel}>Cancelar</button>
        <button type="button" disabled={submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Adicionar Container'}</button>
      </div>
    </div>
  )
}

function CostForm({ processId, onSaved }: { processId: string; onSaved: () => void }) {
  const [costType, setCostType] = useState('freight_intl')
  const [amountOriginal, setAmountOriginal] = useState('')
  const [amountBrl, setAmountBrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!amountBrl) return
    setSubmitting(true); setError('')
    try {
      await addProcessCost(processId, { costType, amountOriginal: Number(amountOriginal) || 0, amountBrl: Number(amountBrl) })
      setAmountOriginal(''); setAmountBrl('')
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro.') }
    setSubmitting(false)
  }

  return (
    <div style={{ marginTop: 16, padding: 12, background: 'var(--color-bg-alt, #f9f9f9)', borderRadius: 8 }}>
      <strong>Adicionar Custo de Importação</strong>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <select value={costType} onChange={e => setCostType(e.target.value)}>
          <option value="freight_intl">Frete Internacional</option><option value="insurance">Seguro</option>
          <option value="import_tax">II</option><option value="ipi">IPI</option><option value="icms">ICMS</option>
          <option value="pis_cofins">PIS/COFINS</option><option value="port_fees">Taxas Portuárias</option>
          <option value="customs_broker">Despachante</option><option value="inland_freight">Frete Interno</option>
          <option value="other">Outro</option>
        </select>
        <input type="number" step="0.01" placeholder="Valor Original" value={amountOriginal} onChange={e => setAmountOriginal(e.target.value)} style={{ width: 130 }} />
        <input type="number" step="0.01" placeholder="Valor (R$)" value={amountBrl} onChange={e => setAmountBrl(e.target.value)} style={{ width: 130 }} />
        <button type="button" disabled={!amountBrl || submitting} onClick={() => void handleSubmit()}>{submitting ? '...' : 'Adicionar'}</button>
      </div>
      {error && <p style={{ color: '#c44', fontSize: 12 }}>{error}</p>}
    </div>
  )
}
