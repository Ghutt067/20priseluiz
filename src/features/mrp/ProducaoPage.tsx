import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../contexts/useAuth'
import {
  StatusBadge, Tabs, TabPanel, DataTable, type Column, Pagination,
  SearchToolbar, PageHeader, KpiCard, KpiRow, Select,
  DetailPanel, DetailField, DetailGrid,
} from '../../components/ui'
import { LookupField, type LookupSearchParams } from '../inventory/LookupFields'
import { useStatusToast } from '../../hooks/useStatusToast'
import { can } from '../../lib/permissions'
import { fmtCurrency, fmtDate, fmtQty } from '../../lib/formatters'
import {
  fetchBomsPaged, fetchBomDetail, createBom, updateBom, fetchMrpExplosion,
  fetchProductionOrdersPaged, createProductionOrder, updateProductionOrder,
  addProductionCost, fetchProductionCosts, fetchMrpDashboard, searchBomsLookup,
  type BomLookup, type BomDetail, type ProductionOrder, type MrpExplosionRow,
  type ProductionCostSummary, type MrpDashboard, type BomLookupItem,
} from '../../services/mrp'

type Tab = 'dashboard' | 'bom' | 'orders' | 'explosion' | 'costs'

const PAGE_SIZE = 20

const orderStatusLabel: Record<string, string> = {
  planned: 'Planejada', released: 'Liberada', in_progress: 'Em produção', completed: 'Concluída', closed: 'Encerrada',
}
const costTypeLabel: Record<string, string> = {
  material: 'Material', labor: 'Mão de Obra', fixed: 'Fixo', variable: 'Variável', other: 'Outro',
}

function lbl(map: Record<string, string>, key: string | null | undefined): string {
  return map[key ?? ''] ?? key ?? '—'
}

export function ProducaoPage() {
  const { organizationId, role } = useAuth()
  const [tab, setTab] = useState<Tab>('dashboard')
  const [status, setStatus] = useState('')
  const [orderSearch, setOrderSearch] = useState('')

  const [showForm, setShowForm] = useState(false)

  const [dash, setDash] = useState<MrpDashboard | null>(null)
  const [dashLoading, setDashLoading] = useState(false)

  const [boms, setBoms] = useState<BomLookup[]>([])
  const [bomTotal, setBomTotal] = useState(0)
  const [bomOffset, setBomOffset] = useState(0)
  const [bomSearch, setBomSearch] = useState('')
  const [bomLoading, setBomLoading] = useState(false)
  const [selectedBom, setSelectedBom] = useState<BomDetail | null>(null)

  const [orders, setOrders] = useState<ProductionOrder[]>([])
  const [orderTotal, setOrderTotal] = useState(0)
  const [orderOffset, setOrderOffset] = useState(0)
  const [orderStatusFilter, setOrderStatusFilter] = useState('')
  const [orderLoading, setOrderLoading] = useState(false)
  const [selectedOrder, setSelectedOrder] = useState<ProductionOrder | null>(null)

  const [explosion, setExplosion] = useState<MrpExplosionRow[]>([])
  const [explosionLoading, setExplosionLoading] = useState(false)

  const [costSummary, setCostSummary] = useState<ProductionCostSummary | null>(null)
  const [costOrderId, setCostOrderId] = useState<string | null>(null)
  const [costLoading, setCostLoading] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  useStatusToast(status)
  const canCreate = can(role ?? '', 'mrp.bom.create')

  const tabItems = useMemo(() => [
    { key: 'dashboard' as const, label: 'Painel' },
    { key: 'bom' as const, label: 'Fichas Técnicas', count: bomTotal },
    { key: 'orders' as const, label: 'Ordens de Produção', count: orderTotal },
    { key: 'explosion' as const, label: 'Explosão MRP' },
    { key: 'costs' as const, label: 'Custos' },
  ], [bomTotal, orderTotal])

  const loadDash = useCallback(async () => {
    if (!organizationId) return
    setDashLoading(true)
    try { setDash(await fetchMrpDashboard()) } catch { /* */ }
    setDashLoading(false)
  }, [organizationId])

  const loadBoms = useCallback(async () => {
    if (!organizationId) return
    abortRef.current?.abort()
    const ctrl = new AbortController(); abortRef.current = ctrl
    setBomLoading(true)
    try {
      const r = await fetchBomsPaged({ query: bomSearch, offset: bomOffset, limit: PAGE_SIZE, signal: ctrl.signal })
      setBoms(r.rows); setBomTotal(r.totalCount)
    } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) setStatus(e instanceof Error ? e.message : 'Erro.') }
    setBomLoading(false)
  }, [organizationId, bomSearch, bomOffset])

  const loadOrders = useCallback(async () => {
    if (!organizationId) return
    abortRef.current?.abort()
    const ctrl = new AbortController(); abortRef.current = ctrl
    setOrderLoading(true)
    try {
      const r = await fetchProductionOrdersPaged({ status: orderStatusFilter || undefined, offset: orderOffset, limit: PAGE_SIZE, signal: ctrl.signal })
      setOrders(r.rows); setOrderTotal(r.totalCount)
    } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) setStatus(e instanceof Error ? e.message : 'Erro.') }
    setOrderLoading(false)
  }, [organizationId, orderStatusFilter, orderOffset])

  const loadExplosion = useCallback(async () => {
    if (!organizationId) return
    setExplosionLoading(true)
    try { setExplosion(await fetchMrpExplosion()) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setExplosionLoading(false)
  }, [organizationId])

  const loadCosts = useCallback(async () => {
    if (!costOrderId) return
    setCostLoading(true)
    try { setCostSummary(await fetchProductionCosts(costOrderId)) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setCostLoading(false)
  }, [costOrderId])

  useEffect(() => {
    if (tab === 'dashboard') void loadDash()
    if (tab === 'bom') void loadBoms()
    if (tab === 'orders') void loadOrders()
    if (tab === 'explosion') void loadExplosion()
    if (tab === 'costs') void loadCosts()
    return () => { abortRef.current?.abort() }
  }, [tab, loadDash, loadBoms, loadOrders, loadExplosion, loadCosts])

  const handleToggleBom = async (id: string, active: boolean) => {
    try { await updateBom(id, { active: !active }); setStatus(active ? 'BOM desativada.' : 'BOM ativada.'); void loadBoms() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const handleOrderStatus = async (id: string, s: string) => {
    try { await updateProductionOrder(id, { status: s }); setStatus('Status da ordem atualizado.'); void loadOrders() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const handleBomClick = async (b: BomLookup) => {
    if (selectedBom?.bom.id === b.id) { setSelectedBom(null); return }
    try { setSelectedBom(await fetchBomDetail(b.id)) } catch { /* */ }
  }

  const bomCols: Column<BomLookup>[] = useMemo(() => [
    { key: 'name', header: 'Nome', render: (b) => <strong>{b.name}</strong> },
    { key: 'product', header: 'Produto', render: (b) => b.productName },
    { key: 'sku', header: 'SKU', render: (b) => b.productSku },
    { key: 'version', header: 'Versão', render: (b) => b.version },
    { key: 'active', header: 'Ativo', render: (b) => b.active ? 'Sim' : 'Não' },
    { key: 'created', header: 'Criação', render: (b) => fmtDate(b.createdAt) },
    ...(canCreate ? [{
      key: 'actions', header: 'Ações', render: (b: BomLookup) => (
        <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={(e) => { e.stopPropagation(); void handleToggleBom(b.id, b.active) }}>{b.active ? 'Desativar' : 'Ativar'}</button>
      ),
    }] : []),
  ], [canCreate])

  const orderCols: Column<ProductionOrder>[] = useMemo(() => [
    { key: 'product', header: 'Produto', render: (o) => <strong>{o.productName}</strong> },
    { key: 'bom', header: 'BOM', render: (o) => o.bomName },
    { key: 'warehouse', header: 'Depósito', render: (o) => o.warehouseName },
    { key: 'qtyPlan', header: 'Qtd Plan.', align: 'right', render: (o) => fmtQty(o.qtyPlanned) },
    { key: 'qtyProd', header: 'Qtd Prod.', align: 'right', render: (o) => fmtQty(o.qtyProduced) },
    { key: 'progress', header: 'Progresso', render: (o) => {
      const pct = o.qtyPlanned > 0 ? Math.min(100, Math.round((o.qtyProduced / o.qtyPlanned) * 100)) : 0
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 60, height: 6, background: 'var(--border)', borderRadius: 3 }}>
            <div style={{ width: `${pct}%`, height: '100%', background: pct >= 100 ? '#38a169' : 'var(--accent)', borderRadius: 3 }} />
          </div>
          <span style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>{pct}%</span>
        </div>
      )
    }},
    { key: 'status', header: 'Status', render: (o) => <StatusBadge status={o.status} label={lbl(orderStatusLabel, o.status)} /> },
    { key: 'dates', header: 'Período', render: (o) => `${fmtDate(o.startDate)} — ${fmtDate(o.endDate)}` },
    { key: 'actions', header: 'Ações', render: (o) => (
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button type="button" className="ghost" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); setCostOrderId(o.id); setTab('costs') }}>Custos</button>
        {canCreate && o.status === 'planned' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={(e) => { e.stopPropagation(); void handleOrderStatus(o.id, 'released') }}>Liberar</button>}
        {canCreate && o.status === 'released' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={(e) => { e.stopPropagation(); void handleOrderStatus(o.id, 'in_progress') }}>Iniciar</button>}
        {canCreate && o.status === 'in_progress' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={(e) => { e.stopPropagation(); void handleOrderStatus(o.id, 'completed') }}>Concluir</button>}
      </div>
    )},
  ], [canCreate])

  const explosionCols: Column<MrpExplosionRow>[] = useMemo(() => [
    { key: 'name', header: 'Componente', render: (r) => <strong>{r.componentName}</strong> },
    { key: 'sku', header: 'SKU', render: (r) => r.componentSku },
    { key: 'gross', header: 'Necessidade Bruta', align: 'right', render: (r) => fmtQty(r.grossRequired) },
    { key: 'free', header: 'Estoque Livre', align: 'right', render: (r) => fmtQty(r.freeStock) },
    { key: 'net', header: 'Necessidade Líquida', align: 'right', render: (r) => (
      <strong style={{ color: Number(r.netRequired) > 0 ? '#c33' : '#38a169' }}>{fmtQty(r.netRequired)}</strong>
    )},
  ], [])

  const orderStatusOptions = [
    { value: '', label: 'Todos os status' },
    { value: 'planned', label: 'Planejada' },
    { value: 'released', label: 'Liberada' },
    { value: 'in_progress', label: 'Em produção' },
    { value: 'completed', label: 'Concluída' },
    { value: 'closed', label: 'Encerrada' },
  ]

  return (
    <div className="page">
      <PageHeader />
      <Tabs tabs={tabItems} active={tab} onChange={(k) => { setTab(k); setShowForm(false); setSelectedBom(null); setSelectedOrder(null) }} />

      {/* ── DASHBOARD ── */}
      <TabPanel active={tab === 'dashboard'}>
        
        
          <KpiRow>
              <KpiCard label="BOMs Cadastradas" value={dash.totalBoms} />
              <KpiCard label="Ordens Ativas" value={dash.activeOrders} tone="warning" />
              <KpiCard label="Atrasadas" value={dash.lateOrders} tone={dash.lateOrders > 0 ? 'danger' : 'default'} />
              <KpiCard label="Concluídas (mês)" value={dash.completedThisMonth} tone="success" />
            </KpiRow>
            {dash.lateOrders > 0 && (
              <div className="card" style={{ borderLeft: '3px solid #c44' }}>
                <strong>{dash.lateOrders} ordem(ns) de produção atrasada(s)</strong>
              </div>
            )}
      </TabPanel>

      {/* ── BOM ── */}
      <TabPanel active={tab === 'bom'}>
        <SearchToolbar
          query={bomSearch}
          onQueryChange={(v) => { setBomSearch(v); setBomOffset(0) }}
          placeholder="Buscar ficha técnica..."
          count={bomTotal}
          actions={canCreate ? <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Nova Ficha Técnica'}</button> : undefined}
        />
        {showForm && <BomForm onSaved={() => { setShowForm(false); setStatus('Ficha técnica criada.'); void loadBoms() }} />}
        <DataTable columns={bomCols} rows={boms} rowKey={(b) => b.id} loading={bomLoading} onRowClick={(b) => void handleBomClick(b)} />
        <Pagination total={bomTotal} offset={bomOffset} limit={PAGE_SIZE} loading={bomLoading} onPageChange={setBomOffset} />

        {selectedBom && (
          <DetailPanel open onClose={() => setSelectedBom(null)} title={selectedBom.bom.name} subtitle={`Produto: ${selectedBom.bom.productName} • Versão: ${selectedBom.bom.version}`}>
            <h4 style={{ margin: '0 0 8px' }}>Componentes ({selectedBom.items.length})</h4>
            <table className="data-table" style={{ fontSize: '0.84rem' }}>
              <thead><tr><th>Componente</th><th>SKU</th><th>Qtd/Un</th><th>Unidade</th><th>% Perda</th></tr></thead>
              <tbody>{selectedBom.items.map(it => (
                <tr key={it.id}>
                  <td>{it.componentName}</td><td>{it.componentSku}</td>
                  <td style={{ textAlign: 'right' }}>{fmtQty(it.qtyPerUnit)}</td>
                  <td>{it.unitOfMeasure}</td>
                  <td style={{ textAlign: 'right' }}>{fmtQty(it.scrapPct, 1)}%</td>
                </tr>
              ))}</tbody>
            </table>
          </DetailPanel>
        )}
      </TabPanel>

      {/* ── ORDENS ── */}
      <TabPanel active={tab === 'orders'}>
        <SearchToolbar
          query={orderSearch}
          onQueryChange={(v) => {}}
          placeholder="Buscar ordem..."
          count={orderTotal}
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              <Select value={orderStatusFilter} options={orderStatusOptions} onChange={(v) => { setOrderStatusFilter(v); setOrderOffset(0) }} />
              {canCreate && <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Nova Ordem'}</button>}
            </div>
          }
        />
        {showForm && <ProductionOrderForm onSaved={() => { setShowForm(false); setStatus('Ordem criada.'); void loadOrders() }} />}
        <DataTable columns={orderCols} rows={orders} rowKey={(o) => o.id} loading={orderLoading}
          onRowClick={(o) => setSelectedOrder(selectedOrder?.id === o.id ? null : o)} />
        <Pagination total={orderTotal} offset={orderOffset} limit={PAGE_SIZE} loading={orderLoading} onPageChange={setOrderOffset} />

        {selectedOrder && (
          <DetailPanel open onClose={() => setSelectedOrder(null)} title={`Ordem: ${selectedOrder.productName}`} subtitle={`BOM: ${selectedOrder.bomName} • Depósito: ${selectedOrder.warehouseName}`}>
            <DetailGrid columns={4}>
              <DetailField label="Status" value={lbl(orderStatusLabel, selectedOrder.status)} />
              <DetailField label="Qtd Planejada" value={fmtQty(selectedOrder.qtyPlanned)} />
              <DetailField label="Qtd Produzida" value={fmtQty(selectedOrder.qtyProduced)} />
              <DetailField label="Progresso" value={`${selectedOrder.qtyPlanned > 0 ? Math.round((selectedOrder.qtyProduced / selectedOrder.qtyPlanned) * 100) : 0}%`} />
              <DetailField label="Início" value={fmtDate(selectedOrder.startDate)} />
              <DetailField label="Fim" value={fmtDate(selectedOrder.endDate)} />
              <DetailField label="Criação" value={fmtDate(selectedOrder.createdAt)} />
            </DetailGrid>
          </DetailPanel>
        )}
      </TabPanel>

      {/* ── EXPLOSÃO ── */}
      <TabPanel active={tab === 'explosion'}>
        <DataTable columns={explosionCols} rows={explosion} rowKey={(r) => r.componentProductId} loading={explosionLoading} emptyMessage="Nenhuma necessidade pendente." />
      </TabPanel>

      {/* ── CUSTOS ── */}
      <TabPanel active={tab === 'costs'}>

        {costOrderId && costSummary && (
          <>
            <KpiRow>
              <KpiCard label="Custo Total" value={fmtCurrency(costSummary.totalCost)} />
              <KpiCard label="Custo Unitário" value={fmtCurrency(costSummary.unitCost)} />
              <KpiCard label="Lançamentos" value={costSummary.items.length} />
            </KpiRow>
            <DataTable
              columns={[
                { key: 'type', header: 'Tipo', render: (c) => lbl(costTypeLabel, c.costType) },
                { key: 'desc', header: 'Descrição', render: (c) => c.description ?? '—' },
                { key: 'amount', header: 'Valor', align: 'right', render: (c) => fmtCurrency(c.amount) },
                { key: 'date', header: 'Data', render: (c) => fmtDate(c.createdAt) },
              ]}
              rows={costSummary.items}
              rowKey={(c) => c.id}
              emptyMessage="Nenhum custo registrado."
            />
            {canCreate && <CostForm orderId={costOrderId} onSaved={() => { setStatus('Custo registrado.'); void loadCosts() }} />}
          </>
        )}
      </TabPanel>
    </div>
  )
}

/* ── Sub-forms with LookupField ── */

function BomLookupField({ value, selectedLabel, onSelect, onClear }: {
  value: string; selectedLabel: string
  onSelect: (item: BomLookupItem) => void; onClear: () => void
}) {
  const search = useCallback(async (params: LookupSearchParams) => {
    return searchBomsLookup({ query: params.query, offset: params.offset, limit: params.limit, signal: params.signal })
  }, [])
  return (
    <label className="purchase-order-lookup">
      Ficha Técnica (BOM) *
      <LookupField<BomLookupItem>
        value={value} selectedLabel={selectedLabel} placeholder="Buscar BOM..."
        searchOptions={search} onSelect={onSelect} onClear={onClear}
        renderMeta={(item) => item.productName}
      />
    </label>
  )
}

function BomForm({ onSaved }: { onSaved: () => void }) {
  const [productId, setProductId] = useState('')
  const [name, setName] = useState('')
  const [version, setVersion] = useState('1.0')
  const [items, setItems] = useState([{ componentProductId: '', qtyPerUnit: '', scrapPct: '0' }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const addItem = () => setItems([...items, { componentProductId: '', qtyPerUnit: '', scrapPct: '0' }])
  const updateItem = (i: number, field: string, value: string) => {
    const next = [...items]; (next[i] as Record<string, string>)[field] = value; setItems(next)
  }

  const handleSubmit = async () => {
    if (!productId || !name || items.length === 0) return
    setSubmitting(true); setError('')
    try {
      await createBom({
        productId, name, version,
        items: items.filter(it => it.componentProductId && it.qtyPerUnit).map(it => ({
          componentProductId: it.componentProductId,
          qtyPerUnit: Number(it.qtyPerUnit),
          scrapPct: Number(it.scrapPct) || 0,
        })),
      })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro ao salvar.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <label>ID do Produto Acabado * <input value={productId} onChange={e => setProductId(e.target.value)} placeholder="Código do produto" /></label>
        <label>Nome da Ficha * <input value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Cadeira Modelo A" /></label>
        <label>Versão <input value={version} onChange={e => setVersion(e.target.value)} /></label>
        <h4 style={{ margin: '8px 0 4px' }}>Componentes</h4>
        {items.map((it, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
            <input placeholder="UUID componente" value={it.componentProductId} onChange={e => updateItem(i, 'componentProductId', e.target.value)} style={{ flex: 2 }} />
            <input type="number" step="0.01" placeholder="Qty/un" value={it.qtyPerUnit} onChange={e => updateItem(i, 'qtyPerUnit', e.target.value)} style={{ flex: 1 }} />
            <input type="number" step="0.1" placeholder="% perda" value={it.scrapPct} onChange={e => updateItem(i, 'scrapPct', e.target.value)} style={{ flex: 1 }} />
          </div>
        ))}
        <button type="button" className="ghost" onClick={addItem} style={{ fontSize: 12 }}>+ Componente</button>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
        <button type="button" disabled={!productId || !name || submitting} onClick={() => void handleSubmit()}>
          {submitting ? 'Processando...' : 'Criar Ficha Técnica'}
        </button>
      </div>
    </div>
  )
}

function ProductionOrderForm({ onSaved }: { onSaved: () => void }) {
  const [bomId, setBomId] = useState('')
  const [bomLabel, setBomLabel] = useState('')
  const [productId, setProductId] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [qtyPlanned, setQtyPlanned] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!bomId || !productId || !warehouseId || !qtyPlanned) return
    setSubmitting(true); setError('')
    try {
      await createProductionOrder({
        bomId, productId, warehouseId, qtyPlanned: Number(qtyPlanned),
        startDate: startDate || undefined, endDate: endDate || undefined,
      })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro ao salvar.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <BomLookupField value={bomId} selectedLabel={bomLabel} onSelect={(b) => { setBomId(b.id); setBomLabel(b.name) }} onClear={() => { setBomId(''); setBomLabel('') }} />
        <label>ID do Produto * <input value={productId} onChange={e => setProductId(e.target.value)} placeholder="Código" /></label>
        <label>ID do Depósito * <input value={warehouseId} onChange={e => setWarehouseId(e.target.value)} placeholder="Código" /></label>
        <label>Quantidade Planejada * <input type="number" step="0.01" value={qtyPlanned} onChange={e => setQtyPlanned(e.target.value)} /></label>
        <label>Data Início <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></label>
        <label>Data Fim <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
        <button type="button" disabled={!bomId || !productId || !warehouseId || !qtyPlanned || submitting} onClick={() => void handleSubmit()}>
          {submitting ? 'Processando...' : 'Criar Ordem de Produção'}
        </button>
      </div>
    </div>
  )
}

function CostForm({ orderId, onSaved }: { orderId: string; onSaved: () => void }) {
  const [costType, setCostType] = useState('material')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!amount) return
    setSubmitting(true); setError('')
    try {
      await addProductionCost(orderId, { costType, description: description || undefined, amount: Number(amount) })
      setAmount(''); setDescription('')
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro ao salvar.') }
    setSubmitting(false)
  }

  return (
    <div style={{ marginTop: 16, padding: 12, background: 'var(--color-bg-alt, #f9f9f9)', borderRadius: 8 }}>
      <strong>Adicionar Custo</strong>
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <select value={costType} onChange={e => setCostType(e.target.value)}>
          <option value="material">Material</option><option value="labor">Mão de Obra</option>
          <option value="fixed">Fixo</option><option value="variable">Variável</option><option value="other">Outro</option>
        </select>
        <input placeholder="Descrição" value={description} onChange={e => setDescription(e.target.value)} style={{ flex: 1 }} />
        <input type="number" step="0.01" placeholder="Valor (R$)" value={amount} onChange={e => setAmount(e.target.value)} style={{ width: 120 }} />
        <button type="button" disabled={!amount || submitting} onClick={() => void handleSubmit()}>
          {submitting ? '...' : 'Adicionar'}
        </button>
      </div>
      {error && <p style={{ color: '#c44', fontSize: 12 }}>{error}</p>}
    </div>
  )
}
