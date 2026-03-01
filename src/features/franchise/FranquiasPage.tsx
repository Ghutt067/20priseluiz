import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../contexts/useAuth'
import {
  Tabs, TabPanel, DataTable, type Column,
  SearchToolbar, PageHeader, KpiCard, KpiRow,
} from '../../components/ui'
import { useStatusToast } from '../../hooks/useStatusToast'
import { can } from '../../lib/permissions'
import { fmtCurrency, fmtDate, fmtQty } from '../../lib/formatters'
import {
  fetchGroups, createGroup, fetchMembers, addMember, removeMember,
  fetchRoyaltyRules, createRoyaltyRule, removeRoyaltyRule,
  fetchCatalogOverrides, createCatalogOverride,
  fetchConsolidatedDre,
  type FranchiseGroup, type FranchiseMember, type RoyaltyRule,
  type CatalogOverride, type ConsolidatedDre,
} from '../../services/franchise'

type Tab = 'dashboard' | 'groups' | 'members' | 'royalties' | 'catalog' | 'dre'

const memberTypeLabel: Record<string, string> = { branch: 'Filial', franchisee: 'Franqueado' }
const ruleTypeLabel: Record<string, string> = { royalty: 'Royalty', marketing_fee: 'Taxa Marketing', technology_fee: 'Taxa Tecnologia' }
const baseLabel: Record<string, string> = { gross_revenue: 'Faturamento Bruto', net_revenue: 'Faturamento Líquido' }

function lbl(map: Record<string, string>, key: string | null | undefined): string { return map[key ?? ''] ?? key ?? '—' }

export function FranquiasPage() {
  const { organizationId, role } = useAuth()
  const [tab, setTab] = useState<Tab>('dashboard')
  const [status, setStatus] = useState('')
  const [showForm, setShowForm] = useState(false)

  const [groups, setGroups] = useState<FranchiseGroup[]>([])
  const [groupsLoading, setGroupsLoading] = useState(false)
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null)

  const [members, setMembers] = useState<FranchiseMember[]>([])
  const [membersLoading, setMembersLoading] = useState(false)

  const [royalties, setRoyalties] = useState<RoyaltyRule[]>([])
  const [royaltiesLoading, setRoyaltiesLoading] = useState(false)

  const [catalog, setCatalog] = useState<CatalogOverride[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)

  const [dre, setDre] = useState<ConsolidatedDre | null>(null)
  const [dreLoading, setDreLoading] = useState(false)

  useStatusToast(status)
  const canManage = can(role ?? '', 'franchise.group.manage')

  const tabItems = useMemo(() => [
    { key: 'dashboard' as const, label: 'Painel' },
    { key: 'groups' as const, label: 'Grupos', count: groups.length },
    { key: 'members' as const, label: 'Membros' },
    { key: 'royalties' as const, label: 'Royalties' },
    { key: 'catalog' as const, label: 'Catálogo' },
    { key: 'dre' as const, label: 'DRE Consolidado' },
  ], [groups.length])

  const loadGroups = useCallback(async () => {
    if (!organizationId) return; setGroupsLoading(true)
    try { setGroups(await fetchGroups()) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setGroupsLoading(false)
  }, [organizationId])

  const loadMembers = useCallback(async () => {
    if (!selectedGroupId) return; setMembersLoading(true)
    try { setMembers(await fetchMembers(selectedGroupId)) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setMembersLoading(false)
  }, [selectedGroupId])

  const loadRoyalties = useCallback(async () => {
    if (!selectedGroupId) return; setRoyaltiesLoading(true)
    try { setRoyalties(await fetchRoyaltyRules(selectedGroupId)) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setRoyaltiesLoading(false)
  }, [selectedGroupId])

  const loadCatalog = useCallback(async () => {
    if (!selectedGroupId) return; setCatalogLoading(true)
    try { setCatalog(await fetchCatalogOverrides(selectedGroupId)) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setCatalogLoading(false)
  }, [selectedGroupId])

  const loadDre = useCallback(async () => {
    if (!selectedGroupId) return; setDreLoading(true)
    try { setDre(await fetchConsolidatedDre(selectedGroupId)) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setDreLoading(false)
  }, [selectedGroupId])

  useEffect(() => {
    if (tab === 'dashboard' || tab === 'groups') void loadGroups()
    if (tab === 'members') void loadMembers()
    if (tab === 'royalties') void loadRoyalties()
    if (tab === 'catalog') void loadCatalog()
    if (tab === 'dre') void loadDre()
  }, [tab, loadGroups, loadMembers, loadRoyalties, loadCatalog, loadDre])

  const handleRemoveMember = async (memberId: string) => {
    if (!selectedGroupId) return
    try { await removeMember(selectedGroupId, memberId); setStatus('Membro removido.'); void loadMembers() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }
  const handleRemoveRoyalty = async (ruleId: string) => {
    if (!selectedGroupId) return
    try { await removeRoyaltyRule(selectedGroupId, ruleId); setStatus('Regra excluída.'); void loadRoyalties() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const totalMembers = useMemo(() => groups.reduce((s, g) => s + g.memberCount, 0), [groups])

  const groupCols: Column<FranchiseGroup>[] = useMemo(() => [
    { key: 'name', header: 'Nome', render: (g) => <strong>{g.name}</strong> },
    { key: 'members', header: 'Membros', align: 'right', render: (g) => g.memberCount },
    { key: 'created', header: 'Criado em', render: (g) => fmtDate(g.createdAt) },
    { key: 'actions', header: 'Ações', render: (g) => (
      <div style={{ display: 'flex', gap: 4 }}>
        <button type="button" className="ghost" style={{ fontSize: 12 }} onClick={() => { setSelectedGroupId(g.id); setTab('members') }}>Membros</button>
        <button type="button" className="ghost" style={{ fontSize: 12 }} onClick={() => { setSelectedGroupId(g.id); setTab('royalties') }}>Royalties</button>
        <button type="button" className="ghost" style={{ fontSize: 12 }} onClick={() => { setSelectedGroupId(g.id); setTab('dre') }}>DRE</button>
      </div>
    )},
  ], [])

  const memberCols: Column<FranchiseMember>[] = useMemo(() => [
    { key: 'org', header: 'Organização', render: (m) => <strong>{m.organizationName}</strong> },
    { key: 'type', header: 'Tipo', render: (m) => lbl(memberTypeLabel, m.memberType) },
    { key: 'active', header: 'Ativo', render: (m) => m.active ? 'Sim' : 'Não' },
    { key: 'joined', header: 'Desde', render: (m) => fmtDate(m.joinedAt) },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (m: FranchiseMember) => (
        <button type="button" className="ghost" style={{ fontSize: 11, color: '#c44' }} onClick={() => void handleRemoveMember(m.id)}>Remover</button>
      ),
    }] : []),
  ], [canManage])

  const royaltyCols: Column<RoyaltyRule>[] = useMemo(() => [
    { key: 'type', header: 'Tipo', render: (r) => lbl(ruleTypeLabel, r.ruleType) },
    { key: 'pct', header: '%', align: 'right', render: (r) => `${fmtQty(r.percentage, 2)}%` },
    { key: 'base', header: 'Base', render: (r) => lbl(baseLabel, r.base) },
    { key: 'active', header: 'Ativo', render: (r) => r.active ? 'Sim' : 'Não' },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (r: RoyaltyRule) => (
        <button type="button" className="ghost" style={{ fontSize: 11, color: '#c44' }} onClick={() => void handleRemoveRoyalty(r.id)}>Excluir</button>
      ),
    }] : []),
  ], [canManage])

  const catalogCols: Column<CatalogOverride>[] = useMemo(() => [
    { key: 'product', header: 'Produto', render: (c) => <strong>{c.productName}</strong> },
    { key: 'org', header: 'Organização', render: (c) => c.orgName },
    { key: 'global', header: 'Preço Global', align: 'right', render: (c) => fmtCurrency(c.globalPrice) },
    { key: 'regional', header: 'Preço Regional', align: 'right', render: (c) => fmtCurrency(c.regionalPrice) },
    { key: 'diff', header: 'Diferença', align: 'right', render: (c) => {
      const diff = Number(c.regionalPrice) - Number(c.globalPrice)
      return <span style={{ color: diff > 0 ? '#c44' : diff < 0 ? '#38a169' : 'inherit' }}>{fmtCurrency(diff)}</span>
    }},
  ], [])

  const dreCols: Column<ConsolidatedDre['byOrg'][number]>[] = useMemo(() => [
    { key: 'org', header: 'Organização', render: (r) => r.orgName },
    { key: 'type', header: 'Tipo', render: (r) => r.title_type },
    { key: 'total', header: 'Total', align: 'right', render: (r) => fmtCurrency(r.total) },
  ], [])

  return (
    <div className="page">
      <PageHeader />
      <Tabs tabs={tabItems} active={tab} onChange={(k) => { setTab(k); setShowForm(false) }} />

      <TabPanel active={tab === 'dashboard'}>
        <KpiRow>
          <KpiCard label="Grupos" value={groups.length} />
          <KpiCard label="Total Membros" value={totalMembers} />
        </KpiRow>
      </TabPanel>

      <TabPanel active={tab === 'groups'}>
        <SearchToolbar query="" onQueryChange={() => {}} placeholder="Buscar grupo..." count={groups.length}
          actions={canManage ? <button type="button" onClick={() => setShowForm(true)}>+ Novo Grupo</button> : undefined} />
        {showForm && <GroupForm onSaved={() => { setShowForm(false); setStatus('Grupo criado.'); void loadGroups() }} />}
        <DataTable columns={groupCols} rows={groups} rowKey={(g) => g.id} loading={groupsLoading} />
      </TabPanel>

      <TabPanel active={tab === 'members'}>
        
        {selectedGroupId && (
          <>
            <SearchToolbar query="" onQueryChange={() => {}} placeholder="Buscar membro..." count={members.length}
              actions={canManage ? <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Adicionar Membro'}</button> : undefined} />
            {showForm && <MemberForm groupId={selectedGroupId} onSaved={() => { setShowForm(false); setStatus('Membro adicionado.'); void loadMembers() }} />}
            <DataTable columns={memberCols} rows={members} rowKey={(m) => m.id} loading={membersLoading} emptyMessage="Nenhum membro neste grupo." />
          </>
        )}
      </TabPanel>

      <TabPanel active={tab === 'royalties'}>
        
        {selectedGroupId && (
          <>
            <SearchToolbar query="" onQueryChange={() => {}} placeholder="Buscar regra..." count={royalties.length}
              actions={canManage ? <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Nova Regra'}</button> : undefined} />
            {showForm && <RoyaltyForm groupId={selectedGroupId} onSaved={() => { setShowForm(false); setStatus('Regra criada.'); void loadRoyalties() }} />}
            <DataTable columns={royaltyCols} rows={royalties} rowKey={(r) => r.id} loading={royaltiesLoading} emptyMessage="Nenhuma regra de royalty." />
          </>
        )}
      </TabPanel>

      <TabPanel active={tab === 'catalog'}>
        
        {selectedGroupId && (
          <>
            <SearchToolbar query="" onQueryChange={() => {}} placeholder="Buscar preço..." count={catalog.length}
              actions={canManage ? <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Override de Preço'}</button> : undefined} />
            {showForm && <CatalogForm groupId={selectedGroupId} onSaved={() => { setShowForm(false); setStatus('Preço regional salvo.'); void loadCatalog() }} />}
            <DataTable columns={catalogCols} rows={catalog} rowKey={(c) => c.id} loading={catalogLoading} emptyMessage="Nenhum override de preço." />
          </>
        )}
      </TabPanel>

      <TabPanel active={tab === 'dre'}>

        {selectedGroupId && dre && (
          <>
            <KpiRow>
              <KpiCard label="Eliminação Intercompany" value={fmtCurrency(dre.intercompanyElimination)} />
              <KpiCard label="Linhas" value={dre.byOrg.length} />
            </KpiRow>
            <DataTable columns={dreCols} rows={dre.byOrg} rowKey={(r) => `${r.orgName}-${r.title_type}`} emptyMessage="Sem dados financeiros no período." />
          </>
        )}
      </TabPanel>
    </div>
  )
}

function GroupForm({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const handleSubmit = async () => {
    if (!name) return; setSubmitting(true); setError('')
    try { await createGroup(name); onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : 'Erro.') } setSubmitting(false)
  }
  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}><div className="inline-create-body">
      <label>Nome do Grupo * <input value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Rede Alpha" /></label>
      {error && <p style={{ color: '#c44' }}>{error}</p>}
    </div><div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
      <button type="button" disabled={!name || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Criar Grupo'}</button>
    </div></div>
  )
}

function MemberForm({ groupId, onSaved }: { groupId: string; onSaved: () => void }) {
  const [organizationId, setOrganizationId] = useState('')
  const [memberType, setMemberType] = useState('branch')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const handleSubmit = async () => {
    if (!organizationId) return; setSubmitting(true); setError('')
    try { await addMember(groupId, { organizationId, memberType }); onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : 'Erro.') } setSubmitting(false)
  }
  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}><div className="inline-create-body">
      <label>ID da Organização * <input value={organizationId} onChange={e => setOrganizationId(e.target.value)} placeholder="Código" /></label>
      <label>Tipo <select value={memberType} onChange={e => setMemberType(e.target.value)}><option value="branch">Filial</option><option value="franchisee">Franqueado</option></select></label>
      {error && <p style={{ color: '#c44' }}>{error}</p>}
    </div><div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
      <button type="button" disabled={!organizationId || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Adicionar Membro'}</button>
    </div></div>
  )
}

function RoyaltyForm({ groupId, onSaved }: { groupId: string; onSaved: () => void }) {
  const [ruleType, setRuleType] = useState('royalty')
  const [percentage, setPercentage] = useState('')
  const [base, setBase] = useState('gross_revenue')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const handleSubmit = async () => {
    if (!percentage) return; setSubmitting(true); setError('')
    try { await createRoyaltyRule(groupId, { ruleType, percentage: Number(percentage), base: base as 'gross_revenue' | 'net_revenue' }); onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : 'Erro.') } setSubmitting(false)
  }
  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}><div className="inline-create-body">
      <label>Tipo <select value={ruleType} onChange={e => setRuleType(e.target.value)}><option value="royalty">Royalty</option><option value="marketing_fee">Taxa de Marketing</option><option value="technology_fee">Taxa de Tecnologia</option></select></label>
      <label>Percentual (%) * <input type="number" step="0.01" value={percentage} onChange={e => setPercentage(e.target.value)} /></label>
      <label>Base <select value={base} onChange={e => setBase(e.target.value)}><option value="gross_revenue">Faturamento Bruto</option><option value="net_revenue">Faturamento Líquido</option></select></label>
      {error && <p style={{ color: '#c44' }}>{error}</p>}
    </div><div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
      <button type="button" disabled={!percentage || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Criar Regra'}</button>
    </div></div>
  )
}

function CatalogForm({ groupId, onSaved }: { groupId: string; onSaved: () => void }) {
  const [orgId, setOrgId] = useState('')
  const [productId, setProductId] = useState('')
  const [regionalPrice, setRegionalPrice] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const handleSubmit = async () => {
    if (!orgId || !productId || !regionalPrice) return; setSubmitting(true); setError('')
    try { await createCatalogOverride(groupId, { organizationId: orgId, productId, regionalPrice: Number(regionalPrice) }); onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : 'Erro.') } setSubmitting(false)
  }
  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}><div className="inline-create-body">
      <label>ID da Organização * <input value={orgId} onChange={e => setOrgId(e.target.value)} placeholder="Código" /></label>
      <label>ID do Produto * <input value={productId} onChange={e => setProductId(e.target.value)} placeholder="Código" /></label>
      <label>Preço Regional (R$) * <input type="number" step="0.01" value={regionalPrice} onChange={e => setRegionalPrice(e.target.value)} /></label>
      {error && <p style={{ color: '#c44' }}>{error}</p>}
    </div><div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
      <button type="button" disabled={!orgId || !productId || !regionalPrice || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Confirmar Preço'}</button>
    </div></div>
  )
}
