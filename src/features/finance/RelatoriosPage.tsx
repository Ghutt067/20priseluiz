import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react'
import {
  autoReconcile,
  fetchBankTransactionsPaged,
  fetchFinanceInstallmentsPaged,
  fetchFinancialAccountsPaged,
  fetchReconciliationActivity,
  importOfx,
  reconcileBankTransaction,
  reconcileBankTransactionAdjustment,
  reconcileBankTransactionSettle,
  type BankTransactionLookup,
  type FinancialAccountLookup,
  type FinancialInstallmentLookup,
  type ReconciliationActivity,
} from '../../services/finance'
import { DateInput, NumericInput, Select, Tabs, TabPanel, PageHeader } from '../../components/ui'
import { useAuth } from '../../contexts/useAuth'
import { useStatusToast } from '../../hooks/useStatusToast'
import { toNumber, fmtCurrency, fmtDateFull, fmtDateTime, pageInfoLabel, canGoNextPage } from '../../lib/formatters'
import {
  fetchAgingEntriesReport,
  fetchAgingReport,
  fetchCashflowEntriesReport,
  fetchCashflowReport,
  fetchCommissionsReport,
  fetchDreReport,
  fetchInventoryTurnover,
  fetchInventoryValue,
  fetchMarginByProduct,
  fetchSalesReport,
  fetchTopCustomers,
  type AgingBucket,
  type AgingEntryReportRow,
  type CashflowEntryReportRow,
  type CashflowReportRow,
} from '../../services/reports'

function MiniBarChart({ data, height = 64, color = 'var(--accent)' }: {
  data: Array<{ label: string; value: number }>
  height?: number
  color?: string
}) {
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1)
  const bw = 100 / (data.length || 1)
  return (
    <svg width="100%" height={height} style={{ overflow: 'visible', marginTop: 6 }}>
      {data.map((d, i) => {
        const bh = Math.max((Math.abs(d.value) / max) * (height - 14), 2)
        const isNeg = d.value < 0
        return (
          <g key={d.label}>
            <rect x={`${i * bw + bw * 0.1}%`} y={height - 14 - bh} width={`${bw * 0.8}%`}
              height={bh} rx={2} fill={isNeg ? '#c44' : color} opacity={0.8} />
            <text x={`${i * bw + bw / 2}%`} y={height - 2} textAnchor="middle" fontSize={8} fill="var(--muted)">
              {d.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

function HorizontalBar({ value, max, label, amount }: { value: number; max: number; label: string; amount: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: 3 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{label}</span>
        <span style={{ color: 'var(--muted)', flexShrink: 0, marginLeft: 8 }}>{amount}</span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: 'var(--border)' }}>
        <div style={{ height: '100%', borderRadius: 3, background: 'var(--accent)', width: `${pct}%` }} />
      </div>
    </div>
  )
}

type WorkspaceTab = 'reconciliation' | 'reports'
type PaymentMethod = 'cash' | 'card' | 'pix' | 'boleto' | 'transfer' | 'other'
type AdjustmentType = 'bank_fee' | 'interest' | 'pix_fee' | 'reversal' | 'other'
type TitleTypeFilter = '' | 'receivable' | 'payable'
type ReportPreset = 'today' | 'last7' | 'month' | 'quarter' | 'custom'
type ConfirmAction = 'settle' | 'adjustment' | 'only'
type OfxPreviewRow = {
  postedAt: string | null
  description: string
  amount: number
  direction: 'in' | 'out'
}

const RECON_PAGE_SIZE = 12
const DRILLDOWN_PAGE_SIZE = 20
const HISTORY_PAGE_SIZE = 8

const paymentMethodOptions: Array<{ value: PaymentMethod; label: string }> = [
  { value: 'pix', label: 'PIX' },
  { value: 'transfer', label: 'Transferência' },
  { value: 'cash', label: 'Dinheiro' },
  { value: 'card', label: 'Cartão' },
  { value: 'boleto', label: 'Boleto' },
  { value: 'other', label: 'Outro' },
]

const adjustmentTypeOptions: Array<{ value: AdjustmentType; label: string }> = [
  { value: 'bank_fee', label: 'Tarifa bancária' },
  { value: 'pix_fee', label: 'Tarifa PIX' },
  { value: 'interest', label: 'Juros' },
  { value: 'reversal', label: 'Estorno' },
  { value: 'other', label: 'Outro' },
]

const agingBucketOptions: Array<{ value: AgingBucket; label: string }> = [
  { value: 'overdue', label: 'Vencido' },
  { value: 'due_0_30', label: '0-30 dias' },
  { value: 'due_31_60', label: '31-60 dias' },
  { value: 'due_60_plus', label: '60+ dias' },
]

function formatMonth(value: string) {
  const normalized = value.slice(0, 10)
  const parsed = new Date(`${normalized}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString('pt-BR', {
    month: '2-digit',
    year: 'numeric',
  })
}

function directionLabel(value: 'in' | 'out') {
  return value === 'in' ? 'Entrada' : 'Saída'
}

function titleTypeLabel(value: 'receivable' | 'payable') {
  return value === 'receivable' ? 'A receber' : 'A pagar'
}

function agingBucketLabel(value: AgingBucket) {
  if (value === 'overdue') return 'Vencido'
  if (value === 'due_0_30') return '0-30 dias'
  if (value === 'due_31_60') return '31-60 dias'
  return '60+ dias'
}

function counterpartyLabel(row: { customerName?: string | null; supplierName?: string | null }) {
  return row.customerName || row.supplierName || 'Sem vínculo'
}

function csvCell(value: unknown) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`
}

function downloadCsv(filename: string, header: string[], rows: unknown[][]) {
  if (globalThis.window === undefined) return
  const body = rows.map((row) => row.map((cell) => csvCell(cell)).join(';')).join('\n')
  const csvContent = `${header.map((cell) => csvCell(cell)).join(';')}\n${body}`
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
  const url = globalThis.URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  globalThis.URL.revokeObjectURL(url)
}

function toInputDate(value: Date) {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function startOfQuarter(reference: Date) {
  const quarterStartMonth = Math.floor(reference.getMonth() / 3) * 3
  return new Date(reference.getFullYear(), quarterStartMonth, 1)
}

function parseOfxTag(block: string, tag: string) {
  const pattern = new RegExp(String.raw`<${tag}>([^<\r\n]+)`, 'i')
  const match = pattern.exec(block)
  return match?.[1]?.trim() ?? null
}

function parseOfxPostedAt(rawDate: string | null) {
  if (!rawDate) return null
  const normalized = rawDate.replaceAll(/[^0-9]/g, '').slice(0, 14)
  if (normalized.length < 8) return rawDate
  const year = normalized.slice(0, 4)
  const month = normalized.slice(4, 6)
  const day = normalized.slice(6, 8)
  const hour = normalized.slice(8, 10) || '00'
  const minute = normalized.slice(10, 12) || '00'
  const second = normalized.slice(12, 14) || '00'
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`
}

function parseOfxPreviewRows(rawText: string, limit = 5): OfxPreviewRow[] {
  const statements = rawText.split(/<STMTTRN>/i).slice(1, limit + 1)

  return statements
    .map((statement) => {
      const amount = Number(parseOfxTag(statement, 'TRNAMT') ?? 0)
      const memo = parseOfxTag(statement, 'MEMO')
      const name = parseOfxTag(statement, 'NAME')
      const postedAt = parseOfxPostedAt(parseOfxTag(statement, 'DTPOSTED'))

      return {
        postedAt,
        description: memo || name || 'OFX',
        amount: Math.abs(amount),
        direction: amount >= 0 ? 'in' : 'out',
      } satisfies OfxPreviewRow
    })
    .filter((row) => Number.isFinite(row.amount) && row.amount > 0)
}

function reconciliationSourceLabel(source: ReconciliationActivity['source']) {
  if (source === 'finance.ofx.import') return 'Importação OFX'
  if (source === 'finance.reconcile.settle') return 'Conciliar + baixa'
  if (source === 'finance.reconcile.adjustment') return 'Conciliar como ajuste'
  return 'Somente conciliar'
}

export function RelatoriosPage() {
  const { role } = useAuth()

  const [activeTab, setActiveTab] = useState<WorkspaceTab>('reconciliation')

  const [accounts, setAccounts] = useState<FinancialAccountLookup[]>([])
  const [accountsLoading, setAccountsLoading] = useState(false)
  const [accountsStatus, setAccountsStatus] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)

  const [ofxAccountId, setOfxAccountId] = useState('')
  const [ofxRawText, setOfxRawText] = useState('')
  const [ofxStatus, setOfxStatus] = useState('')
  const [ofxPreviewRows, setOfxPreviewRows] = useState<OfxPreviewRow[]>([])
  const [ofxFileName, setOfxFileName] = useState('')
  const [ofxUploading, setOfxUploading] = useState(false)
  const [showOfxPasteAdvanced, setShowOfxPasteAdvanced] = useState(false)

  const [autoReconcileAccountId, setAutoReconcileAccountId] = useState('')
  const [autoReconcileTolerance, setAutoReconcileTolerance] = useState('0.01')
  const [autoReconcileStatus, setAutoReconcileStatus] = useState('')

  const [bankTxQuery, setBankTxQuery] = useState('')
  const [bankTxAccountId, setBankTxAccountId] = useState('')
  const [bankTxFrom, setBankTxFrom] = useState('')
  const [bankTxTo, setBankTxTo] = useState('')
  const [bankTxOffset, setBankTxOffset] = useState(0)
  const [bankTxRows, setBankTxRows] = useState<BankTransactionLookup[]>([])
  const [bankTxTotalCount, setBankTxTotalCount] = useState<number | null>(null)
  const [bankTxLoading, setBankTxLoading] = useState(false)
  const [bankTxStatus, setBankTxStatus] = useState('')
  const [selectedBankTransactionId, setSelectedBankTransactionId] = useState('')

  const [installmentQuery, setInstallmentQuery] = useState('')
  const [installmentOffset, setInstallmentOffset] = useState(0)
  const [installmentRows, setInstallmentRows] = useState<FinancialInstallmentLookup[]>([])
  const [installmentTotalCount, setInstallmentTotalCount] = useState<number | null>(null)
  const [installmentLoading, setInstallmentLoading] = useState(false)
  const [installmentStatus, setInstallmentStatus] = useState('')
  const [selectedInstallmentId, setSelectedInstallmentId] = useState('')

  const [settleMethod, setSettleMethod] = useState<PaymentMethod>('transfer')
  const [settlePaidAt, setSettlePaidAt] = useState('')
  const [settleStatus, setSettleStatus] = useState('')

  const [adjustmentType, setAdjustmentType] = useState<AdjustmentType>('bank_fee')
  const [adjustmentDescription, setAdjustmentDescription] = useState('')
  const [adjustmentStatus, setAdjustmentStatus] = useState('')
  const [onlyReconcileStatus, setOnlyReconcileStatus] = useState('')
  const [showAdvancedReconcile, setShowAdvancedReconcile] = useState(false)
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)

  const [reportFrom, setReportFrom] = useState('')
  const [reportTo, setReportTo] = useState('')
  const [reportAccountId, setReportAccountId] = useState('')
  const [agingTitleType, setAgingTitleType] = useState<TitleTypeFilter>('')
  const [reportPreset, setReportPreset] = useState<ReportPreset>('custom')
  const [showOtherReports, setShowOtherReports] = useState(false)

  const [reportsLoading, setReportsLoading] = useState(false)
  const [reportsStatus, setReportsStatus] = useState('')
  useStatusToast(reportsStatus)
  const [reportsInitialized, setReportsInitialized] = useState(false)

  const [cashflowRows, setCashflowRows] = useState<CashflowReportRow[]>([])
  const [cashflowEntriesMonth, setCashflowEntriesMonth] = useState('')
  const [cashflowEntriesRows, setCashflowEntriesRows] = useState<CashflowEntryReportRow[]>([])
  const [cashflowEntriesOffset, setCashflowEntriesOffset] = useState(0)
  const [cashflowEntriesTotalCount, setCashflowEntriesTotalCount] = useState<number | null>(null)
  const [cashflowEntriesLoading, setCashflowEntriesLoading] = useState(false)
  const [cashflowEntriesStatus, setCashflowEntriesStatus] = useState('')

  const [dreRows, setDreRows] = useState<Array<{ title_type: string; total: string | number }>>([])
  const [salesRows, setSalesRows] = useState<Array<{ month: string; total: string | number }>>([])
  const [topCustomersRows, setTopCustomersRows] = useState<Array<{ id: string; name: string; total: string | number }>>([])
  const [inventoryValue, setInventoryValue] = useState<string | number>(0)
  const [marginRows, setMarginRows] = useState<
    Array<{
      id: string
      name: string
      qty_sold: string | number
      revenue: string | number
      cost: string | number
      margin: string | number
    }>
  >([])
  const [turnoverRows, setTurnoverRows] = useState<
    Array<{
      id: string
      name: string
      qty_sold: string | number
      avg_stock: string | number
    }>
  >([])
  const [commissionsRows, setCommissionsRows] = useState<
    Array<{ id: string; name: string; total: string | number; status: string }>
  >([])
  const [agingSummary, setAgingSummary] = useState<{
    overdue: string | number
    due_0_30: string | number
    due_31_60: string | number
    due_60_plus: string | number
  } | null>(null)

  const [agingEntriesBucket, setAgingEntriesBucket] = useState<AgingBucket | ''>('')
  const [agingEntriesRows, setAgingEntriesRows] = useState<AgingEntryReportRow[]>([])
  const [agingEntriesOffset, setAgingEntriesOffset] = useState(0)
  const [agingEntriesTotalCount, setAgingEntriesTotalCount] = useState<number | null>(null)
  const [agingEntriesLoading, setAgingEntriesLoading] = useState(false)
  const [agingEntriesStatus, setAgingEntriesStatus] = useState('')

  const [activityRows, setActivityRows] = useState<ReconciliationActivity[]>([])
  const [activityOffset, setActivityOffset] = useState(0)
  const [activityTotalCount, setActivityTotalCount] = useState<number | null>(null)
  const [activityLoading, setActivityLoading] = useState(false)
  const [activityStatus, setActivityStatus] = useState('')

  const accountSelectOptions = useMemo(
    () => [{ value: '', label: 'Todas as contas' }, ...accounts.map((account) => ({ value: account.id, label: account.name }))],
    [accounts],
  )

  const selectedBankTransaction = useMemo(
    () => bankTxRows.find((row) => row.id === selectedBankTransactionId) ?? null,
    [bankTxRows, selectedBankTransactionId],
  )

  const selectedInstallment = useMemo(
    () => installmentRows.find((row) => row.id === selectedInstallmentId) ?? null,
    [installmentRows, selectedInstallmentId],
  )

  const canUseAdvancedReconcile = role === 'chefe'

  const rankedInstallmentRows = useMemo(() => {
    if (!selectedBankTransaction) return installmentRows

    const txAmount = toNumber(selectedBankTransaction.amount)
    const txTime = selectedBankTransaction.occurredAt
      ? new Date(selectedBankTransaction.occurredAt).getTime()
      : Number.NaN

    return [...installmentRows].sort((a, b) => {
      const amountDistanceA = Math.abs(toNumber(a.amount) - txAmount)
      const amountDistanceB = Math.abs(toNumber(b.amount) - txAmount)
      if (Math.abs(amountDistanceA - amountDistanceB) > 0.01) {
        return amountDistanceA - amountDistanceB
      }

      if (Number.isFinite(txTime)) {
        const dueA = a.dueDate ? new Date(a.dueDate).getTime() : Number.NaN
        const dueB = b.dueDate ? new Date(b.dueDate).getTime() : Number.NaN
        const dueDistanceA = Number.isFinite(dueA) ? Math.abs(dueA - txTime) : Number.MAX_SAFE_INTEGER
        const dueDistanceB = Number.isFinite(dueB) ? Math.abs(dueB - txTime) : Number.MAX_SAFE_INTEGER
        if (dueDistanceA !== dueDistanceB) {
          return dueDistanceA - dueDistanceB
        }
      }

      return a.id.localeCompare(b.id)
    })
  }, [installmentRows, selectedBankTransaction])

  const recommendedInstallment = rankedInstallmentRows[0] ?? null

  const guidedAction: ConfirmAction = selectedInstallment ? 'settle' : 'adjustment'

  const reportBaseFilters = useMemo(
    () => ({
      from: reportFrom || undefined,
      to: reportTo || undefined,
    }),
    [reportFrom, reportTo],
  )

  const reportAccountFilters = useMemo(
    () => ({
      ...reportBaseFilters,
      accountId: reportAccountId || undefined,
    }),
    [reportBaseFilters, reportAccountId],
  )

  const refreshReconciliationLists = useCallback(() => {
    setRefreshToken((state) => state + 1)
  }, [])

  const exportCsv = useCallback(
    (filenamePrefix: string, header: string[], rows: unknown[][]) => {
      if (rows.length === 0) {
        setReportsStatus('Nada para exportar com os filtros atuais.')
        return
      }
      const filename = `${filenamePrefix}-${Date.now()}.csv`
      downloadCsv(filename, header, rows)
      setReportsStatus(`Arquivo ${filename} gerado.`)
    },
    [],
  )

  const exportPdfReport = useCallback(
    async (title: string, header: string[], rows: unknown[][]) => {
      if (rows.length === 0) {
        setReportsStatus('Nada para exportar com os filtros atuais.')
        return
      }
      const { exportPdf } = await import('../../lib/exportPdf')
      exportPdf({ title, header, rows, orientation: rows[0].length > 5 ? 'landscape' : 'portrait' })
      setReportsStatus(`PDF "${title}" aberto para impressão.`)
    },
    [],
  )

  const loadReports = useCallback(async () => {
    setReportsLoading(true)
    try {
      const [cashflow, dre, sales, topCustomers, inventory, margin, turnover, commissions, aging] =
        await Promise.all([
          fetchCashflowReport(reportAccountFilters),
          fetchDreReport(reportBaseFilters),
          fetchSalesReport(reportBaseFilters),
          fetchTopCustomers(reportBaseFilters),
          fetchInventoryValue(),
          fetchMarginByProduct(reportBaseFilters),
          fetchInventoryTurnover(reportBaseFilters),
          fetchCommissionsReport(reportBaseFilters),
          fetchAgingReport({
            ...reportBaseFilters,
            titleType: agingTitleType || undefined,
          }),
        ])

      setCashflowRows(cashflow)
      setDreRows(dre)
      setSalesRows(sales)
      setTopCustomersRows(topCustomers)
      setInventoryValue(inventory.total_value)
      setMarginRows(margin)
      setTurnoverRows(turnover)
      setCommissionsRows(commissions)
      setAgingSummary(aging)

      setCashflowEntriesMonth('')
      setCashflowEntriesRows([])
      setCashflowEntriesOffset(0)
      setCashflowEntriesTotalCount(null)
      setCashflowEntriesStatus('')

      setAgingEntriesBucket('')
      setAgingEntriesRows([])
      setAgingEntriesOffset(0)
      setAgingEntriesTotalCount(null)
      setAgingEntriesStatus('')

      setReportsStatus('Relatórios atualizados com sucesso.')
      setReportsInitialized(true)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao atualizar os relatórios.'
      setReportsStatus(message)
    } finally {
      setReportsLoading(false)
    }
  }, [agingTitleType, reportAccountFilters, reportBaseFilters])

  const loadCashflowEntries = useCallback(
    async (month: string, offset: number) => {
      if (!month) return
      setCashflowEntriesLoading(true)
      try {
        const response = await fetchCashflowEntriesReport({
          ...reportAccountFilters,
          month: month.slice(0, 10),
          limit: DRILLDOWN_PAGE_SIZE,
          offset,
        })
        setCashflowEntriesMonth(month.slice(0, 10))
        setCashflowEntriesOffset(offset)
        setCashflowEntriesRows(response.rows)
        setCashflowEntriesTotalCount(response.totalCount)
        setCashflowEntriesStatus(response.rows.length === 0 ? 'Nenhum lançamento encontrado.' : '')
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Erro ao carregar lançamentos do fluxo de caixa.'
        setCashflowEntriesStatus(message)
      } finally {
        setCashflowEntriesLoading(false)
      }
    },
    [reportAccountFilters],
  )

  const loadAgingEntries = useCallback(
    async (bucket: AgingBucket, offset: number) => {
      setAgingEntriesLoading(true)
      try {
        const response = await fetchAgingEntriesReport({
          ...reportBaseFilters,
          titleType: agingTitleType || undefined,
          bucket,
          limit: DRILLDOWN_PAGE_SIZE,
          offset,
        })
        setAgingEntriesBucket(bucket)
        setAgingEntriesOffset(offset)
        setAgingEntriesRows(response.rows)
        setAgingEntriesTotalCount(response.totalCount)
        setAgingEntriesStatus(response.rows.length === 0 ? 'Nenhum título encontrado.' : '')
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Erro ao carregar drill-down de aging.'
        setAgingEntriesStatus(message)
      } finally {
        setAgingEntriesLoading(false)
      }
    },
    [agingTitleType, reportBaseFilters],
  )

  const loadReconciliationActivity = useCallback(async (offset: number, signal?: AbortSignal) => {
    setActivityLoading(true)
    try {
      const page = await fetchReconciliationActivity({
        limit: HISTORY_PAGE_SIZE,
        offset,
        signal,
      })

      setActivityRows(page.rows)
      setActivityTotalCount(page.totalCount)
      setActivityOffset(offset)
      setActivityStatus(page.rows.length === 0 ? 'Nenhum histórico encontrado para esta empresa.' : '')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      const message = error instanceof Error ? error.message : 'Erro ao carregar histórico de conciliação.'
      setActivityStatus(message)
    } finally {
      setActivityLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setAccountsLoading(true)
    setAccountsStatus('')

    fetchFinancialAccountsPaged({
      limit: 200,
      offset: 0,
      signal: controller.signal,
    })
      .then((page) => {
        setAccounts(page.rows)
        if (page.rows.length === 0) {
          setAccountsStatus('Cadastre uma conta financeira para usar todos os fluxos de conciliação.')
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        const message = error instanceof Error ? error.message : 'Erro ao carregar contas financeiras.'
        setAccountsStatus(message)
      })
      .finally(() => {
        setAccountsLoading(false)
      })

    return () => controller.abort()
  }, [refreshToken])

  useEffect(() => {
    const controller = new AbortController()
    setBankTxLoading(true)
    setBankTxStatus('')

    fetchBankTransactionsPaged({
      status: 'pending',
      query: bankTxQuery || undefined,
      accountId: bankTxAccountId || undefined,
      from: bankTxFrom || undefined,
      to: bankTxTo || undefined,
      limit: RECON_PAGE_SIZE,
      offset: bankTxOffset,
      signal: controller.signal,
    })
      .then((page) => {
        setBankTxRows(page.rows)
        setBankTxTotalCount(page.totalCount)
        if (page.rows.length === 0) {
          setBankTxStatus('Nenhuma transação pendente encontrada com os filtros atuais.')
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        const message =
          error instanceof Error ? error.message : 'Erro ao carregar transações bancárias pendentes.'
        setBankTxStatus(message)
      })
      .finally(() => {
        setBankTxLoading(false)
      })

    return () => controller.abort()
  }, [bankTxAccountId, bankTxFrom, bankTxOffset, bankTxQuery, bankTxTo, refreshToken])

  useEffect(() => {
    if (!selectedBankTransactionId) return
    if (bankTxRows.some((row) => row.id === selectedBankTransactionId)) return
    setSelectedBankTransactionId('')
    setSelectedInstallmentId('')
  }, [bankTxRows, selectedBankTransactionId])

  useEffect(() => {
    setInstallmentOffset(0)
    setSelectedInstallmentId('')
  }, [selectedBankTransactionId])

  useEffect(() => {
    if (!selectedBankTransaction) {
      setInstallmentRows([])
      setInstallmentTotalCount(null)
      setInstallmentStatus('Selecione uma transação para listar as parcelas compatíveis.')
      return
    }

    const controller = new AbortController()
    setInstallmentLoading(true)
    setInstallmentStatus('')

    fetchFinanceInstallmentsPaged({
      status: 'open',
      titleType: selectedBankTransaction.direction === 'in' ? 'receivable' : 'payable',
      query: installmentQuery || undefined,
      limit: RECON_PAGE_SIZE,
      offset: installmentOffset,
      signal: controller.signal,
    })
      .then((page) => {
        setInstallmentRows(page.rows)
        setInstallmentTotalCount(page.totalCount)
        if (page.rows.length === 0) {
          setInstallmentStatus('Nenhuma parcela em aberto encontrada para a direção da transação.')
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        const message = error instanceof Error ? error.message : 'Erro ao carregar parcelas em aberto.'
        setInstallmentStatus(message)
      })
      .finally(() => {
        setInstallmentLoading(false)
      })

    return () => controller.abort()
  }, [installmentOffset, installmentQuery, refreshToken, selectedBankTransaction])

  useEffect(() => {
    if (!selectedInstallmentId) return
    if (installmentRows.some((row) => row.id === selectedInstallmentId)) return
    setSelectedInstallmentId('')
  }, [installmentRows, selectedInstallmentId])

  useEffect(() => {
    if (activeTab !== 'reports') return
    if (reportsInitialized) return
    void loadReports()
  }, [activeTab, loadReports, reportsInitialized])

  useEffect(() => {
    if (activeTab !== 'reconciliation') return
    const controller = new AbortController()
    void loadReconciliationActivity(activityOffset, controller.signal)
    return () => controller.abort()
  }, [activeTab, activityOffset, loadReconciliationActivity, refreshToken])

  const handleOfxFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setOfxUploading(true)
    setOfxStatus('Lendo arquivo OFX...')
    setOfxFileName(file.name)

    const reader = new FileReader()
    reader.onload = () => {
      const content = typeof reader.result === 'string' ? reader.result : ''
      if (!content.trim()) {
        setOfxStatus('Arquivo OFX vazio ou inválido.')
        setOfxRawText('')
        setOfxPreviewRows([])
        setOfxUploading(false)
        return
      }

      setOfxRawText(content)
      setOfxPreviewRows(parseOfxPreviewRows(content))
      setOfxStatus('Arquivo OFX carregado. Revise a prévia e clique em importar.')
      setOfxUploading(false)
    }

    reader.onerror = () => {
      setOfxStatus('Não foi possível ler o arquivo OFX selecionado.')
      setOfxUploading(false)
    }

    reader.readAsText(file)
    event.target.value = ''
  }, [])

  const handleImportOfx = useCallback(async () => {
    try {
      const result = await importOfx({
        accountId: ofxAccountId || undefined,
        rawText: ofxRawText,
      })
      setOfxStatus(
        `Importação concluída: ${result.importedCount} importadas e ${result.ignoredCount} duplicadas ignoradas (total ${result.totalCount}).`,
      )
      refreshReconciliationLists()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao importar OFX.'
      setOfxStatus(message)
    }
  }, [ofxAccountId, ofxRawText, refreshReconciliationLists])

  const handleAutoReconcile = useCallback(async () => {
    setAutoReconcileStatus('Executando conciliação automática...')
    try {
      const result = await autoReconcile({
        accountId: autoReconcileAccountId || undefined,
        tolerance: Number(autoReconcileTolerance || '0.01'),
      })
      setAutoReconcileStatus(`Conciliação automática concluída. Transações conciliadas: ${result.matched}.`)
      refreshReconciliationLists()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro na conciliação automática.'
      setAutoReconcileStatus(message)
    }
  }, [autoReconcileAccountId, autoReconcileTolerance, refreshReconciliationLists])

  const runSettleReconcile = useCallback(async () => {
    if (!selectedBankTransactionId || !selectedInstallmentId) {
      setSettleStatus('Selecione transação e parcela para conciliar com baixa.')
      return
    }
    setSettleStatus('Conciliando e dando baixa...')
    try {
      const result = await reconcileBankTransactionSettle({
        bankTransactionId: selectedBankTransactionId,
        installmentId: selectedInstallmentId,
        method: settleMethod,
        paidAt: settlePaidAt || undefined,
      })
      setSettleStatus(`Conciliação concluída. Item: ${result.reconciliationItemId}.`)
      setSelectedBankTransactionId('')
      setSelectedInstallmentId('')
      refreshReconciliationLists()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao conciliar e dar baixa.'
      setSettleStatus(message)
    }
  }, [
    refreshReconciliationLists,
    selectedBankTransactionId,
    selectedInstallmentId,
    settleMethod,
    settlePaidAt,
  ])

  const runAdjustmentReconcile = useCallback(async () => {
    if (!selectedBankTransactionId) {
      setAdjustmentStatus('Selecione uma transação para conciliar como ajuste.')
      return
    }
    setAdjustmentStatus('Conciliando como ajuste...')
    try {
      const result = await reconcileBankTransactionAdjustment({
        bankTransactionId: selectedBankTransactionId,
        adjustmentType,
        description: adjustmentDescription || undefined,
      })
      setAdjustmentStatus(`Ajuste conciliado. Item: ${result.reconciliationItemId}.`)
      setSelectedBankTransactionId('')
      setSelectedInstallmentId('')
      refreshReconciliationLists()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao conciliar como ajuste.'
      setAdjustmentStatus(message)
    }
  }, [adjustmentDescription, adjustmentType, refreshReconciliationLists, selectedBankTransactionId])

  const runOnlyReconcile = useCallback(async () => {
    if (!selectedBankTransactionId) {
      setOnlyReconcileStatus('Selecione uma transação para marcar somente como conciliada.')
      return
    }
    setOnlyReconcileStatus('Aplicando conciliação sem baixa...')
    try {
      const result = await reconcileBankTransaction({
        bankTransactionId: selectedBankTransactionId,
      })
      setOnlyReconcileStatus(`Conciliação aplicada. Item: ${result.reconciliationItemId}.`)
      setSelectedBankTransactionId('')
      setSelectedInstallmentId('')
      refreshReconciliationLists()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao aplicar conciliação simples.'
      setOnlyReconcileStatus(message)
    }
  }, [refreshReconciliationLists, selectedBankTransactionId])

  const requestPrimaryAction = useCallback(() => {
    if (!selectedBankTransactionId) {
      setSettleStatus('Selecione uma transação bancária pendente para continuar.')
      return
    }

    if (guidedAction === 'settle' && !selectedInstallmentId) {
      setSettleStatus('Selecione uma parcela para usar "Conciliar e dar baixa".')
      return
    }

    setConfirmAction(guidedAction)
  }, [guidedAction, selectedBankTransactionId, selectedInstallmentId])

  const requestOnlyReconcile = useCallback(() => {
    if (!canUseAdvancedReconcile) {
      setOnlyReconcileStatus('A opção avançada "Somente conciliar" está disponível apenas para perfil gestor.')
      return
    }
    if (!selectedBankTransactionId) {
      setOnlyReconcileStatus('Selecione uma transação para usar a opção avançada.')
      return
    }
    setConfirmAction('only')
  }, [canUseAdvancedReconcile, selectedBankTransactionId])

  const executeConfirmedAction = useCallback(async () => {
    if (confirmAction === 'settle') {
      await runSettleReconcile()
      setConfirmAction(null)
      return
    }
    if (confirmAction === 'adjustment') {
      await runAdjustmentReconcile()
      setConfirmAction(null)
      return
    }
    if (confirmAction === 'only') {
      await runOnlyReconcile()
      setConfirmAction(null)
    }
  }, [confirmAction, runAdjustmentReconcile, runOnlyReconcile, runSettleReconcile])

  const applyReportPreset = useCallback((preset: ReportPreset) => {
    const today = new Date()
    if (preset === 'today') {
      const value = toInputDate(today)
      setReportFrom(value)
      setReportTo(value)
      setReportPreset(preset)
      return
    }

    if (preset === 'last7') {
      const from = new Date(today)
      from.setDate(today.getDate() - 6)
      setReportFrom(toInputDate(from))
      setReportTo(toInputDate(today))
      setReportPreset(preset)
      return
    }

    if (preset === 'month') {
      const from = new Date(today.getFullYear(), today.getMonth(), 1)
      setReportFrom(toInputDate(from))
      setReportTo(toInputDate(today))
      setReportPreset(preset)
      return
    }

    if (preset === 'quarter') {
      const from = startOfQuarter(today)
      setReportFrom(toInputDate(from))
      setReportTo(toInputDate(today))
      setReportPreset(preset)
      return
    }

    setReportPreset('custom')
  }, [])

  const confirmationSummary = useMemo(() => {
    if (!selectedBankTransaction) return 'Nenhuma transação selecionada.'

    if (confirmAction === 'settle') {
      return `Será feita a conciliação com baixa da parcela ${selectedInstallment ? fmtCurrency(selectedInstallment.amount) : 'selecionada'} para a transação ${fmtCurrency(selectedBankTransaction.amount)}.`
    }

    if (confirmAction === 'adjustment') {
      return `Será feita a conciliação como ajuste (${adjustmentTypeOptions.find((item) => item.value === adjustmentType)?.label ?? 'Outro'}) para a transação ${fmtCurrency(selectedBankTransaction.amount)}.`
    }

    if (confirmAction === 'only') {
      return `A transação ${fmtCurrency(selectedBankTransaction.amount)} será marcada apenas como conciliada, sem baixa.`
    }

    return ''
  }, [adjustmentType, confirmAction, selectedBankTransaction, selectedInstallment])

  const receivableTotal = toNumber(dreRows.find((row) => row.title_type === 'receivable')?.total ?? 0)
  const payableTotal = toNumber(dreRows.find((row) => row.title_type === 'payable')?.total ?? 0)
  const dreResult = receivableTotal - payableTotal
  const cashflowTotal = cashflowRows.reduce((total, row) => total + toNumber(row.total), 0)
  const commissionsTotal = commissionsRows.reduce((total, row) => total + toNumber(row.total), 0)
  const agingTotal = agingSummary
    ? toNumber(agingSummary.overdue) +
      toNumber(agingSummary.due_0_30) +
      toNumber(agingSummary.due_31_60) +
      toNumber(agingSummary.due_60_plus)
    : 0

  const runReportRefresh = useCallback(() => {
    void loadReports()
  }, [loadReports])

  return (
    <div className="page-grid">
      <PageHeader />
      <Tabs
        tabs={[
          { key: 'reconciliation' as const, label: 'Conciliação bancária' },
          { key: 'reports' as const, label: 'Relatórios' },
        ]}
        active={activeTab}
        onChange={(k) => setActiveTab(k as WorkspaceTab)}
      />

      <TabPanel active={activeTab === 'reconciliation'}>
        <>
          <div className="card fiscal-card">
            <div className="finance-form-section">
              <div className="fiscal-grid">
                <label>
                  Conta financeira (opcional)
                  <Select
                    value={ofxAccountId}
                    options={accountSelectOptions}
                    onChange={setOfxAccountId}
                    disabled={accountsLoading}
                  />
                </label>
                <label>
                  Arquivo OFX
                  <input
                    type="file"
                    accept=".ofx,text/plain"
                    onChange={handleOfxFileChange}
                    disabled={ofxUploading}
                  />
                </label>
              </div>

              {ofxFileName && (
                <strong>Arquivo: {ofxFileName}</strong>
              )}

              <div className="actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setShowOfxPasteAdvanced((state) => !state)}
                  disabled={ofxUploading}
                >
                  {showOfxPasteAdvanced ? 'Ocultar colagem manual' : 'Colar conteúdo OFX manualmente'}
                </button>
              </div>

              {showOfxPasteAdvanced && (
                <label className="fiscal-textarea">
                  Conteúdo OFX
                  <textarea
                    value={ofxRawText}
                    onChange={(event) => {
                      const value = event.target.value
                      setOfxRawText(value)
                      setOfxPreviewRows(parseOfxPreviewRows(value))
                    }}
                    placeholder="Cole aqui o conteúdo OFX"
                  />
                </label>
              )}

              {ofxPreviewRows.length > 0 && (
                <div className="finance-table-wrapper">
                  <table className="finance-table">
                    <thead>
                      <tr>
                        <th>Data</th>
                        <th>Descrição</th>
                        <th>Direção</th>
                        <th>Valor</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ofxPreviewRows.map((row, index) => (
                        <tr key={`${row.postedAt ?? 'sem-data'}-${row.description}-${index}`}>
                          <td>{row.postedAt ? fmtDateTime(row.postedAt) : 'Sem data'}</td>
                          <td>{row.description}</td>
                          <td>{directionLabel(row.direction)}</td>
                          <td>{fmtCurrency(row.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="actions">
                <button type="button" onClick={() => void handleImportOfx()} disabled={!ofxRawText.trim() || ofxUploading}>
                  Importar OFX
                </button>
              </div>
              
            </div>

            <div className="finance-form-section">
              <div className="fiscal-grid">
                <label>
                  Conta financeira (opcional)
                  <Select
                    value={autoReconcileAccountId}
                    options={accountSelectOptions}
                    onChange={setAutoReconcileAccountId}
                    disabled={accountsLoading}
                  />
                </label>
                <label>
                  Tolerância de valor
                  <NumericInput
                    value={autoReconcileTolerance}
                    onChange={(event) => setAutoReconcileTolerance(event.target.value)}
                  />
                </label>
              </div>
              <div className="actions">
                <button
                  type="button"
                  onClick={() => void handleAutoReconcile()}
                  disabled={toNumber(autoReconcileTolerance) < 0}
                >
                  Executar conciliação automática
                </button>
              </div>
              
            </div>
          </div>

          <div className="card fiscal-card">
            <div className="finance-form-section">
              <div className="fiscal-grid">
                <label>
                  Buscar
                  <input
                    value={bankTxQuery}
                    onChange={(event) => {
                      setBankTxQuery(event.target.value)
                      setBankTxOffset(0)
                    }}
                    placeholder="Descrição ou referência"
                  />
                </label>
                <label>
                  Conta
                  <Select
                    value={bankTxAccountId}
                    options={accountSelectOptions}
                    onChange={(value) => {
                      setBankTxAccountId(value)
                      setBankTxOffset(0)
                    }}
                    disabled={accountsLoading}
                  />
                </label>
                <label>
                  De
                  <DateInput
                    value={bankTxFrom}
                    onChange={(event) => {
                      setBankTxFrom(event.target.value)
                      setBankTxOffset(0)
                    }}
                  />
                </label>
                <label>
                  Até
                  <DateInput
                    value={bankTxTo}
                    onChange={(event) => {
                      setBankTxTo(event.target.value)
                      setBankTxOffset(0)
                    }}
                  />
                </label>
              </div>
              <div className="finance-table-wrapper">
                <table className="finance-table">
                  <thead>
                    <tr>
                      <th>Selecionar</th>
                      <th>Data</th>
                      <th>Descrição</th>
                      <th>Direção</th>
                      <th>Conta</th>
                      <th>Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bankTxRows.map((row) => (
                      <tr
                        key={row.id}
                        className={selectedBankTransactionId === row.id ? 'finance-row-highlight' : ''}
                      >
                        <td>
                          <input
                            type="radio"
                            name="selected-bank-transaction"
                            checked={selectedBankTransactionId === row.id}
                            onChange={() => setSelectedBankTransactionId(row.id)}
                          />
                        </td>
                        <td>{fmtDateTime(row.occurredAt)}</td>
                        <td>{row.description || row.externalRef || 'Sem descrição'}</td>
                        <td>{directionLabel(row.direction)}</td>
                        <td>{row.accountName || 'Sem conta'}</td>
                        <td>{fmtCurrency(row.amount)}</td>
                      </tr>
                    ))}
                    {bankTxRows.length === 0 && (
                      <tr>
                        <td colSpan={6}>Nenhuma transação pendente encontrada.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setBankTxOffset((state) => Math.max(0, state - RECON_PAGE_SIZE))}
                  disabled={bankTxOffset === 0}
                >
                  Anterior
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setBankTxOffset((state) => state + RECON_PAGE_SIZE)}
                  disabled={!canGoNextPage(bankTxOffset, bankTxRows.length, bankTxTotalCount, RECON_PAGE_SIZE)}
                >
                  Próxima
                </button>
                <span>{pageInfoLabel(bankTxOffset, bankTxRows.length, bankTxTotalCount)}</span>
              </div>
            </div>

            <div className="finance-form-section">
              <p className="hint">
                Filtro automático baseado na direção da transação ({selectedBankTransaction ? directionLabel(selectedBankTransaction.direction) : '—'}).
              </p>
              {recommendedInstallment && (
                <p className="hint">
                  Sugestão do motor: {fmtCurrency(recommendedInstallment.amount)} ·{' '}
                  {recommendedInstallment.titleDescription || 'Sem descrição'}{' '}
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => setSelectedInstallmentId(recommendedInstallment.id)}
                  >
                    Selecionar sugestão
                  </button>
                </p>
              )}
              <div className="fiscal-grid">
                <label>
                  Buscar
                  <input
                    value={installmentQuery}
                    onChange={(event) => {
                      setInstallmentQuery(event.target.value)
                      setInstallmentOffset(0)
                    }}
                    placeholder="Descrição, cliente ou fornecedor"
                  />
                </label>
              </div>
              <div className="finance-table-wrapper">
                <table className="finance-table">
                  <thead>
                    <tr>
                      <th>Selecionar</th>
                      <th>Vencimento</th>
                      <th>Tipo</th>
                      <th>Descrição</th>
                      <th>Contraparte</th>
                      <th>Valor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rankedInstallmentRows.map((row) => (
                      <tr key={row.id} className={selectedInstallmentId === row.id ? 'finance-row-highlight' : ''}>
                        <td>
                          <input
                            type="radio"
                            name="selected-installment"
                            checked={selectedInstallmentId === row.id}
                            onChange={() => setSelectedInstallmentId(row.id)}
                          />
                        </td>
                        <td>{fmtDateFull(row.dueDate)}</td>
                        <td>{titleTypeLabel(row.titleType)}</td>
                        <td>{row.titleDescription || 'Sem descrição'}</td>
                        <td>{counterpartyLabel(row)}</td>
                        <td>{fmtCurrency(row.amount)}</td>
                      </tr>
                    ))}
                    {rankedInstallmentRows.length === 0 && (
                      <tr>
                        <td colSpan={6}>Nenhuma parcela em aberto encontrada para a seleção atual.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setInstallmentOffset((state) => Math.max(0, state - RECON_PAGE_SIZE))}
                  disabled={installmentOffset === 0}
                >
                  Anterior
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setInstallmentOffset((state) => state + RECON_PAGE_SIZE)}
                  disabled={
                    !canGoNextPage(
                      installmentOffset,
                      installmentRows.length,
                      installmentTotalCount,
                      RECON_PAGE_SIZE,
                    )
                  }
                >
                  Próxima
                </button>
                <span>{pageInfoLabel(installmentOffset, rankedInstallmentRows.length, installmentTotalCount)}</span>
              </div>
            </div>
          </div>

          <div className="card fiscal-card">
            <p className="hint">
              Transação base:{' '}
              {selectedBankTransaction
                ? `${fmtCurrency(selectedBankTransaction.amount)} · ${directionLabel(selectedBankTransaction.direction)} · ${selectedBankTransaction.description || selectedBankTransaction.externalRef || 'Sem descrição'}`
                : 'Nenhuma selecionada'}
            </p>
            <p className="hint">
              Título contrapartida:{' '}
              {selectedInstallment
                ? `${fmtCurrency(selectedInstallment.amount)} · ${titleTypeLabel(selectedInstallment.titleType)} · ${selectedInstallment.titleDescription || 'Sem descrição'}`
                : 'Nenhum selecionado'}
            </p>

            <div className="finance-form-section">
              <div className="actions">
                <button
                  type="button"
                  onClick={requestPrimaryAction}
                  disabled={!selectedBankTransactionId || (guidedAction === 'settle' && !selectedInstallmentId)}
                >
                  {guidedAction === 'settle' ? 'Confirmar conciliação com baixa' : 'Confirmar conciliação como ajuste'}
                </button>
              </div>
            </div>

            <div className="finance-form-section">
              <div className="fiscal-grid">
                <label>
                  Método de pagamento
                  <Select
                    value={settleMethod}
                    options={paymentMethodOptions}
                    onChange={(value) => setSettleMethod(value as PaymentMethod)}
                  />
                </label>
                <label>
                  Pago em (opcional)
                  <DateInput value={settlePaidAt} onChange={(event) => setSettlePaidAt(event.target.value)} />
                </label>
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setConfirmAction('settle')}
                  disabled={!selectedBankTransactionId || !selectedInstallmentId}
                >
                  Conciliar e baixar parcela
                </button>
              </div>
              
            </div>

            <div className="finance-form-section">
              <div className="fiscal-grid">
                <label>
                  Tipo de ajuste
                  <Select
                    value={adjustmentType}
                    options={adjustmentTypeOptions}
                    onChange={(value) => setAdjustmentType(value as AdjustmentType)}
                  />
                </label>
                <label>
                  Descrição (opcional)
                  <input
                    value={adjustmentDescription}
                    onChange={(event) => setAdjustmentDescription(event.target.value)}
                    placeholder="Ex.: tarifa de manutenção"
                  />
                </label>
              </div>
              <div className="actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setConfirmAction('adjustment')}
                  disabled={!selectedBankTransactionId}
                >
                  Conciliar como ajuste
                </button>
              </div>
              
            </div>

            <div className="actions">
              <button type="button" className="ghost" onClick={() => setShowAdvancedReconcile((state) => !state)}>
                {showAdvancedReconcile ? 'Ocultar ações avançadas' : 'Mostrar ações avançadas'}
              </button>
            </div>

            {showAdvancedReconcile && (
              <div className="finance-form-section">
                <div className="actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={requestOnlyReconcile}
                    disabled={!selectedBankTransactionId}
                  >
                    Marcar somente como conciliada
                  </button>
                </div>
                
              </div>
            )}

            {confirmAction && (
              <div className="finance-form-section">
                
                <div className="actions">
                  <button type="button" onClick={() => void executeConfirmedAction()}>
                    Confirmar ação
                  </button>
                  <button type="button" className="ghost" onClick={() => setConfirmAction(null)}>
                    Cancelar
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="card fiscal-card">
            <div className="finance-table-wrapper">
              <table className="finance-table">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Origem</th>
                    <th>Responsável</th>
                    <th>Transação</th>
                    <th>Detalhe</th>
                  </tr>
                </thead>
                <tbody>
                  {activityRows.map((row) => (
                    <tr key={row.id}>
                      <td>{fmtDateTime(row.createdAt)}</td>
                      <td>{reconciliationSourceLabel(row.source)}</td>
                      <td>{row.actorName || 'Sistema'}</td>
                      <td>
                        {row.bankTransactionAmount !== null && row.bankTransactionDirection
                          ? `${fmtCurrency(row.bankTransactionAmount)} · ${directionLabel(row.bankTransactionDirection)}`
                          : '—'}
                      </td>
                      <td>
                        {row.source === 'finance.ofx.import'
                          ? `${row.importedCount ?? 0} importadas / ${row.ignoredCount ?? 0} ignoradas`
                          : row.installmentAmount !== null && row.installmentTitleType
                            ? `${fmtCurrency(row.installmentAmount)} · ${titleTypeLabel(row.installmentTitleType)}`
                            : 'Sem parcela vinculada'}
                      </td>
                    </tr>
                  ))}
                  {activityRows.length === 0 && (
                    <tr>
                      <td colSpan={5}>Nenhum evento de conciliação encontrado.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="actions">
              <button
                type="button"
                className="ghost"
                onClick={() => setActivityOffset((state) => Math.max(0, state - HISTORY_PAGE_SIZE))}
                disabled={activityOffset === 0}
              >
                Anterior
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => setActivityOffset((state) => state + HISTORY_PAGE_SIZE)}
                disabled={!canGoNextPage(activityOffset, activityRows.length, activityTotalCount, HISTORY_PAGE_SIZE)}
              >
                Próxima
              </button>
              <span>{pageInfoLabel(activityOffset, activityRows.length, activityTotalCount)}</span>
            </div>
          </div>
        </>
      </TabPanel>

      <TabPanel active={activeTab === 'reports'}>
          <div className="card fiscal-card">
            <div className="actions">
              <button
                type="button"
                className={reportPreset === 'today' ? '' : 'ghost'}
                onClick={() => applyReportPreset('today')}
              >
                Hoje
              </button>
              <button
                type="button"
                className={reportPreset === 'last7' ? '' : 'ghost'}
                onClick={() => applyReportPreset('last7')}
              >
                Últimos 7 dias
              </button>
              <button
                type="button"
                className={reportPreset === 'month' ? '' : 'ghost'}
                onClick={() => applyReportPreset('month')}
              >
                Mês atual
              </button>
              <button
                type="button"
                className={reportPreset === 'quarter' ? '' : 'ghost'}
                onClick={() => applyReportPreset('quarter')}
              >
                Trimestre atual
              </button>
              <button
                type="button"
                className={reportPreset === 'custom' ? '' : 'ghost'}
                onClick={() => applyReportPreset('custom')}
              >
                Personalizado
              </button>
            </div>
            <div className="fiscal-grid">
              <label>
                De
                <DateInput
                  value={reportFrom}
                  onChange={(event) => {
                    setReportFrom(event.target.value)
                    setReportPreset('custom')
                  }}
                />
              </label>
              <label>
                Até
                <DateInput
                  value={reportTo}
                  onChange={(event) => {
                    setReportTo(event.target.value)
                    setReportPreset('custom')
                  }}
                />
              </label>
              <label>
                Conta financeira
                <Select
                  value={reportAccountId}
                  options={accountSelectOptions}
                  onChange={setReportAccountId}
                  disabled={accountsLoading}
                />
              </label>
              <label>
                Tipo no aging
                <Select
                  value={agingTitleType}
                  options={[
                    { value: '', label: 'Todos os títulos' },
                    { value: 'receivable', label: 'A receber' },
                    { value: 'payable', label: 'A pagar' },
                  ]}
                  onChange={(value) => setAgingTitleType(value as TitleTypeFilter)}
                />
              </label>
            </div>
            <div className="actions">
              <button type="button" onClick={runReportRefresh} disabled={reportsLoading}>
                'Atualizar relatórios'
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  exportCsv(
                    'resumo-fluxo-caixa',
                    ['Mes', 'Total'],
                    cashflowRows.map((row) => [formatMonth(row.month), fmtCurrency(row.total)]),
                  )
                }
                disabled={cashflowRows.length === 0}
              >
                Exportar fluxo CSV
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  void exportPdfReport(
                    'Fluxo de Caixa',
                    ['Mês', 'Total'],
                    cashflowRows.map((row) => [formatMonth(row.month), fmtCurrency(row.total)]),
                  )
                }
                disabled={cashflowRows.length === 0}
              >
                Exportar fluxo PDF
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  exportCsv(
                    'resumo-aging',
                    ['Faixa', 'Total'],
                    agingSummary
                      ? [
                          ['Vencido', fmtCurrency(agingSummary.overdue)],
                          ['0-30 dias', fmtCurrency(agingSummary.due_0_30)],
                          ['31-60 dias', fmtCurrency(agingSummary.due_31_60)],
                          ['60+ dias', fmtCurrency(agingSummary.due_60_plus)],
                        ]
                      : [],
                  )
                }
                disabled={!agingSummary}
              >
                Exportar aging CSV
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  void exportPdfReport(
                    'Aging de Títulos',
                    ['Faixa', 'Total'],
                    agingSummary
                      ? [
                          ['Vencido', fmtCurrency(agingSummary.overdue)],
                          ['0-30 dias', fmtCurrency(agingSummary.due_0_30)],
                          ['31-60 dias', fmtCurrency(agingSummary.due_31_60)],
                          ['60+ dias', fmtCurrency(agingSummary.due_60_plus)],
                        ]
                      : [],
                  )
                }
                disabled={!agingSummary}
              >
                Exportar aging PDF
              </button>
            </div>
            
          </div>

          <div className="card fiscal-card">
            <div className="finance-summary-grid">
              <div className="finance-summary-card">
                <small>Resultado DRE</small>
                <strong>{fmtCurrency(dreResult)}</strong>
              </div>
              <div className="finance-summary-card">
                <small>Fluxo acumulado</small>
                <strong>{fmtCurrency(cashflowTotal)}</strong>
              </div>
              <div className="finance-summary-card">
                <small>Comissões</small>
                <strong>{fmtCurrency(commissionsTotal)}</strong>
              </div>
              <div className="finance-summary-card">
                <small>Estoque (valor)</small>
                <strong>{fmtCurrency(inventoryValue)}</strong>
              </div>
              <div className="finance-summary-card">
                <small>Aging total</small>
                <strong>{fmtCurrency(agingTotal)}</strong>
              </div>
            </div>
          </div>

          <div className="card fiscal-card">
            <div className="finance-table-wrapper">
              <table className="finance-table">
                <thead>
                  <tr>
                    <th>Mês</th>
                    <th>Total</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {cashflowRows.map((row) => (
                    <tr key={row.month}>
                      <td>{formatMonth(row.month)}</td>
                      <td>{fmtCurrency(row.total)}</td>
                      <td>
                        <button type="button" className="ghost" onClick={() => void loadCashflowEntries(row.month, 0)}>
                          Ver lançamentos
                        </button>
                      </td>
                    </tr>
                  ))}
                  {cashflowRows.length === 0 && (
                    <tr>
                      <td colSpan={3}>Nenhum dado para o período informado.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card fiscal-card">
            <div className="finance-table-wrapper">
              <table className="finance-table">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Descrição</th>
                    <th>Conta</th>
                    <th>Tipo</th>
                    <th>Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {cashflowEntriesRows.map((row) => (
                    <tr key={row.id}>
                      <td>{fmtDateFull(row.entryDate)}</td>
                      <td>{row.description || 'Sem descrição'}</td>
                      <td>{row.accountName || 'Sem conta'}</td>
                      <td>{row.titleType ? titleTypeLabel(row.titleType) : 'Ajuste / avulso'}</td>
                      <td>{fmtCurrency(row.amount)}</td>
                    </tr>
                  ))}
                  {cashflowEntriesRows.length === 0 && (
                    <tr>
                      <td colSpan={5}>Sem lançamentos carregados.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="actions">
              <button
                type="button"
                className="ghost"
                onClick={() => void loadCashflowEntries(cashflowEntriesMonth, Math.max(0, cashflowEntriesOffset - DRILLDOWN_PAGE_SIZE))}
                disabled={!cashflowEntriesMonth || cashflowEntriesOffset === 0}
              >
                Anterior
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => void loadCashflowEntries(cashflowEntriesMonth, cashflowEntriesOffset + DRILLDOWN_PAGE_SIZE)}
                disabled={
                  !cashflowEntriesMonth ||
                  !canGoNextPage(
                    cashflowEntriesOffset,
                    cashflowEntriesRows.length,
                    cashflowEntriesTotalCount,
                    DRILLDOWN_PAGE_SIZE,
                  )
                }
              >
                Próxima
              </button>
              <span>
                {pageInfoLabel(cashflowEntriesOffset, cashflowEntriesRows.length, cashflowEntriesTotalCount)}
              </span>
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  exportCsv(
                    'fluxo-caixa-lancamentos',
                    ['Data', 'Descricao', 'Conta', 'Tipo', 'Valor'],
                    cashflowEntriesRows.map((row) => [
                      fmtDateFull(row.entryDate),
                      row.description || '',
                      row.accountName || '',
                      row.titleType ? titleTypeLabel(row.titleType) : 'Ajuste / avulso',
                      fmtCurrency(row.amount),
                    ]),
                  )
                }
                disabled={cashflowEntriesRows.length === 0}
              >
                Exportar drill-down CSV
              </button>
            </div>
          </div>

          <div className="card fiscal-card">
            <div className="finance-summary-grid">
              {agingBucketOptions.map((option) => {
                const total =
                  option.value === 'overdue'
                    ? agingSummary?.overdue
                    : option.value === 'due_0_30'
                      ? agingSummary?.due_0_30
                      : option.value === 'due_31_60'
                        ? agingSummary?.due_31_60
                        : agingSummary?.due_60_plus

                return (
                  <button
                    key={option.value}
                    type="button"
                    className={[
                      'finance-aging-card-button',
                      agingEntriesBucket === option.value ? 'active' : '',
                    ].join(' ')}
                    onClick={() => void loadAgingEntries(option.value, 0)}
                    disabled={!agingSummary}
                  >
                    <small>{option.label}</small>
                    <strong>{fmtCurrency(total ?? 0)}</strong>
                    <span>Ver títulos</span>
                  </button>
                )
              })}
            </div>
          </div>

          <div className="card fiscal-card">
            <div className="finance-table-wrapper">
              <table className="finance-table">
                <thead>
                  <tr>
                    <th>Vencimento</th>
                    <th>Faixa</th>
                    <th>Tipo</th>
                    <th>Descrição</th>
                    <th>Contraparte</th>
                    <th>Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {agingEntriesRows.map((row) => (
                    <tr key={row.id}>
                      <td>{fmtDateFull(row.dueDate)}</td>
                      <td>{agingBucketLabel(row.bucket)}</td>
                      <td>{titleTypeLabel(row.titleType)}</td>
                      <td>{row.titleDescription || 'Sem descrição'}</td>
                      <td>{counterpartyLabel(row)}</td>
                      <td>{fmtCurrency(row.amount)}</td>
                    </tr>
                  ))}
                  {agingEntriesRows.length === 0 && (
                    <tr>
                      <td colSpan={6}>Sem títulos carregados para o drill-down.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="actions">
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  agingEntriesBucket
                    ? void loadAgingEntries(agingEntriesBucket, Math.max(0, agingEntriesOffset - DRILLDOWN_PAGE_SIZE))
                    : undefined
                }
                disabled={!agingEntriesBucket || agingEntriesOffset === 0}
              >
                Anterior
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  agingEntriesBucket
                    ? void loadAgingEntries(agingEntriesBucket, agingEntriesOffset + DRILLDOWN_PAGE_SIZE)
                    : undefined
                }
                disabled={
                  !agingEntriesBucket ||
                  !canGoNextPage(
                    agingEntriesOffset,
                    agingEntriesRows.length,
                    agingEntriesTotalCount,
                    DRILLDOWN_PAGE_SIZE,
                  )
                }
              >
                Próxima
              </button>
              <span>{pageInfoLabel(agingEntriesOffset, agingEntriesRows.length, agingEntriesTotalCount)}</span>
              <button
                type="button"
                className="ghost"
                onClick={() =>
                  exportCsv(
                    'aging-drilldown',
                    ['Vencimento', 'Faixa', 'Tipo', 'Descricao', 'Contraparte', 'Valor'],
                    agingEntriesRows.map((row) => [
                      fmtDateFull(row.dueDate),
                      agingBucketLabel(row.bucket),
                      titleTypeLabel(row.titleType),
                      row.titleDescription || '',
                      counterpartyLabel(row),
                      fmtCurrency(row.amount),
                    ]),
                  )
                }
                disabled={agingEntriesRows.length === 0}
              >
                Exportar drill-down CSV
              </button>
            </div>
          </div>

          <div className="card fiscal-card">
            <div className="actions">
              <button type="button" className="ghost" onClick={() => setShowOtherReports((state) => !state)}>
                {showOtherReports ? 'Ocultar blocos secundários' : 'Exibir blocos secundários'}
              </button>
            </div>

            {showOtherReports && (
              <div className="finance-split-grid">
                <div className="finance-quick-block">
                  <h3>DRE resumido</h3>
                  <MiniBarChart
                    data={[
                      { label: 'Receitas', value: receivableTotal },
                      { label: 'Despesas', value: -payableTotal },
                      { label: 'Resultado', value: dreResult },
                    ]}
                    height={64}
                  />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginTop: 4 }}>
                    <span style={{ color: '#38a169' }}>{fmtCurrency(receivableTotal)}</span>
                    <span style={{ color: '#c44' }}>-{fmtCurrency(payableTotal)}</span>
                    <span style={{ fontWeight: 600, color: dreResult >= 0 ? '#38a169' : '#c44' }}>{fmtCurrency(dreResult)}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                    <button type="button" className="ghost" style={{ fontSize: '0.74rem', padding: '3px 8px' }} onClick={() => exportCsv('dre-resumido', ['Tipo', 'Total'], [['Receitas', fmtCurrency(receivableTotal)], ['Despesas', fmtCurrency(payableTotal)], ['Resultado', fmtCurrency(dreResult)]])} disabled={dreRows.length === 0}>CSV</button>
                    <button type="button" className="ghost" style={{ fontSize: '0.74rem', padding: '3px 8px' }} onClick={() => void exportPdfReport('DRE Resumido', ['Tipo', 'Total'], [['Receitas', fmtCurrency(receivableTotal)], ['Despesas', fmtCurrency(payableTotal)], ['Resultado', fmtCurrency(dreResult)]])} disabled={dreRows.length === 0}>PDF</button>
                  </div>
                </div>

                <div className="finance-quick-block">
                  <h3>Vendas por mês</h3>
                  {salesRows.length > 0 ? (
                    <MiniBarChart
                      data={salesRows.slice(-6).map((r) => ({ label: formatMonth(r.month).slice(0, 3), value: toNumber(r.total) }))}
                      height={64}
                    />
                  ) : null}
                  <button type="button" className="ghost" style={{ fontSize: '0.74rem', padding: '3px 8px', marginTop: 4 }} onClick={() => exportCsv('vendas-por-mes', ['Mes', 'Total'], salesRows.map((r) => [formatMonth(r.month), fmtCurrency(r.total)]))} disabled={salesRows.length === 0}>Exportar CSV</button>
                </div>

                <div className="finance-quick-block">
                  <h3>Top clientes</h3>
                  {topCustomersRows.slice(0, 5).map((row, i) => (
                    <HorizontalBar key={row.id} label={`${i + 1}. ${row.name}`} value={toNumber(row.total)} max={toNumber(topCustomersRows[0]?.total ?? 1)} amount={fmtCurrency(row.total)} />
                  ))}
                  {topCustomersRows.length === 0 && null}
                  <button type="button" className="ghost" style={{ fontSize: '0.74rem', padding: '3px 8px', marginTop: 4 }} onClick={() => exportCsv('top-clientes', ['Cliente', 'Total'], topCustomersRows.map((r) => [r.name, fmtCurrency(r.total)]))} disabled={topCustomersRows.length === 0}>Exportar CSV</button>
                </div>

                <div className="finance-quick-block">
                  <h3>Margem por produto</h3>
                  {marginRows.slice(0, 5).map((row) => (
                    <HorizontalBar key={row.id} label={row.name} value={toNumber(row.margin)} max={toNumber(marginRows[0]?.margin ?? 1)} amount={fmtCurrency(row.margin)} />
                  ))}
                  {marginRows.length === 0 && null}
                  <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                    <button type="button" className="ghost" style={{ fontSize: '0.74rem', padding: '3px 8px' }} onClick={() => exportCsv('margem-produto', ['Produto', 'Qtd Vendida', 'Receita', 'Custo', 'Margem'], marginRows.map((r) => [r.name, toNumber(r.qty_sold).toString(), fmtCurrency(r.revenue), fmtCurrency(r.cost), fmtCurrency(r.margin)]))} disabled={marginRows.length === 0}>CSV</button>
                    <button type="button" className="ghost" style={{ fontSize: '0.74rem', padding: '3px 8px' }} onClick={() => void exportPdfReport('Margem por Produto', ['Produto', 'Qtd Vendida', 'Receita', 'Custo', 'Margem'], marginRows.map((r) => [r.name, toNumber(r.qty_sold).toString(), fmtCurrency(r.revenue), fmtCurrency(r.cost), fmtCurrency(r.margin)]))} disabled={marginRows.length === 0}>PDF</button>
                  </div>
                </div>

                <div className="finance-quick-block">
                  <h3>Giro de estoque</h3>
                  <ul className="finance-quick-list">
                    {turnoverRows.slice(0, 5).map((row) => (
                      <li key={row.id} className="finance-quick-item">
                        <small>{row.name}</small>
                        <strong>
                          {toNumber(row.avg_stock) > 0
                            ? (toNumber(row.qty_sold) / toNumber(row.avg_stock)).toFixed(2)
                            : '0,00'}
                        </strong>
                      </li>
                    ))}
                    {turnoverRows.length === 0 && <li className="finance-quick-item">Sem dados</li>}
                  </ul>
                </div>

                <div className="finance-quick-block">
                  <h3>Comissões</h3>
                  {commissionsRows.slice(0, 5).map((row) => (
                    <HorizontalBar key={row.id} label={`${row.name} (${row.status})`} value={toNumber(row.total)} max={toNumber(commissionsRows[0]?.total ?? 1)} amount={fmtCurrency(row.total)} />
                  ))}
                  {commissionsRows.length === 0 && null}
                  <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                    <button type="button" className="ghost" style={{ fontSize: '0.74rem', padding: '3px 8px' }} onClick={() => exportCsv('comissoes', ['Vendedor', 'Status', 'Total'], commissionsRows.map((r) => [r.name, r.status, fmtCurrency(r.total)]))} disabled={commissionsRows.length === 0}>CSV</button>
                    <button type="button" className="ghost" style={{ fontSize: '0.74rem', padding: '3px 8px' }} onClick={() => void exportPdfReport('Comissões', ['Vendedor', 'Status', 'Total'], commissionsRows.map((r) => [r.name, r.status, fmtCurrency(r.total)]))} disabled={commissionsRows.length === 0}>PDF</button>
                  </div>
                </div>
              </div>
            )}
          </div>
      </TabPanel>
    </div>
  )
}
