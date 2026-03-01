import { useState } from 'react'
import { NumericInput } from './ui'
import { createCustomer, createSupplier, createProduct, createWarehouse } from '../services/core'

export type QuickCreateType = 'customer' | 'supplier' | 'product' | 'warehouse'

type QuickCreateModalProps = {
  type: QuickCreateType
  onCreated: (entity: { id: string; name: string }) => void
  onClose: () => void
  initialName?: string
}

const LABELS: Record<QuickCreateType, { title: string; namePlaceholder: string }> = {
  customer: { title: 'Novo Cliente', namePlaceholder: 'Nome do cliente' },
  supplier: { title: 'Novo Fornecedor', namePlaceholder: 'Nome do fornecedor' },
  product: { title: 'Novo Produto', namePlaceholder: 'Nome do produto' },
  warehouse: { title: 'Novo Depósito', namePlaceholder: 'Nome do depósito' },
}

export function QuickCreateModal({ type, onCreated, onClose, initialName = '' }: QuickCreateModalProps) {
  const [name, setName] = useState(initialName)
  const [phone, setPhone] = useState('')
  const [price, setPrice] = useState('')
  const [sku, setSku] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const labels = LABELS[type]

  const handleSubmit = async () => {
    if (!name.trim()) return
    setSubmitting(true)
    setError('')
    try {
      let result: { id: string }
      if (type === 'customer') {
        result = await createCustomer({ personType: 'natural', name: name.trim(), phone: phone.trim() || undefined })
      } else if (type === 'supplier') {
        result = await createSupplier({ personType: 'legal', name: name.trim(), phone: phone.trim() || undefined })
      } else if (type === 'product') {
        result = await createProduct({ name: name.trim(), price: Number(price) || 0, sku: sku.trim() || undefined })
      } else {
        result = await createWarehouse({ name: name.trim() })
      }
      onCreated({ id: result.id, name: name.trim() })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao criar registro.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="qc-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="qc-card">
        <div className="qc-header">
          <h3>{labels.title}</h3>
          <button type="button" className="ghost" onClick={onClose} aria-label="Fechar">✕</button>
        </div>
        <div className="qc-body">
          <label>
            Nome
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={labels.namePlaceholder}
              onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void handleSubmit() }}
            />
          </label>
          {(type === 'customer' || type === 'supplier') && (
            <label>
              Telefone (opcional)
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(00) 00000-0000" />
            </label>
          )}
          {type === 'product' && (
            <>
              <label>
                Preço de venda
                <NumericInput value={price} onChange={(e) => setPrice(e.target.value)} />
              </label>
              <label>
                SKU (opcional)
                <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="Código do produto" />
              </label>
            </>
          )}
          {error && <p className="subtitle" style={{ color: '#c44' }}>{error}</p>}
        </div>
        <div className="qc-footer">
          <button type="button" className="ghost" onClick={onClose}>Cancelar</button>
          <button type="button" disabled={!name.trim() || submitting} onClick={() => void handleSubmit()}>
            {submitting ? 'Salvando...' : 'Criar e selecionar'}
          </button>
        </div>
      </div>
    </div>
  )
}
