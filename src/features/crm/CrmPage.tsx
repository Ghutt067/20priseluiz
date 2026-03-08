import { useEffect, useMemo, useRef, useState } from 'react'
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence'
import { useStatusToast } from '../../hooks/useStatusToast'
import {
  createAppointment,
  createCallLog,
  createCampaign,
  createPromotion,
  createReturnOrder,
  addCampaignContact,
  fetchAppointments,
  fetchCallLogs,
  fetchCampaigns,
  fetchCampaignContacts,
  fetchPromotions,
  fetchReturnOrders,
  fetchPipeline,
  createPipelineLead,
  updatePipelineStage,
  fetchCoupons,
  createCoupon,
  toggleCoupon,
  updateAppointmentStatus,
  updateCampaignStatus,
  updatePromotionStatus,
  updateReturnStatus,
  type AppointmentLookup,
  type CallLogLookup,
  type CampaignLookup,
  type CampaignContactLookup,
  type PromotionLookup,
  type ReturnOrderLookup,
  type PipelineLead,
  type PipelineStage,
  type CouponLookup,
} from '../../services/crm'
import { searchProducts } from '../../services/core'
import {
  DateInput, NumericInput, Select, StatusBadge, Tabs, TabPanel,
  DataTable, type Column, SearchToolbar, PageHeader, KpiCard, KpiRow,
} from '../../components/ui'
import { fmtDateTime, fmtDate, fmtCurrency } from '../../lib/formatters'

type CrmTab = 'dashboard' | 'pipeline' | 'agenda' | 'contatos' | 'campanhas' | 'promocoes' | 'devolucoes' | 'cupons'

const apptStatusLabel: Record<string, string> = { scheduled: 'Agendado', completed: 'Concluído', cancelled: 'Cancelado' }
const campStatusLabel: Record<string, string> = { draft: 'Rascunho', active: 'Ativa', completed: 'Encerrada' }
const promoStatusLabel: Record<string, string> = { scheduled: 'Agendada', active: 'Ativa', ended: 'Encerrada' }
const returnStatusLabel: Record<string, string> = { requested: 'Solicitada', approved: 'Aprovada', received: 'Recebida', refunded: 'Reembolsada' }

const RETURN_NEXT: Record<string, 'approved' | 'received' | 'refunded'> = {
  requested: 'approved', approved: 'received', received: 'refunded',
}

function lbl(map: Record<string, string>, key: string | null | undefined): string { return map[key ?? ''] ?? key ?? '—' }

export function CrmPage() {
  const [tab, setTab] = useState<CrmTab>('dashboard')
  const [msg, setMsg] = useState('')
  useStatusToast(msg)
  const [loading, setLoading] = useState(false)
  const [showForm, setShowForm] = useState(false)

  const [appointments, setAppointments] = useState<AppointmentLookup[]>([])
  const [calls, setCalls] = useState<CallLogLookup[]>([])
  const [campaigns, setCampaigns] = useState<CampaignLookup[]>([])
  const [promotions, setPromotions] = useState<PromotionLookup[]>([])
  const [returns, setReturns] = useState<ReturnOrderLookup[]>([])

  const [apptForm, setApptForm] = useState({ subject: '', scheduledAt: '', notes: '', customerId: '' })
  const [callForm, setCallForm] = useState({ phone: '', outcome: '', notes: '', customerId: '' })
  const [campForm, setCampForm] = useState({ name: '', channel: '', startsAt: '', endsAt: '' })
  const [promoForm, setPromoForm] = useState({ name: '', promoPrice: '', productId: '', productQuery: '' })
  const [returnForm, setReturnForm] = useState({ reason: '', customerId: '', productId: '', productQuery: '', quantity: '1' })

  const [prodResults, setProdResults] = useState<Array<{ id: string; name: string; price: number }>>([])
  const [prodDropOpen, setProdDropOpen] = useState(false)
  const { mounted: prodDropMounted, exiting: prodDropExiting } = useAnimatedPresence(prodDropOpen && prodResults.length > 0, 180)
  const prodTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [expandedCampaign, setExpandedCampaign] = useState<string | null>(null)
  const [campContacts, setCampContacts] = useState<CampaignContactLookup[]>([])
  const [campContactForm, setCampContactForm] = useState({ email: '', phone: '' })

  const [pipeline, setPipeline] = useState<PipelineLead[]>([])
  const [pipelineForm, setPipelineForm] = useState({ name: '', estimatedValue: '', notes: '' })

  const [coupons, setCoupons] = useState<CouponLookup[]>([])
  const [couponForm, setCouponForm] = useState({ code: '', couponType: 'percent' as 'percent' | 'fixed', value: '', maxUses: '' })

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000) }

  const load = async (t: CrmTab) => {
    setLoading(true)
    try {
      if (t === 'dashboard') { setPipeline(await fetchPipeline()); setAppointments(await fetchAppointments({ limit: 50 })) }
      else if (t === 'pipeline') setPipeline(await fetchPipeline())
      else if (t === 'agenda') setAppointments(await fetchAppointments({ limit: 50 }))
      else if (t === 'contatos') setCalls(await fetchCallLogs(50))
      else if (t === 'campanhas') setCampaigns(await fetchCampaigns(50))
      else if (t === 'promocoes') setPromotions(await fetchPromotions(50))
      else if (t === 'devolucoes') setReturns(await fetchReturnOrders(50))
      else if (t === 'cupons') setCoupons(await fetchCoupons())
    } catch (e) { flash(e instanceof Error ? e.message : 'Erro ao carregar.') }
    setLoading(false)
  }

  useEffect(() => { void load(tab) }, [tab])

  const switchTab = (t: CrmTab) => { setTab(t); setShowForm(false); setMsg(''); setExpandedCampaign(null) }

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

  const STAGES: Array<{ key: PipelineStage; label: string }> = [
    { key: 'contact', label: 'Contato' },
    { key: 'qualified', label: 'Qualificado' },
    { key: 'proposal', label: 'Proposta' },
    { key: 'negotiation', label: 'Negociação' },
    { key: 'closed_won', label: 'Ganho ✓' },
    { key: 'closed_lost', label: 'Perdido ✗' },
  ]
  const STAGE_NEXT: Partial<Record<PipelineStage, PipelineStage>> = {
    contact: 'qualified', qualified: 'proposal', proposal: 'negotiation', negotiation: 'closed_won',
  }

  const tabItems = useMemo(() => [
    { key: 'dashboard' as const, label: 'Painel' },
    { key: 'pipeline' as const, label: 'Pipeline', count: pipeline.filter(p => p.stage !== 'closed_won' && p.stage !== 'closed_lost').length },
    { key: 'agenda' as const, label: 'Agenda', count: appointments.filter(a => a.status === 'scheduled').length },
    { key: 'contatos' as const, label: 'Contatos' },
    { key: 'campanhas' as const, label: 'Campanhas' },
    { key: 'promocoes' as const, label: 'Promoções' },
    { key: 'devolucoes' as const, label: 'Devoluções' },
    { key: 'cupons' as const, label: 'Cupons' },
  ], [pipeline, appointments])

  const dashPipelineValue = useMemo(() => pipeline.filter(p => p.stage !== 'closed_lost').reduce((s, p) => s + (p.estimatedValue ?? 0), 0), [pipeline])
  const dashScheduled = useMemo(() => appointments.filter(a => a.status === 'scheduled').length, [appointments])

  const apptCols: Column<AppointmentLookup>[] = useMemo(() => [
    { key: 'subject', header: 'Assunto', render: (a) => <strong>{a.subject}</strong> },
    { key: 'customer', header: 'Cliente', render: (a) => a.customerName ?? '—' },
    { key: 'scheduledAt', header: 'Data/Hora', render: (a) => fmtDateTime(a.scheduledAt) },
    { key: 'status', header: 'Status', render: (a) => <StatusBadge status={a.status} label={lbl(apptStatusLabel, a.status)} /> },
    { key: 'actions', header: 'Ações', render: (a) => a.status === 'scheduled' ? (
      <div style={{ display: 'flex', gap: 4 }}>
        <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={async () => { try { await updateAppointmentStatus(a.id, 'completed'); void load('agenda') } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') } }}>Concluir</button>
        <button type="button" className="ghost" style={{ fontSize: 11, color: '#c44' }} onClick={async () => { try { await updateAppointmentStatus(a.id, 'cancelled'); void load('agenda') } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') } }}>Cancelar</button>
      </div>
    ) : null },
  ], [])

  const callCols: Column<CallLogLookup>[] = useMemo(() => [
    { key: 'contact', header: 'Contato', render: (c) => <strong>{c.customerName || c.phone || 'Contato'}</strong> },
    { key: 'outcome', header: 'Resultado', render: (c) => c.outcome ?? '—' },
    { key: 'notes', header: 'Observações', render: (c) => c.notes ?? '—' },
    { key: 'date', header: 'Data', render: (c) => fmtDateTime(c.occurredAt) },
  ], [])

  const campCols: Column<CampaignLookup>[] = useMemo(() => [
    { key: 'name', header: 'Nome', render: (c) => <strong>{c.name}</strong> },
    { key: 'channel', header: 'Canal', render: (c) => c.channel ?? '—' },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.status} label={lbl(campStatusLabel, c.status)} /> },
    { key: 'actions', header: 'Ações', render: (c) => (
      <div style={{ display: 'flex', gap: 4 }}>
        {c.status === 'draft' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={async () => { try { await updateCampaignStatus(c.id, 'active'); void load('campanhas') } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') } }}>Ativar</button>}
        {c.status === 'active' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={async () => { try { await updateCampaignStatus(c.id, 'completed'); void load('campanhas') } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') } }}>Encerrar</button>}
        <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={async () => {
          if (expandedCampaign === c.id) { setExpandedCampaign(null); return }
          try { setCampContacts(await fetchCampaignContacts(c.id)); setExpandedCampaign(c.id) } catch { flash('Erro ao carregar contatos.') }
        }}>{expandedCampaign === c.id ? 'Fechar' : 'Contatos'}</button>
      </div>
    )},
  ], [expandedCampaign])

  const promoCols: Column<PromotionLookup>[] = useMemo(() => [
    { key: 'name', header: 'Nome', render: (p) => <strong>{p.name}</strong> },
    { key: 'product', header: 'Produto', render: (p) => p.productName ?? '—' },
    { key: 'price', header: 'Preço Promo', align: 'right', render: (p) => fmtCurrency(p.promoPrice) },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} label={lbl(promoStatusLabel, p.status)} /> },
    { key: 'actions', header: 'Ações', render: (p) => (
      <div style={{ display: 'flex', gap: 4 }}>
        {p.status === 'scheduled' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={async () => { try { await updatePromotionStatus(p.id, 'active'); void load('promocoes') } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') } }}>Ativar</button>}
        {p.status === 'active' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={async () => { try { await updatePromotionStatus(p.id, 'ended'); void load('promocoes') } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') } }}>Encerrar</button>}
      </div>
    )},
  ], [])

  const returnCols: Column<ReturnOrderLookup>[] = useMemo(() => [
    { key: 'customer', header: 'Cliente', render: (r) => <strong>{r.customerName || 'Sem cliente'}</strong> },
    { key: 'reason', header: 'Motivo', render: (r) => r.reason ?? '—' },
    { key: 'items', header: 'Itens', align: 'right', render: (r) => r.itemCount },
    { key: 'date', header: 'Data', render: (r) => fmtDate(r.createdAt) },
    { key: 'status', header: 'Status', render: (r) => <StatusBadge status={r.status} label={lbl(returnStatusLabel, r.status)} /> },
    { key: 'actions', header: 'Ações', render: (r) => RETURN_NEXT[r.status] ? (
      <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={async () => {
        try { await updateReturnStatus(r.id, RETURN_NEXT[r.status]); void load('devolucoes') } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
      }}>Avançar → {lbl(returnStatusLabel, RETURN_NEXT[r.status])}</button>
    ) : null },
  ], [])

  const couponCols: Column<CouponLookup>[] = useMemo(() => [
    { key: 'code', header: 'Código', render: (c) => <strong style={{ fontFamily: 'monospace' }}>{c.code}</strong> },
    { key: 'type', header: 'Tipo', render: (c) => c.couponType === 'percent' ? `${c.value}%` : fmtCurrency(c.value) },
    { key: 'uses', header: 'Usos', render: (c) => c.maxUses ? `${c.usesCount}/${c.maxUses}` : String(c.usesCount) },
    { key: 'status', header: 'Status', render: (c) => <StatusBadge status={c.active ? 'active' : 'inactive'} label={c.active ? 'Ativo' : 'Inativo'} /> },
    { key: 'actions', header: 'Ações', render: (c) => (
      <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={async () => {
        try { await toggleCoupon(c.id); void load('cupons') } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
      }}>{c.active ? 'Desativar' : 'Ativar'}</button>
    )},
  ], [])

  return (
    <div className="page">
      <PageHeader
       
        />

      <Tabs tabs={tabItems} active={tab} onChange={switchTab} />

      

      <TabPanel active={tab === 'dashboard'}>
        <KpiRow>
          <KpiCard label="Pipeline" value={pipeline.length} subtitle={fmtCurrency(dashPipelineValue)} />
          <KpiCard label="Agendamentos" value={dashScheduled} tone={dashScheduled > 0 ? 'warning' : 'default'} />
          <KpiCard label="Campanhas Ativas" value={campaigns.filter(c => c.status === 'active').length} />
          <KpiCard label="Devoluções Pendentes" value={returns.filter(r => r.status === 'requested').length} tone={returns.filter(r => r.status === 'requested').length > 0 ? 'danger' : 'default'} />
        </KpiRow>
      </TabPanel>

      <TabPanel active={tab === 'pipeline'}>
        <SearchToolbar query="" onQueryChange={(v) => {}} placeholder="Buscar oportunidade..." count={pipeline.length}
          actions={<button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Nova Oportunidade'}</button>} />
        {showForm && (
          <div className="inline-create-form" style={{ marginBottom: 12 }}>
            <div className="inline-create-body">
              <label>Nome / Descrição<input value={pipelineForm.name} onChange={(e) => setPipelineForm((s) => ({ ...s, name: e.target.value }))} /></label>
              <label>Valor estimado (R$)<NumericInput value={pipelineForm.estimatedValue} onChange={(e) => setPipelineForm((s) => ({ ...s, estimatedValue: e.target.value }))} /></label>
              <label>Observações<input value={pipelineForm.notes} onChange={(e) => setPipelineForm((s) => ({ ...s, notes: e.target.value }))} /></label>
            </div>
            <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
              <button type="button" disabled={!pipelineForm.name.trim()} onClick={async () => {
                try {
                  await createPipelineLead({ name: pipelineForm.name, estimatedValue: Number(pipelineForm.estimatedValue) || undefined, notes: pipelineForm.notes || undefined })
                  flash('Oportunidade criada.'); setShowForm(false); setPipelineForm({ name: '', estimatedValue: '', notes: '' }); void load('pipeline')
                } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
              }}>Confirmar</button>
            </div>
          </div>
        )}
        <div className="pipeline-kanban">
          {STAGES.map((stage) => {
            const leads = pipeline.filter((p) => p.stage === stage.key)
            const stageValue = leads.reduce((s, p) => s + (p.estimatedValue ?? 0), 0)
            const isWon = stage.key === 'closed_won'
            const isLost = stage.key === 'closed_lost'
            return (
              <div key={stage.key} className="pipeline-column">
                <div className="pipeline-col-header">
                  <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{stage.label}</span>
                  <span className="subtitle" style={{ fontSize: '0.78rem' }}>{leads.length} · {fmtCurrency(stageValue)}</span>
                </div>
                {leads.map((lead) => (
                  <div key={lead.id} className={`pipeline-card ${isWon ? 'won' : isLost ? 'lost' : ''}`}>
                    <div className="pipeline-card-name">{lead.name}</div>
                    {lead.customerName && <div className="pipeline-card-meta">{lead.customerName}</div>}
                    {lead.estimatedValue && <div className="pipeline-card-value">{fmtCurrency(lead.estimatedValue)}</div>}
                    {STAGE_NEXT[lead.stage] && (
                      <button type="button" className="ghost" style={{ marginTop: 6, fontSize: '0.7rem', padding: '3px 8px' }} onClick={async () => {
                        const next = STAGE_NEXT[lead.stage]
                        if (!next) return
                        try { await updatePipelineStage(lead.id, next); void load('pipeline') } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
                      }}>Avançar →</button>
                    )}
                    {!isLost && lead.stage !== 'closed_won' && (
                      <button type="button" className="ghost" style={{ marginTop: 4, fontSize: '0.7rem', padding: '3px 8px', color: '#c44', borderColor: '#c44' }} onClick={async () => {
                        try { await updatePipelineStage(lead.id, 'closed_lost'); void load('pipeline') } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
                      }}>Perder</button>
                    )}
                    {lead.stage === 'closed_won' && (
                      <a href="/vendas" style={{ marginTop: 4, fontSize: '0.7rem', padding: '3px 8px' }} className="ghost">Criar Pedido</a>
                    )}
                  </div>
                ))}
                {leads.length === 0 && <p className="pipeline-empty">Vazio</p>}
              </div>
            )
          })}
        </div>
      </TabPanel>

      <TabPanel active={tab === 'agenda'}>
        <SearchToolbar query="" onQueryChange={(v) => {}} placeholder="Buscar agendamento..." count={appointments.length}
          actions={<button type="button" onClick={() => setShowForm(true)}>+ Agendamento</button>} />
        {showForm && (
          <div className="inline-create-form" style={{ marginBottom: 12 }}>
            <div className="inline-create-body">
              <label>Assunto<input value={apptForm.subject} onChange={(e) => setApptForm((s) => ({ ...s, subject: e.target.value }))} /></label>
              <label>Data/hora<DateInput value={apptForm.scheduledAt} onChange={(e) => setApptForm((s) => ({ ...s, scheduledAt: e.target.value }))} /></label>
              <label>Cliente ID (opcional)<input value={apptForm.customerId} placeholder="UUID do cliente" onChange={(e) => setApptForm((s) => ({ ...s, customerId: e.target.value }))} /></label>
              <label>Observações<input value={apptForm.notes} onChange={(e) => setApptForm((s) => ({ ...s, notes: e.target.value }))} /></label>
            </div>
            <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
              <button type="button" disabled={!apptForm.subject.trim() || !apptForm.scheduledAt} onClick={async () => {
                try {
                  await createAppointment({ subject: apptForm.subject, scheduledAt: apptForm.scheduledAt, notes: apptForm.notes || undefined, customerId: apptForm.customerId || undefined })
                  flash('Agendamento criado.'); setShowForm(false); setApptForm({ subject: '', scheduledAt: '', notes: '', customerId: '' }); void load('agenda')
                } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
              }}>Confirmar</button>
            </div>
          </div>
        )}
        <DataTable columns={apptCols} rows={appointments} rowKey={(a) => a.id} loading={loading} emptyMessage="Nenhum agendamento." />
      </TabPanel>

      <TabPanel active={tab === 'contatos'}>
        <SearchToolbar query="" onQueryChange={(v) => {}} placeholder="Buscar contato..." count={calls.length}
          actions={<button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Registrar Contato'}</button>} />
        {showForm && (
          <div className="inline-create-form" style={{ marginBottom: 12 }}>
            <div className="inline-create-body">
              <label>Telefone<input value={callForm.phone} onChange={(e) => setCallForm((s) => ({ ...s, phone: e.target.value }))} /></label>
              <label>Resultado
                <Select value={callForm.outcome} options={[
                  { value: '', label: '(selecionar)' },
                  { value: 'atendeu', label: 'Atendeu' },
                  { value: 'nao_atendeu', label: 'Não atendeu' },
                  { value: 'interessado', label: 'Interessado' },
                  { value: 'sem_interesse', label: 'Sem interesse' },
                  { value: 'retornar', label: 'Retornar depois' },
                ]} onChange={(v) => setCallForm((s) => ({ ...s, outcome: v }))} />
              </label>
              <label>Cliente ID (opcional)<input value={callForm.customerId} placeholder="UUID do cliente" onChange={(e) => setCallForm((s) => ({ ...s, customerId: e.target.value }))} /></label>
              <label>Observações<input value={callForm.notes} onChange={(e) => setCallForm((s) => ({ ...s, notes: e.target.value }))} /></label>
            </div>
            <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
              <button type="button" onClick={async () => {
                try {
                  await createCallLog({ phone: callForm.phone || undefined, outcome: callForm.outcome || undefined, notes: callForm.notes || undefined, customerId: callForm.customerId || undefined })
                  flash('Contato registrado.'); setShowForm(false); setCallForm({ phone: '', outcome: '', notes: '', customerId: '' }); void load('contatos')
                } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
              }}>Confirmar</button>
            </div>
          </div>
        )}
        <DataTable columns={callCols} rows={calls} rowKey={(c) => c.id} loading={loading} emptyMessage="Nenhum contato registrado." />
      </TabPanel>

      <TabPanel active={tab === 'campanhas'}>
        <SearchToolbar query="" onQueryChange={(v) => {}} placeholder="Buscar campanha..." count={campaigns.length}
          actions={<button type="button" onClick={() => { setShowForm(!showForm); setExpandedCampaign(null) }}>{showForm ? 'Cancelar' : '+ Nova Campanha'}</button>} />
        {showForm && (
          <div className="inline-create-form" style={{ marginBottom: 12 }}>
            <div className="inline-create-body">
              <label>Nome<input value={campForm.name} onChange={(e) => setCampForm((s) => ({ ...s, name: e.target.value }))} /></label>
              <label>Canal<input value={campForm.channel} placeholder="WhatsApp, Email, SMS..." onChange={(e) => setCampForm((s) => ({ ...s, channel: e.target.value }))} /></label>
              <label>Início<DateInput value={campForm.startsAt} onChange={(e) => setCampForm((s) => ({ ...s, startsAt: e.target.value }))} /></label>
              <label>Fim<DateInput value={campForm.endsAt} onChange={(e) => setCampForm((s) => ({ ...s, endsAt: e.target.value }))} /></label>
            </div>
            <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
              <button type="button" disabled={!campForm.name.trim()} onClick={async () => {
                try {
                  await createCampaign({ name: campForm.name, channel: campForm.channel || undefined, startsAt: campForm.startsAt || undefined, endsAt: campForm.endsAt || undefined })
                  flash('Campanha criada.'); setShowForm(false); setCampForm({ name: '', channel: '', startsAt: '', endsAt: '' }); void load('campanhas')
                } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
              }}>Confirmar</button>
            </div>
          </div>
        )}
        <DataTable columns={campCols} rows={campaigns} rowKey={(c) => c.id} loading={loading} emptyMessage="Nenhuma campanha." />
        {expandedCampaign && (
          <div className="card" style={{ borderLeft: '3px solid var(--accent)', marginTop: 8 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: '0.95rem' }}>Contatos da campanha</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, marginBottom: 8 }}>
              <label>Email<input value={campContactForm.email} onChange={(e) => setCampContactForm((s) => ({ ...s, email: e.target.value }))} /></label>
              <label>Telefone<input value={campContactForm.phone} onChange={(e) => setCampContactForm((s) => ({ ...s, phone: e.target.value }))} /></label>
              <button type="button" style={{ alignSelf: 'end' }} disabled={!campContactForm.email && !campContactForm.phone} onClick={async () => {
                try {
                  await addCampaignContact({ campaignId: expandedCampaign, email: campContactForm.email || undefined, phone: campContactForm.phone || undefined })
                  setCampContactForm({ email: '', phone: '' })
                  setCampContacts(await fetchCampaignContacts(expandedCampaign))
                  flash('Contato adicionado.')
                } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
              }}>Adicionar</button>
            </div>
            {campContacts.length > 0 ? campContacts.map((cc) => (
              <div key={cc.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: '1px solid var(--border)', fontSize: '0.84rem' }}>
                <strong>{cc.customerName || cc.email || cc.phone || 'Contato'}</strong>
                <span className="subtitle">{cc.email} {cc.phone}</span>
              </div>
            )) : null}
          </div>
        )}
      </TabPanel>

      <TabPanel active={tab === 'promocoes'}>
        <SearchToolbar query="" onQueryChange={(v) => {}} placeholder="Buscar promoção..." count={promotions.length}
          actions={<button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Nova Promoção'}</button>} />
        {showForm && (
          <div className="inline-create-form" style={{ marginBottom: 12 }}>
            <div className="inline-create-body">
              <label>Nome<input value={promoForm.name} onChange={(e) => setPromoForm((s) => ({ ...s, name: e.target.value }))} /></label>
              <label>Preço promocional<NumericInput value={promoForm.promoPrice} onChange={(e) => setPromoForm((s) => ({ ...s, promoPrice: e.target.value }))} /></label>
              <label>
                Produto (buscar)
                <div className="pdv-search-wrapper">
                  <input value={promoForm.productQuery} placeholder="Buscar produto..." onChange={(e) => { setPromoForm((s) => ({ ...s, productQuery: e.target.value })); searchProd(e.target.value) }}
                    onFocus={() => { if (prodResults.length > 0) setProdDropOpen(true) }}
                    onBlur={() => setTimeout(() => setProdDropOpen(false), 200)} />
                  {prodDropMounted && (
                    <div className={`pdv-search-dropdown ${prodDropExiting ? 'dropdown-rubber-exit' : 'dropdown-rubber-enter'}`}>
                      {prodResults.map((p) => (
                        <button key={p.id} type="button" className="pdv-search-result" onMouseDown={() => {
                          setPromoForm((s) => ({ ...s, productId: p.id, productQuery: p.name, promoPrice: s.promoPrice || String(p.price) }))
                          setProdDropOpen(false)
                        }}><span>{p.name}</span><span className="pdv-search-price">{fmtCurrency(p.price)}</span></button>
                      ))}
                    </div>
                  )}
                </div>
              </label>
            </div>
            <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
              <button type="button" disabled={!promoForm.name.trim() || !promoForm.promoPrice} onClick={async () => {
                try {
                  await createPromotion({ name: promoForm.name, promoPrice: Number(promoForm.promoPrice), productId: promoForm.productId || undefined })
                  flash('Promoção criada.'); setShowForm(false); setPromoForm({ name: '', promoPrice: '', productId: '', productQuery: '' }); void load('promocoes')
                } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
              }}>Confirmar</button>
            </div>
          </div>
        )}
        <DataTable columns={promoCols} rows={promotions} rowKey={(p) => p.id} loading={loading} emptyMessage="Nenhuma promoção." />
      </TabPanel>

      <TabPanel active={tab === 'devolucoes'}>
        <SearchToolbar query="" onQueryChange={(v) => {}} placeholder="Buscar devolução..." count={returns.length}
          actions={<button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Nova Devolução'}</button>} />
        {showForm && (
          <div className="inline-create-form" style={{ marginBottom: 12 }}>
            <div className="inline-create-body">
              <label>Motivo<input value={returnForm.reason} onChange={(e) => setReturnForm((s) => ({ ...s, reason: e.target.value }))} /></label>
              <label>Cliente ID (opcional)<input value={returnForm.customerId} placeholder="UUID do cliente" onChange={(e) => setReturnForm((s) => ({ ...s, customerId: e.target.value }))} /></label>
              <label>
                Produto (buscar)
                <div className="pdv-search-wrapper">
                  <input value={returnForm.productQuery} placeholder="Buscar produto..." onChange={(e) => { setReturnForm((s) => ({ ...s, productQuery: e.target.value })); searchProd(e.target.value) }}
                    onFocus={() => { if (prodResults.length > 0) setProdDropOpen(true) }}
                    onBlur={() => setTimeout(() => setProdDropOpen(false), 200)} />
                  {prodDropMounted && (
                    <div className={`pdv-search-dropdown ${prodDropExiting ? 'dropdown-rubber-exit' : 'dropdown-rubber-enter'}`}>
                      {prodResults.map((p) => (
                        <button key={p.id} type="button" className="pdv-search-result" onMouseDown={() => {
                          setReturnForm((s) => ({ ...s, productId: p.id, productQuery: p.name }))
                          setProdDropOpen(false)
                        }}><span>{p.name}</span><span className="pdv-search-price">{fmtCurrency(p.price)}</span></button>
                      ))}
                    </div>
                  )}
                </div>
              </label>
              <label>Quantidade<NumericInput value={returnForm.quantity} onChange={(e) => setReturnForm((s) => ({ ...s, quantity: e.target.value }))} /></label>
            </div>
            <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
              <button type="button" disabled={!returnForm.productId || !returnForm.quantity} onClick={async () => {
                try {
                  await createReturnOrder({ reason: returnForm.reason || undefined, customerId: returnForm.customerId || undefined, items: [{ product_id: returnForm.productId, quantity: Number(returnForm.quantity) }] })
                  flash('Devolução criada.'); setShowForm(false); setReturnForm({ reason: '', customerId: '', productId: '', productQuery: '', quantity: '1' }); void load('devolucoes')
                } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
              }}>Registrar Devolução</button>
            </div>
          </div>
        )}
        <DataTable columns={returnCols} rows={returns} rowKey={(r) => r.id} loading={loading} emptyMessage="Nenhuma devolução." />
      </TabPanel>

      <TabPanel active={tab === 'cupons'}>
        <SearchToolbar query="" onQueryChange={(v) => {}} placeholder="Buscar cupom..." count={coupons.length}
          actions={<button type="button" onClick={() => setShowForm(true)}>+ Novo Cupom</button>} />
        {showForm && (
          <div className="inline-create-form" style={{ marginBottom: 12 }}>
            <div className="inline-create-body">
              <label>Código<input value={couponForm.code} placeholder="DESCONTO10" onChange={(e) => setCouponForm((s) => ({ ...s, code: e.target.value.toUpperCase() }))} /></label>
              <label>Tipo
                <Select value={couponForm.couponType} options={[{ value: 'percent', label: 'Percentual (%)' }, { value: 'fixed', label: 'Valor fixo (R$)' }]} onChange={(v) => setCouponForm((s) => ({ ...s, couponType: v as 'percent' | 'fixed' }))} />
              </label>
              <label>Valor ({couponForm.couponType === 'percent' ? '%' : 'R$'})<NumericInput value={couponForm.value} onChange={(e) => setCouponForm((s) => ({ ...s, value: e.target.value }))} /></label>
              <label>Limite de usos (opcional)<input type="number" value={couponForm.maxUses} onChange={(e) => setCouponForm((s) => ({ ...s, maxUses: e.target.value }))} /></label>
            </div>
            <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
              <button type="button" disabled={!couponForm.code.trim() || !couponForm.value} onClick={async () => {
                try {
                  await createCoupon({ code: couponForm.code, couponType: couponForm.couponType, value: Number(couponForm.value), maxUses: couponForm.maxUses ? Number(couponForm.maxUses) : undefined })
                  flash('Cupom criado.'); setShowForm(false); setCouponForm({ code: '', couponType: 'percent', value: '', maxUses: '' }); void load('cupons')
                } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
              }}>Confirmar</button>
            </div>
          </div>
        )}
        <DataTable columns={couponCols} rows={coupons} rowKey={(c) => c.id} loading={loading} emptyMessage="Nenhum cupom." />
      </TabPanel>
    </div>
  )
}
