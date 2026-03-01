import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../contexts/useAuth'
import {
  StatusBadge, Tabs, TabPanel, DataTable, type Column, Pagination, Select,
  SearchToolbar, PageHeader, KpiCard, KpiRow,
  DetailPanel, DetailField, DetailGrid,
} from '../../components/ui'
import { useStatusToast } from '../../hooks/useStatusToast'
import { can } from '../../lib/permissions'
import { fmtCurrency, fmtDate, fmtQty } from '../../lib/formatters'
import {
  fetchAssetsPaged, createAsset, updateAsset, calculateDepreciation,
  fetchAssetDepreciations, transferAsset, fetchAssetTransfers,
  type FixedAsset, type AssetDepreciation, type AssetTransfer,
} from '../../services/assets'

type Tab = 'dashboard' | 'assets' | 'depreciation' | 'transfers'
const PAGE_SIZE = 20

const assetStatusLabel: Record<string, string> = { active: 'Ativo', disposed: 'Baixado', in_maintenance: 'Em manutenção' }

function lbl(map: Record<string, string>, key: string | null | undefined): string { return map[key ?? ''] ?? key ?? '—' }

export function PatrimonioPage() {
  const { organizationId, role } = useAuth()
  const [tab, setTab] = useState<Tab>('dashboard')
  const [status, setStatus] = useState('')
  const [showForm, setShowForm] = useState(false)

  const [assets, setAssets] = useState<FixedAsset[]>([])
  const [assetTotal, setAssetTotal] = useState(0)
  const [assetOffset, setAssetOffset] = useState(0)
  const [assetSearch, setAssetSearch] = useState('')
  const [assetStatusFilter, setAssetStatusFilter] = useState('')
  const [assetLoading, setAssetLoading] = useState(false)
  const [selectedAsset, setSelectedAsset] = useState<FixedAsset | null>(null)
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null)

  const [depreciations, setDepreciations] = useState<AssetDepreciation[]>([])
  const [depLoading, setDepLoading] = useState(false)
  const [depMonth, setDepMonth] = useState(new Date().toISOString().slice(0, 7) + '-01')

  const [transfers, setTransfers] = useState<AssetTransfer[]>([])
  const [trLoading, setTrLoading] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  useStatusToast(status)
  const canManage = can(role ?? '', 'asset.create')

  const tabItems = useMemo(() => [
    { key: 'dashboard' as const, label: 'Painel' },
    { key: 'assets' as const, label: 'Ativos', count: assetTotal },
    { key: 'depreciation' as const, label: 'Depreciação' },
    { key: 'transfers' as const, label: 'Transferências' },
  ], [assetTotal])

  const loadAssets = useCallback(async () => {
    if (!organizationId) return
    abortRef.current?.abort()
    const ctrl = new AbortController(); abortRef.current = ctrl
    setAssetLoading(true)
    try {
      const r = await fetchAssetsPaged({ query: assetSearch, status: assetStatusFilter || undefined, offset: assetOffset, limit: PAGE_SIZE, signal: ctrl.signal })
      setAssets(r.rows); setAssetTotal(r.totalCount)
    } catch (e) { if (!(e instanceof DOMException && e.name === 'AbortError')) setStatus(e instanceof Error ? e.message : 'Erro.') }
    setAssetLoading(false)
  }, [organizationId, assetSearch, assetStatusFilter, assetOffset])

  const loadDep = useCallback(async () => {
    if (!selectedAssetId) return
    setDepLoading(true)
    try { setDepreciations(await fetchAssetDepreciations(selectedAssetId)) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setDepLoading(false)
  }, [selectedAssetId])

  const loadTr = useCallback(async () => {
    if (!selectedAssetId) return
    setTrLoading(true)
    try { setTransfers(await fetchAssetTransfers(selectedAssetId)) } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setTrLoading(false)
  }, [selectedAssetId])

  useEffect(() => {
    if (tab === 'dashboard' || tab === 'assets') void loadAssets()
    if (tab === 'depreciation') void loadDep()
    if (tab === 'transfers') void loadTr()
    return () => { abortRef.current?.abort() }
  }, [tab, loadAssets, loadDep, loadTr])

  const handleDispose = async (id: string) => {
    try { await updateAsset(id, { status: 'disposed' }); setStatus('Ativo baixado.'); void loadAssets() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }
  const handleCalcDep = async () => {
    try { const r = await calculateDepreciation(depMonth); setStatus(`Depreciação calculada: ${r.calculated} ativos.`) }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const dashTotalValue = useMemo(() => assets.reduce((s, a) => s + Number(a.acquisitionValue), 0), [assets])
  const dashActive = useMemo(() => assets.filter(a => a.status === 'active').length, [assets])

  const assetCols: Column<FixedAsset>[] = useMemo(() => [
    { key: 'name', header: 'Nome', render: (a) => <strong>{a.name}</strong> },
    { key: 'category', header: 'Categoria', render: (a) => a.category },
    { key: 'number', header: 'Nº Patrimônio', render: (a) => a.assetNumber ?? '—' },
    { key: 'acqValue', header: 'Valor Aquisição', align: 'right', render: (a) => fmtCurrency(a.acquisitionValue) },
    { key: 'curValue', header: 'Valor Atual', align: 'right', render: (a) => fmtCurrency(a.currentValue ?? a.acquisitionValue) },
    { key: 'acqDate', header: 'Aquisição', render: (a) => fmtDate(a.acquisitionDate) },
    { key: 'life', header: 'Vida Útil', render: (a) => `${a.usefulLifeMonths} meses` },
    { key: 'status', header: 'Status', render: (a) => <StatusBadge status={a.status} label={lbl(assetStatusLabel, a.status)} /> },
    { key: 'actions', header: 'Ações', render: (a) => (
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button type="button" className="ghost" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); setSelectedAssetId(a.id); setTab('depreciation') }}>Deprec.</button>
        <button type="button" className="ghost" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); setSelectedAssetId(a.id); setTab('transfers') }}>Transf.</button>
        {canManage && a.status === 'active' && <button type="button" className="ghost" style={{ fontSize: 11, color: '#c44' }} onClick={(e) => { e.stopPropagation(); void handleDispose(a.id) }}>Baixar</button>}
      </div>
    )},
  ], [canManage])

  const depCols: Column<AssetDepreciation>[] = useMemo(() => [
    { key: 'month', header: 'Mês', render: (d) => d.referenceMonth },
    { key: 'dep', header: 'Depreciação', align: 'right', render: (d) => fmtCurrency(d.depreciationValue) },
    { key: 'accum', header: 'Acumulada', align: 'right', render: (d) => fmtCurrency(d.accumulatedDepreciation) },
    { key: 'book', header: 'Valor Contábil', align: 'right', render: (d) => fmtCurrency(d.bookValue) },
    { key: 'created', header: 'Calculado em', render: (d) => fmtDate(d.createdAt) },
  ], [])

  const trCols: Column<AssetTransfer>[] = useMemo(() => [
    { key: 'from', header: 'De', render: (t) => t.fromUserId?.slice(0, 8) ?? '—' },
    { key: 'to', header: 'Para', render: (t) => t.toUserId.slice(0, 8) },
    { key: 'date', header: 'Data', render: (t) => fmtDate(t.transferDate) },
    { key: 'reason', header: 'Motivo', render: (t) => t.reason ?? '—' },
    { key: 'created', header: 'Registrado', render: (t) => fmtDate(t.createdAt) },
  ], [])

  const statusOpts = [
    { value: '', label: 'Todos' }, { value: 'active', label: 'Ativo' },
    { value: 'disposed', label: 'Baixado' },
  ]

  return (
    <div className="page">
      <PageHeader />
      <Tabs tabs={tabItems} active={tab} onChange={(k) => { setTab(k); setShowForm(false); setSelectedAsset(null) }} />

      <TabPanel active={tab === 'dashboard'}>
        <KpiRow>
          <KpiCard label="Total Ativos" value={assetTotal} />
          <KpiCard label="Ativos" value={dashActive} tone="success" />
          <KpiCard label="Valor Patrimonial" value={fmtCurrency(dashTotalValue)} />
        </KpiRow>
      </TabPanel>

      <TabPanel active={tab === 'assets'}>
        <SearchToolbar query={assetSearch} onQueryChange={(v) => { setAssetSearch(v); setAssetOffset(0) }}
          placeholder="Buscar ativo..." count={assetTotal}
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              <Select value={assetStatusFilter} options={statusOpts} onChange={(v) => { setAssetStatusFilter(v); setAssetOffset(0) }} />
              {canManage && <button type="button" onClick={() => setShowForm(true)}>+ Novo Ativo</button>}
            </div>
          }
        />
        {showForm && <AssetForm onSaved={() => { setShowForm(false); setStatus('Ativo criado.'); void loadAssets() }} />}
        <DataTable columns={assetCols} rows={assets} rowKey={(a) => a.id} loading={assetLoading}
          onRowClick={(a) => setSelectedAsset(selectedAsset?.id === a.id ? null : a)} />
        <Pagination total={assetTotal} offset={assetOffset} limit={PAGE_SIZE} loading={assetLoading} onPageChange={setAssetOffset} />

        {selectedAsset && (
          <DetailPanel open onClose={() => setSelectedAsset(null)} title={selectedAsset.name}
            subtitle={`${selectedAsset.category} • Nº ${selectedAsset.assetNumber ?? '—'}`}>
            <DetailGrid columns={4}>
              <DetailField label="Status" value={lbl(assetStatusLabel, selectedAsset.status)} />
              <DetailField label="Valor Aquisição" value={fmtCurrency(selectedAsset.acquisitionValue)} />
              <DetailField label="Valor Atual" value={fmtCurrency(selectedAsset.currentValue ?? selectedAsset.acquisitionValue)} />
              <DetailField label="Valor Residual" value={fmtCurrency(selectedAsset.residualValue)} />
              <DetailField label="Data Aquisição" value={fmtDate(selectedAsset.acquisitionDate)} />
              <DetailField label="Vida Útil" value={`${selectedAsset.usefulLifeMonths} meses`} />
              <DetailField label="Método" value={selectedAsset.depreciationMethod} />
              <DetailField label="Localização" value={selectedAsset.locationDescription ?? '—'} />
            </DetailGrid>
          </DetailPanel>
        )}
      </TabPanel>

      <TabPanel active={tab === 'depreciation'}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
          <label>Mês referência: <input type="month" value={depMonth.slice(0, 7)} onChange={e => setDepMonth(e.target.value + '-01')} /></label>
          {canManage && <button type="button" onClick={() => void handleCalcDep()}>Calcular Depreciação</button>}
        </div>
        
        {selectedAssetId && <DataTable columns={depCols} rows={depreciations} rowKey={(d) => d.id} loading={depLoading} emptyMessage="Nenhuma depreciação registrada." />}
      </TabPanel>

      <TabPanel active={tab === 'transfers'}>
        
        {selectedAssetId && (
          <>
            <SearchToolbar query="" onQueryChange={() => {}} placeholder="Filtrar transferências..."
              count={transfers.length}
              actions={canManage ? <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Transferir'}</button> : undefined}
            />
            {showForm && <TransferForm assetId={selectedAssetId} onSaved={() => { setShowForm(false); setStatus('Ativo transferido.'); void loadTr() }} />}
            <DataTable columns={trCols} rows={transfers} rowKey={(t) => t.id} loading={trLoading} emptyMessage="Nenhuma transferência registrada." />
          </>
        )}
      </TabPanel>
    </div>
  )
}

function AssetForm({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [assetNumber, setAssetNumber] = useState('')
  const [acquisitionValue, setAcquisitionValue] = useState('')
  const [acquisitionDate, setAcquisitionDate] = useState(new Date().toISOString().slice(0, 10))
  const [usefulLifeMonths, setUsefulLifeMonths] = useState('60')
  const [residualValue, setResidualValue] = useState('0')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!name || !category || !acquisitionValue) return
    setSubmitting(true); setError('')
    try {
      await createAsset({
        name, category, assetNumber: assetNumber || undefined,
        acquisitionValue: Number(acquisitionValue), acquisitionDate,
        usefulLifeMonths: Number(usefulLifeMonths) || 60,
        residualValue: Number(residualValue) || 0,
      })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro ao salvar.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <label>Nome * <input value={name} onChange={e => setName(e.target.value)} placeholder="Ex: Empilhadeira Yale" /></label>
        <label>Categoria * <input value={category} onChange={e => setCategory(e.target.value)} placeholder="Máquinas, Veículos, TI..." /></label>
        <label>Nº Patrimônio <input value={assetNumber} onChange={e => setAssetNumber(e.target.value)} /></label>
        <label>Valor de Aquisição (R$) * <input type="number" step="0.01" value={acquisitionValue} onChange={e => setAcquisitionValue(e.target.value)} /></label>
        <label>Data de Aquisição * <input type="date" value={acquisitionDate} onChange={e => setAcquisitionDate(e.target.value)} /></label>
        <label>Vida Útil (meses) <input type="number" value={usefulLifeMonths} onChange={e => setUsefulLifeMonths(e.target.value)} /></label>
        <label>Valor Residual (R$) <input type="number" step="0.01" value={residualValue} onChange={e => setResidualValue(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
        <button type="button" disabled={!name || !category || !acquisitionValue || submitting} onClick={() => void handleSubmit()}>
          {submitting ? 'Processando...' : 'Criar Ativo'}
        </button>
      </div>
    </div>
  )
}

function TransferForm({ assetId, onSaved }: { assetId: string; onSaved: () => void }) {
  const [toUserId, setToUserId] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!toUserId) return
    setSubmitting(true); setError('')
    try { await transferAsset(assetId, { toUserId, reason: reason || undefined }); onSaved() }
    catch (e) { setError(e instanceof Error ? e.message : 'Erro ao salvar.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <label>ID do Novo Responsável * <input value={toUserId} onChange={e => setToUserId(e.target.value)} placeholder="UUID do usuário" /></label>
        <label>Motivo <input value={reason} onChange={e => setReason(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
        <button type="button" disabled={!toUserId || submitting} onClick={() => void handleSubmit()}>
          {submitting ? 'Processando...' : 'Transferir Ativo'}
        </button>
      </div>
    </div>
  )
}
