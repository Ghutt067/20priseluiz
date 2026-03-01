import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../contexts/useAuth'
import {
  StatusBadge, Tabs, TabPanel, DataTable, type Column,
  SearchToolbar, PageHeader, KpiCard, KpiRow, Select,
  DetailField, DetailGrid, SplitPane,
} from '../../components/ui'
import { useStatusToast } from '../../hooks/useStatusToast'
import { can } from '../../lib/permissions'
import { fmtCurrency, fmtDate, fmtQty } from '../../lib/formatters'
import {
  fetchLoans, createLoan, updateLoanStatus, fetchLoanInstallments, payLoanInstallment,
  fetchIntercompany, createIntercompanyTransfer, updateIntercompanyStatus,
  type TreasuryLoan, type LoanInstallment, type IntercompanyTransfer,
} from '../../services/treasury'

type Tab = 'dashboard' | 'loans' | 'installments' | 'intercompany'

const loanStatusLabel: Record<string, string> = {
  active: 'Ativo', paid_off: 'Quitado', cancelled: 'Cancelado',
}
const loanTypeLabel: Record<string, string> = { loan: 'Empréstimo', investment: 'Aplicação' }
const installmentStatusLabel: Record<string, string> = {
  open: 'Em aberto', paid: 'Pago', overdue: 'Vencido',
}
const icStatusLabel: Record<string, string> = {
  pending: 'Pendente', approved: 'Aprovado', completed: 'Concluído', cancelled: 'Cancelado',
}
const icTypeLabel: Record<string, string> = { financial: 'Financeiro', merchandise: 'Mercadoria' }

function lbl(map: Record<string, string>, key: string | null | undefined): string {
  return map[key ?? ''] ?? key ?? '—'
}

type TreasuryDash = { totalDebt: number; totalActive: number; overdueInstallments: number; pendingIc: number }

export function TesourariaPage() {
  const { organizationId, role } = useAuth()
  const [tab, setTab] = useState<Tab>('dashboard')
  const [status, setStatus] = useState('')
  const [showForm, setShowForm] = useState(false)

  const [dash, setDash] = useState<TreasuryDash | null>(null)
  const [dashLoading, setDashLoading] = useState(false)

  const [loans, setLoans] = useState<TreasuryLoan[]>([])
  const [loanStatusFilter, setLoanStatusFilter] = useState('')
  const [loansLoading, setLoansLoading] = useState(false)
  const [selectedLoan, setSelectedLoan] = useState<TreasuryLoan | null>(null)

  const [installments, setInstallments] = useState<LoanInstallment[]>([])
  const [installmentFilter, setInstallmentFilter] = useState('')
  const [installLoading, setInstallLoading] = useState(false)
  const [selectedLoanId, setSelectedLoanId] = useState<string | null>(null)

  const [intercompany, setIntercompany] = useState<IntercompanyTransfer[]>([])
  const [icStatusFilter, setIcStatusFilter] = useState('')
  const [icLoading, setIcLoading] = useState(false)

  useStatusToast(status)
  const canManage = can(role ?? '', 'treasury.loan.create')

  const tabItems = useMemo(() => [
    { key: 'dashboard' as const, label: 'Painel' },
    { key: 'loans' as const, label: 'Empréstimos', count: loans.length },
    { key: 'installments' as const, label: 'Amortização' },
    { key: 'intercompany' as const, label: 'Intercompany', count: intercompany.length },
  ], [loans.length, intercompany.length])

  const loadDash = useCallback(async () => {
    if (!organizationId) return
    setDashLoading(true)
    try {
      const [lo, ic] = await Promise.all([fetchLoans(), fetchIntercompany()])
      const active = lo.filter(l => l.status === 'active')
      setDash({
        totalDebt: active.reduce((s, l) => s + Number(l.principalAmount), 0),
        totalActive: active.length,
        overdueInstallments: 0,
        pendingIc: ic.filter(i => i.status === 'pending').length,
      })
    } catch { /* */ }
    setDashLoading(false)
  }, [organizationId])

  const loadLoans = useCallback(async () => {
    if (!organizationId) return
    setLoansLoading(true)
    try {
      const all = await fetchLoans(loanStatusFilter || undefined)
      setLoans(all)
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setLoansLoading(false)
  }, [organizationId, loanStatusFilter])

  const loadInstallments = useCallback(async () => {
    if (!selectedLoanId) return
    setInstallLoading(true)
    try {
      const all = await fetchLoanInstallments(selectedLoanId)
      setInstallments(installmentFilter ? all.filter(i => i.status === installmentFilter) : all)
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setInstallLoading(false)
  }, [selectedLoanId, installmentFilter])

  const loadIc = useCallback(async () => {
    if (!organizationId) return
    setIcLoading(true)
    try {
      const all = await fetchIntercompany()
      setIntercompany(icStatusFilter ? all.filter(i => i.status === icStatusFilter) : all)
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setIcLoading(false)
  }, [organizationId, icStatusFilter])

  useEffect(() => {
    if (tab === 'dashboard') void loadDash()
    if (tab === 'loans') void loadLoans()
    if (tab === 'installments') void loadInstallments()
    if (tab === 'intercompany') void loadIc()
  }, [tab, loadDash, loadLoans, loadInstallments, loadIc])

  const handleLoanStatus = async (id: string, s: string) => {
    try { await updateLoanStatus(id, s); setStatus('Status atualizado.'); void loadLoans() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }
  const handlePayInstallment = async (id: string) => {
    try { await payLoanInstallment(id); setStatus('Parcela paga.'); void loadInstallments() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }
  const handleIcStatus = async (id: string, s: string) => {
    try { await updateIntercompanyStatus(id, s); setStatus('Status atualizado.'); void loadIc() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const loanCols: Column<TreasuryLoan>[] = useMemo(() => [
    { key: 'type', header: 'Tipo', render: (l) => lbl(loanTypeLabel, l.loanType) },
    { key: 'bank', header: 'Banco', render: (l) => l.bankName ?? '—' },
    { key: 'principal', header: 'Principal', align: 'right', render: (l) => fmtCurrency(l.principalAmount) },
    { key: 'rate', header: 'Taxa (%a.a.)', align: 'right', render: (l) => `${fmtQty(l.interestRate, 2)}%` },
    { key: 'system', header: 'Sistema', render: (l) => l.amortizationSystem.toUpperCase() },
    { key: 'installments', header: 'Parcelas', align: 'right', render: (l) => l.totalInstallments },
    { key: 'start', header: 'Início', render: (l) => fmtDate(l.startDate) },
    { key: 'status', header: 'Status', render: (l) => <StatusBadge status={l.status} label={lbl(loanStatusLabel, l.status)} /> },
    { key: 'actions', header: 'Ações', render: (l) => (
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button type="button" className="ghost" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); setSelectedLoanId(l.id); setTab('installments') }}>Parcelas</button>
        {canManage && l.status === 'active' && <button type="button" className="ghost" style={{ fontSize: 11, color: '#c44' }} onClick={(e) => { e.stopPropagation(); void handleLoanStatus(l.id, 'cancelled') }}>Cancelar</button>}
      </div>
    )},
  ], [canManage])

  const installCols: Column<LoanInstallment>[] = useMemo(() => [
    { key: 'num', header: '#', width: '50px', render: (i) => i.installmentNumber },
    { key: 'due', header: 'Vencimento', render: (i) => fmtDate(i.dueDate) },
    { key: 'amort', header: 'Amortização', align: 'right', render: (i) => fmtCurrency(i.amortization) },
    { key: 'interest', header: 'Juros', align: 'right', render: (i) => fmtCurrency(i.interest) },
    { key: 'total', header: 'Total', align: 'right', render: (i) => <strong>{fmtCurrency(i.totalAmount)}</strong> },
    { key: 'balance', header: 'Saldo Devedor', align: 'right', render: (i) => fmtCurrency(i.outstandingBalance) },
    { key: 'status', header: 'Status', render: (i) => <StatusBadge status={i.status} label={lbl(installmentStatusLabel, i.status)} /> },
    { key: 'paid', header: 'Pago em', render: (i) => fmtDate(i.paidAt) },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (i: LoanInstallment) => (
        i.status === 'open' ? <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handlePayInstallment(i.id)}>Pagar</button> : null
      ),
    }] : []),
  ], [canManage])

  const icCols: Column<IntercompanyTransfer>[] = useMemo(() => [
    { key: 'source', header: 'Origem', render: (ic) => ic.sourceOrgName },
    { key: 'target', header: 'Destino', render: (ic) => ic.targetOrgName },
    { key: 'type', header: 'Tipo', render: (ic) => lbl(icTypeLabel, ic.transferType) },
    { key: 'amount', header: 'Valor', align: 'right', render: (ic) => fmtCurrency(ic.amount) },
    { key: 'desc', header: 'Descrição', render: (ic) => ic.description ?? '—' },
    { key: 'status', header: 'Status', render: (ic) => <StatusBadge status={ic.status} label={lbl(icStatusLabel, ic.status)} /> },
    { key: 'created', header: 'Criação', render: (ic) => fmtDate(ic.createdAt) },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (ic: IntercompanyTransfer) => (
        <div style={{ display: 'flex', gap: 4 }}>
          {ic.status === 'pending' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleIcStatus(ic.id, 'approved')}>Aprovar</button>}
          {ic.status === 'approved' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={() => void handleIcStatus(ic.id, 'completed')}>Concluir</button>}
          {(ic.status === 'pending' || ic.status === 'approved') && <button type="button" className="ghost" style={{ fontSize: 11, color: '#c44' }} onClick={() => void handleIcStatus(ic.id, 'cancelled')}>Cancelar</button>}
        </div>
      ),
    }] : []),
  ], [canManage])

  const loanStatusOpts = [
    { value: '', label: 'Todos' }, { value: 'active', label: 'Ativo' },
    { value: 'paid_off', label: 'Quitado' }, { value: 'cancelled', label: 'Cancelado' },
  ]
  const installOpts = [
    { value: '', label: 'Todas' }, { value: 'open', label: 'Em aberto' },
    { value: 'paid', label: 'Pago' }, { value: 'overdue', label: 'Vencido' },
  ]
  const icOpts = [
    { value: '', label: 'Todos' }, { value: 'pending', label: 'Pendente' },
    { value: 'approved', label: 'Aprovado' }, { value: 'completed', label: 'Concluído' },
    { value: 'cancelled', label: 'Cancelado' },
  ]

  return (
    <div className="page">
      <PageHeader />
      <Tabs tabs={tabItems} active={tab} onChange={(k) => { setTab(k); setShowForm(false); setSelectedLoan(null) }} />

      <TabPanel active={tab === 'dashboard'}>
        
        {dash && (
          <KpiRow>
            <KpiCard label="Empréstimos Ativos" value={dash.totalActive} />
            <KpiCard label="Dívida Total" value={fmtCurrency(dash.totalDebt)} tone={dash.totalDebt > 0 ? 'warning' : 'default'} />
            <KpiCard label="Transferências Pendentes" value={dash.pendingIc} tone={dash.pendingIc > 0 ? 'warning' : 'default'} />
          </KpiRow>
        )}
      </TabPanel>

      <TabPanel active={tab === 'loans'}>
        <SplitPane
          hasSelection={showForm || selectedLoan !== null}
          list={
            <>
              <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                <SearchToolbar query="" onQueryChange={() => {}} placeholder="Buscar empréstimo..." count={loans.length}
                  actions={
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Select value={loanStatusFilter} options={loanStatusOpts} onChange={setLoanStatusFilter} />
                      {canManage && <button type="button" onClick={() => { setSelectedLoan(null); setShowForm(true) }}>+ Novo</button>}
                    </div>
                  }
                />
              </div>
              <DataTable columns={loanCols} rows={loans} rowKey={(l) => l.id} loading={loansLoading}
                onRowClick={(l) => { setSelectedLoan(selectedLoan?.id === l.id ? null : l); setShowForm(false) }} />
            </>
          }
          detail={
            showForm ? (
              <LoanForm onSaved={() => { setShowForm(false); setStatus('Empréstimo criado.'); void loadLoans() }} onCancel={() => setShowForm(false)} />
            ) : selectedLoan ? (
              <div style={{ display: 'grid', gap: 12 }}>
                <h3 style={{ margin: 0, fontSize: '0.95rem' }}>{lbl(loanTypeLabel, selectedLoan.loanType)} — {selectedLoan.bankName ?? 'Sem banco'}</h3>
                <DetailGrid columns={3}>
                  <DetailField label="Principal" value={fmtCurrency(selectedLoan.principalAmount)} />
                  <DetailField label="Taxa" value={`${fmtQty(selectedLoan.interestRate, 2)}% a.a.`} />
                  <DetailField label="Status" value={lbl(loanStatusLabel, selectedLoan.status)} />
                  <DetailField label="Sistema" value={selectedLoan.amortizationSystem.toUpperCase()} />
                  <DetailField label="Parcelas" value={String(selectedLoan.totalInstallments)} />
                  <DetailField label="Início" value={fmtDate(selectedLoan.startDate)} />
                </DetailGrid>
                <div style={{ display: 'flex', gap: 6, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
                  <button type="button" onClick={() => { setSelectedLoanId(selectedLoan.id); setTab('installments') }}>Ver Parcelas</button>
                  {canManage && selectedLoan.status === 'active' && <button type="button" className="ghost" style={{ color: '#c44', borderColor: '#c44' }} onClick={() => void handleLoanStatus(selectedLoan.id, 'cancelled')}>Cancelar</button>}
                </div>
              </div>
            ) : (
              <span>Selecione um empréstimo ou crie um novo</span>
            )
          }
        />
      </TabPanel>

      <TabPanel active={tab === 'installments'}>
        
        {selectedLoanId && (
          <>
            <SearchToolbar
              query="" onQueryChange={() => {}} placeholder="Filtrar parcelas..."
              count={installments.length}
              actions={<Select value={installmentFilter} options={installOpts} onChange={setInstallmentFilter} />}
            />
            <DataTable columns={installCols} rows={installments} rowKey={(i) => i.id} loading={installLoading}
              emptyMessage="Nenhuma parcela gerada." />
          </>
        )}
      </TabPanel>

      <TabPanel active={tab === 'intercompany'}>
        <SearchToolbar
          query="" onQueryChange={() => {}} placeholder="Buscar transferência..."
          count={intercompany.length}
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              <Select value={icStatusFilter} options={icOpts} onChange={setIcStatusFilter} />
              {canManage && <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Nova Transferência'}</button>}
            </div>
          }
        />
        {showForm && <IntercompanyForm onSaved={() => { setShowForm(false); setStatus('Transferência criada.'); void loadIc() }} onCancel={() => setShowForm(false)} />}
        <DataTable columns={icCols} rows={intercompany} rowKey={(ic) => ic.id} loading={icLoading} />
      </TabPanel>
    </div>
  )
}

function LoanForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [loanType, setLoanType] = useState('loan')
  const [bankName, setBankName] = useState('')
  const [principalAmount, setPrincipalAmount] = useState('')
  const [interestRate, setInterestRate] = useState('')
  const [amortizationSystem, setAmortizationSystem] = useState('price')
  const [totalInstallments, setTotalInstallments] = useState('')
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!principalAmount || !interestRate || !totalInstallments) return
    setSubmitting(true); setError('')
    try {
      await createLoan({
        loanType: loanType as 'loan' | 'investment', bankName: bankName || undefined,
        principalAmount: Number(principalAmount), interestRate: Number(interestRate),
        amortizationSystem: amortizationSystem as 'sac' | 'price',
        totalInstallments: Number(totalInstallments), startDate,
      })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <label>Tipo <select value={loanType} onChange={e => setLoanType(e.target.value)}><option value="loan">Empréstimo</option><option value="investment">Aplicação</option></select></label>
        <label>Banco <input value={bankName} onChange={e => setBankName(e.target.value)} /></label>
        <label>Valor Principal (R$) * <input type="number" step="0.01" value={principalAmount} onChange={e => setPrincipalAmount(e.target.value)} /></label>
        <label>Taxa de Juros (%a.a.) * <input type="number" step="0.01" value={interestRate} onChange={e => setInterestRate(e.target.value)} /></label>
        <label>Sistema <select value={amortizationSystem} onChange={e => setAmortizationSystem(e.target.value)}><option value="price">PRICE</option><option value="sac">SAC</option></select></label>
        <label>Nº Parcelas * <input type="number" value={totalInstallments} onChange={e => setTotalInstallments(e.target.value)} /></label>
        <label>Data Início * <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={onCancel}>Cancelar</button>
        <button type="button" disabled={!principalAmount || !interestRate || !totalInstallments || submitting} onClick={() => void handleSubmit()}>
          {submitting ? 'Processando...' : 'Criar Empréstimo'}
        </button>
      </div>
    </div>
  )
}

function IntercompanyForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const [targetOrgId, setTargetOrgId] = useState('')
  const [transferType, setTransferType] = useState('financial')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!targetOrgId || !amount) return
    setSubmitting(true); setError('')
    try {
      await createIntercompanyTransfer({ targetOrganizationId: targetOrgId, transferType, amount: Number(amount), description: description || undefined })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <label>ID Org. Destino * <input value={targetOrgId} onChange={e => setTargetOrgId(e.target.value)} placeholder="Código da organização" /></label>
        <label>Tipo <select value={transferType} onChange={e => setTransferType(e.target.value)}><option value="financial">Financeiro</option><option value="merchandise">Mercadoria</option></select></label>
        <label>Valor (R$) * <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} /></label>
        <label>Descrição <input value={description} onChange={e => setDescription(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={onCancel}>Cancelar</button>
        <button type="button" disabled={!targetOrgId || !amount || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Criar Transferência'}</button>
      </div>
    </div>
  )
}
