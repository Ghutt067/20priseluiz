import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { PageHeader } from '../../components/ui'
import { useStatusToast } from '../../hooks/useStatusToast'
import { fmtCurrency, fmtTime, fmtDate, fmtRelative } from '../../lib/formatters'
import {
  fetchDashboardAll,
  type DashboardSummary,
  type DashboardAlerts,
  type ActivityEntry,
  type DashboardCharts,
} from '../../services/dashboard'

function BarChart({ data, height = 80 }: { data: Array<{ label: string; value: number }>; height?: number }) {
  const max = Math.max(...data.map((d) => d.value), 1)
  const barW = 100 / (data.length || 1)
  return (
    <svg width="100%" height={height} style={{ overflow: 'visible' }}>
      {data.map((d, i) => {
        const barH = Math.max((d.value / max) * (height - 18), 2)
        const x = i * barW
        return (
          <g key={d.label}>
            <rect
              x={`${x + barW * 0.1}%`}
              y={height - 18 - barH}
              width={`${barW * 0.8}%`}
              height={barH}
              rx={3}
              fill="var(--accent)"
              opacity={0.85}
            />
            <text
              x={`${x + barW / 2}%`}
              y={height - 4}
              textAnchor="middle"
              fontSize={9}
              fill="var(--muted)"
            >
              {d.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

export function DashboardPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const isVisible = location.pathname === '/dashboard'
  const [summary, setSummary] = useState<DashboardSummary>({ salesToday: { count: 0, revenue: 0 }, pendingPurchases: 0, overdueReceivables: { count: 0, total: 0 }, lowStockProducts: 0, activeContracts: 0 })
  const [alerts, setAlerts] = useState<DashboardAlerts>({ lowStock: [], overduePayments: [], todayAppointments: [] })
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [charts, setCharts] = useState<DashboardCharts>({ salesByDay: [], dreMonth: { receitas: 0, despesas: 0 }, topProducts: [] })
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState('')
  const [view, setView] = useState<'grid' | 'activity'>('grid')
  useStatusToast(status)

  useEffect(() => {
    if (!isVisible) return
    let cancelled = false
    setLoading(true)

    const load = async () => {
      try {
        const result = await fetchDashboardAll()
        if (cancelled) return
        setSummary(result.summary)
        setAlerts(result.alerts)
        setActivity(result.activity)
        setCharts(result.charts)
      } catch (error) {
        console.info('Dashboard load error:', error)
        if (!cancelled) setStatus('Erro ao carregar dashboard.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [isVisible])

  const totalAlerts =
    (alerts?.lowStock.length ?? 0) +
    (alerts?.overduePayments.length ?? 0) +
    (alerts?.todayAppointments.length ?? 0)

  const profit = charts ? charts.dreMonth.receitas - charts.dreMonth.despesas : 0
  const showActivityMore = activity.length > 6
  const previewActivity = activity.slice(0, 7)

  if (view === 'activity') {
    return (
      <div className="page">
        <PageHeader />

        <div className={`dash-widget-grid${loading ? ' loading-fade' : ''}`}>
          <div className="dash-widget dash-widget-span3">
            <div className="dash-widget-header">
              <span className="dash-widget-title">Log recente</span>
              <button type="button" className="ghost" onClick={() => setView('grid')}>Voltar</button>
            </div>
            <div className="dash-widget-list">
              {activity.map((entry) => (
                <div key={entry.id} className="dash-widget-list-row">
                  <span>{entry.summary}</span>
                  <span className="dash-widget-meta">{entry.actorName} · {fmtRelative(entry.createdAt)}</span>
                </div>
              ))}
              {activity.length === 0 && <div className="dash-widget-sub" style={{ padding: '8px 0' }}>Sem atividade recente</div>}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <PageHeader />

      <div className={`dash-widget-grid${loading ? ' loading-fade' : ''}`}>
        {/* Row 1: KPI widgets */}
        <div className="dash-widget" onClick={() => navigate('/vendas')} style={{ cursor: 'pointer' }}>
          <div className="dash-widget-header">
            <span className="dash-widget-title">Vendas hoje</span>
            <span className="dash-widget-link">→ Vendas</span>
          </div>
          <div className="dash-widget-big">{summary.salesToday.count}</div>
          <div className="dash-widget-sub">{fmtCurrency(summary.salesToday.revenue)}</div>
        </div>

        <div className="dash-widget" onClick={() => navigate('/financeiro')} style={{ cursor: 'pointer' }}>
          <div className="dash-widget-header">
            <span className="dash-widget-title">Inadimplência</span>
            <span className="dash-widget-link">→ Financeiro</span>
          </div>
          <div className={`dash-widget-big${summary.overdueReceivables.count > 0 ? ' danger' : ''}`}>{fmtCurrency(summary.overdueReceivables.total)}</div>
          <div className="dash-widget-sub">{summary.overdueReceivables.count} título(s) vencido(s)</div>
        </div>

        <div className="dash-widget" onClick={() => navigate('/relatorios')} style={{ cursor: 'pointer' }}>
          <div className="dash-widget-header">
            <span className="dash-widget-title">Resultado do mês</span>
            <span className="dash-widget-link">→ Relatórios</span>
          </div>
          <div className={`dash-widget-big${profit >= 0 ? ' success' : ' danger'}`}>{fmtCurrency(profit)}</div>
          <div className="dash-widget-sub">{fmtCurrency(charts.dreMonth.receitas)} rec. · {fmtCurrency(charts.dreMonth.despesas)} desp.</div>
        </div>

        {/* Row 2: Chart (span 2) + Estoque baixo */}
        <div className="dash-widget dash-widget-span2">
          <div className="dash-widget-header">
            <span className="dash-widget-title">Faturamento (7 dias)</span>
            <span className="dash-widget-sub">{fmtCurrency(charts.salesByDay.reduce((s, d) => s + d.revenue, 0))}</span>
          </div>
          {charts.salesByDay.length > 0 ? (
            <BarChart
              data={charts.salesByDay.map((d) => ({
                label: new Date(d.day).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
                value: d.revenue,
              }))}
              height={80}
            />
          ) : (
            <div className="dash-widget-sub" style={{ padding: '20px 0', textAlign: 'center' }}>Sem dados no período</div>
          )}
        </div>

        <div className="dash-widget" onClick={() => navigate('/estoque')} style={{ cursor: 'pointer' }}>
          <div className="dash-widget-header">
            <span className="dash-widget-title">Estoque baixo</span>
            <span className="dash-widget-link">→ Estoque</span>
          </div>
          <div className={`dash-widget-big${summary.lowStockProducts > 0 ? ' warning' : ''}`}>{summary.lowStockProducts}</div>
          <div className="dash-widget-sub">produto(s) abaixo do mínimo</div>
        </div>

        {/* Row 3: Pendências + Atalhos + Log */}
        <div className="dash-widget">
          <div className="dash-widget-header">
            <span className="dash-widget-title">Pendências</span>
            {totalAlerts > 0 && <span className="dash-badge">{totalAlerts}</span>}
          </div>
          <div className="dash-widget-list">
            {alerts.todayAppointments.map((a) => (
              <div key={a.id} className="dash-widget-list-row">
                <span>{fmtTime(a.scheduledAt)} — {a.subject}</span>
                <span className="dash-widget-tag">Agenda</span>
              </div>
            ))}
            {alerts.overduePayments.map((p) => (
              <div key={p.titleId} className="dash-widget-list-row">
                <span>{fmtDate(p.dueDate)} — {p.partyName || 'Título'} {fmtCurrency(p.amount)}</span>
                <span className="dash-widget-tag danger">Financeiro</span>
              </div>
            ))}
            {alerts.lowStock.map((s) => (
              <div key={`${s.productId}-${s.warehouseName}`} className="dash-widget-list-row">
                <span>{s.productName} — {Number(s.qtyAvailable).toFixed(0)} / mín {Number(s.minQty).toFixed(0)}</span>
                <span className="dash-widget-tag warning">Estoque</span>
              </div>
            ))}
            {totalAlerts === 0 && <div className="dash-widget-sub" style={{ padding: '8px 0' }}>Nenhuma pendência</div>}
          </div>
        </div>

        <div className="dash-widget">
          <div className="dash-widget-header">
            <span className="dash-widget-title">Atalhos</span>
          </div>
          {/* Compras pendentes + Contratos */}
          <div className="dash-widget-list">
            <div className="dash-widget-list-row" onClick={() => navigate('/compras')} style={{ cursor: 'pointer' }}>
              <span>Compras pendentes</span>
              <strong>{summary.pendingPurchases}</strong>
            </div>
            <div className="dash-widget-list-row" onClick={() => navigate('/contratos')} style={{ cursor: 'pointer' }}>
              <span>Contratos ativos</span>
              <strong>{summary.activeContracts ?? 0}</strong>
            </div>
          </div>
        </div>

        <div className="dash-widget">
          <div className="dash-widget-header">
            <span className="dash-widget-title">Log recente</span>
            {showActivityMore && (
              <button type="button" className="ghost" onClick={() => setView('activity')}>Ver mais</button>
            )}
          </div>
          <div className={`dash-widget-list${showActivityMore ? ' dash-log-preview' : ''}`}>
            {previewActivity.map((entry) => (
              <div key={entry.id} className="dash-widget-list-row">
                <span>{entry.summary}</span>
                <span className="dash-widget-meta">{entry.actorName} · {fmtRelative(entry.createdAt)}</span>
              </div>
            ))}
            {activity.length === 0 && <div className="dash-widget-sub" style={{ padding: '8px 0' }}>Sem atividade recente</div>}
          </div>
        </div>

        {/* Row 4: Curva ABC (full width) */}
        {charts.topProducts.length > 0 && (
          <div className="dash-widget dash-widget-span3">
            <div className="dash-widget-header">
              <span className="dash-widget-title">Curva ABC (Produtos)</span>
            </div>
            <div className="dash-widget-abc">
              {charts.topProducts.map((p, i) => {
                const maxRev = charts.topProducts[0]?.revenue ?? 1
                const pct = Math.round((p.revenue / maxRev) * 100)
                return (
                  <div key={p.id} className="dash-abc-row">
                    <span className="dash-abc-rank">{i + 1}</span>
                    <div className="dash-abc-bar-wrap">
                      <div className="dash-abc-label">
                        <span>{p.name}</span>
                        <span className="dash-widget-sub">{fmtCurrency(p.revenue)}</span>
                      </div>
                      <div className="dash-abc-track">
                        <div className="dash-abc-fill" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
