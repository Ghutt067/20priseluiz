import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../contexts/useAuth'
import {
  StatusBadge, Tabs, TabPanel, DataTable, type Column, Select,
  SearchToolbar, PageHeader, KpiCard, KpiRow,
} from '../../components/ui'
import { useStatusToast } from '../../hooks/useStatusToast'
import { can } from '../../lib/permissions'
import { fmtDate, fmtDateTime } from '../../lib/formatters'
import {
  fetchRules, createRule, toggleRule, deleteRule, fetchExecutions,
  fetchSignatures, createSignatureRequest, updateSignatureStatus,
  type AutomationRule, type AutomationExecution, type SignatureRequest,
} from '../../services/automation'

type Tab = 'dashboard' | 'rules' | 'executions' | 'signatures'

const execResultLabel: Record<string, string> = { success: 'Sucesso', error: 'Erro', skipped: 'Ignorado' }
const sigStatusLabel: Record<string, string> = { pending: 'Pendente', sent: 'Enviado', signed: 'Assinado', refused: 'Recusado', expired: 'Expirado' }

function lbl(map: Record<string, string>, key: string | null | undefined): string { return map[key ?? ''] ?? key ?? '—' }

export function AutomacaoPage() {
  const { organizationId, role } = useAuth()
  const [tab, setTab] = useState<Tab>('dashboard')
  const [status, setStatus] = useState('')
  const [flowSearch, setFlowSearch] = useState('')
  const [executionSearch, setExecutionSearch] = useState('')

  const [showForm, setShowForm] = useState(false)

  const [rules, setRules] = useState<AutomationRule[]>([])
  const [rulesLoading, setRulesLoading] = useState(false)

  const [executions, setExecutions] = useState<AutomationExecution[]>([])
  const [execFilter, setExecFilter] = useState('')
  const [execLoading, setExecLoading] = useState(false)

  const [signatures, setSignatures] = useState<SignatureRequest[]>([])
  const [sigFilter, setSigFilter] = useState('')
  const [sigLoading, setSigLoading] = useState(false)

  useStatusToast(status)
  const canManage = can(role ?? '', 'automation.rule.manage')

  const tabItems = useMemo(() => [
    { key: 'dashboard' as const, label: 'Painel' },
    { key: 'rules' as const, label: 'Regras', count: rules.length },
    { key: 'executions' as const, label: 'Execuções', count: executions.length },
    { key: 'signatures' as const, label: 'Assinaturas', count: signatures.length },
  ], [rules.length, executions.length, signatures.length])

  const loadRules = useCallback(async () => {
    if (!organizationId) return; setRulesLoading(true)
    try { setRules(await fetchRules()) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setRulesLoading(false)
  }, [organizationId])

  const loadExec = useCallback(async () => {
    if (!organizationId) return; setExecLoading(true)
    try {
      const all = await fetchExecutions()
      setExecutions(execFilter ? all.filter(e => e.result === execFilter) : all)
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setExecLoading(false)
  }, [organizationId, execFilter])

  const loadSig = useCallback(async () => {
    if (!organizationId) return; setSigLoading(true)
    try {
      const all = await fetchSignatures(sigFilter || undefined)
      setSignatures(all)
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setSigLoading(false)
  }, [organizationId, sigFilter])

  useEffect(() => {
    if (tab === 'dashboard') { void loadRules(); void loadExec(); void loadSig() }
    if (tab === 'rules') void loadRules()
    if (tab === 'executions') void loadExec()
    if (tab === 'signatures') void loadSig()
  }, [tab, loadRules, loadExec, loadSig])

  const handleToggle = async (ruleId: string) => {
    try { await toggleRule(ruleId); void loadRules() } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }
  const handleDeleteRule = async (id: string) => {
    try { await deleteRule(id); setStatus('Regra excluída.'); void loadRules() } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }
  const handleSigStatus = async (id: string, s: string) => {
    try { await updateSignatureStatus(id, s); setStatus('Status atualizado.'); void loadSig() } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const dashActive = useMemo(() => rules.filter(r => r.active).length, [rules])
  const dashSuccess = useMemo(() => executions.filter(e => e.result === 'success').length, [executions])
  const dashPendingSig = useMemo(() => signatures.filter(s => s.status === 'pending' || s.status === 'sent').length, [signatures])

  const ruleCols: Column<AutomationRule>[] = useMemo(() => [
    { key: 'name', header: 'Nome', render: (r) => <strong>{r.name}</strong> },
    { key: 'trigger', header: 'Evento Gatilho', render: (r) => r.triggerEvent },
    { key: 'active', header: 'Ativo', render: (r) => r.active ? 'Sim' : 'Não' },
    { key: 'count', header: 'Execuções', align: 'right', render: (r) => r.executionCount },
    { key: 'lastTriggered', header: 'Último Disparo', render: (r) => fmtDateTime(r.lastTriggeredAt) },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (r: AutomationRule) => (
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" className="ghost" style={{ fontSize: 12 }} onClick={() => void handleToggle(r.id)}>{r.active ? 'Desativar' : 'Ativar'}</button>
          <button type="button" className="ghost" style={{ fontSize: 11, color: '#c44' }} onClick={() => void handleDeleteRule(r.id)}>Excluir</button>
        </div>
      ),
    }] : []),
  ], [canManage])

  const execCols: Column<AutomationExecution>[] = useMemo(() => [
    { key: 'rule', header: 'Regra', render: (e) => e.ruleName },
    { key: 'result', header: 'Resultado', render: (e) => <StatusBadge status={e.result} label={lbl(execResultLabel, e.result)} /> },
    { key: 'error', header: 'Erro', render: (e) => e.errorMessage ?? '—' },
    { key: 'date', header: 'Data', render: (e) => fmtDateTime(e.executedAt) },
  ], [])

  const sigCols: Column<SignatureRequest>[] = useMemo(() => [
    { key: 'docType', header: 'Documento', render: (s) => s.documentType },
    { key: 'provider', header: 'Provedor', render: (s) => s.provider },
    { key: 'signer', header: 'Assinante', render: (s) => `${s.signerName} (${s.signerEmail})` },
    { key: 'status', header: 'Status', render: (s) => <StatusBadge status={s.status} label={lbl(sigStatusLabel, s.status)} /> },
    { key: 'sent', header: 'Enviado', render: (s) => fmtDate(s.sentAt) },
    { key: 'signed', header: 'Assinado', render: (s) => fmtDate(s.signedAt) },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (s: SignatureRequest) => (
        <div style={{ display: 'flex', gap: 4 }}>
          {s.status === 'pending' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleSigStatus(s.id, 'sent')}>Enviar</button>}
          {s.status === 'sent' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleSigStatus(s.id, 'signed')}>Assinado</button>}
          {(s.status === 'pending' || s.status === 'sent') && <button type="button" className="ghost" style={{ fontSize: 11, color: '#c44' }} onClick={() => void handleSigStatus(s.id, 'refused')}>Recusar</button>}
        </div>
      ),
    }] : []),
  ], [canManage])

  const execOpts = [{ value: '', label: 'Todos' }, { value: 'success', label: 'Sucesso' }, { value: 'error', label: 'Erro' }]
  const sigOpts = [{ value: '', label: 'Todos' }, { value: 'pending', label: 'Pendente' }, { value: 'sent', label: 'Enviado' }, { value: 'signed', label: 'Assinado' }, { value: 'refused', label: 'Recusado' }]

  return (
    <div className="page">
      <PageHeader />
      <Tabs tabs={tabItems} active={tab} onChange={(k) => { setTab(k); setShowForm(false) }} />

      <TabPanel active={tab === 'dashboard'}>
        <KpiRow>
          <KpiCard label="Regras Ativas" value={dashActive} tone="success" />
          <KpiCard label="Execuções" value={executions.length} />
          <KpiCard label="Taxa Sucesso" value={executions.length > 0 ? `${Math.round((dashSuccess / executions.length) * 100)}%` : '—'} />
          <KpiCard label="Assinaturas Pendentes" value={dashPendingSig} tone={dashPendingSig > 0 ? 'warning' : 'default'} />
        </KpiRow>
      </TabPanel>

      <TabPanel active={tab === 'rules'}>
        <SearchToolbar query={flowSearch} onQueryChange={(v) => {}} placeholder="Buscar regra..." count={rules.length}
          actions={canManage ? <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Nova Regra'}</button> : undefined} />
        {showForm && <RuleForm onSaved={() => { setShowForm(false); setStatus('Regra criada.'); void loadRules() }} />}
        <DataTable columns={ruleCols} rows={rules} rowKey={(r) => r.id} loading={rulesLoading} />
      </TabPanel>

      <TabPanel active={tab === 'executions'}>
        <SearchToolbar query={flowSearch} onQueryChange={(v) => {}} placeholder="Buscar execução..." count={executions.length}
          actions={<Select value={execFilter} options={execOpts} onChange={setExecFilter} />} />
        <DataTable columns={execCols} rows={executions} rowKey={(e) => e.id} loading={execLoading} emptyMessage="Nenhuma execução registrada." />
      </TabPanel>

      <TabPanel active={tab === 'signatures'}>
        <SearchToolbar query={flowSearch} onQueryChange={(v) => {}} placeholder="Buscar assinatura..." count={signatures.length}
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              <Select value={sigFilter} options={sigOpts} onChange={setSigFilter} />
              {canManage && <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Solicitar Assinatura'}</button>}
            </div>
          } />
        {showForm && <SignatureForm onSaved={() => { setShowForm(false); setStatus('Assinatura solicitada.'); void loadSig() }} />}
        <DataTable columns={sigCols} rows={signatures} rowKey={(s) => s.id} loading={sigLoading} />
      </TabPanel>
    </div>
  )
}

function RuleForm({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState('')
  const [triggerEvent, setTriggerEvent] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const handleSubmit = async () => {
    if (!name || !triggerEvent) return; setSubmitting(true); setError('')
    try { await createRule({ name, triggerEvent, actions: [{ type: 'notification', channel: 'internal' }] }); onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : 'Erro.') } setSubmitting(false)
  }
  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}><div className="inline-create-body">
      <label>Nome da Regra * <input value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Alerta venda alta" /></label>
      <label>Evento Gatilho * <input value={triggerEvent} onChange={e => setTriggerEvent(e.target.value)} placeholder="Ex: sales_order.created" /></label>
      {error && <p style={{ color: '#c44' }}>{error}</p>}
    </div><div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
      <button type="button" disabled={!name || !triggerEvent || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Criar Regra'}</button>
    </div></div>
  )
}

function SignatureForm({ onSaved }: { onSaved: () => void }) {
  const [documentType, setDocumentType] = useState('contract')
  const [documentId, setDocumentId] = useState('')
  const [provider, setProvider] = useState('zapsign')
  const [signerName, setSignerName] = useState('')
  const [signerEmail, setSignerEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const handleSubmit = async () => {
    if (!documentId || !signerName || !signerEmail) return; setSubmitting(true); setError('')
    try { await createSignatureRequest({ documentType, documentId, provider: provider as 'zapsign' | 'docusign' | 'adobe_sign', signerName, signerEmail }); onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : 'Erro.') } setSubmitting(false)
  }
  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}><div className="inline-create-body">
      <label>Tipo Documento <input value={documentType} onChange={e => setDocumentType(e.target.value)} placeholder="contract, proposal..." /></label>
      <label>ID do Documento * <input value={documentId} onChange={e => setDocumentId(e.target.value)} placeholder="Código" /></label>
      <label>Provedor <select value={provider} onChange={e => setProvider(e.target.value)}><option value="zapsign">ZapSign</option><option value="docusign">DocuSign</option><option value="adobe_sign">Adobe Sign</option></select></label>
      <label>Nome do Assinante * <input value={signerName} onChange={e => setSignerName(e.target.value)} /></label>
      <label>E-mail do Assinante * <input type="email" value={signerEmail} onChange={e => setSignerEmail(e.target.value)} /></label>
      {error && <p style={{ color: '#c44' }}>{error}</p>}
    </div><div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
      <button type="button" disabled={!documentId || !signerName || !signerEmail || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Solicitar Assinatura'}</button>
    </div></div>
  )
}
