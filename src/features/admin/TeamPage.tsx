import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import {
  DateInput, NumericInput, Select, StatusBadge, Tabs, TabPanel,
  DataTable, type Column, SearchToolbar, PageHeader, KpiCard, KpiRow,
} from '../../components/ui'
import { useStatusToast } from '../../hooks/useStatusToast'
import { getAllowedActions, type ActionKey } from '../../lib/permissions'
import { getJson } from '../../services/http'
import {
  createEmployee,
  createSalesAgent,
  createLoan,
  fetchEmployees,
  fetchAgents,
  fetchCommissions,
  fetchLoans,
  toggleEmployeeStatus,
  toggleAgentActive,
  payCommission,
  cancelCommission,
  returnLoan,
  updateLoanStatus,
  type EmployeeLookup,
  type AgentLookup,
  type CommissionLookup,
  type LoanLookup,
} from '../../services/people'
import { searchProducts } from '../../services/core'
import { fmtCurrency, fmtDate } from '../../lib/formatters'

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'

type TeamTab = 'dashboard' | 'membros' | 'funcionarios' | 'vendedores' | 'comissoes' | 'emprestimos'
type RoleOption = 'vendedor' | 'estoquista' | 'financeiro'

type TeamMember = {
  id: string
  email: string | null
  fullName: string | null
  role: string
  joinedAt: string
}

const roleLabels: Record<string, string> = {
  chefe: 'Chefe', vendedor: 'Vendedor', estoquista: 'Estoquista', financeiro: 'Financeiro',
}
const empStatusLabel: Record<string, string> = { active: 'Ativo', inactive: 'Inativo' }
const commStatusLabel: Record<string, string> = { pending: 'Pendente', paid: 'Paga', canceled: 'Cancelada' }
const loanStatusLabel: Record<string, string> = { open: 'Aberto', returned: 'Devolvido', overdue: 'Vencido' }

function lbl(map: Record<string, string>, key: string | null | undefined): string { return map[key ?? ''] ?? key ?? '—' }

export function TeamPage() {
  const [tab, setTab] = useState<TeamTab>('dashboard')
  const [msg, setMsg] = useState('')
  useStatusToast(msg)
  const [showForm, setShowForm] = useState(false)
  const [permPreviewRole, setPermPreviewRole] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const [members, setMembers] = useState<TeamMember[]>([])
  const [membersLoading, setMembersLoading] = useState(true)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<RoleOption>('vendedor')

  const [employees, setEmployees] = useState<EmployeeLookup[]>([])
  const [empQuery, setEmpQuery] = useState('')
  const [agents, setAgents] = useState<AgentLookup[]>([])
  const [commissions, setCommissions] = useState<CommissionLookup[]>([])
  const [commFilter, setCommFilter] = useState<'all' | 'pending' | 'paid' | 'canceled'>('all')
  const [loans, setLoans] = useState<LoanLookup[]>([])
  const [loanFilter, setLoanFilter] = useState<'all' | 'open' | 'returned' | 'overdue'>('all')

  const [empForm, setEmpForm] = useState({ name: '', role: '', email: '', phone: '' })
  const [agentForm, setAgentForm] = useState({ name: '', commissionRate: '5', employeeId: '' })
  const [loanForm, setLoanForm] = useState({ customerId: '', expectedReturnDate: '', notes: '', productId: '', productQuery: '', quantity: '1' })

  const [prodResults, setProdResults] = useState<Array<{ id: string; name: string; price: number }>>([])
  const [prodDropOpen, setProdDropOpen] = useState(false)
  const prodTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000) }

  const loadMembers = async () => {
    setMembersLoading(true)
    try { setMembers(await getJson<TeamMember[]>('/team/members')) } catch { setMembers([]) }
    setMembersLoading(false)
  }

  const loadTab = async (t: TeamTab) => {
    setLoading(true)
    try {
      if (t === 'dashboard') { await loadMembers(); setEmployees(await fetchEmployees('')); setCommissions(await fetchCommissions({})) }
      else if (t === 'membros') await loadMembers()
      else if (t === 'funcionarios') setEmployees(await fetchEmployees(empQuery))
      else if (t === 'vendedores') setAgents(await fetchAgents())
      else if (t === 'comissoes') setCommissions(await fetchCommissions({ status: commFilter === 'all' ? undefined : commFilter }))
      else if (t === 'emprestimos') setLoans(await fetchLoans({ status: loanFilter === 'all' ? undefined : loanFilter }))
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Erro ao carregar.') }
    setLoading(false)
  }

  useEffect(() => { void loadTab(tab) }, [tab, empQuery, commFilter, loanFilter])

  const switchTab = (t: TeamTab) => { setTab(t); setShowForm(false); setMsg('') }

  const searchProd = (q: string) => {
    if (prodTimer.current) clearTimeout(prodTimer.current)
    if (!q.trim()) { setProdResults([]); setProdDropOpen(false); return }
    prodTimer.current = setTimeout(async () => {
      try {
        const r = await searchProducts(q, '', undefined, { limit: 6 })
        setProdResults(r.map((p) => ({ id: p.id, name: p.name, price: Number(p.price) })))
        setProdDropOpen(true)
      } catch { setProdResults([]) }
    }, 200)
  }

  const handleInvite = async (event: React.FormEvent) => {
    event.preventDefault()
    setLoading(true)
    try {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) throw new Error('Sessão inválida. Faça login novamente.')
      const response = await fetch(`${apiUrl}/team/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ email, password, role }),
      })
      if (!response.ok) {
        const d = await response.json().catch(() => ({}))
        throw new Error(d.error ?? 'Falha ao cadastrar funcionário.')
      }
      flash('Funcionário cadastrado com sucesso.')
      setEmail(''); setPassword(''); setRole('vendedor'); setShowForm(false)
      void loadMembers()
    } catch (error) {
      flash(error instanceof Error ? error.message : 'Erro inesperado.')
    } finally { setLoading(false) }
  }

  const commTotalPending = useMemo(() => commissions.filter((c) => c.status === 'pending').reduce((s, c) => s + c.amount, 0), [commissions])
  const commTotalPaid = useMemo(() => commissions.filter((c) => c.status === 'paid').reduce((s, c) => s + c.amount, 0), [commissions])
  const activeEmps = useMemo(() => employees.filter(e => e.status === 'active').length, [employees])

  const tabItems = useMemo(() => [
    { key: 'dashboard' as const, label: 'Painel' },
    { key: 'membros' as const, label: 'Membros', count: members.length },
    { key: 'funcionarios' as const, label: 'Funcionários', count: employees.length },
    { key: 'vendedores' as const, label: 'Vendedores' },
    { key: 'comissoes' as const, label: 'Comissões' },
    { key: 'emprestimos' as const, label: 'Empréstimos' },
  ], [members.length, employees.length])

  const memberCols: Column<TeamMember>[] = useMemo(() => [
    { key: 'name', header: 'Nome', render: (m) => <strong>{m.fullName || m.email || 'Membro'}</strong> },
    { key: 'email', header: 'E-mail', render: (m) => m.email ?? '—' },
    { key: 'role', header: 'Função', render: (m) => lbl(roleLabels, m.role) },
    { key: 'joined', header: 'Desde', render: (m) => fmtDate(m.joinedAt) },
  ], [])

  const empCols: Column<EmployeeLookup>[] = useMemo(() => [
    { key: 'name', header: 'Nome', render: (e) => <strong>{e.name}</strong> },
    { key: 'role', header: 'Cargo', render: (e) => e.role ?? '—' },
    { key: 'email', header: 'E-mail', render: (e) => e.email ?? '—' },
    { key: 'status', header: 'Status', render: (e) => <StatusBadge status={e.status} label={lbl(empStatusLabel, e.status)} /> },
    { key: 'actions', header: 'Ações', render: (e) => (
      <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={async () => {
        try { await toggleEmployeeStatus(e.id); void loadTab('funcionarios') } catch (err) { flash(err instanceof Error ? err.message : 'Erro.') }
      }}>{e.status === 'active' ? 'Desativar' : 'Reativar'}</button>
    )},
  ], [])

  const agentCols: Column<AgentLookup>[] = useMemo(() => [
    { key: 'name', header: 'Nome', render: (a) => <strong>{a.name}</strong> },
    { key: 'employee', header: 'Funcionário', render: (a) => a.employeeName ?? '—' },
    { key: 'rate', header: 'Comissão', align: 'right', render: (a) => `${a.commissionRate}%` },
    { key: 'status', header: 'Status', render: (a) => <StatusBadge status={a.active ? 'active' : 'inactive'} label={a.active ? 'Ativo' : 'Inativo'} /> },
    { key: 'actions', header: 'Ações', render: (a) => (
      <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={async () => {
        try { await toggleAgentActive(a.id); void loadTab('vendedores') } catch (err) { flash(err instanceof Error ? err.message : 'Erro.') }
      }}>{a.active ? 'Desativar' : 'Reativar'}</button>
    )},
  ], [])

  const commCols: Column<CommissionLookup>[] = useMemo(() => [
    { key: 'agent', header: 'Vendedor', render: (c) => <strong>{c.agentName || 'Vendedor'}</strong> },
    { key: 'amount', header: 'Valor', align: 'right', render: (c) => fmtCurrency(c.amount) },
    { key: 'date', header: 'Data', render: (c) => fmtDate(c.createdAt) },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} label={lbl(commStatusLabel, c.status)} /> },
    { key: 'actions', header: 'Ações', render: (c) => c.status === 'pending' ? (
      <div style={{ display: 'flex', gap: 4 }}>
        <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={async () => { try { await payCommission(c.id); void loadTab('comissoes') } catch (err) { flash(err instanceof Error ? err.message : 'Erro.') } }}>Pagar</button>
        <button type="button" className="ghost" style={{ fontSize: 11, color: '#c44' }} onClick={async () => { try { await cancelCommission(c.id); void loadTab('comissoes') } catch (err) { flash(err instanceof Error ? err.message : 'Erro.') } }}>Cancelar</button>
      </div>
    ) : null },
  ], [])

  const loanCols: Column<LoanLookup>[] = useMemo(() => [
    { key: 'customer', header: 'Cliente', render: (l) => <strong>{l.customerName || 'Sem cliente'}</strong> },
    { key: 'items', header: 'Itens', align: 'right', render: (l) => l.itemCount },
    { key: 'return', header: 'Retorno', render: (l) => l.expectedReturnDate ? fmtDate(l.expectedReturnDate) : '—' },
    { key: 'status', header: 'Status', render: (l) => <StatusBadge status={l.status} label={lbl(loanStatusLabel, l.status)} /> },
    { key: 'actions', header: 'Ações', render: (l) => l.status === 'open' ? (
      <div style={{ display: 'flex', gap: 4 }}>
        <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={async () => { try { await returnLoan(l.id); void loadTab('emprestimos') } catch (err) { flash(err instanceof Error ? err.message : 'Erro.') } }}>Devolver</button>
        <button type="button" className="ghost" style={{ fontSize: 11, color: '#c44' }} onClick={async () => { try { await updateLoanStatus(l.id, 'overdue'); void loadTab('emprestimos') } catch (err) { flash(err instanceof Error ? err.message : 'Erro.') } }}>Vencido</button>
      </div>
    ) : null },
  ], [])

  return (
    <div className="page">
      <PageHeader />

      <Tabs tabs={tabItems} active={tab} onChange={switchTab} />

      

      <TabPanel active={tab === 'dashboard'}>
        <KpiRow>
          <KpiCard label="Membros" value={members.length} />
          <KpiCard label="Funcionários Ativos" value={activeEmps} tone="success" />
          <KpiCard label="Comissões Pendentes" value={fmtCurrency(commTotalPending)} tone={commTotalPending > 0 ? 'warning' : 'default'} />
          <KpiCard label="Comissões Pagas" value={fmtCurrency(commTotalPaid)} />
        </KpiRow>
      </TabPanel>

      <TabPanel active={tab === 'membros'}>
        <SearchToolbar query="" onQueryChange={() => {}} placeholder="Buscar membro..." count={members.length}
          actions={<button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Adicionar Funcionário'}</button>} />
        {showForm && (
          <form className="inline-create-form" style={{ marginBottom: 12 }} onSubmit={handleInvite}>
            <div className="inline-create-body">
              <label>E-mail<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
              <label>Senha<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
              <label>Função<Select value={role} options={[{ value: 'vendedor', label: 'Vendedor' }, { value: 'estoquista', label: 'Estoquista' }, { value: 'financeiro', label: 'Financeiro' }]} onChange={(v) => setRole(v as RoleOption)} /></label>
            </div>
            <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button><button type="submit" disabled={loading}>{loading ? 'Processando...' : 'Adicionar'}</button></div>
          </form>
        )}
        <DataTable columns={memberCols} rows={members} rowKey={(m) => m.id} loading={membersLoading}
          onRowClick={(m) => setPermPreviewRole(permPreviewRole === m.id ? null : m.id)} emptyMessage="Nenhum membro encontrado." />
        {permPreviewRole && (() => {
          const m = members.find(x => x.id === permPreviewRole)
          if (!m) return null
          return (
            <div className="card" style={{ borderLeft: '3px solid var(--accent)', marginTop: 8, padding: '12px 16px' }}>
              <strong style={{ fontSize: '0.85rem' }}>Permissões — {lbl(roleLabels, m.role)}</strong>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px', marginTop: 6 }}>
                {getAllowedActions(m.role).map((action: ActionKey) => (
                  <span key={action} className="status-badge badge-muted" style={{ fontSize: '0.72rem', padding: '1px 6px' }}>{action}</span>
                ))}
                {getAllowedActions(m.role).length === 0 && <span className="subtitle">Nenhuma permissão definida.</span>}
              </div>
            </div>
          )
        })()}
      </TabPanel>

      <TabPanel active={tab === 'funcionarios'}>
        <SearchToolbar query={empQuery} onQueryChange={setEmpQuery} placeholder="Buscar funcionário..." count={employees.length}
          actions={<button type="button" onClick={() => setShowForm(true)}>+ Funcionário</button>} />
        {showForm && (
          <div className="inline-create-form" style={{ marginBottom: 12 }}>
            <div className="inline-create-body">
              <label>Nome<input value={empForm.name} onChange={(e) => setEmpForm((s) => ({ ...s, name: e.target.value }))} /></label>
              <label>Cargo<input value={empForm.role} onChange={(e) => setEmpForm((s) => ({ ...s, role: e.target.value }))} /></label>
              <label>Email<input value={empForm.email} onChange={(e) => setEmpForm((s) => ({ ...s, email: e.target.value }))} /></label>
              <label>Telefone<input value={empForm.phone} onChange={(e) => setEmpForm((s) => ({ ...s, phone: e.target.value }))} /></label>
            </div>
            <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
              <button type="button" disabled={!empForm.name.trim()} onClick={async () => {
                try {
                  await createEmployee({ name: empForm.name, role: empForm.role || undefined, email: empForm.email || undefined, phone: empForm.phone || undefined })
                  flash('Funcionário criado.'); setShowForm(false); setEmpForm({ name: '', role: '', email: '', phone: '' }); void loadTab('funcionarios')
                } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
              }}>Confirmar</button>
            </div>
          </div>
        )}
        <DataTable columns={empCols} rows={employees} rowKey={(e) => e.id} loading={loading} emptyMessage="Nenhum funcionário cadastrado." />
      </TabPanel>

      <TabPanel active={tab === 'vendedores'}>
        <SearchToolbar query="" onQueryChange={() => {}} placeholder="Buscar vendedor..." count={agents.length}
          actions={<button type="button" onClick={() => setShowForm(true)}>+ Vendedor</button>} />
        {showForm && (
          <div className="inline-create-form" style={{ marginBottom: 12 }}>
            <div className="inline-create-body">
              <label>Nome<input value={agentForm.name} onChange={(e) => setAgentForm((s) => ({ ...s, name: e.target.value }))} /></label>
              <label>Comissão (%)<NumericInput value={agentForm.commissionRate} onChange={(e) => setAgentForm((s) => ({ ...s, commissionRate: e.target.value }))} /></label>
              <label>Funcionário ID (opcional)<input value={agentForm.employeeId} placeholder="UUID funcionário" onChange={(e) => setAgentForm((s) => ({ ...s, employeeId: e.target.value }))} /></label>
            </div>
            <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
              <button type="button" disabled={!agentForm.name.trim()} onClick={async () => {
                try {
                  await createSalesAgent({ name: agentForm.name, commissionRate: Number(agentForm.commissionRate), employeeId: agentForm.employeeId || undefined })
                  flash('Vendedor criado.'); setShowForm(false); setAgentForm({ name: '', commissionRate: '5', employeeId: '' }); void loadTab('vendedores')
                } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
              }}>Confirmar</button>
            </div>
          </div>
        )}
        <DataTable columns={agentCols} rows={agents} rowKey={(a) => a.id} loading={loading} emptyMessage="Nenhum vendedor cadastrado." />
      </TabPanel>

      <TabPanel active={tab === 'comissoes'}>
        <SearchToolbar query="" onQueryChange={() => {}} placeholder="Buscar comissão..." count={commissions.length}
          actions={
            <Select value={commFilter} options={[
              { value: 'all', label: 'Todas' }, { value: 'pending', label: 'Pendentes' },
              { value: 'paid', label: 'Pagas' }, { value: 'canceled', label: 'Canceladas' },
            ]} onChange={(v) => setCommFilter(v as typeof commFilter)} />
          } />
        <KpiRow>
          <KpiCard label="Pendente" value={fmtCurrency(commTotalPending)} tone={commTotalPending > 0 ? 'warning' : 'default'} />
          <KpiCard label="Pago" value={fmtCurrency(commTotalPaid)} tone="success" />
        </KpiRow>
        <DataTable columns={commCols} rows={commissions} rowKey={(c) => c.id} loading={loading} emptyMessage="Nenhuma comissão." />
      </TabPanel>

      <TabPanel active={tab === 'emprestimos'}>
        <SearchToolbar query="" onQueryChange={() => {}} placeholder="Buscar empréstimo..." count={loans.length}
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              <Select value={loanFilter} options={[
                { value: 'all', label: 'Todos' }, { value: 'open', label: 'Abertos' },
                { value: 'returned', label: 'Devolvidos' }, { value: 'overdue', label: 'Vencidos' },
              ]} onChange={(v) => setLoanFilter(v as typeof loanFilter)} />
              <button type="button" onClick={() => setShowForm(true)}>+ Empréstimo</button>
            </div>
          } />
        {showForm && (
          <div className="inline-create-form" style={{ marginBottom: 12 }}>
            <div className="inline-create-body">
              <label>Cliente ID (opcional)<input value={loanForm.customerId} placeholder="UUID do cliente" onChange={(e) => setLoanForm((s) => ({ ...s, customerId: e.target.value }))} /></label>
              <label>Retorno esperado<DateInput value={loanForm.expectedReturnDate} onChange={(e) => setLoanForm((s) => ({ ...s, expectedReturnDate: e.target.value }))} /></label>
              <label>
                Produto (buscar)
                <div className="pdv-search-wrapper">
                  <input value={loanForm.productQuery} placeholder="Buscar produto..." onChange={(e) => { setLoanForm((s) => ({ ...s, productQuery: e.target.value })); searchProd(e.target.value) }}
                    onFocus={() => { if (prodResults.length > 0) setProdDropOpen(true) }}
                    onBlur={() => setTimeout(() => setProdDropOpen(false), 200)} />
                  {prodDropOpen && prodResults.length > 0 && (
                    <div className="pdv-search-dropdown">
                      {prodResults.map((p) => (
                        <button key={p.id} type="button" className="pdv-search-result" onMouseDown={() => {
                          setLoanForm((s) => ({ ...s, productId: p.id, productQuery: p.name }))
                          setProdDropOpen(false)
                        }}><span>{p.name}</span></button>
                      ))}
                    </div>
                  )}
                </div>
              </label>
              <label>Quantidade<NumericInput value={loanForm.quantity} onChange={(e) => setLoanForm((s) => ({ ...s, quantity: e.target.value }))} /></label>
              <label>Observações<input value={loanForm.notes} onChange={(e) => setLoanForm((s) => ({ ...s, notes: e.target.value }))} /></label>
            </div>
            <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
              <button type="button" disabled={!loanForm.productId || !loanForm.quantity} onClick={async () => {
                try {
                  await createLoan({ customerId: loanForm.customerId || undefined, expectedReturnDate: loanForm.expectedReturnDate || undefined, notes: loanForm.notes || undefined, items: [{ product_id: loanForm.productId, quantity: Number(loanForm.quantity) }] })
                  flash('Empréstimo criado.'); setShowForm(false); setLoanForm({ customerId: '', expectedReturnDate: '', notes: '', productId: '', productQuery: '', quantity: '1' }); void loadTab('emprestimos')
                } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
              }}>Registrar Empréstimo</button>
            </div>
          </div>
        )}
        <DataTable columns={loanCols} rows={loans} rowKey={(l) => l.id} loading={loading} emptyMessage="Nenhum empréstimo." />
      </TabPanel>
    </div>
  )
}
