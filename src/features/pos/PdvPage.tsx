import { useCallback, useEffect, useRef, useState } from 'react'
import { useAnimatedPresence } from '../../hooks/useAnimatedPresence'
import { Select, ConfirmDialog, Modal, PageHeader } from '../../components/ui'
import {
  openPosSession,
  createPosSale,
  cancelPosSale,
  fetchCurrentPosSession,
  fetchPosSessionSales,
  fetchPosSessionSummary,
  fetchPosSessionReport,
  closeSessionWithReport,
  posSessionSangria,
  posSessionReforco,
  type PosSession,
  type PosSessionSale,
  type PosSessionSummary,
  type PosSessionReport,
} from '../../services/pos'
import { searchProducts, searchCustomersPaged } from '../../services/core'
import { escapeHtml, printHtmlDocument } from '../../services/printing'
import { useStatusToast } from '../../hooks/useStatusToast'
import { fmtCurrency, fmtTime } from '../../lib/formatters'

type CartItem = {
  productId: string
  name: string
  price: number
  quantity: number
  discountValue: number
  discountMode: 'percent' | 'value'
}

type PaymentLine = {
  method: string
  amount: string
}

const PAYMENT_METHODS = [
  { value: 'cash', label: 'Dinheiro' },
  { value: 'pix', label: 'PIX' },
  { value: 'card', label: 'Cartão' },
  { value: 'boleto', label: 'Boleto' },
]

const METHOD_LABELS: Record<string, string> = { cash: 'Dinheiro', pix: 'PIX', card: 'Cartão', boleto: 'Boleto', other: 'Outro' }

const BARCODE_MIN_LENGTH = 8
const BARCODE_MAX_INTERVAL_MS = 80

function computeItemTotal(item: CartItem) {
  const disc = item.discountMode === 'percent'
    ? (item.price * Math.max(0, item.discountValue)) / 100
    : Math.max(0, item.discountValue)
  return Math.max(item.price - disc, 0) * item.quantity
}

export function PdvPage() {
  const [session, setSession] = useState<PosSession | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [status, setStatus] = useState('')
  useStatusToast(status)

  const [cart, setCart] = useState<CartItem[]>([])
  const [globalDiscount, setGlobalDiscount] = useState('')
  const [payments, setPayments] = useState<PaymentLine[]>([{ method: 'cash', amount: '' }])
  const [saleLoading, setSaleLoading] = useState(false)

  const [showSangriaModal, setShowSangriaModal] = useState(false)
  const [sangriaAmount, setSangriaAmount] = useState('')
  const [sangriaType, setSangriaType] = useState<'sangria' | 'reforco'>('sangria')
  const [sangriaNote, setSangriaNote] = useState('')

  const [showFechamento, setShowFechamento] = useState(false)
  const [closingAmount, setClosingAmount] = useState('')
  const [sessionReport, setSessionReport] = useState<PosSessionReport | null>(null)
  const [openingAmount, setOpeningAmount] = useState('')

  const [productQuery, setProductQuery] = useState('')
  const [productResults, setProductResults] = useState<Array<{ id: string; name: string; price: number; stock_available: number }>>([])
  const [productSearchOpen, setProductSearchOpen] = useState(false)
  const { mounted: pdvDropMounted, exiting: pdvDropExiting } = useAnimatedPresence(productSearchOpen && productResults.length > 0, 180)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const [sessionSales, setSessionSales] = useState<PosSessionSale[]>([])
  const [sessionSummary, setSessionSummary] = useState<PosSessionSummary | null>(null)

  const [customerCpf, setCustomerCpf] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [customerQuery, setCustomerQuery] = useState('')
  const [customerResults, setCustomerResults] = useState<Array<{ id: string; name: string }>>([])
  const { mounted: custDropMounted, exiting: custDropExiting } = useAnimatedPresence(customerResults.length > 0, 180)
  const [showCustomerLookup, setShowCustomerLookup] = useState(false)
  const customerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [confirmCancelSaleId, setConfirmCancelSaleId] = useState<string | null>(null)
  const [cancellingId, setCancellingId] = useState<string | null>(null)
  const [confirmFechamento, setConfirmFechamento] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)

  const barcodeBufferRef = useRef('')
  const barcodeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const loadSession = useCallback(async () => {
    setSessionLoading(true)
    try {
      const s = await fetchCurrentPosSession()
      setSession(s)
      if (s) {
        const [sales, summary] = await Promise.all([
          fetchPosSessionSales(s.sessionId),
          fetchPosSessionSummary(s.sessionId),
        ])
        setSessionSales(sales)
        setSessionSummary(summary)
      }
    } catch {
      setSession(null)
    } finally {
      setSessionLoading(false)
    }
  }, [])

  useEffect(() => { void loadSession() }, [loadSession])

  useEffect(() => {
    if (!productQuery.trim()) {
      setProductResults([])
      setProductSearchOpen(false)
      return
    }
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await searchProducts(productQuery, '', undefined, { limit: 8 })
        setProductResults(results.map((r) => ({
          id: r.id,
          name: r.name,
          price: Number(r.price),
          stock_available: Number(r.stock_available),
        })))
        setProductSearchOpen(true)
      } catch {
        setProductResults([])
      }
    }, 250)
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [productQuery])

  useEffect(() => {
    const q = customerQuery.trim()
    if (q.length < 2) { setCustomerResults([]); return }
    if (customerTimerRef.current) clearTimeout(customerTimerRef.current)
    customerTimerRef.current = setTimeout(async () => {
      try {
        const rows = await searchCustomersPaged(q, { limit: 5 })
        setCustomerResults(rows.map((r) => ({ id: r.id, name: r.name })))
      } catch { setCustomerResults([]) }
    }, 200)
    return () => { if (customerTimerRef.current) clearTimeout(customerTimerRef.current) }
  }, [customerQuery])

  const discountPct = Math.min(100, Math.max(0, Number(globalDiscount) || 0))
  const cartSubtotal = cart.reduce((sum, item) => sum + computeItemTotal(item), 0)
  const discountAmount = cartSubtotal * discountPct / 100
  const cartTotal = cartSubtotal - discountAmount
  const paymentsTotal = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
  const remaining = cartTotal - paymentsTotal

  const addToCart = useCallback((product: { id: string; name: string; price: number }) => {
    setCart((prev) => {
      const existing = prev.find((item) => item.productId === product.id)
      if (existing) {
        return prev.map((item) =>
          item.productId === product.id ? { ...item, quantity: item.quantity + 1 } : item,
        )
      }
      return [...prev, { productId: product.id, name: product.name, price: product.price, quantity: 1, discountValue: 0, discountMode: 'value' as const }]
    })
    setProductQuery('')
    setProductSearchOpen(false)
    searchInputRef.current?.focus()
  }, [])

  const handleBarcodeInput = useCallback(async (barcode: string) => {
    if (!barcode || barcode.length < BARCODE_MIN_LENGTH) return
    try {
      const results = await searchProducts(barcode, '', undefined, { limit: 1 })
      if (results.length > 0) {
        addToCart({ id: results[0].id, name: results[0].name, price: Number(results[0].price) })
        setStatus(`${results[0].name} adicionado.`)
      } else {
        setStatus('Produto não encontrado para este código.')
      }
    } catch {
      setStatus('Erro ao buscar produto por código de barras.')
    }
  }, [addToCart])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F1') { e.preventDefault(); searchInputRef.current?.focus() }
      if (e.key === 'F2') { e.preventDefault(); setShowCustomerLookup((s) => !s) }
      if (e.key === 'F9') { e.preventDefault(); if (cart.length > 0 && remaining <= 0.005 && !saleLoading) void handleFinalizeSale() }
      if (e.key === 'F12') { e.preventDefault(); if (session) void handleOpenFechamento() }
      if (e.key === '?' && !e.ctrlKey && !(e.target instanceof HTMLInputElement) && !(e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault(); setShowShortcuts((s) => !s)
      }
      if (e.key === 'Escape') {
        setShowShortcuts(false)
        setShowCustomerLookup(false)
        setProductSearchOpen(false)
      }

      if (e.target instanceof HTMLInputElement && e.target === searchInputRef.current) {
        if (/^[0-9]$/.test(e.key)) {
          barcodeBufferRef.current += e.key
          if (barcodeTimerRef.current) clearTimeout(barcodeTimerRef.current)
          barcodeTimerRef.current = setTimeout(() => {
            const buffer = barcodeBufferRef.current
            barcodeBufferRef.current = ''
            if (buffer.length >= BARCODE_MIN_LENGTH && /^\d+$/.test(buffer)) {
              setProductQuery('')
              void handleBarcodeInput(buffer)
            }
          }, BARCODE_MAX_INTERVAL_MS)
        } else if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Alt') {
          barcodeBufferRef.current = ''
          if (barcodeTimerRef.current) clearTimeout(barcodeTimerRef.current)
        }
        if (e.key === 'Enter' && productQuery.trim() && /^\d{8,}$/.test(productQuery.trim())) {
          e.preventDefault()
          void handleBarcodeInput(productQuery.trim())
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  })

  const updateCartQty = (productId: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((item) =>
          item.productId === productId ? { ...item, quantity: Math.max(0, item.quantity + delta) } : item,
        )
        .filter((item) => item.quantity > 0),
    )
  }

  const updateCartDiscount = (productId: string, field: 'discountValue' | 'discountMode', value: number | string) => {
    setCart((prev) =>
      prev.map((item) =>
        item.productId === productId ? { ...item, [field]: value } : item,
      ),
    )
  }

  const removeFromCart = (productId: string) => {
    setCart((prev) => prev.filter((item) => item.productId !== productId))
  }

  const handleOpenSession = async () => {
    setStatus('')
    try {
      const result = await openPosSession({ openingAmount: Number(openingAmount) || 0 })
      setSession({ sessionId: result.sessionId, cashierId: null, openedAt: new Date().toISOString() })
      setSessionSales([])
      setSessionSummary({ salesCount: 0, totalRevenue: 0 })
      setOpeningAmount('')
      setStatus('Caixa aberto.')
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Erro ao abrir caixa.')
    }
  }

  const handleOpenFechamento = async () => {
    if (!session) return
    try {
      const report = await fetchPosSessionReport(session.sessionId)
      setSessionReport(report)
      setShowFechamento(true)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Erro ao carregar relatório.')
    }
  }

  const handleConfirmFechamento = async () => {
    if (!session) return
    try {
      await closeSessionWithReport(session.sessionId, Number(closingAmount) || undefined)
      setSession(null)
      setCart([])
      setPayments([{ method: 'cash', amount: '' }])
      setShowFechamento(false)
      setSessionReport(null)
      setClosingAmount('')
      setStatus('Caixa fechado.')
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Erro ao fechar caixa.')
    }
  }

  const handleSangriaReforco = async () => {
    if (!session || !sangriaAmount) return
    try {
      const amount = Number(sangriaAmount)
      if (sangriaType === 'sangria') {
        await posSessionSangria(session.sessionId, amount, sangriaNote || undefined)
        setStatus(`Sangria de ${fmtCurrency(amount)} registrada.`)
      } else {
        await posSessionReforco(session.sessionId, amount, sangriaNote || undefined)
        setStatus(`Reforço de ${fmtCurrency(amount)} registrado.`)
      }
      setShowSangriaModal(false)
      setSangriaAmount('')
      setSangriaNote('')
      void loadSession()
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Erro.')
    }
  }

  const printReceipt = async (saleTotal: number, saleItems: CartItem[], salePayments: PaymentLine[], saleDiscount: number) => {
    const now = new Date()
    const itemsHtml = saleItems.map((item) => {
      const lineTotal = computeItemTotal(item)
      const discLabel = item.discountValue > 0
        ? ` <small>(desc ${item.discountMode === 'percent' ? `${item.discountValue}%` : fmtCurrency(item.discountValue)})</small>`
        : ''
      return `<tr><td>${escapeHtml(item.name)}${discLabel}</td><td style="text-align:center">${item.quantity}</td><td style="text-align:right">${fmtCurrency(lineTotal)}</td></tr>`
    }).join('')
    const paymentsHtml = salePayments.filter((p) => Number(p.amount) > 0).map((p) =>
      `<tr><td>${escapeHtml(METHOD_LABELS[p.method] ?? p.method)}</td><td style="text-align:right">${fmtCurrency(Number(p.amount))}</td></tr>`,
    ).join('')
    const bodyHtml = `
      <p style="text-align:center;margin-bottom:8px"><strong>CUPOM NÃO FISCAL</strong></p>
      <p>${now.toLocaleDateString('pt-BR')} ${now.toLocaleTimeString('pt-BR')}</p>
      ${customerName ? `<p>Cliente: ${escapeHtml(customerName)}</p>` : ''}
      ${customerCpf ? `<p>CPF: ${escapeHtml(customerCpf)}</p>` : ''}
      <hr/>
      <table class="print-table"><thead><tr><th>Item</th><th>Qtd</th><th>Total</th></tr></thead><tbody>${itemsHtml}</tbody></table>
      ${saleDiscount > 0 ? `<p style="margin-top:6px">Desconto: -${fmtCurrency(saleDiscount)}</p>` : ''}
      <p style="font-size:1.2em;margin-top:6px"><strong>TOTAL: ${fmtCurrency(saleTotal)}</strong></p>
      <hr/>
      <table style="width:100%"><tbody>${paymentsHtml}</tbody></table>
      <p style="text-align:center;margin-top:10px;font-size:0.85em">Obrigado pela preferência!</p>
    `
    try {
      await printHtmlDocument({ title: 'Cupom de Venda', preset: 'thermal_80mm', bodyHtml })
    } catch { /* silent fail for print */ }
  }

  const handleFinalizeSale = async () => {
    if (!session || cart.length === 0) return
    setSaleLoading(true)
    setStatus('')
    const saleCart = [...cart]
    const salePaymentsCopy = [...payments]
    const saleDiscountAmount = discountAmount
    try {
      const result = await createPosSale({
        posSessionId: session.sessionId,
        customerId: customerId || undefined,
        customerCpf: customerCpf.trim() || undefined,
        globalDiscountPct: discountPct > 0 ? discountPct : undefined,
        items: cart.map((item) => ({
          product_id: item.productId,
          quantity: item.quantity,
          unit_price: item.price,
          discount_value: item.discountValue > 0 ? item.discountValue : undefined,
          discount_mode: item.discountValue > 0 ? item.discountMode : undefined,
        })),
        payments: payments
          .filter((p) => Number(p.amount) > 0)
          .map((p) => ({ method: p.method, amount: Number(p.amount) })),
      })
      setStatus(`Venda registrada — ${fmtCurrency(result.totalAmount)}`)
      setCart([])
      setPayments([{ method: 'cash', amount: '' }])
      setGlobalDiscount('')
      setCustomerCpf('')
      setCustomerName('')
      setCustomerId('')
      void loadSession()
      void printReceipt(result.totalAmount, saleCart, salePaymentsCopy, saleDiscountAmount)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Erro ao registrar venda.')
    } finally {
      setSaleLoading(false)
    }
  }

  const handleCancelSale = async (saleId: string) => {
    setCancellingId(saleId)
    try {
      const result = await cancelPosSale(saleId)
      setStatus(`Venda cancelada — ${fmtCurrency(result.totalAmount)} estornado.`)
      void loadSession()
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Erro ao cancelar venda.')
    } finally {
      setCancellingId(null)
      setConfirmCancelSaleId(null)
    }
  }

  const addPaymentLine = () => {
    setPayments((prev) => [...prev, { method: 'pix', amount: '' }])
  }

  const removePaymentLine = (index: number) => {
    setPayments((prev) => prev.filter((_, i) => i !== index))
  }

  const autoFillLastPayment = () => {
    if (payments.length === 0 || cartTotal <= 0) return
    const otherTotal = payments.slice(0, -1).reduce((sum, p) => sum + (Number(p.amount) || 0), 0)
    const lastAmount = Math.max(0, cartTotal - otherTotal)
    setPayments((prev) =>
      prev.map((p, i) => (i === prev.length - 1 ? { ...p, amount: lastAmount.toFixed(2) } : p)),
    )
  }

  return (
    <div className="page">
      <PageHeader
       
        subtitle={session ? `Caixa ativo${sessionSummary ? ` — ${sessionSummary.salesCount} vendas · ${fmtCurrency(sessionSummary.totalRevenue)}` : ''}` : undefined}
        actions={session ? (
          <>
            <button type="button" className="ghost" onClick={() => { setSangriaType('sangria'); setShowSangriaModal(true) }}>Sangria</button>
            <button type="button" className="ghost" onClick={() => { setSangriaType('reforco'); setShowSangriaModal(true) }}>Reforço</button>
            <button type="button" className="ghost" onClick={handleOpenFechamento}>Fechar Caixa</button>
            <button type="button" className="ghost" onClick={() => setShowShortcuts(true)}>?</button>
          </>
        ) : undefined}
      />

      {!session && !sessionLoading && (
        <div className="card" style={{ maxWidth: 360 }}>
          <label>
            Fundo de caixa inicial (R$)
            <input type="number" step="0.01" min="0" value={openingAmount} placeholder="0,00" onChange={(e) => setOpeningAmount(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void handleOpenSession() }} />
          </label>
          <button type="button" onClick={handleOpenSession}>Abrir Caixa</button>
        </div>
      )}

      {session && (<>

      <Modal
        open={showSangriaModal}
        onClose={() => setShowSangriaModal(false)}
        title={sangriaType === 'sangria' ? 'Sangria de Caixa' : 'Reforço de Caixa'}
        size="sm"
      >
        <div style={{ display: 'grid', gap: 12 }}>
          
          <label>Valor (R$)<input type="number" step="0.01" min="0.01" value={sangriaAmount} autoFocus onChange={(e) => setSangriaAmount(e.target.value)} /></label>
          <label>Observação (opcional)<input value={sangriaNote} onChange={(e) => setSangriaNote(e.target.value)} /></label>
          <div className="actions">
            <button type="button" onClick={handleSangriaReforco} disabled={!sangriaAmount}>
              {sangriaType === 'sangria' ? 'Confirmar' : 'Confirmar'}
            </button>
            <button type="button" className="ghost" onClick={() => setShowSangriaModal(false)}>Cancelar</button>
          </div>
        </div>
      </Modal>

      <Modal
        open={showFechamento}
        onClose={() => setShowFechamento(false)}
       
        size="md"
      >
        {sessionReport && (
          <div style={{ display: 'grid', gap: 12 }}>
            <div className="pdv-payment-summary">
              <div className="pdv-payment-row"><span>Operações realizadas</span><strong>{sessionReport.salesCount}</strong></div>
              <div className="pdv-payment-row"><span>Faturamento bruto</span><strong>{fmtCurrency(sessionReport.totalRevenue)}</strong></div>
              {sessionReport.byMethod.map((m) => (
                <div key={m.method} className="pdv-payment-row" style={{ paddingLeft: 12 }}>
                  <span>{METHOD_LABELS[m.method] ?? m.method}</span>
                  <span>{fmtCurrency(m.total)} ({m.count} venda{m.count > 1 ? 's' : ''})</span>
                </div>
              ))}
            </div>
            <div className="pdv-payment-summary">
              <div className="pdv-payment-row"><span>Fundo de caixa (abertura)</span><span>{fmtCurrency(sessionReport.openingAmount)}</span></div>
              {sessionReport.movements.map((m) => (
                <div key={m.type} className="pdv-payment-row">
                  <span>{m.type === 'sangria' ? 'Sangrias' : m.type === 'reforco' ? 'Reforços' : 'Fundo'}</span>
                  <span>{m.type === 'sangria' ? '-' : '+'}{fmtCurrency(m.total)}</span>
                </div>
              ))}
              <div className="pdv-payment-row"><span><strong>Saldo projetado</strong></span><strong>{fmtCurrency(sessionReport.expectedCash)}</strong></div>
            </div>
            <label>
              Valor apurado na gaveta (R$)
              <input type="number" step="0.01" min="0" value={closingAmount} autoFocus placeholder={sessionReport.expectedCash.toFixed(2)} onChange={(e) => setClosingAmount(e.target.value)} />
            </label>
            {closingAmount && (
              <p className="subtitle" style={{ color: Math.abs(Number(closingAmount) - sessionReport.expectedCash) > 0.01 ? '#c44' : '#38a169' }}>
                {Number(closingAmount) > sessionReport.expectedCash ? `Sobra: ${fmtCurrency(Number(closingAmount) - sessionReport.expectedCash)}` :
                  Number(closingAmount) < sessionReport.expectedCash ? `Falta: ${fmtCurrency(sessionReport.expectedCash - Number(closingAmount))}` : 'Caixa conferido ✓'}
              </p>
            )}
            <div className="actions">
              <button type="button" onClick={handleConfirmFechamento}>Confirmar Fechamento</button>
              <button type="button" className="ghost" onClick={() => setShowFechamento(false)}>Cancelar</button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmCancelSaleId !== null}
        onClose={() => setConfirmCancelSaleId(null)}
        onConfirm={() => { if (confirmCancelSaleId) void handleCancelSale(confirmCancelSaleId) }}
       
        message="Estorna os valores e devolve itens ao estoque. Confirma?"
        confirmLabel="Confirmar estorno"
        variant="danger"
        loading={cancellingId !== null}
      />

      <ConfirmDialog
        open={confirmFechamento}
        onClose={() => setConfirmFechamento(false)}
        onConfirm={() => { setConfirmFechamento(false); void handleConfirmFechamento() }}
       
        message="Apurar os totais encerra o turno atual e bloqueia novas operações neste caixa. Continuar?"
        confirmLabel="Confirmar fechamento"
        variant="warning"
      />

      <Modal open={showShortcuts} onClose={() => setShowShortcuts(false)} size="sm">
        <div style={{ display: 'grid', gap: 6, fontSize: '0.88rem' }}>
          <div><strong>F1</strong> — Focar na busca de produto</div>
          <div><strong>F2</strong> — Identificar cliente (CPF/Nome)</div>
          <div><strong>F9</strong> — Finalizar venda</div>
          <div><strong>F12</strong> — Fechar caixa</div>
          <div><strong>?</strong> — Mostrar/ocultar atalhos</div>
          <div><strong>Esc</strong> — Fechar painel aberto</div>
          <div><strong>Leitor de código de barras</strong> — escanear produto automaticamente</div>
        </div>
      </Modal>

      <div className="pdv-split">
        <div className="pdv-main">
          <div className="pdv-search-wrapper">
            <input
              ref={searchInputRef}
              placeholder="Buscar produto (F1)"
              value={productQuery}
              onChange={(e) => setProductQuery(e.target.value)}
              onFocus={() => { if (productResults.length > 0) setProductSearchOpen(true) }}
              onBlur={() => setTimeout(() => setProductSearchOpen(false), 200)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && productResults.length > 0) {
                  e.preventDefault()
                  addToCart(productResults[0])
                }
              }}
            />
            {pdvDropMounted && (
              <div className={`pdv-search-dropdown ${pdvDropExiting ? 'dropdown-rubber-exit' : 'dropdown-rubber-enter'}`}>
                {productResults.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="pdv-search-result"
                    onMouseDown={() => addToCart(p)}
                  >
                    <span>{p.name}</span>
                    <span className="pdv-search-price">{fmtCurrency(p.price)}</span>
                    {p.stock_available <= 0 && <span style={{ color: '#c44', fontSize: '0.78rem' }}>Sem estoque</span>}
                  </button>
                ))}
              </div>
            )}
          </div>

          {showCustomerLookup && (
            <div className="card" style={{ padding: '10px 14px', marginBottom: 8 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ flex: 1, minWidth: 140 }}>
                  CPF do cliente
                  <input value={customerCpf} onChange={(e) => setCustomerCpf(e.target.value)} placeholder="000.000.000-00" />
                </label>
                <label style={{ flex: 2, minWidth: 180 }}>
                  Nome do cliente
                  <input value={customerQuery} onChange={(e) => { setCustomerQuery(e.target.value); setCustomerName(e.target.value) }} placeholder="Buscar cliente..." />
                  {custDropMounted && (
                    <div className={custDropExiting ? 'dropdown-rubber-exit' : 'dropdown-rubber-enter'} style={{ border: '1px solid var(--border)', borderRadius: 6, marginTop: 2, maxHeight: 120 }}>
                      {customerResults.map((c) => (
                        <button key={c.id} type="button" className="pdv-search-result" style={{ width: '100%' }} onMouseDown={() => {
                          setCustomerId(c.id); setCustomerName(c.name); setCustomerQuery(c.name); setCustomerResults([])
                        }}>
                          <span>{c.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </label>
                <button type="button" className="ghost" onClick={() => setShowCustomerLookup(false)} style={{ alignSelf: 'flex-end', fontSize: '0.82rem' }}>Fechar (F2)</button>
              </div>
              {customerName && <p className="subtitle" style={{ marginTop: 4 }}>Cliente: {customerName}{customerCpf ? ` — CPF: ${customerCpf}` : ''}</p>}
            </div>
          )}

          {cart.length === 0 && null}

          <div className="pdv-cart">
            {cart.map((item) => (
              <div key={item.productId} className="pdv-cart-item">
                <div className="pdv-cart-info">
                  <span className="pdv-cart-name">{item.name}</span>
                  <span className="pdv-cart-price">{fmtCurrency(item.price)} un.</span>
                </div>
                <div className="pdv-cart-controls">
                  <button type="button" className="pdv-qty-btn" onClick={() => updateCartQty(item.productId, -1)}>-</button>
                  <span className="pdv-qty">{item.quantity}</span>
                  <button type="button" className="pdv-qty-btn" onClick={() => updateCartQty(item.productId, 1)}>+</button>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <select value={item.discountMode} onChange={(e) => updateCartDiscount(item.productId, 'discountMode', e.target.value)} style={{ width: 52, padding: '4px 2px', fontSize: '0.78rem' }}>
                      <option value="value">R$</option>
                      <option value="percent">%</option>
                    </select>
                    <input type="number" min="0" step="0.01" value={item.discountValue || ''} placeholder="0" onChange={(e) => updateCartDiscount(item.productId, 'discountValue', Math.max(0, Number(e.target.value) || 0))} style={{ width: 60, padding: '4px 6px', fontSize: '0.82rem' }} />
                  </div>
                  <span className="pdv-cart-subtotal">{fmtCurrency(computeItemTotal(item))}</span>
                  <button type="button" className="pdv-remove-btn" onClick={() => removeFromCart(item.productId)}>x</button>
                </div>
              </div>
            ))}
          </div>

          {cart.length > 0 && (
            <div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0' }}>
                <span className="cadastro-row-meta">Desconto global (%):</span>
                <input type="number" min="0" max="100" step="1" value={globalDiscount} placeholder="0" onChange={(e) => setGlobalDiscount(e.target.value)} style={{ width: 70 }} />
              </div>
              <div className="pdv-total-line">
                <strong>Total</strong>
                <strong>{fmtCurrency(cartTotal)}</strong>
              </div>
            </div>
          )}
        </div>

        <div className="pdv-sidebar-panel">
          {cart.length > 0 && (
            <>
              <h3>Pagamento</h3>
              <div className="pdv-payments">
                {payments.map((p, idx) => (
                  <div key={idx} className="pdv-payment-line">
                    <Select
                      value={p.method}
                      options={PAYMENT_METHODS}
                      onChange={(v) =>
                        setPayments((prev) => prev.map((item, i) => (i === idx ? { ...item, method: v } : item)))
                      }
                    />
                    <label style={{ flex: 1, minWidth: 0, margin: 0 }}>
                      <span className="visually-hidden">Valor (R$)</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="Valor (R$)"
                        value={p.amount}
                        onChange={(e) =>
                          setPayments((prev) => prev.map((item, i) => (i === idx ? { ...item, amount: e.target.value } : item)))
                        }
                      />
                    </label>
                    {payments.length > 1 && (
                      <button type="button" className="pdv-remove-btn" onClick={() => removePaymentLine(idx)}>x</button>
                    )}
                  </div>
                ))}
              </div>
              <div className="actions">
                <button type="button" className="ghost" onClick={addPaymentLine} style={{ fontSize: '0.82rem', padding: '6px 12px' }}>
                  + Forma de pagamento
                </button>
                <button type="button" className="ghost" onClick={autoFillLastPayment} style={{ fontSize: '0.82rem', padding: '6px 12px' }}>
                  Preencher total
                </button>
              </div>

              <div className="pdv-payment-summary">
                <div className="pdv-payment-row">
                  <span>Total</span>
                  <span>{fmtCurrency(cartTotal)}</span>
                </div>
                <div className="pdv-payment-row">
                  <span>Pago</span>
                  <span>{fmtCurrency(paymentsTotal)}</span>
                </div>
                {remaining > 0.005 && (
                  <div className="pdv-payment-row" style={{ color: '#a33' }}>
                    <span>Falta</span>
                    <span>{fmtCurrency(remaining)}</span>
                  </div>
                )}
                {remaining < -0.005 && (
                  <div className="pdv-payment-row">
                    <span>Troco</span>
                    <span>{fmtCurrency(-remaining)}</span>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={handleFinalizeSale}
                disabled={saleLoading || remaining > 0.005}
                style={{ width: '100%', marginTop: 8 }}
              >
                {saleLoading ? 'Registrando...' : 'Finalizar Venda (F9)'}
              </button>
            </>
          )}

          {(
            <div className="pdv-recent">
              <h3>Vendas da sessão</h3>
              {sessionSales.slice(0, 12).map((s) => (
                <div key={s.posSaleId} className="pdv-recent-row">
                  <span>{fmtTime(s.createdAt)}</span>
                  <span>{s.customerName || 'Consumidor'}</span>
                  <span>{fmtCurrency(s.totalAmount)}</span>
                  <button
                    type="button"
                    className="pdv-remove-btn"
                   
                    disabled={cancellingId === s.posSaleId}
                    onClick={() => setConfirmCancelSaleId(s.posSaleId)}
                    style={{ fontSize: '0.72rem', padding: '2px 6px' }}
                  >
                    {cancellingId === s.posSaleId ? '...' : 'Cancelar'}
                  </button>
                </div>
              ))}
            </div>
          )}

        </div>
      </div>
      </>)}
    </div>
  )
}
