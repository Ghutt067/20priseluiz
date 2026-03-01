import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  createBankTransaction,
  createFinancialAccount,
  createFinancialTitle,
  fetchBankTransactionsPaged,
  fetchFinanceInboxToday,
  fetchFinanceInstallmentsPaged,
  fetchFinancialAccountsPaged,
  fetchFinancialTitlesPaged,
  cancelFinancialTitle,
  updateFinancialTitle,
  payInstallment,
  type BankTransactionLookup,
  type FinanceInboxToday,
  type FinancialAccountLookup,
  type FinancialInstallmentLookup,
  type FinancialTitleLookup,
  type LookupPageResult,
} from '../../services/finance'
import { fetchSuppliersPaged, searchCustomersPaged } from '../../services/core'
import { DateInput, NumericInput, Select, PageHeader, Tabs, TabPanel } from '../../components/ui'
import { useStatusToast } from '../../hooks/useStatusToast'
import { usePermission } from '../../hooks/usePermission'
import { toNumber as toNum, fmtCurrency, fmtDateFull, fmtDateTime, pageInfoLabel, canGoNextPage as canGoNext } from '../../lib/formatters'

type PaymentMethod = 'cash' | 'card' | 'pix' | 'boleto' | 'transfer' | 'other'

const PAGE_SIZE = 10
const LOOKUP_LIMIT = 80
const INBOX_LIMIT = 8

const paymentMethodOptions: Array<{ value: PaymentMethod; label: string }> = [
  { value: 'cash', label: 'Dinheiro' },
  { value: 'card', label: 'Cartão' },
  { value: 'pix', label: 'PIX' },
  { value: 'boleto', label: 'Boleto' },
  { value: 'transfer', label: 'Transferência' },
  { value: 'other', label: 'Outro' },
]

function emptyPage<T>(): LookupPageResult<T> {
  return {
    rows: [],
    totalCount: null,
  }
}

function titleTypeLabel(value: 'receivable' | 'payable') {
  return value === 'receivable' ? 'A receber' : 'A pagar'
}

function financialStatusLabel(value: 'open' | 'paid' | 'canceled' | 'overdue') {
  if (value === 'open') return 'Aberto'
  if (value === 'paid') return 'Pago'
  if (value === 'canceled') return 'Cancelado'
  return 'Vencido'
}

function bankStatusLabel(value: 'pending' | 'cleared' | 'reconciled') {
  if (value === 'pending') return 'Pendente'
  if (value === 'cleared') return 'Compensada'
  return 'Conciliada'
}

function directionLabel(value: 'in' | 'out') {
  return value === 'in' ? 'Entrada' : 'Saída'
}

function counterpartyLabel(input: {
  customerName?: string | null
  supplierName?: string | null
}) {
  return input.customerName || input.supplierName || 'Sem vínculo'
}

export function FinanceiroWorkspace() {
  const canCreateTitle = usePermission('finance.title.create')
  const canPayInstallment = usePermission('finance.installment.pay')
  const canCreateBankTx = usePermission('finance.bank.transaction')
  const [refreshToken, setRefreshToken] = useState(0)

  const [inboxStatus, setInboxStatus] = useState('')
  const [accountStatus, setAccountStatus] = useState('')
  const [titleStatus, setTitleStatus] = useState('')
  useStatusToast(titleStatus)
  const [paymentStatus, setPaymentStatus] = useState('')
  useStatusToast(paymentStatus)
  const [bankTxStatus, setBankTxStatus] = useState('')
  useStatusToast(bankTxStatus)

  const [accountForm, setAccountForm] = useState({
    name: '',
    bankCode: '',
    agency: '',
    accountNumber: '',
  })

  const [titleForm, setTitleForm] = useState<{
    titleType: 'receivable' | 'payable'
    customerId: string
    supplierId: string
    description: string
    totalAmount: string
    installmentCount: string
    firstDueDate: string
  }>({
    titleType: 'receivable',
    customerId: '',
    supplierId: '',
    description: '',
    totalAmount: '100',
    installmentCount: '1',
    firstDueDate: '',
  })

  const [paymentForm, setPaymentForm] = useState<{
    installmentId: string
    accountId: string
    amount: string
    method: PaymentMethod
  }>({
    installmentId: '',
    accountId: '',
    amount: '0',
    method: 'pix',
  })

  const [bankTxForm, setBankTxForm] = useState<{
    accountId: string
    direction: 'in' | 'out'
    amount: string
    description: string
    externalRef: string
    occurredAt: string
  }>({
    accountId: '',
    direction: 'in',
    amount: '100',
    description: '',
    externalRef: '',
    occurredAt: '',
  })

  const [customerLookupQuery, setCustomerLookupQuery] = useState('')
  const [supplierLookupQuery, setSupplierLookupQuery] = useState('')
  const [customerLookupRows, setCustomerLookupRows] = useState<Array<{ id: string; name: string }>>([])
  const [supplierLookupRows, setSupplierLookupRows] = useState<Array<{ id: string; name: string }>>([])
  const [selectedCustomerName, setSelectedCustomerName] = useState('')
  const [selectedSupplierName, setSelectedSupplierName] = useState('')
  const [customerLookupLoading, setCustomerLookupLoading] = useState(false)
  const [supplierLookupLoading, setSupplierLookupLoading] = useState(false)
  const [customerLookupStatus, setCustomerLookupStatus] = useState('')
  const [supplierLookupStatus, setSupplierLookupStatus] = useState('')

  const [accountLookupRows, setAccountLookupRows] = useState<FinancialAccountLookup[]>([])
  const [accountLookupStatus, setAccountLookupStatus] = useState('')

  const [accountsPage, setAccountsPage] = useState<LookupPageResult<FinancialAccountLookup>>(emptyPage)
  const [accountQuery, setAccountQuery] = useState('')
  const [accountOffset, setAccountOffset] = useState(0)
  const [accountsLoading, setAccountsLoading] = useState(false)
  const [accountsListStatus, setAccountsListStatus] = useState('')

  const [titlesPage, setTitlesPage] = useState<LookupPageResult<FinancialTitleLookup>>(emptyPage)
  const [titleQuery, setTitleQuery] = useState('')
  const [titleTypeFilter, setTitleTypeFilter] = useState<'' | 'receivable' | 'payable'>('')
  const [titleStatusFilter, setTitleStatusFilter] = useState<'' | 'open' | 'paid' | 'canceled' | 'overdue'>('')
  const [titleOffset, setTitleOffset] = useState(0)
  const [titlesLoading, setTitlesLoading] = useState(false)
  const [titlesListStatus, setTitlesListStatus] = useState('')

  const [installmentsPage, setInstallmentsPage] = useState<LookupPageResult<FinancialInstallmentLookup>>(emptyPage)
  const [installmentQuery, setInstallmentQuery] = useState('')
  const [installmentTypeFilter, setInstallmentTypeFilter] = useState<'' | 'receivable' | 'payable'>('')
  const [installmentStatusFilter, setInstallmentStatusFilter] = useState<'' | 'open' | 'paid' | 'canceled' | 'overdue'>('')
  const [installmentDueFrom, setInstallmentDueFrom] = useState('')
  const [installmentDueTo, setInstallmentDueTo] = useState('')
  const [installmentOffset, setInstallmentOffset] = useState(0)
  const [installmentsLoading, setInstallmentsLoading] = useState(false)
  const [installmentsListStatus, setInstallmentsListStatus] = useState('')

  const [bankTransactionsPage, setBankTransactionsPage] = useState<LookupPageResult<BankTransactionLookup>>(emptyPage)
  const [bankTxQuery, setBankTxQuery] = useState('')
  const [bankTxDirectionFilter, setBankTxDirectionFilter] = useState<'' | 'in' | 'out'>('')
  const [bankTxStatusFilter, setBankTxStatusFilter] = useState<'' | 'pending' | 'cleared' | 'reconciled'>('')
  const [bankTxOffset, setBankTxOffset] = useState(0)
  const [bankTransactionsLoading, setBankTransactionsLoading] = useState(false)
  const [bankTransactionsListStatus, setBankTransactionsListStatus] = useState('')

  const [inbox, setInbox] = useState<FinanceInboxToday | null>(null)
  const [inboxLoading, setInboxLoading] = useState(false)
  const [quickPayInstallmentId, setQuickPayInstallmentId] = useState('')

  const refreshAll = useCallback(() => {
    setRefreshToken((state) => state + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    fetchFinancialAccountsPaged({
      limit: LOOKUP_LIMIT,
      offset: 0,
      signal: controller.signal,
    })
      .then((page) => {
        setAccountLookupRows(page.rows)
        setAccountLookupStatus('')
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        const message =
          error instanceof Error ? error.message : 'Erro ao carregar contas para seleção.'
        setAccountLookupStatus(message)
      })

    return () => controller.abort()
  }, [refreshToken])

  useEffect(() => {
    if (accountLookupRows.length === 0) return

    setPaymentForm((state) => {
      if (state.accountId) return state
      return {
        ...state,
        accountId: accountLookupRows[0].id,
      }
    })

    setBankTxForm((state) => {
      if (state.accountId) return state
      return {
        ...state,
        accountId: accountLookupRows[0].id,
      }
    })
  }, [accountLookupRows])

  useEffect(() => {
    const controller = new AbortController()

    setAccountsLoading(true)
    setAccountsListStatus('')

    fetchFinancialAccountsPaged({
      query: accountQuery,
      limit: PAGE_SIZE,
      offset: accountOffset,
      signal: controller.signal,
    })
      .then((page) => setAccountsPage(page))
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        const message = error instanceof Error ? error.message : 'Erro ao carregar contas.'
        setAccountsListStatus(message)
      })
      .finally(() => setAccountsLoading(false))

    return () => controller.abort()
  }, [accountOffset, accountQuery, refreshToken])

  useEffect(() => {
    const controller = new AbortController()

    setTitlesLoading(true)
    setTitlesListStatus('')

    fetchFinancialTitlesPaged({
      titleType: titleTypeFilter || undefined,
      status: titleStatusFilter || undefined,
      query: titleQuery,
      limit: PAGE_SIZE,
      offset: titleOffset,
      signal: controller.signal,
    })
      .then((page) => setTitlesPage(page))
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        const message = error instanceof Error ? error.message : 'Erro ao carregar títulos.'
        setTitlesListStatus(message)
      })
      .finally(() => setTitlesLoading(false))

    return () => controller.abort()
  }, [refreshToken, titleOffset, titleQuery, titleStatusFilter, titleTypeFilter])

  useEffect(() => {
    const controller = new AbortController()

    setInstallmentsLoading(true)
    setInstallmentsListStatus('')

    fetchFinanceInstallmentsPaged({
      status: installmentStatusFilter || undefined,
      titleType: installmentTypeFilter || undefined,
      dueFrom: installmentDueFrom || undefined,
      dueTo: installmentDueTo || undefined,
      query: installmentQuery,
      limit: PAGE_SIZE,
      offset: installmentOffset,
      signal: controller.signal,
    })
      .then((page) => setInstallmentsPage(page))
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        const message = error instanceof Error ? error.message : 'Erro ao carregar parcelas.'
        setInstallmentsListStatus(message)
      })
      .finally(() => setInstallmentsLoading(false))

    return () => controller.abort()
  }, [
    installmentDueFrom,
    installmentDueTo,
    installmentOffset,
    installmentQuery,
    installmentStatusFilter,
    installmentTypeFilter,
    refreshToken,
  ])

  useEffect(() => {
    const controller = new AbortController()

    setBankTransactionsLoading(true)
    setBankTransactionsListStatus('')

    fetchBankTransactionsPaged({
      direction: bankTxDirectionFilter || undefined,
      status: bankTxStatusFilter || undefined,
      query: bankTxQuery,
      limit: PAGE_SIZE,
      offset: bankTxOffset,
      signal: controller.signal,
    })
      .then((page) => setBankTransactionsPage(page))
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        const message =
          error instanceof Error ? error.message : 'Erro ao carregar transações bancárias.'
        setBankTransactionsListStatus(message)
      })
      .finally(() => setBankTransactionsLoading(false))

    return () => controller.abort()
  }, [bankTxDirectionFilter, bankTxOffset, bankTxQuery, bankTxStatusFilter, refreshToken])

  useEffect(() => {
    const controller = new AbortController()

    setInboxLoading(true)
    setInboxStatus('')

    fetchFinanceInboxToday({
      limit: INBOX_LIMIT,
      signal: controller.signal,
    })
      .then((payload) => setInbox(payload))
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        const message = error instanceof Error ? error.message : 'Erro ao carregar inbox de hoje.'
        setInboxStatus(message)
      })
      .finally(() => setInboxLoading(false))

    return () => controller.abort()
  }, [refreshToken])

  useEffect(() => {
    if (titleForm.titleType !== 'receivable') {
      setCustomerLookupRows([])
      setCustomerLookupLoading(false)
      setCustomerLookupStatus('')
      return
    }

    const query = customerLookupQuery.trim()
    if (query.length < 2) {
      setCustomerLookupRows([])
      setCustomerLookupLoading(false)
      setCustomerLookupStatus(
        query.length === 0 ? 'Digite ao menos 2 caracteres para buscar cliente.' : '',
      )
      return
    }

    const controller = new AbortController()

    setCustomerLookupLoading(true)
    setCustomerLookupStatus('')

    searchCustomersPaged(query, {
      limit: 8,
      offset: 0,
      signal: controller.signal,
    })
      .then((rows) => {
        const mapped = rows.map((row) => ({ id: row.id, name: row.name }))
        setCustomerLookupRows(mapped)
        if (mapped.length === 0) {
          setCustomerLookupStatus('Nenhum cliente encontrado para essa busca.')
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        const message = error instanceof Error ? error.message : 'Erro ao pesquisar clientes.'
        setCustomerLookupStatus(message)
      })
      .finally(() => setCustomerLookupLoading(false))

    return () => controller.abort()
  }, [customerLookupQuery, titleForm.titleType])

  useEffect(() => {
    if (titleForm.titleType !== 'payable') {
      setSupplierLookupRows([])
      setSupplierLookupLoading(false)
      setSupplierLookupStatus('')
      return
    }

    const controller = new AbortController()

    setSupplierLookupLoading(true)
    setSupplierLookupStatus('')

    fetchSuppliersPaged({
      query: supplierLookupQuery.trim() || undefined,
      limit: 8,
      offset: 0,
      signal: controller.signal,
    })
      .then((page) => {
        const mapped = page.rows.map((row) => ({ id: row.id, name: row.name }))
        setSupplierLookupRows(mapped)
        if (mapped.length === 0) {
          setSupplierLookupStatus('Nenhum fornecedor encontrado para essa busca.')
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        const message =
          error instanceof Error ? error.message : 'Erro ao pesquisar fornecedores.'
        setSupplierLookupStatus(message)
      })
      .finally(() => setSupplierLookupLoading(false))

    return () => controller.abort()
  }, [supplierLookupQuery, titleForm.titleType])

  useEffect(() => {
    if (!titleForm.customerId) return
    const selected = customerLookupRows.find((row) => row.id === titleForm.customerId)
    if (selected) {
      setSelectedCustomerName(selected.name)
    }
  }, [customerLookupRows, titleForm.customerId])

  useEffect(() => {
    if (!titleForm.supplierId) return
    const selected = supplierLookupRows.find((row) => row.id === titleForm.supplierId)
    if (selected) {
      setSelectedSupplierName(selected.name)
    }
  }, [supplierLookupRows, titleForm.supplierId])

  const accountOptions = useMemo(() => {
    return [
      { value: '', label: 'Sem conta vinculada' },
      ...accountLookupRows.map((account) => ({
        value: account.id,
        label: `${account.name}${account.bankCode ? ` • ${account.bankCode}` : ''}`,
      })),
    ]
  }, [accountLookupRows])

  const customerOptions = useMemo(() => {
    const catalog = new Map<string, string>()
    if (titleForm.customerId && selectedCustomerName) {
      catalog.set(titleForm.customerId, selectedCustomerName)
    }
    for (const row of customerLookupRows) {
      catalog.set(row.id, row.name)
    }
    return [
      { value: '', label: 'Selecione um cliente' },
      ...Array.from(catalog.entries()).map(([value, label]) => ({ value, label })),
    ]
  }, [customerLookupRows, selectedCustomerName, titleForm.customerId])

  const supplierOptions = useMemo(() => {
    const catalog = new Map<string, string>()
    if (titleForm.supplierId && selectedSupplierName) {
      catalog.set(titleForm.supplierId, selectedSupplierName)
    }
    for (const row of supplierLookupRows) {
      catalog.set(row.id, row.name)
    }
    return [
      { value: '', label: 'Selecione um fornecedor' },
      ...Array.from(catalog.entries()).map(([value, label]) => ({ value, label })),
    ]
  }, [selectedSupplierName, supplierLookupRows, titleForm.supplierId])

  const openInstallments = useMemo(() => {
    const catalog = new Map<string, FinancialInstallmentLookup>()

    for (const installment of installmentsPage.rows) {
      if (installment.status === 'open') {
        catalog.set(installment.id, installment)
      }
    }

    for (const installment of inbox?.installmentsDueToday ?? []) {
      if (installment.status === 'open') {
        catalog.set(installment.id, installment)
      }
    }

    for (const installment of inbox?.installmentsOverdue ?? []) {
      if (installment.status === 'open') {
        catalog.set(installment.id, installment)
      }
    }

    return Array.from(catalog.values()).sort((a, b) => {
      return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
    })
  }, [inbox?.installmentsDueToday, inbox?.installmentsOverdue, installmentsPage.rows])

  const installmentById = useMemo(() => {
    return new Map(openInstallments.map((installment) => [installment.id, installment]))
  }, [openInstallments])

  const installmentOptions = useMemo(() => {
    return [
      { value: '', label: 'Selecione uma parcela aberta' },
      ...openInstallments.map((installment) => ({
        value: installment.id,
        label: `${fmtDateFull(installment.dueDate)} • ${counterpartyLabel(installment)} • ${fmtCurrency(installment.amount)}`,
      })),
    ]
  }, [openInstallments])

  const selectedInstallment = paymentForm.installmentId
    ? installmentById.get(paymentForm.installmentId)
    : undefined

  const accountsCanNext = canGoNext(
    accountOffset,
    accountsPage.rows.length,
    accountsPage.totalCount,
    PAGE_SIZE,
  )
  const titlesCanNext = canGoNext(titleOffset, titlesPage.rows.length, titlesPage.totalCount, PAGE_SIZE)
  const installmentsCanNext = canGoNext(
    installmentOffset,
    installmentsPage.rows.length,
    installmentsPage.totalCount,
    PAGE_SIZE,
  )
  const bankTxCanNext = canGoNext(
    bankTxOffset,
    bankTransactionsPage.rows.length,
    bankTransactionsPage.totalCount,
    PAGE_SIZE,
  )

  const prefillPayment = useCallback((installment: FinancialInstallmentLookup) => {
    setPaymentForm((state) => ({
      ...state,
      installmentId: installment.id,
      amount: toNum(installment.amount).toFixed(2),
    }))
    setPaymentStatus('Parcela selecionada para pagamento.')
  }, [])

  const handleQuickPay = useCallback(
    async (installment: FinancialInstallmentLookup) => {
      setQuickPayInstallmentId(installment.id)
      try {
        await payInstallment({
          installmentId: installment.id,
          accountId: paymentForm.accountId || undefined,
          amount: toNum(installment.amount),
          method: paymentForm.method,
        })

        setPaymentStatus(`Baixa registrada para ${counterpartyLabel(installment)}.`)
        refreshAll()
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Erro ao registrar baixa rápida.'
        setPaymentStatus(message)
      } finally {
        setQuickPayInstallmentId('')
      }
    },
    [paymentForm.accountId, paymentForm.method, refreshAll],
  )

  const [finTab, setFinTab] = useState<'inbox' | 'operations' | 'listings'>('inbox')

  return (
    <div className="page-grid">
      <PageHeader />
      <Tabs
        tabs={[
          { key: 'inbox' as const, label: 'Inbox' },
          { key: 'operations' as const, label: 'Operações' },
          { key: 'listings' as const, label: 'Listagens' },
        ]}
        active={finTab}
        onChange={(k) => setFinTab(k as 'inbox' | 'operations' | 'listings')}
      />
      <TabPanel active={finTab === 'inbox'}>
      <div className="card fiscal-card">
        <div className="fiscal-grid">
          <label>
            Conta (Baixa rápida)
            <Select
              value={paymentForm.accountId}
              options={accountOptions}
              onChange={(value) => setPaymentForm((state) => ({ ...state, accountId: value }))}
            />
          </label>
          <label>
            Método padrão
            <Select
              value={paymentForm.method}
              options={paymentMethodOptions.map((option) => ({
                value: option.value,
                label: option.label,
              }))}
              onChange={(value) =>
                setPaymentForm((state) => ({
                  ...state,
                  method: value as PaymentMethod,
                }))
              }
            />
          </label>
        </div>

        <div className="actions">
          <button type="button" onClick={refreshAll}>
            Atualizar Dados
          </button>
          
        </div>

        {inbox && (
          <>
            <div className="finance-summary-grid">
              <article className="finance-summary-card">
                
                <strong>{inbox.summary.dueTodayCount}</strong>
                <span>{fmtCurrency(inbox.summary.dueTodayAmount)}</span>
              </article>
              <article className="finance-summary-card">
                
                <strong>{inbox.summary.overdueCount}</strong>
                <span>{fmtCurrency(inbox.summary.overdueAmount)}</span>
              </article>
              <article className="finance-summary-card">
                
                <strong>{inbox.summary.pendingBankTransactionsCount}</strong>
                <span>Conciliação</span>
              </article>
            </div>

            <div className="finance-split-grid">
              <section className="finance-quick-block">
                <h3>Vencimentos de Hoje</h3>
                {inbox.installmentsDueToday.length === 0 && null}
                {inbox.installmentsDueToday.length > 0 && (
                  <ul className="finance-quick-list">
                    {inbox.installmentsDueToday.map((installment) => (
                      <li key={installment.id} className="finance-quick-item">
                        <div>
                          <strong>{counterpartyLabel(installment)}</strong>
                          <p className="hint">
                            {titleTypeLabel(installment.titleType)} • vence {fmtDateFull(installment.dueDate)}
                          </p>
                        </div>
                        <div className="actions">
                          <strong>{fmtCurrency(installment.amount)}</strong>
                          <button
                            type="button"
                            onClick={() => {
                              void handleQuickPay(installment)
                            }}
                            disabled={quickPayInstallmentId === installment.id}
                          >
                            Baixar
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => prefillPayment(installment)}
                          >
                            Preencher
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="finance-quick-block">
                <h3>Títulos em Atraso</h3>
                {inbox.installmentsOverdue.length === 0 && null}
                {inbox.installmentsOverdue.length > 0 && (
                  <ul className="finance-quick-list">
                    {inbox.installmentsOverdue.map((installment) => (
                      <li key={installment.id} className="finance-quick-item">
                        <div>
                          <strong>{counterpartyLabel(installment)}</strong>
                          <p className="hint">
                            {titleTypeLabel(installment.titleType)} • venceu em {fmtDateFull(installment.dueDate)}
                          </p>
                        </div>
                        <div className="actions">
                          <strong>{fmtCurrency(installment.amount)}</strong>
                          <button
                            type="button"
                            onClick={() => {
                              void handleQuickPay(installment)
                            }}
                            disabled={quickPayInstallmentId === installment.id}
                          >
                            Baixar
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => prefillPayment(installment)}
                          >
                            Preencher
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="finance-quick-block">
                <h3>Transações a Conciliar</h3>
                {inbox.pendingBankTransactions.length === 0 && null}
                {inbox.pendingBankTransactions.length > 0 && (
                  <ul className="finance-quick-list">
                    {inbox.pendingBankTransactions.map((transaction) => (
                      <li key={transaction.id} className="finance-quick-item">
                        <div>
                          <strong>{transaction.description || 'Sem descrição'}</strong>
                          <p className="hint">
                            {directionLabel(transaction.direction)} • {transaction.accountName || 'Sem conta'}
                          </p>
                        </div>
                        <div className="actions">
                          <strong>{fmtCurrency(transaction.amount)}</strong>
                          <span className={`finance-status-badge ${transaction.status}`}>
                            {bankStatusLabel(transaction.status)}
                          </span>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => {
                              setBankTxStatusFilter('pending')
                              setBankTxOffset(0)
                            }}
                          >
                            Ver lista
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}
      </div>
      </TabPanel>

      <TabPanel active={finTab === 'operations'}>
      <div className="card fiscal-card">
        <section className="finance-form-section">
          <h3>Nova Conta Financeira</h3>
          <div className="fiscal-grid">
            <label>
              Nome
              <input
                value={accountForm.name}
                onChange={(event) =>
                  setAccountForm((state) => ({ ...state, name: event.target.value }))
                }
              />
            </label>
            <label>
              Banco
              <input
                value={accountForm.bankCode}
                onChange={(event) =>
                  setAccountForm((state) => ({ ...state, bankCode: event.target.value }))
                }
              />
            </label>
            <label>
              Agência
              <input
                value={accountForm.agency}
                onChange={(event) =>
                  setAccountForm((state) => ({ ...state, agency: event.target.value }))
                }
              />
            </label>
            <label>
              Conta
              <input
                value={accountForm.accountNumber}
                onChange={(event) =>
                  setAccountForm((state) => ({ ...state, accountNumber: event.target.value }))
                }
              />
            </label>
          </div>
          <div className="actions">
            <button
              type="button"
              onClick={async () => {
                if (!accountForm.name.trim()) {
                  setAccountStatus('Informe o nome da conta.')
                  return
                }

                setAccountStatus('Criando conta...')
                try {
                  await createFinancialAccount({
                    name: accountForm.name.trim(),
                    bankCode: accountForm.bankCode.trim() || undefined,
                    agency: accountForm.agency.trim() || undefined,
                    accountNumber: accountForm.accountNumber.trim() || undefined,
                  })
                  setAccountStatus('Conta criada com sucesso.')
                  setAccountForm({ name: '', bankCode: '', agency: '', accountNumber: '' })
                  refreshAll()
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : 'Erro ao criar conta.'
                  setAccountStatus(message)
                }
              }}
            >
              Criar conta
            </button>
          </div>
        </section>

        <section className="finance-form-section">
          <h3>Novo Título (A Receber / A Pagar)</h3>
          <div className="fiscal-grid">
            <label>
              Tipo
              <Select
                value={titleForm.titleType}
                options={[
                  { value: 'receivable', label: 'A receber' },
                  { value: 'payable', label: 'A pagar' },
                ]}
                onChange={(value) => {
                  const nextType = value as 'receivable' | 'payable'
                  setTitleForm((state) => ({
                    ...state,
                    titleType: nextType,
                    customerId: nextType === 'receivable' ? state.customerId : '',
                    supplierId: nextType === 'payable' ? state.supplierId : '',
                  }))
                  if (nextType === 'receivable') {
                    setSelectedSupplierName('')
                    setSupplierLookupQuery('')
                    setSupplierLookupRows([])
                  } else {
                    setSelectedCustomerName('')
                    setCustomerLookupQuery('')
                    setCustomerLookupRows([])
                  }
                }}
              />
            </label>

            {titleForm.titleType === 'receivable' ? (
              <>
                <label>
                  Buscar cliente
                  <input
                    value={customerLookupQuery}
                    placeholder="Nome, CPF ou telefone"
                    onChange={(event) => setCustomerLookupQuery(event.target.value)}
                  />
                </label>
                <label>
                  Cliente
                  <Select
                    value={titleForm.customerId}
                    options={customerOptions}
                    onChange={(value) => {
                      setTitleForm((state) => ({ ...state, customerId: value }))
                      const selected = customerLookupRows.find((row) => row.id === value)
                      if (selected) {
                        setSelectedCustomerName(selected.name)
                      }
                    }}
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  Buscar fornecedor
                  <input
                    value={supplierLookupQuery}
                    placeholder="Nome ou CNPJ"
                    onChange={(event) => setSupplierLookupQuery(event.target.value)}
                  />
                </label>
                <label>
                  Fornecedor
                  <Select
                    value={titleForm.supplierId}
                    options={supplierOptions}
                    onChange={(value) => {
                      setTitleForm((state) => ({ ...state, supplierId: value }))
                      const selected = supplierLookupRows.find((row) => row.id === value)
                      if (selected) {
                        setSelectedSupplierName(selected.name)
                      }
                    }}
                  />
                </label>
              </>
            )}

            <label>
              Valor total
              <NumericInput
                value={titleForm.totalAmount}
                currency
                onChange={(event) =>
                  setTitleForm((state) => ({ ...state, totalAmount: event.target.value }))
                }
              />
            </label>
            <label>
              Parcelas
              <NumericInput
                value={titleForm.installmentCount}
                decimals={0}
                onChange={(event) =>
                  setTitleForm((state) => ({ ...state, installmentCount: event.target.value }))
                }
              />
            </label>
            <label>
              Primeiro vencimento
              <DateInput
                value={titleForm.firstDueDate}
                onChange={(event) =>
                  setTitleForm((state) => ({ ...state, firstDueDate: event.target.value }))
                }
              />
            </label>
            <label>
              Descrição
              <input
                value={titleForm.description}
                onChange={(event) =>
                  setTitleForm((state) => ({ ...state, description: event.target.value }))
                }
              />
            </label>
          </div>

          {(customerLookupLoading || supplierLookupLoading) && null}
          {customerLookupStatus && titleForm.titleType === 'receivable' && null}
          {supplierLookupStatus && titleForm.titleType === 'payable' && null}

          <div className="actions">
            <button
              type="button"
              onClick={async () => {
                const totalAmount = toNum(titleForm.totalAmount)
                const installmentCount = Math.max(
                  1,
                  Math.floor(toNum(titleForm.installmentCount) || 1),
                )

                if (totalAmount <= 0) {
                  setTitleStatus('Informe um valor total maior que zero.')
                  return
                }

                if (!titleForm.firstDueDate) {
                  setTitleStatus('Informe o primeiro vencimento.')
                  return
                }

                if (titleForm.titleType === 'receivable' && !titleForm.customerId) {
                  setTitleStatus('Selecione um cliente para título a receber.')
                  return
                }

                if (titleForm.titleType === 'payable' && !titleForm.supplierId) {
                  setTitleStatus('Selecione um fornecedor para título a pagar.')
                  return
                }

                setTitleStatus('Criando título...')
                try {
                  const result = await createFinancialTitle({
                    titleType: titleForm.titleType,
                    customerId: titleForm.customerId || undefined,
                    supplierId: titleForm.supplierId || undefined,
                    description: titleForm.description.trim() || undefined,
                    totalAmount,
                    installmentCount,
                    firstDueDate: titleForm.firstDueDate,
                  })
                  setTitleStatus(`Título criado: ${result.titleId}`)
                  setTitleForm((state) => ({
                    ...state,
                    customerId: '',
                    supplierId: '',
                    description: '',
                    totalAmount: '100',
                    installmentCount: '1',
                    firstDueDate: '',
                  }))
                  refreshAll()
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : 'Erro ao criar título.'
                  setTitleStatus(message)
                }
              }}
            >
              {canCreateTitle ? 'Criar título' : 'Sem permissão'}
            </button>
          </div>
        </section>

        <section className="finance-form-section">
          <h3>Pagamento</h3>
          <div className="fiscal-grid">
            <label>
              Parcela
              <Select
                value={paymentForm.installmentId}
                options={installmentOptions}
                onChange={(value) => {
                  const selected = installmentById.get(value)
                  if (selected) {
                    setPaymentForm((state) => ({
                      ...state,
                      installmentId: selected.id,
                      amount: toNum(selected.amount).toFixed(2),
                    }))
                    return
                  }
                  setPaymentForm((state) => ({ ...state, installmentId: value }))
                }}
              />
            </label>
            <label>
              Conta
              <Select
                value={paymentForm.accountId}
                options={accountOptions}
                onChange={(value) => setPaymentForm((state) => ({ ...state, accountId: value }))}
              />
            </label>
            <label>
              Valor
              <NumericInput
                value={paymentForm.amount}
                currency
                onChange={(event) =>
                  setPaymentForm((state) => ({ ...state, amount: event.target.value }))
                }
              />
            </label>
            <label>
              Método
              <Select
                value={paymentForm.method}
                options={paymentMethodOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                onChange={(value) =>
                  setPaymentForm((state) => ({
                    ...state,
                    method: value as PaymentMethod,
                  }))
                }
              />
            </label>
          </div>

          {selectedInstallment && (
            <p className="hint">
              Selecionado: {counterpartyLabel(selectedInstallment)} • {fmtDateFull(selectedInstallment.dueDate)} •{' '}
              {fmtCurrency(selectedInstallment.amount)}
            </p>
          )}

          <div className="actions">
            <button
              type="button"
              onClick={async () => {
                const amount = toNum(paymentForm.amount)

                if (!paymentForm.installmentId) {
                  setPaymentStatus('Selecione uma parcela aberta para pagamento.')
                  return
                }

                if (amount <= 0) {
                  setPaymentStatus('Informe um valor maior que zero.')
                  return
                }
                try {
                  const result = await payInstallment({
                    installmentId: paymentForm.installmentId,
                    accountId: paymentForm.accountId || undefined,
                    amount,
                    method: paymentForm.method,
                  })
                  setPaymentStatus(`Pagamento registrado: ${result.installmentId}`)
                  setPaymentForm((state) => ({
                    ...state,
                    installmentId: '',
                    amount: '0',
                  }))
                  refreshAll()
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : 'Erro ao registrar pagamento.'
                  setPaymentStatus(message)
                }
              }}
            >
              Registrar pagamento
            </button>
          </div>
        </section>

        <section className="finance-form-section">
          <h3>Nova Transação Avulsa</h3>
          <div className="fiscal-grid">
            <label>
              Conta
              <Select
                value={bankTxForm.accountId}
                options={accountOptions}
                onChange={(value) => setBankTxForm((state) => ({ ...state, accountId: value }))}
              />
            </label>
            <label>
              Direção
              <Select
                value={bankTxForm.direction}
                options={[
                  { value: 'in', label: 'Entrada' },
                  { value: 'out', label: 'Saída' },
                ]}
                onChange={(value) =>
                  setBankTxForm((state) => ({
                    ...state,
                    direction: value as 'in' | 'out',
                  }))
                }
              />
            </label>
            <label>
              Valor
              <NumericInput
                value={bankTxForm.amount}
                currency
                onChange={(event) =>
                  setBankTxForm((state) => ({ ...state, amount: event.target.value }))
                }
              />
            </label>
            <label>
              Data ocorrência
              <DateInput
                value={bankTxForm.occurredAt}
                onChange={(event) =>
                  setBankTxForm((state) => ({ ...state, occurredAt: event.target.value }))
                }
              />
            </label>
            <label>
              Referência externa
              <input
                value={bankTxForm.externalRef}
                onChange={(event) =>
                  setBankTxForm((state) => ({ ...state, externalRef: event.target.value }))
                }
              />
            </label>
            <label>
              Descrição
              <input
                value={bankTxForm.description}
                onChange={(event) =>
                  setBankTxForm((state) => ({ ...state, description: event.target.value }))
                }
              />
            </label>
          </div>

          <div className="actions">
            <button
              type="button"
              onClick={async () => {
                const amount = toNum(bankTxForm.amount)

                if (amount <= 0) {
                  setBankTxStatus('Informe um valor maior que zero.')
                  return
                }

                setBankTxStatus('Criando transação bancária...')
                try {
                  const result = await createBankTransaction({
                    accountId: bankTxForm.accountId || undefined,
                    direction: bankTxForm.direction,
                    amount,
                    description: bankTxForm.description.trim() || undefined,
                    externalRef: bankTxForm.externalRef.trim() || undefined,
                    occurredAt: bankTxForm.occurredAt || undefined,
                  })
                  setBankTxStatus(`Transação criada: ${result.bankTransactionId}`)
                  setBankTxForm((state) => ({
                    ...state,
                    amount: '100',
                    description: '',
                    externalRef: '',
                    occurredAt: '',
                  }))
                  refreshAll()
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : 'Erro ao criar transação.'
                  setBankTxStatus(message)
                }
              }}
            >
              {canCreateBankTx ? 'Criar transação bancária' : 'Sem permissão'}
            </button>
          </div>
        </section>

        {(accountStatus || titleStatus || paymentStatus || bankTxStatus) && (
          <div className="finance-status-stack">

          </div>
        )}
      </div>
      </TabPanel>

      <TabPanel active={finTab === 'listings'}>
      <div className="card fiscal-card">
        <div className="finance-list-header">
          <div className="actions">
            <button type="button" className="ghost" onClick={refreshAll}>
              Recarregar
            </button>
          </div>
        </div>

        <div className="finance-list-controls">
          <label>
            Buscar
            <input
              value={accountQuery}
              placeholder="Nome, banco, agência ou conta"
              onChange={(event) => {
                setAccountQuery(event.target.value)
                setAccountOffset(0)
              }}
            />
          </label>
        </div>

        <div className="finance-table-wrapper">
          <table className="finance-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Banco / Agência / Conta</th>
                <th>Status</th>
                <th>Criada em</th>
              </tr>
            </thead>
            <tbody>
              {accountsPage.rows.map((account) => (
                <tr key={account.id}>
                  <td>{account.name}</td>
                  <td>
                    {[account.bankCode, account.agency, account.accountNumber].filter(Boolean).join(' / ') || '—'}
                  </td>
                  <td>
                    <span className={`finance-status-badge ${account.active ? 'paid' : 'canceled'}`}>
                      {account.active ? 'Ativa' : 'Inativa'}
                    </span>
                  </td>
                  <td>{fmtDateTime(account.createdAt)}</td>
                </tr>
              ))}
              {accountsPage.rows.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="actions">
          <span className="hint">
            {pageInfoLabel(accountOffset, accountsPage.rows.length, accountsPage.totalCount)}
          </span>
          <button
            type="button"
            className="ghost"
            disabled={accountOffset === 0}
            onClick={() => setAccountOffset((state) => Math.max(0, state - PAGE_SIZE))}
          >
            Anterior
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!accountsCanNext}
            onClick={() => setAccountOffset((state) => state + PAGE_SIZE)}
          >
            Próxima
          </button>
        </div>
      </div>

      <div className="card fiscal-card">
        <div className="finance-list-header">
        </div>

        <div className="finance-list-controls">
          <label>
            Buscar
            <input
              value={titleQuery}
              placeholder="Descrição, cliente ou fornecedor"
              onChange={(event) => {
                setTitleQuery(event.target.value)
                setTitleOffset(0)
              }}
            />
          </label>
          <label>
            Tipo
            <Select
              value={titleTypeFilter}
              options={[
                { value: '', label: 'Todos' },
                { value: 'receivable', label: 'A receber' },
                { value: 'payable', label: 'A pagar' },
              ]}
              onChange={(value) => {
                setTitleTypeFilter(value as '' | 'receivable' | 'payable')
                setTitleOffset(0)
              }}
            />
          </label>
          <label>
            Status
            <Select
              value={titleStatusFilter}
              options={[
                { value: '', label: 'Todos' },
                { value: 'open', label: 'Aberto' },
                { value: 'paid', label: 'Pago' },
                { value: 'overdue', label: 'Vencido' },
                { value: 'canceled', label: 'Cancelado' },
              ]}
              onChange={(value) => {
                setTitleStatusFilter(value as '' | 'open' | 'paid' | 'canceled' | 'overdue')
                setTitleOffset(0)
              }}
            />
          </label>
        </div>

        <div className="finance-table-wrapper">
          <table className="finance-table">
            <thead>
              <tr>
                <th>Criado em</th>
                <th>Tipo</th>
                <th>Status</th>
                <th>Descrição</th>
                <th>Vínculo</th>
                <th>Total</th>
                <th>Em aberto</th>
                <th>Próx. venc.</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {titlesPage.rows.map((title) => (
                <tr key={title.id}>
                  <td>{fmtDateTime(title.createdAt)}</td>
                  <td>{titleTypeLabel(title.titleType)}</td>
                  <td>
                    <span className={`finance-status-badge ${title.status}`}>
                      {financialStatusLabel(title.status)}
                    </span>
                  </td>
                  <td>{title.description || '—'}</td>
                  <td>{counterpartyLabel(title)}</td>
                  <td>{fmtCurrency(title.totalAmount)}</td>
                  <td>{fmtCurrency(title.openAmount)}</td>
                  <td>{fmtDateFull(title.nextDueDate)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {title.status === 'open' && (
                        <button type="button" className="ghost" style={{ fontSize: '0.72rem', padding: '2px 6px' }} onClick={async () => {
                          const desc = globalThis.prompt('Editar descrição / centro de custo:', title.description ?? '')
                          if (desc === null) return
                          try {
                            await updateFinancialTitle(title.id, { description: desc, costCenter: desc })
                            setTitleStatus('Título atualizado.')
                            refreshAll()
                          } catch (e) { setTitleStatus(e instanceof Error ? e.message : 'Erro.') }
                        }}>Editar</button>
                      )}
                      {(title.status === 'open' || title.status === 'overdue') && (
                        <button type="button" className="ghost" style={{ fontSize: '0.72rem', padding: '2px 6px', color: 'var(--danger, #c00)' }} onClick={async () => {
                          if (!globalThis.confirm('Cancelar (estornar) este título?')) return
                          try {
                            await cancelFinancialTitle(title.id)
                            setTitleStatus('Título cancelado (estornado).')
                            refreshAll()
                          } catch (e) { setTitleStatus(e instanceof Error ? e.message : 'Erro.') }
                        }}>Estornar</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {titlesPage.rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="actions">
          <span className="hint">
            {pageInfoLabel(titleOffset, titlesPage.rows.length, titlesPage.totalCount)}
          </span>
          <button
            type="button"
            className="ghost"
            disabled={titleOffset === 0}
            onClick={() => setTitleOffset((state) => Math.max(0, state - PAGE_SIZE))}
          >
            Anterior
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!titlesCanNext}
            onClick={() => setTitleOffset((state) => state + PAGE_SIZE)}
          >
            Próxima
          </button>
        </div>
      </div>

      <div className="card fiscal-card">
        <div className="finance-list-header">
        </div>

        <div className="finance-list-controls">
          <label>
            Buscar
            <input
              value={installmentQuery}
              placeholder="Descrição, cliente ou fornecedor"
              onChange={(event) => {
                setInstallmentQuery(event.target.value)
                setInstallmentOffset(0)
              }}
            />
          </label>
          <label>
            Tipo
            <Select
              value={installmentTypeFilter}
              options={[
                { value: '', label: 'Todos' },
                { value: 'receivable', label: 'A receber' },
                { value: 'payable', label: 'A pagar' },
              ]}
              onChange={(value) => {
                setInstallmentTypeFilter(value as '' | 'receivable' | 'payable')
                setInstallmentOffset(0)
              }}
            />
          </label>
          <label>
            Status
            <Select
              value={installmentStatusFilter}
              options={[
                { value: '', label: 'Todos' },
                { value: 'open', label: 'Aberto' },
                { value: 'paid', label: 'Pago' },
                { value: 'overdue', label: 'Vencido' },
                { value: 'canceled', label: 'Cancelado' },
              ]}
              onChange={(value) => {
                setInstallmentStatusFilter(value as '' | 'open' | 'paid' | 'canceled' | 'overdue')
                setInstallmentOffset(0)
              }}
            />
          </label>
          <label>
            De
            <DateInput
              value={installmentDueFrom}
              onChange={(event) => {
                setInstallmentDueFrom(event.target.value)
                setInstallmentOffset(0)
              }}
            />
          </label>
          <label>
            Até
            <DateInput
              value={installmentDueTo}
              onChange={(event) => {
                setInstallmentDueTo(event.target.value)
                setInstallmentOffset(0)
              }}
            />
          </label>
        </div>

        <div className="finance-table-wrapper">
          <table className="finance-table">
            <thead>
              <tr>
                <th>Vencimento</th>
                <th>Status</th>
                <th>Tipo</th>
                <th>Vínculo</th>
                <th>Descrição</th>
                <th>Valor</th>
                <th>Pago em</th>
                <th>Ação</th>
              </tr>
            </thead>
            <tbody>
              {installmentsPage.rows.map((installment) => (
                <tr
                  key={installment.id}
                  className={
                    paymentForm.installmentId === installment.id ? 'finance-row-highlight' : ''
                  }
                >
                  <td>{fmtDateFull(installment.dueDate)}</td>
                  <td>
                    <span className={`finance-status-badge ${installment.status}`}>
                      {financialStatusLabel(installment.status)}
                    </span>
                  </td>
                  <td>{titleTypeLabel(installment.titleType)}</td>
                  <td>{counterpartyLabel(installment)}</td>
                  <td>{installment.titleDescription || '—'}</td>
                  <td>{fmtCurrency(installment.amount)}</td>
                  <td>{fmtDateTime(installment.paidAt)}</td>
                  <td>
                    {installment.status === 'open' ? (
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => prefillPayment(installment)}
                      >
                        Usar no pagamento
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
              {installmentsPage.rows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="actions">
          <span className="hint">
            {pageInfoLabel(installmentOffset, installmentsPage.rows.length, installmentsPage.totalCount)}
          </span>
          <button
            type="button"
            className="ghost"
            disabled={installmentOffset === 0}
            onClick={() => setInstallmentOffset((state) => Math.max(0, state - PAGE_SIZE))}
          >
            Anterior
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!installmentsCanNext}
            onClick={() => setInstallmentOffset((state) => state + PAGE_SIZE)}
          >
            Próxima
          </button>
        </div>
      </div>

      <div className="card fiscal-card">
        <div className="finance-list-header">
        </div>

        <div className="finance-list-controls">
          <label>
            Buscar
            <input
              value={bankTxQuery}
              placeholder="Descrição, referência ou conta"
              onChange={(event) => {
                setBankTxQuery(event.target.value)
                setBankTxOffset(0)
              }}
            />
          </label>
          <label>
            Direção
            <Select
              value={bankTxDirectionFilter}
              options={[
                { value: '', label: 'Todas' },
                { value: 'in', label: 'Entrada' },
                { value: 'out', label: 'Saída' },
              ]}
              onChange={(value) => {
                setBankTxDirectionFilter(value as '' | 'in' | 'out')
                setBankTxOffset(0)
              }}
            />
          </label>
          <label>
            Status
            <Select
              value={bankTxStatusFilter}
              options={[
                { value: '', label: 'Todos' },
                { value: 'pending', label: 'Pendente' },
                { value: 'cleared', label: 'Compensada' },
                { value: 'reconciled', label: 'Conciliada' },
              ]}
              onChange={(value) => {
                setBankTxStatusFilter(value as '' | 'pending' | 'cleared' | 'reconciled')
                setBankTxOffset(0)
              }}
            />
          </label>
        </div>

        <div className="finance-table-wrapper">
          <table className="finance-table">
            <thead>
              <tr>
                <th>Ocorrida em</th>
                <th>Status</th>
                <th>Direção</th>
                <th>Conta</th>
                <th>Descrição</th>
                <th>Referência</th>
                <th>Valor</th>
              </tr>
            </thead>
            <tbody>
              {bankTransactionsPage.rows.map((transaction) => (
                <tr key={transaction.id}>
                  <td>{fmtDateTime(transaction.occurredAt)}</td>
                  <td>
                    <span className={`finance-status-badge ${transaction.status}`}>
                      {bankStatusLabel(transaction.status)}
                    </span>
                  </td>
                  <td>{directionLabel(transaction.direction)}</td>
                  <td>{transaction.accountName || 'Sem conta'}</td>
                  <td>{transaction.description || '—'}</td>
                  <td>{transaction.externalRef || '—'}</td>
                  <td>{fmtCurrency(transaction.amount)}</td>
                </tr>
              ))}
              {bankTransactionsPage.rows.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="actions">
          <span className="hint">
            {pageInfoLabel(bankTxOffset, bankTransactionsPage.rows.length, bankTransactionsPage.totalCount)}
          </span>
          <button
            type="button"
            className="ghost"
            disabled={bankTxOffset === 0}
            onClick={() => setBankTxOffset((state) => Math.max(0, state - PAGE_SIZE))}
          >
            Anterior
          </button>
          <button
            type="button"
            className="ghost"
            disabled={!bankTxCanNext}
            onClick={() => setBankTxOffset((state) => state + PAGE_SIZE)}
          >
            Próxima
          </button>
        </div>
      </div>
      </TabPanel>
    </div>
  )
}
