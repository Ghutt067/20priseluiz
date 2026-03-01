import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../contexts/useAuth'
import {
  StatusBadge, Tabs, TabPanel, DataTable, type Column, Select,
  SearchToolbar, PageHeader, KpiCard, KpiRow,
} from '../../components/ui'
import { useStatusToast } from '../../hooks/useStatusToast'
import { can } from '../../lib/permissions'
import { fmtDate } from '../../lib/formatters'
import {
  fetchNcrs, createNcr, updateNcr, fetchCalibration, createCalibrationInstrument,
  fetchDocuments, createDocument, approveDocument,
  type NcrReport, type CalibrationInstrument, type ControlledDocument,
} from '../../services/quality'

type Tab = 'dashboard' | 'ncr' | 'calibration' | 'documents'

const ncrStatusLabel: Record<string, string> = {
  open: 'Aberta', analyzing: 'Analisando', action_plan: 'Plano de Ação',
  implementing: 'Implementando', verifying: 'Verificando', closed: 'Fechada',
}
const ncrTypeLabel: Record<string, string> = {
  product: 'Produto', process: 'Processo', supplier: 'Fornecedor', customer: 'Cliente', internal: 'Interna',
}
const severityLabel: Record<string, string> = { low: 'Baixa', medium: 'Média', high: 'Alta', critical: 'Crítica' }
const calStatusLabel: Record<string, string> = { ok: 'OK', due_soon: 'Próxima', overdue: 'Vencida' }
const docStatusLabel: Record<string, string> = { draft: 'Rascunho', review: 'Revisão', approved: 'Aprovado', obsolete: 'Obsoleto' }
const docTypeLabel: Record<string, string> = { manual: 'Manual', norm: 'Norma', pop: 'POP', instruction: 'Instrução', form: 'Formulário', policy: 'Política' }

function lbl(map: Record<string, string>, key: string | null | undefined): string { return map[key ?? ''] ?? key ?? '—' }

export function QualidadePage() {
  const { organizationId, role } = useAuth()
  const [tab, setTab] = useState<Tab>('dashboard')
  const [status, setStatus] = useState('')
  const [ncrSearch, setNcrSearch] = useState('')
  const [calSearch, setCalSearch] = useState('')
  const [docSearch, setDocSearch] = useState('')

  const [showForm, setShowForm] = useState(false)

  const [ncrs, setNcrs] = useState<NcrReport[]>([])
  const [ncrStatusFilter, setNcrStatusFilter] = useState('')
  const [ncrLoading, setNcrLoading] = useState(false)

  const [instruments, setInstruments] = useState<CalibrationInstrument[]>([])
  const [calStatusFilter, setCalStatusFilter] = useState('')
  const [calLoading, setCalLoading] = useState(false)

  const [docs, setDocs] = useState<ControlledDocument[]>([])
  const [docStatusFilter, setDocStatusFilter] = useState('')
  const [docsLoading, setDocsLoading] = useState(false)

  useStatusToast(status)
  const canManage = can(role ?? '', 'quality.ncr.create')

  const tabItems = useMemo(() => [
    { key: 'dashboard' as const, label: 'Painel' },
    { key: 'ncr' as const, label: 'RNC / CAPA', count: ncrs.length },
    { key: 'calibration' as const, label: 'Calibração', count: instruments.length },
    { key: 'documents' as const, label: 'Documentos (GED)', count: docs.length },
  ], [ncrs.length, instruments.length, docs.length])

  const loadNcrs = useCallback(async () => {
    if (!organizationId) return; setNcrLoading(true)
    try { setNcrs(await fetchNcrs(ncrStatusFilter || undefined)) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setNcrLoading(false)
  }, [organizationId, ncrStatusFilter])

  const loadCal = useCallback(async () => {
    if (!organizationId) return; setCalLoading(true)
    try {
      const all = await fetchCalibration(calStatusFilter || undefined)
      setInstruments(all)
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setCalLoading(false)
  }, [organizationId, calStatusFilter])

  const loadDocs = useCallback(async () => {
    if (!organizationId) return; setDocsLoading(true)
    try { setDocs(await fetchDocuments(docStatusFilter || undefined)) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setDocsLoading(false)
  }, [organizationId, docStatusFilter])

  useEffect(() => {
    if (tab === 'dashboard') { void loadNcrs(); void loadCal() }
    if (tab === 'ncr') void loadNcrs()
    if (tab === 'calibration') void loadCal()
    if (tab === 'documents') void loadDocs()
  }, [tab, loadNcrs, loadCal, loadDocs])

  const handleApproveDoc = async (docId: string) => {
    try { await approveDocument(docId); setStatus('Documento aprovado.'); void loadDocs() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const dashOpenNcr = useMemo(() => ncrs.filter(n => n.status !== 'closed').length, [ncrs])
  const dashCritical = useMemo(() => ncrs.filter(n => n.severity === 'critical' && n.status !== 'closed').length, [ncrs])
  const dashOverdue = useMemo(() => instruments.filter(i => i.status === 'overdue').length, [instruments])

  const ncrCols: Column<NcrReport>[] = useMemo(() => [
    { key: 'num', header: '#', width: '60px', render: (n) => n.ncrNumber },
    { key: 'type', header: 'Tipo', render: (n) => lbl(ncrTypeLabel, n.ncrType) },
    { key: 'title', header: 'Título', render: (n) => <strong>{n.title}</strong> },
    { key: 'severity', header: 'Severidade', render: (n) => <StatusBadge status={n.severity} label={lbl(severityLabel, n.severity)} /> },
    { key: 'status', header: 'Status', render: (n) => <StatusBadge status={n.status} label={lbl(ncrStatusLabel, n.status)} /> },
    { key: 'created', header: 'Criação', render: (n) => fmtDate(n.createdAt) },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (n: NcrReport) => (
        n.status !== 'closed' ? (
          <select defaultValue="" onChange={async e => { if (e.target.value) { try { await updateNcr(n.id, { status: e.target.value }); setStatus('Status atualizado.'); void loadNcrs() } catch { /* */ } } }} style={{ fontSize: 12 }}>
            <option value="" disabled>Mudar status</option>
            <option value="analyzing">Analisando</option><option value="action_plan">Plano de Ação</option>
            <option value="implementing">Implementando</option><option value="verifying">Verificando</option><option value="closed">Fechar</option>
          </select>
        ) : null
      ),
    }] : []),
  ], [canManage])

  const calCols: Column<CalibrationInstrument>[] = useMemo(() => [
    { key: 'code', header: 'Código', render: (i) => <strong>{i.code}</strong> },
    { key: 'name', header: 'Nome', render: (i) => i.name },
    { key: 'type', header: 'Tipo', render: (i) => i.instrumentType ?? '—' },
    { key: 'interval', header: 'Intervalo (dias)', align: 'right', render: (i) => i.calibrationIntervalDays },
    { key: 'last', header: 'Última Cal.', render: (i) => fmtDate(i.lastCalibration) },
    { key: 'next', header: 'Próxima Cal.', render: (i) => fmtDate(i.nextCalibration) },
    { key: 'status', header: 'Status', render: (i) => <StatusBadge status={i.status} label={lbl(calStatusLabel, i.status)} /> },
  ], [])

  const docCols: Column<ControlledDocument>[] = useMemo(() => [
    { key: 'title', header: 'Título', render: (d) => <strong>{d.title}</strong> },
    { key: 'type', header: 'Tipo', render: (d) => lbl(docTypeLabel, d.docType) },
    { key: 'version', header: 'Versão', render: (d) => d.currentVersion },
    { key: 'status', header: 'Status', render: (d) => <StatusBadge status={d.status} label={lbl(docStatusLabel, d.status)} /> },
    { key: 'approved', header: 'Aprovado em', render: (d) => fmtDate(d.approvedAt) },
    { key: 'created', header: 'Criação', render: (d) => fmtDate(d.createdAt) },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (d: ControlledDocument) => (
        d.status !== 'approved' ? <button type="button" className="ghost" style={{ fontSize: 12 }} onClick={() => void handleApproveDoc(d.id)}>Aprovar</button> : null
      ),
    }] : []),
  ], [canManage])

  const ncrStatusOpts = [
    { value: '', label: 'Todos' }, { value: 'open', label: 'Aberta' },
    { value: 'analyzing', label: 'Analisando' }, { value: 'action_plan', label: 'Plano de Ação' },
    { value: 'implementing', label: 'Implementando' }, { value: 'closed', label: 'Fechada' },
  ]
  const calStatusOpts = [
    { value: '', label: 'Todos' }, { value: 'ok', label: 'OK' },
    { value: 'due_soon', label: 'Próxima' }, { value: 'overdue', label: 'Vencida' },
  ]
  const docStatusOpts = [
    { value: '', label: 'Todos' }, { value: 'draft', label: 'Rascunho' },
    { value: 'review', label: 'Revisão' }, { value: 'approved', label: 'Aprovado' },
  ]

  return (
    <div className="page">
      <PageHeader />
      <Tabs tabs={tabItems} active={tab} onChange={(k) => { setTab(k); setShowForm(false) }} />

      <TabPanel active={tab === 'dashboard'}>
        <KpiRow>
          <KpiCard label="RNCs Abertas" value={dashOpenNcr} tone={dashOpenNcr > 0 ? 'warning' : 'default'} />
          <KpiCard label="Críticas" value={dashCritical} tone={dashCritical > 0 ? 'danger' : 'default'} />
          <KpiCard label="Calibrações Vencidas" value={dashOverdue} tone={dashOverdue > 0 ? 'danger' : 'default'} />
          <KpiCard label="Documentos" value={docs.length} />
        </KpiRow>
        {dashOverdue > 0 && (
          <div className="card" style={{ borderLeft: '3px solid #c44' }}>
            <strong>{dashOverdue} instrumento(s) com calibração vencida</strong>
          </div>
        )}
      </TabPanel>

      <TabPanel active={tab === 'ncr'}>
        <SearchToolbar query={ncrSearch} onQueryChange={(v) => {}} placeholder="Buscar RNC..."
          count={ncrs.length}
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              <Select value={ncrStatusFilter} options={ncrStatusOpts} onChange={setNcrStatusFilter} />
              {canManage && <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Nova RNC'}</button>}
            </div>
          }
        />
        {showForm && <NcrForm onSaved={() => { setShowForm(false); setStatus('RNC criada.'); void loadNcrs() }} onCancel={() => setShowForm(false)} />}
        <DataTable columns={ncrCols} rows={ncrs} rowKey={(n) => n.id} loading={ncrLoading} />
      </TabPanel>

      <TabPanel active={tab === 'calibration'}>
        <SearchToolbar query={calSearch} onQueryChange={(v) => {}} placeholder="Buscar instrumento..."
          count={instruments.length}
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              <Select value={calStatusFilter} options={calStatusOpts} onChange={setCalStatusFilter} />
              {canManage && <button type="button" onClick={() => setShowForm(true)}>+ Instrumento</button>}
            </div>
          }
        />
        {showForm && <CalibrationForm onSaved={() => { setShowForm(false); setStatus('Instrumento cadastrado.'); void loadCal() }} onCancel={() => setShowForm(false)} />}
        <DataTable columns={calCols} rows={instruments} rowKey={(i) => i.id} loading={calLoading} />
      </TabPanel>

      <TabPanel active={tab === 'documents'}>
        <SearchToolbar query={docSearch} onQueryChange={(v) => {}} placeholder="Buscar documento..."
          count={docs.length}
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              <Select value={docStatusFilter} options={docStatusOpts} onChange={setDocStatusFilter} />
              {canManage && <button type="button" onClick={() => setShowForm(true)}>+ Documento</button>}
            </div>
          }
        />
        {showForm && <DocumentForm onSaved={() => { setShowForm(false); setStatus('Documento criado.'); void loadDocs() }} onCancel={() => setShowForm(false)} />}
        <DataTable columns={docCols} rows={docs} rowKey={(d) => d.id} loading={docsLoading} />
      </TabPanel>
    </div>
  )
}

function NcrForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [ncrType, setNcrType] = useState('internal')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [severity, setSeverity] = useState('medium')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const handleSubmit = async () => {
    if (!title) return; setSubmitting(true); setError('')
    try { await createNcr({ ncrType, title, description: description || undefined, severity }); onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : 'Erro.') } setSubmitting(false)
  }
  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}><div className="inline-create-body">
      <label>Tipo <select value={ncrType} onChange={e => setNcrType(e.target.value)}><option value="product">Produto</option><option value="process">Processo</option><option value="supplier">Fornecedor</option><option value="customer">Cliente</option><option value="internal">Interna</option></select></label>
      <label>Título * <input value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>Descrição <input value={description} onChange={e => setDescription(e.target.value)} /></label>
      <label>Severidade <select value={severity} onChange={e => setSeverity(e.target.value)}><option value="low">Baixa</option><option value="medium">Média</option><option value="high">Alta</option><option value="critical">Crítica</option></select></label>
      {error && <p style={{ color: '#c44' }}>{error}</p>}
    </div><div className="inline-create-footer">
        <button type="button" className="ghost" onClick={onCancel}>Cancelar</button>
      <button type="button" disabled={!title || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Criar RNC'}</button>
    </div></div>
  )
}

function CalibrationForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [instrumentType, setInstrumentType] = useState('')
  const [intervalDays, setIntervalDays] = useState('365')
  const [lastCal, setLastCal] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const handleSubmit = async () => {
    if (!name || !code) return; setSubmitting(true); setError('')
    try { await createCalibrationInstrument({ name, code, instrumentType: instrumentType || undefined, calibrationIntervalDays: Number(intervalDays) || 365, lastCalibration: lastCal || undefined }); onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : 'Erro.') } setSubmitting(false)
  }
  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}><div className="inline-create-body">
      <label>Nome * <input value={name} onChange={e => setName(e.target.value)} /></label>
      <label>Código * <input value={code} onChange={e => setCode(e.target.value)} /></label>
      <label>Tipo <input value={instrumentType} onChange={e => setInstrumentType(e.target.value)} placeholder="Paquímetro, Micrômetro..." /></label>
      <label>Intervalo (dias) <input type="number" value={intervalDays} onChange={e => setIntervalDays(e.target.value)} /></label>
      <label>Última Calibração <input type="date" value={lastCal} onChange={e => setLastCal(e.target.value)} /></label>
      {error && <p style={{ color: '#c44' }}>{error}</p>}
    </div><div className="inline-create-footer">
        <button type="button" className="ghost" onClick={onCancel}>Cancelar</button>
      <button type="button" disabled={!name || !code || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Cadastrar Instrumento'}</button>
    </div></div>
  )
}

function DocumentForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState('')
  const [docType, setDocType] = useState('pop')
  const [contentUrl, setContentUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const handleSubmit = async () => {
    if (!title) return; setSubmitting(true); setError('')
    try { await createDocument({ title, docType, contentUrl: contentUrl || undefined }); onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : 'Erro.') } setSubmitting(false)
  }
  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}><div className="inline-create-body">
      <label>Título * <input value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label>Tipo <select value={docType} onChange={e => setDocType(e.target.value)}><option value="manual">Manual</option><option value="norm">Norma</option><option value="pop">POP</option><option value="instruction">Instrução</option><option value="form">Formulário</option><option value="policy">Política</option></select></label>
      <label>URL do Conteúdo <input value={contentUrl} onChange={e => setContentUrl(e.target.value)} placeholder="https://..." /></label>
      {error && <p style={{ color: '#c44' }}>{error}</p>}
    </div><div className="inline-create-footer">
        <button type="button" className="ghost" onClick={onCancel}>Cancelar</button>
      <button type="button" disabled={!title || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Criar Documento'}</button>
    </div></div>
  )
}
