import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../contexts/useAuth'
import {
  StatusBadge, Tabs, TabPanel, DataTable, type Column, Select,
  SearchToolbar, PageHeader, KpiCard, KpiRow,
} from '../../components/ui'
import { useStatusToast } from '../../hooks/useStatusToast'
import { can } from '../../lib/permissions'
import { fmtDate, fmtQty } from '../../lib/formatters'
import {
  fetchCarbonSummary, createCarbonEntry, autoCalculateFleetCarbon,
  fetchComplianceReports, createComplianceReport, updateComplianceReport,
  type CarbonSummary, type ComplianceReport,
} from '../../services/esg'

type Tab = 'dashboard' | 'carbon' | 'compliance'

const compStatusLabel: Record<string, string> = { open: 'Aberto', investigating: 'Investigando', action_taken: 'Ação tomada', closed: 'Encerrado' }
const compTypeLabel: Record<string, string> = { complaint: 'Reclamação', observation: 'Observação', suggestion: 'Sugestão', irregularity: 'Irregularidade' }
const entryTypeLabel: Record<string, string> = { fuel: 'Combustível', electricity: 'Eletricidade', waste: 'Resíduos', transport: 'Transporte', other: 'Outro' }

function lbl(map: Record<string, string>, key: string | null | undefined): string { return map[key ?? ''] ?? key ?? '—' }

export function EsgPage() {
  const { organizationId, role } = useAuth()
  const [tab, setTab] = useState<Tab>('dashboard')
  const [status, setStatus] = useState('')
  const [compSearch, setCompSearch] = useState('')
  const [carbonSearch, setCarbonSearch] = useState('')

  const [showForm, setShowForm] = useState(false)

  const [carbonData, setCarbonData] = useState<CarbonSummary | null>(null)
  const [carbonLoading, setCarbonLoading] = useState(false)

  const [compliance, setCompliance] = useState<ComplianceReport[]>([])
  const [compFilter, setCompFilter] = useState('')
  const [compLoading, setCompLoading] = useState(false)

  useStatusToast(status)
  const canManage = can(role ?? '', 'esg.carbon.manage')

  const tabItems = useMemo(() => [
    { key: 'dashboard' as const, label: 'Painel' },
    { key: 'carbon' as const, label: 'Inventário de Carbono' },
    { key: 'compliance' as const, label: 'Canal de Denúncias', count: compliance.filter(c => c.status === 'open').length },
  ], [compliance])

  const loadCarbon = useCallback(async () => {
    if (!organizationId) return; setCarbonLoading(true)
    try { setCarbonData(await fetchCarbonSummary()) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setCarbonLoading(false)
  }, [organizationId])

  const loadComp = useCallback(async () => {
    if (!organizationId) return; setCompLoading(true)
    try { setCompliance(await fetchComplianceReports(compFilter || undefined)) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setCompLoading(false)
  }, [organizationId, compFilter])

  useEffect(() => {
    if (tab === 'dashboard') { void loadCarbon(); void loadComp() }
    if (tab === 'carbon') void loadCarbon()
    if (tab === 'compliance') void loadComp()
  }, [tab, loadCarbon, loadComp])

  const handleAutoCalc = async () => {
    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
    const end = now.toISOString().slice(0, 10)
    try {
      const r = await autoCalculateFleetCarbon(start, end)
      setStatus(`Auto-cálculo: ${fmtQty(r.totalLiters, 0)} litros → ${fmtQty(r.co2Kg, 2)} kg CO₂`)
      void loadCarbon()
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const handleCompStatus = async (id: string, s: string) => {
    try { await updateComplianceReport(id, { status: s }); setStatus('Status atualizado.'); void loadComp() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const dashOpen = useMemo(() => compliance.filter(c => c.status === 'open').length, [compliance])

  const carbonCols: Column<CarbonSummary['byType'][number]>[] = useMemo(() => [
    { key: 'type', header: 'Tipo', render: (r) => lbl(entryTypeLabel, r.entryType) },
    { key: 'co2', header: 'CO₂ (kg)', align: 'right', render: (r) => fmtQty(r.totalCo2Kg, 2) },
    { key: 'qty', header: 'Quantidade', align: 'right', render: (r) => fmtQty(r.totalQuantity, 2) },
    { key: 'entries', header: 'Entradas', align: 'right', render: (r) => r.entries },
  ], [])

  const compCols: Column<ComplianceReport>[] = useMemo(() => [
    { key: 'type', header: 'Tipo', render: (r) => lbl(compTypeLabel, r.reportType) },
    { key: 'desc', header: 'Descrição', render: (r) => r.description.length > 80 ? r.description.slice(0, 80) + '...' : r.description },
    { key: 'anon', header: 'Anônimo', render: (r) => r.isAnonymous ? 'Sim' : 'Não' },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} label={lbl(compStatusLabel, r.status)} /> },
    { key: 'created', header: 'Data', render: (r) => fmtDate(r.createdAt) },
    { key: 'resolved', header: 'Resolvido em', render: (r) => fmtDate(r.resolvedAt) },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (r: ComplianceReport) => (
        <div style={{ display: 'flex', gap: 4 }}>
          {r.status === 'open' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleCompStatus(r.id, 'investigating')}>Investigar</button>}
          {r.status === 'investigating' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleCompStatus(r.id, 'action_taken')}>Ação tomada</button>}
          {r.status === 'action_taken' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleCompStatus(r.id, 'closed')}>Encerrar</button>}
        </div>
      ),
    }] : []),
  ], [canManage])

  const compOpts = [
    { value: '', label: 'Todos' }, { value: 'open', label: 'Aberto' },
    { value: 'investigating', label: 'Investigando' }, { value: 'action_taken', label: 'Ação tomada' },
    { value: 'closed', label: 'Encerrado' },
  ]

  return (
    <div className="page">
      <PageHeader />
      <Tabs tabs={tabItems} active={tab} onChange={(k) => { setTab(k); setShowForm(false) }} />

      <TabPanel active={tab === 'dashboard'}>
        <KpiRow>
          <KpiCard label="CO₂ Total (kg)" value={carbonData ? fmtQty(carbonData.totalCo2Kg, 2) : '—'} />
          <KpiCard label="Tipos de Emissão" value={carbonData?.byType.length ?? 0} />
          <KpiCard label="Relatos Abertos" value={dashOpen} tone={dashOpen > 0 ? 'warning' : 'default'} />
          <KpiCard label="Total Relatos" value={compliance.length} />
        </KpiRow>
      </TabPanel>

      <TabPanel active={tab === 'carbon'}>
        <SearchToolbar query={compSearch} onQueryChange={(v) => {}} placeholder="Buscar emissão..." count={carbonData?.byType.length ?? 0}
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              {canManage && <button type="button" className="ghost" onClick={() => void handleAutoCalc()}>Auto-calcular Frota</button>}
              {canManage && <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Entrada Manual'}</button>}
            </div>
          }
        />
        {showForm && (
          <CarbonForm
            onSaved={() => {
              setShowForm(false)
              setStatus('Entrada registrada.')
              void loadCarbon()
            }}
            onCancel={() => setShowForm(false)}
          />
        )}
        <DataTable columns={carbonCols} rows={carbonData?.byType ?? []} rowKey={(r) => r.entryType} loading={carbonLoading} emptyMessage="Nenhuma entrada de carbono." />
      </TabPanel>

      <TabPanel active={tab === 'compliance'}>
        <SearchToolbar query={compSearch} onQueryChange={(v) => {}} placeholder="Buscar relato..." count={compliance.length}
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              <Select value={compFilter} options={compOpts} onChange={setCompFilter} />
              <button type="button" onClick={() => setShowForm(true)}>+ Novo relato</button>
            </div>
          }
        />
        {showForm && (
          <ComplianceForm
            onSaved={() => {
              setShowForm(false)
              setStatus('Relato registrado.')
              void loadComp()
            }}
            onCancel={() => setShowForm(false)}
          />
        )}
        <DataTable columns={compCols} rows={compliance} rowKey={(r) => r.id} loading={compLoading} emptyMessage="Nenhum relato registrado." />
      </TabPanel>

    </div>
  )
}

function CarbonForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [entryType, setEntryType] = useState('fuel')
  const [periodStart, setPeriodStart] = useState(new Date().toISOString().slice(0, 10))
  const [periodEnd, setPeriodEnd] = useState(new Date().toISOString().slice(0, 10))
  const [quantity, setQuantity] = useState('')
  const [unit, setUnit] = useState('liters')
  const [emissionFactor, setEmissionFactor] = useState('2.31')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!quantity) return
    setSubmitting(true); setError('')
    try {
      await createCarbonEntry({ entryType, periodStart, periodEnd, quantity: Number(quantity), unit, emissionFactor: Number(emissionFactor) })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <label>Tipo <select value={entryType} onChange={e => setEntryType(e.target.value)}><option value="fuel">Combustível</option><option value="electricity">Eletricidade</option><option value="waste">Resíduos</option><option value="transport">Transporte</option><option value="other">Outro</option></select></label>
        <label>Período Início <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} /></label>
        <label>Período Fim <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} /></label>
        <label>Quantidade * <input type="number" step="0.01" value={quantity} onChange={e => setQuantity(e.target.value)} /></label>
        <label>Unidade <input value={unit} onChange={e => setUnit(e.target.value)} placeholder="liters, kWh, kg..." /></label>
        <label>Fator de Emissão (kg CO₂/un) <input type="number" step="0.001" value={emissionFactor} onChange={e => setEmissionFactor(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={onCancel}>Cancelar</button>
        <button type="button" disabled={!quantity || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Registrar Entrada'}</button>
      </div>
    </div>
  )
}

function ComplianceForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [reportType, setReportType] = useState('complaint')
  const [description, setDescription] = useState('')
  const [isAnonymous, setIsAnonymous] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!description || description.length < 10) { setError('Descrição deve ter ao menos 10 caracteres.'); return }
    setSubmitting(true); setError('')
    try { await createComplianceReport({ reportType, description, isAnonymous }); onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : 'Erro.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <label>Tipo <select value={reportType} onChange={e => setReportType(e.target.value)}><option value="complaint">Reclamação</option><option value="observation">Observação</option><option value="suggestion">Sugestão</option><option value="irregularity">Irregularidade</option></select></label>
        <label>Descrição * <textarea rows={3} value={description} onChange={e => setDescription(e.target.value)} placeholder="Descreva o relato" style={{ width: '100%' }} /></label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={isAnonymous} onChange={e => setIsAnonymous(e.target.checked)} /> Enviar anonimamente
        </label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={onCancel}>Cancelar</button>
        <button type="button" disabled={!description || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Enviar Relato'}</button>
      </div>
    </div>
  )
}
