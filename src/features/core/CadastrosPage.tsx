import { useCallback, useEffect, useState } from 'react'
import {
  createCustomer,
  createSupplier,
  createProduct,
  createWarehouse,
  updateCustomer,
  updateSupplier,
  updateProduct,
  updateWarehouse,
  deactivateCustomer,
  deactivateSupplier,
  deactivateProduct,
  fetchCategories,
  fetchCarriers,
  createCategory,
  createCarrier,
  toggleCarrier,
  type CustomerLookup,
  type SupplierLookup,
  type ProductLookup,
  type WarehouseLookup,
  type CategoryLookup,
  type CarrierLookup,
} from '../../services/core'
import { getJsonWithHeaders } from '../../services/http'
import { Tabs, DataTable, Pagination, Modal, StatusBadge, EmptyState, useToast, PageHeader, type Column } from '../../components/ui'
import { useAuth } from '../../contexts/useAuth'
import { can } from '../../lib/permissions'
import { validateCpfCnpj, validateEmail, validatePhone, formatCpfCnpj, formatPhone, type FieldErrors } from '../../lib/validation'
import { fmtDate, fmtCurrency } from '../../lib/formatters'

const PAGE_SIZE = 20

type EntityTab = 'clientes' | 'fornecedores' | 'produtos' | 'depositos' | 'categorias' | 'transportadoras'

type PagedResult<T> = { rows: T[]; totalCount: number }

async function fetchPaged<T>(path: string, query: string, offset: number, limit: number): Promise<PagedResult<T>> {
  const params = new URLSearchParams()
  if (query.trim()) params.set('query', query.trim())
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  const url = `${path}?${params.toString()}`
  const { data, headers } = await getJsonWithHeaders<T[]>(url)
  const raw = headers.get('x-total-count')
  const totalCount = raw ? Math.max(Number.parseInt(raw, 10) || 0, 0) : data.length
  return { rows: data, totalCount }
}

export function CadastrosPage() {
  const { toast } = useToast()
  const { role } = useAuth()
  const userRole = role ?? 'vendedor'
  const [tab, setTab] = useState<EntityTab>('clientes')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)

  // Customers
  const [customers, setCustomers] = useState<CustomerLookup[]>([])
  const [customersTotal, setCustomersTotal] = useState(0)

  // Suppliers
  const [suppliers, setSuppliers] = useState<SupplierLookup[]>([])
  const [suppliersTotal, setSuppliersTotal] = useState(0)

  // Products
  const [products, setProducts] = useState<ProductLookup[]>([])
  const [productsTotal, setProductsTotal] = useState(0)

  // Warehouses
  const [warehouses, setWarehouses] = useState<WarehouseLookup[]>([])
  const [warehousesTotal, setWarehousesTotal] = useState(0)

  // Categories & Carriers
  const [categories, setCategories] = useState<CategoryLookup[]>([])
  const [carriers, setCarriers] = useState<CarrierLookup[]>([])

  // Modal state
  const [modalOpen, setModalOpen] = useState(false)
  const [editEntity, setEditEntity] = useState<Record<string, string | number | boolean | null>>({})
  const [isEditing, setIsEditing] = useState(false)
  const [saving, setSaving] = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      if (tab === 'clientes') {
        const r = await fetchPaged<CustomerLookup>('/customers', query, offset, PAGE_SIZE)
        setCustomers(r.rows)
        setCustomersTotal(r.totalCount)
      } else if (tab === 'fornecedores') {
        const r = await fetchPaged<SupplierLookup>('/suppliers', query, offset, PAGE_SIZE)
        setSuppliers(r.rows)
        setSuppliersTotal(r.totalCount)
      } else if (tab === 'produtos') {
        const r = await fetchPaged<ProductLookup>('/products', query, offset, PAGE_SIZE)
        setProducts(r.rows)
        setProductsTotal(r.totalCount)
      } else if (tab === 'depositos') {
        const r = await fetchPaged<WarehouseLookup>('/warehouses', query, offset, PAGE_SIZE)
        setWarehouses(r.rows)
        setWarehousesTotal(r.totalCount)
      } else if (tab === 'categorias') {
        setCategories(await fetchCategories())
      } else if (tab === 'transportadoras') {
        setCarriers(await fetchCarriers())
      }
    } catch (e) { toast(e instanceof Error ? e.message : 'Erro ao carregar.', 'error') }
    setLoading(false)
  }, [tab, query, offset])

  useEffect(() => { void loadData() }, [loadData])

  const switchTab = (t: EntityTab) => {
    setTab(t)
    setQuery('')
    setOffset(0)
  }

  const canCreate = (
    (tab === 'clientes' && can(userRole, 'cadastro.customer.create'))
    || (tab === 'fornecedores' && can(userRole, 'cadastro.supplier.create'))
    || (tab === 'produtos' && can(userRole, 'cadastro.product.create'))
    || (tab === 'depositos' && can(userRole, 'cadastro.warehouse.create'))
    || tab === 'categorias'
    || tab === 'transportadoras'
  )

  const openCreate = () => {
    setIsEditing(false)
    setFieldErrors({})
    if (tab === 'clientes' || tab === 'fornecedores') {
      setEditEntity({ personType: 'legal', name: '', legalName: '', cpfCnpj: '', ie: '', email: '', phone: '' })
    } else if (tab === 'produtos') {
      setEditEntity({ name: '', sku: '', description: '', productType: 'product', ncm: '', uom: 'UN', price: 0, cost: 0 })
    } else if (tab === 'depositos') {
      setEditEntity({ name: '' })
    } else if (tab === 'categorias') {
      setEditEntity({ name: '' })
    } else if (tab === 'transportadoras') {
      setEditEntity({ name: '', cnpj: '', modal: '', avgDays: 0 })
    }
    setModalOpen(true)
  }

  const openEdit = (entity: Record<string, unknown>) => {
    setIsEditing(true)
    const flat: Record<string, string | number | boolean | null> = {}
    for (const [k, v] of Object.entries(entity)) {
      if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        flat[k] = v
      }
    }
    setEditEntity(flat)
    setModalOpen(true)
  }

  const handleSave = async () => {
    const e = editEntity
    const errs: FieldErrors = {}

    if (!String(e.name ?? '').trim()) errs.name = 'Nome é obrigatório.'

    if (tab === 'clientes' || tab === 'fornecedores') {
      const cpfErr = validateCpfCnpj(String(e.cpfCnpj ?? e.cpf_cnpj ?? ''))
      if (cpfErr) errs.cpfCnpj = cpfErr
      const emailErr = validateEmail(String(e.email ?? ''))
      if (emailErr) errs.email = emailErr
      const phoneErr = validatePhone(String(e.phone ?? ''))
      if (phoneErr) errs.phone = phoneErr
    }

    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs)
      return
    }
    setFieldErrors({})
    setSaving(true)
    try {
      if (tab === 'clientes') {
        const payload = {
          personType: (e.personType as 'legal' | 'natural') || 'legal',
          name: String(e.name || ''),
          legalName: String(e.legalName || '') || undefined,
          cpfCnpj: String(e.cpfCnpj || e.cpf_cnpj || '') || undefined,
          ie: String(e.ie || '') || undefined,
          email: String(e.email || '') || undefined,
          phone: String(e.phone || '') || undefined,
        }
        if (isEditing && e.id) {
          await updateCustomer(String(e.id), payload)
          toast('Cliente atualizado.', 'success')
        } else {
          await createCustomer(payload)
          toast('Cliente criado.', 'success')
        }
      } else if (tab === 'fornecedores') {
        const payload = {
          personType: (e.personType as 'legal' | 'natural') || 'legal',
          name: String(e.name || ''),
          legalName: String(e.legalName || e.legal_name || '') || undefined,
          cpfCnpj: String(e.cpfCnpj || e.cpf_cnpj || '') || undefined,
          ie: String(e.ie || '') || undefined,
          email: String(e.email || '') || undefined,
          phone: String(e.phone || '') || undefined,
        }
        if (isEditing && e.id) {
          await updateSupplier(String(e.id), payload)
          toast('Fornecedor atualizado.', 'success')
        } else {
          await createSupplier(payload)
          toast('Fornecedor criado.', 'success')
        }
      } else if (tab === 'produtos') {
        const payload = {
          name: String(e.name || ''),
          sku: String(e.sku || '') || undefined,
          description: String(e.description || '') || undefined,
          productType: (e.productType as 'product' | 'service' | undefined) ?? (e.product_type as 'product' | 'service' | undefined),
          ncm: String(e.ncm || '') || undefined,
          uom: String(e.uom || '') || undefined,
          price: Number(e.price) || 0,
          cost: Number(e.cost) || 0,
        }
        if (isEditing && e.id) {
          await updateProduct(String(e.id), payload)
          toast('Produto atualizado.', 'success')
        } else {
          await createProduct(payload)
          toast('Produto criado.', 'success')
        }
      } else if (tab === 'depositos') {
        const payload = { name: String(e.name || '') }
        if (isEditing && e.id) {
          await updateWarehouse(String(e.id), payload)
          toast('Depósito atualizado.', 'success')
        } else {
          await createWarehouse(payload)
          toast('Depósito criado.', 'success')
        }
      } else if (tab === 'categorias') {
        await createCategory({ name: String(e.name || ''), parentId: undefined })
        toast('Categoria criada.', 'success')
      } else if (tab === 'transportadoras') {
        await createCarrier({
          name: String(e.name || ''),
          cnpj: String(e.cnpj || '') || undefined,
          modal: String(e.modal || '') || undefined,
          avgDays: Number(e.avgDays) || undefined,
        })
        toast('Transportadora criada.', 'success')
      }
      setModalOpen(false)
      void loadData()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Erro ao salvar.', 'error')
    }
    setSaving(false)
  }

  const handleDeactivate = async (id: string) => {
    try {
      if (tab === 'clientes') await deactivateCustomer(id)
      else if (tab === 'fornecedores') await deactivateSupplier(id)
      else if (tab === 'produtos') await deactivateProduct(id)
      else if (tab === 'transportadoras') await toggleCarrier(id)
      toast('Registro desativado.', 'success')
      void loadData()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Erro.', 'error')
    }
  }

  const setField = (key: string, value: string | number | boolean | null) => {
    setEditEntity((prev) => ({ ...prev, [key]: value }))
  }

  const tabs = [
    { key: 'clientes' as EntityTab, label: 'Clientes' },
    { key: 'fornecedores' as EntityTab, label: 'Fornecedores' },
    { key: 'produtos' as EntityTab, label: 'Produtos' },
    { key: 'depositos' as EntityTab, label: 'Depósitos' },
    { key: 'categorias' as EntityTab, label: 'Categorias' },
    { key: 'transportadoras' as EntityTab, label: 'Transportadoras' },
  ]

  const customerCols: Column<CustomerLookup>[] = [
    { key: 'name', header: 'Nome', render: (r) => <strong style={{ fontWeight: 500 }}>{r.name}</strong> },
    { key: 'cpf_cnpj', header: 'CPF/CNPJ', render: (r) => r.cpf_cnpj || '—' },
    { key: 'email', header: 'E-mail', render: (r) => r.email || '—' },
    { key: 'phone', header: 'Telefone', render: (r) => r.phone || '—' },
    { key: 'active', header: 'Status', width: '90px', render: (r) => <StatusBadge status={r.active ? 'active' : 'inactive'} /> },
    { key: 'created_at', header: 'Criado em', width: '90px', render: (r) => fmtDate(r.created_at) },
    {
      key: 'actions', header: '', width: '120px', align: 'right',
      render: (r) => (
        <div className="row-actions">
          <button type="button" className="btn-inline" onClick={(e) => { e.stopPropagation(); openEdit(r as unknown as Record<string, unknown>) }}>Editar</button>
          {r.active && <button type="button" className="btn-inline off" onClick={(e) => { e.stopPropagation(); void handleDeactivate(r.id) }}>Desativar</button>}
        </div>
      ),
    },
  ]

  const supplierCols: Column<SupplierLookup>[] = [
    { key: 'name', header: 'Nome', render: (r) => <strong style={{ fontWeight: 500 }}>{r.name}</strong> },
    { key: 'cpf_cnpj', header: 'CPF/CNPJ', render: (r) => r.cpf_cnpj || '—' },
    { key: 'email', header: 'E-mail', render: (r) => r.email || '—' },
    { key: 'phone', header: 'Telefone', render: (r) => r.phone || '—' },
    { key: 'created_at', header: 'Criado em', width: '90px', render: (r) => fmtDate(r.created_at) },
    {
      key: 'actions', header: '', width: '120px', align: 'right',
      render: (r) => (
        <div className="row-actions">
          <button type="button" className="btn-inline" onClick={(e) => { e.stopPropagation(); openEdit(r as unknown as Record<string, unknown>) }}>Editar</button>
          <button type="button" className="btn-inline off" onClick={(e) => { e.stopPropagation(); void handleDeactivate(r.id) }}>Desativar</button>
        </div>
      ),
    },
  ]

  const productCols: Column<ProductLookup>[] = [
    { key: 'name', header: 'Nome', render: (r) => <strong style={{ fontWeight: 500 }}>{r.name}</strong> },
    { key: 'sku', header: 'SKU', width: '100px', render: (r) => r.sku || '—' },
    { key: 'product_type', header: 'Tipo', width: '80px', render: (r) => r.product_type === 'service' ? 'Serviço' : 'Produto' },
    { key: 'price', header: 'Preço', width: '100px', align: 'right', render: (r) => fmtCurrency(r.price) },
    { key: 'cost', header: 'Custo', width: '100px', align: 'right', render: (r) => fmtCurrency(r.cost) },
    { key: 'created_at', header: 'Criado em', width: '90px', render: (r) => fmtDate(r.created_at) },
    {
      key: 'actions', header: '', width: '120px', align: 'right',
      render: (r) => (
        <div className="row-actions">
          <button type="button" className="btn-inline" onClick={(e) => { e.stopPropagation(); openEdit(r as unknown as Record<string, unknown>) }}>Editar</button>
          <button type="button" className="btn-inline off" onClick={(e) => { e.stopPropagation(); void handleDeactivate(r.id) }}>Desativar</button>
        </div>
      ),
    },
  ]

  const warehouseCols: Column<WarehouseLookup>[] = [
    { key: 'name', header: 'Nome', render: (r) => <strong style={{ fontWeight: 500 }}>{r.name}</strong> },
    { key: 'created_at', header: 'Criado em', width: '120px', render: (r) => fmtDate(r.created_at) },
    {
      key: 'actions', header: '', width: '80px', align: 'right',
      render: (r) => (
        <button type="button" className="btn-inline" onClick={(e) => { e.stopPropagation(); openEdit(r as unknown as Record<string, unknown>) }}>Editar</button>
      ),
    },
  ]

  const categoryCols: Column<CategoryLookup>[] = [
    { key: 'name', header: 'Nome', render: (r) => <strong style={{ fontWeight: 500 }}>{r.name}</strong> },
    { key: 'parentId', header: 'Pai', render: (r) => r.parentId ? categories.find((c) => c.id === r.parentId)?.name ?? '—' : '—' },
    { key: 'createdAt', header: 'Criado em', width: '120px', render: (r) => fmtDate(r.createdAt) },
  ]

  const carrierCols: Column<CarrierLookup>[] = [
    { key: 'name', header: 'Nome', render: (r) => <strong style={{ fontWeight: 500 }}>{r.name}</strong> },
    { key: 'cnpj', header: 'CNPJ', render: (r) => r.cnpj || '—' },
    { key: 'modal', header: 'Modal', width: '100px', render: (r) => r.modal || '—' },
    { key: 'avgDays', header: 'Prazo médio', width: '100px', render: (r) => r.avgDays !== null ? `${r.avgDays} dias` : '—' },
    { key: 'active', header: 'Status', width: '90px', render: (r) => <StatusBadge status={r.active ? 'active' : 'inactive'} /> },
    {
      key: 'actions', header: '', width: '80px', align: 'right',
      render: (r) => (
        <button type="button" className="btn-inline off" onClick={(e) => { e.stopPropagation(); void handleDeactivate(r.id) }}>
          {r.active ? 'Desativar' : 'Ativar'}
        </button>
      ),
    },
  ]

  const showSearch = tab !== 'categorias' && tab !== 'transportadoras'
  const showPagination = tab === 'clientes' || tab === 'fornecedores' || tab === 'produtos' || tab === 'depositos'

  const modalTitle = isEditing
    ? `Editar ${tab === 'clientes' ? 'Cliente' : tab === 'fornecedores' ? 'Fornecedor' : tab === 'produtos' ? 'Produto' : tab === 'depositos' ? 'Depósito' : tab === 'categorias' ? 'Categoria' : 'Transportadora'}`
    : `Novo ${tab === 'clientes' ? 'Cliente' : tab === 'fornecedores' ? 'Fornecedor' : tab === 'produtos' ? 'Produto' : tab === 'depositos' ? 'Depósito' : tab === 'categorias' ? 'Categoria' : 'Transportadora'}`

  return (
    <div className="page">
      <PageHeader

        actions={canCreate ? <button type="button" onClick={openCreate}>+ Novo Registro</button> : undefined}
      />

      <Tabs tabs={tabs} active={tab} onChange={switchTab} />

      {showSearch && (
        <div style={{ marginTop: 14 }}>
          <input
            placeholder={`Localizar em ${tab}...`}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOffset(0) }}
          />
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        {tab === 'clientes' && (
          <>
            <DataTable columns={customerCols} rows={customers} rowKey={(r) => r.id} loading={loading} onRowClick={(r) => openEdit(r as unknown as Record<string, unknown>)} />
            {showPagination && <Pagination total={customersTotal} offset={offset} limit={PAGE_SIZE} loading={loading} onPageChange={setOffset} />}
          </>
        )}
        {tab === 'fornecedores' && (
          <>
            <DataTable columns={supplierCols} rows={suppliers} rowKey={(r) => r.id} loading={loading} onRowClick={(r) => openEdit(r as unknown as Record<string, unknown>)} />
            {showPagination && <Pagination total={suppliersTotal} offset={offset} limit={PAGE_SIZE} loading={loading} onPageChange={setOffset} />}
          </>
        )}
        {tab === 'produtos' && (
          <>
            <DataTable columns={productCols} rows={products} rowKey={(r) => r.id} loading={loading} onRowClick={(r) => openEdit(r as unknown as Record<string, unknown>)} />
            {showPagination && <Pagination total={productsTotal} offset={offset} limit={PAGE_SIZE} loading={loading} onPageChange={setOffset} />}
          </>
        )}
        {tab === 'depositos' && (
          <>
            <DataTable columns={warehouseCols} rows={warehouses} rowKey={(r) => r.id} loading={loading} onRowClick={(r) => openEdit(r as unknown as Record<string, unknown>)} />
            {showPagination && <Pagination total={warehousesTotal} offset={offset} limit={PAGE_SIZE} loading={loading} onPageChange={setOffset} />}
          </>
        )}
        {tab === 'categorias' && (
          <>
            {categories.length === 0 && !loading && <EmptyState icon="📁" description="Organize seu catálogo hierarquicamente." action={<button type="button" onClick={openCreate}>+ Nova Categoria</button>} />}
            {categories.length > 0 && <DataTable columns={categoryCols} rows={categories} rowKey={(r) => r.id} loading={loading} />}
          </>
        )}
        {tab === 'transportadoras' && (
          <>
            {carriers.length === 0 && !loading && <EmptyState icon="🚚" description="Dados para documentação de frete e envio." action={<button type="button" onClick={openCreate}>+ Nova Transportadora</button>} />}
            {carriers.length > 0 && <DataTable columns={carrierCols} rows={carriers} rowKey={(r) => r.id} loading={loading} />}
          </>
        )}
      </div>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={modalTitle}
        size={tab === 'depositos' || tab === 'categorias' ? 'sm' : 'md'}
        footer={
          <div className="v-confirm-actions">
            <button type="button" className="ghost" onClick={() => setModalOpen(false)}>Cancelar</button>
            <button type="button" onClick={handleSave} disabled={saving || !String(editEntity.name ?? '').trim()}>
              {saving ? 'Processando...' : 'Confirmar'}
            </button>
          </div>
        }
      >
        <div className="fiscal-grid">
          {(tab === 'clientes' || tab === 'fornecedores') && (
            <>
              <label>
                Nome *
                <input value={String(editEntity.name ?? '')} onChange={(e) => setField('name', e.target.value)} />
                {fieldErrors.name && <span className="v-field-msg v-field-msg-error">{fieldErrors.name}</span>}
              </label>
              <label>
                Razão social
                <input value={String(editEntity.legalName ?? editEntity.legal_name ?? '')} onChange={(e) => setField('legalName', e.target.value)} />
              </label>
              <label>
                CPF/CNPJ
                <input value={String(editEntity.cpfCnpj ?? editEntity.cpf_cnpj ?? '')} onChange={(e) => setField('cpfCnpj', formatCpfCnpj(e.target.value))} />
                {fieldErrors.cpfCnpj && <span className="v-field-msg v-field-msg-error">{fieldErrors.cpfCnpj}</span>}
              </label>
              <label>
                IE
                <input value={String(editEntity.ie ?? '')} onChange={(e) => setField('ie', e.target.value)} />
              </label>
              <label>
                E-mail
                <input type="email" value={String(editEntity.email ?? '')} onChange={(e) => setField('email', e.target.value)} />
                {fieldErrors.email && <span className="v-field-msg v-field-msg-error">{fieldErrors.email}</span>}
              </label>
              <label>
                Telefone
                <input value={String(editEntity.phone ?? '')} onChange={(e) => setField('phone', formatPhone(e.target.value))} />
                {fieldErrors.phone && <span className="v-field-msg v-field-msg-error">{fieldErrors.phone}</span>}
              </label>
            </>
          )}
          {tab === 'produtos' && (
            <>
              <label>
                Nome *
                <input value={String(editEntity.name ?? '')} onChange={(e) => setField('name', e.target.value)} />
              </label>
              <label>
                SKU
                <input value={String(editEntity.sku ?? '')} onChange={(e) => setField('sku', e.target.value)} />
              </label>
              <label>
                NCM
                <input value={String(editEntity.ncm ?? '')} onChange={(e) => setField('ncm', e.target.value)} />
              </label>
              <label>
                Unidade
                <input value={String(editEntity.uom ?? 'UN')} onChange={(e) => setField('uom', e.target.value)} />
              </label>
              <label>
                Preço de venda
                <input type="number" min="0" step="0.01" value={String(editEntity.price ?? '0')} onChange={(e) => setField('price', Number(e.target.value))} />
              </label>
              <label>
                Custo
                <input type="number" min="0" step="0.01" value={String(editEntity.cost ?? '0')} onChange={(e) => setField('cost', Number(e.target.value))} />
              </label>
              <label style={{ gridColumn: 'span 2' }}>
                Descrição
                <input value={String(editEntity.description ?? '')} onChange={(e) => setField('description', e.target.value)} />
              </label>
            </>
          )}
          {tab === 'depositos' && (
            <label>
              Nome *
              <input value={String(editEntity.name ?? '')} onChange={(e) => setField('name', e.target.value)} />
            </label>
          )}
          {tab === 'categorias' && (
            <label>
              Nome *
              <input value={String(editEntity.name ?? '')} onChange={(e) => setField('name', e.target.value)} />
            </label>
          )}
          {tab === 'transportadoras' && (
            <>
              <label>
                Nome *
                <input value={String(editEntity.name ?? '')} onChange={(e) => setField('name', e.target.value)} />
              </label>
              <label>
                CNPJ
                <input value={String(editEntity.cnpj ?? '')} onChange={(e) => setField('cnpj', e.target.value)} />
              </label>
              <label>
                Modal
                <input value={String(editEntity.modal ?? '')} onChange={(e) => setField('modal', e.target.value)} placeholder="Rodoviário, Aéreo..." />
              </label>
              <label>
                Prazo médio (dias)
                <input type="number" min="0" value={String(editEntity.avgDays ?? '0')} onChange={(e) => setField('avgDays', Number(e.target.value))} />
              </label>
            </>
          )}
        </div>
      </Modal>
    </div>
  )
}
