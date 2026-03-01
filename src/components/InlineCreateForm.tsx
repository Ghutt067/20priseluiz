import { useState } from 'react'
import { NumericInput } from './ui'
import {
  createCustomer,
  createSupplier,
  createProduct,
  createWarehouse,
  createCategory,
  createCarrier,
} from '../services/core'
import {
  validateCpfCnpj,
  validateEmail,
  validatePhone,
  formatCpfCnpj,
  formatPhone,
} from '../lib/validation'

export type InlineCreateType = 'customer' | 'supplier' | 'product' | 'warehouse' | 'category' | 'carrier'

type InlineCreateFormProps = {
  type: InlineCreateType
  initialName?: string
  onCreated: (entity: { id: string; name: string }) => void
  onCancel: () => void
}

const TITLES: Record<InlineCreateType, string> = {
  customer: 'Novo Cliente',
  supplier: 'Novo Fornecedor',
  product: 'Novo Produto',
  warehouse: 'Novo Depósito',
  category: 'Nova Categoria',
  carrier: 'Nova Transportadora',
}

export function InlineCreateForm({ type, initialName = '', onCreated, onCancel }: InlineCreateFormProps) {
  const [name, setName] = useState(initialName)
  const [legalName, setLegalName] = useState('')
  const [cpfCnpj, setCpfCnpj] = useState('')
  const [ie, setIe] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [sku, setSku] = useState('')
  const [ncm, setNcm] = useState('')
  const [uom, setUom] = useState('UN')
  const [price, setPrice] = useState('')
  const [cost, setCost] = useState('')
  const [description, setDescription] = useState('')
  const [cnpj, setCnpj] = useState('')
  const [modal, setModal] = useState('')
  const [avgDays, setAvgDays] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})

  const handleSubmit = async () => {
    if (!name.trim()) return
    const errs: Record<string, string> = {}

    if (type === 'customer' || type === 'supplier') {
      const cpfErr = validateCpfCnpj(cpfCnpj)
      if (cpfErr) errs.cpfCnpj = cpfErr
      const emailErr = validateEmail(email)
      if (emailErr) errs.email = emailErr
      const phoneErr = validatePhone(phone)
      if (phoneErr) errs.phone = phoneErr
    }

    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs)
      return
    }
    setFieldErrors({})
    setSubmitting(true)
    setError('')

    try {
      let result: { id: string }
      if (type === 'customer') {
        result = await createCustomer({
          personType: 'legal',
          name: name.trim(),
          legalName: legalName.trim() || undefined,
          cpfCnpj: cpfCnpj.trim() || undefined,
          ie: ie.trim() || undefined,
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
        })
      } else if (type === 'supplier') {
        result = await createSupplier({
          personType: 'legal',
          name: name.trim(),
          legalName: legalName.trim() || undefined,
          cpfCnpj: cpfCnpj.trim() || undefined,
          ie: ie.trim() || undefined,
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
        })
      } else if (type === 'product') {
        result = await createProduct({
          name: name.trim(),
          sku: sku.trim() || undefined,
          description: description.trim() || undefined,
          ncm: ncm.trim() || undefined,
          uom: uom.trim() || undefined,
          price: Number(price) || 0,
          cost: Number(cost) || 0,
        })
      } else if (type === 'warehouse') {
        result = await createWarehouse({ name: name.trim() })
      } else if (type === 'category') {
        result = await createCategory({ name: name.trim() })
      } else {
        result = await createCarrier({
          name: name.trim(),
          cnpj: cnpj.trim() || undefined,
          modal: modal.trim() || undefined,
          avgDays: Number(avgDays) || undefined,
        })
      }
      onCreated({ id: result.id, name: name.trim() })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Erro ao criar registro.')
    } finally {
      setSubmitting(false)
    }
  }

  const isPerson = type === 'customer' || type === 'supplier'

  return (
    <div className="inline-create-form">
      <div className="inline-create-header">
        <strong>{TITLES[type]}</strong>
      </div>
      <div className="inline-create-body">
        <label>
          Nome *
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) void handleSubmit() }} />
        </label>

        {isPerson && (
          <>
            <label>
              CPF/CNPJ
              <input value={cpfCnpj} onChange={(e) => setCpfCnpj(formatCpfCnpj(e.target.value))} />
              {fieldErrors.cpfCnpj && <span className="v-field-msg v-field-msg-error">{fieldErrors.cpfCnpj}</span>}
            </label>
            <label>
              E-mail
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              {fieldErrors.email && <span className="v-field-msg v-field-msg-error">{fieldErrors.email}</span>}
            </label>
            <label>
              Telefone
              <input value={phone} onChange={(e) => setPhone(formatPhone(e.target.value))} />
              {fieldErrors.phone && <span className="v-field-msg v-field-msg-error">{fieldErrors.phone}</span>}
            </label>
          </>
        )}

        {type === 'product' && (
          <>
            <label>
              SKU
              <input value={sku} onChange={(e) => setSku(e.target.value)} />
            </label>
            <label>
              NCM
              <input value={ncm} onChange={(e) => setNcm(e.target.value)} />
            </label>
            <label>
              Unidade
              <input value={uom} onChange={(e) => setUom(e.target.value)} />
            </label>
            <label>
              Preço de venda
              <NumericInput value={price} onChange={(e) => setPrice(e.target.value)} />
            </label>
            <label>
              Custo
              <NumericInput value={cost} onChange={(e) => setCost(e.target.value)} />
            </label>
            <label>
              Descrição
              <input value={description} onChange={(e) => setDescription(e.target.value)} />
            </label>
          </>
        )}

        {type === 'carrier' && (
          <>
            <label>
              CNPJ
              <input value={cnpj} onChange={(e) => setCnpj(e.target.value)} />
            </label>
            <label>
              Modal
              <input value={modal} onChange={(e) => setModal(e.target.value)} placeholder="Rodoviário, Aéreo..." />
            </label>
            <label>
              Prazo médio (dias)
              <input type="number" min="0" value={avgDays} onChange={(e) => setAvgDays(e.target.value)} />
            </label>
          </>
        )}

        {error && <p className="inline-create-error">{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={onCancel}>Cancelar</button>
        <button type="button" disabled={!name.trim() || submitting} onClick={() => void handleSubmit()}>
          {submitting ? 'Salvando...' : 'Adicionar'}
        </button>
      </div>
    </div>
  )
}
