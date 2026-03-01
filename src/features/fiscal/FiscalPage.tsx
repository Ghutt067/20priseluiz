import { useCallback, useEffect, useMemo, useState } from 'react'
import { NumericInput, Select, PageHeader, Tabs, TabPanel } from '../../components/ui'
import { LookupField } from '../inventory/LookupFields'
import { searchCustomersPaged } from '../../services/core'
import {
  createFiscalEmitter,
  createFiscalDraft,
  createFiscalProfile,
  createFiscalRule,
  fetchFiscalDocumentsPaged,
  fetchFiscalEmittersPaged,
  fetchFiscalProviderConfig,
  fetchFiscalProfiles,
  upsertFiscalProviderConfig,
  type FiscalDocumentListItem,
  type FiscalDocumentStatus,
  type FiscalDocumentType,
  type FiscalEmitter,
  type FiscalProfile,
  type FiscalTaxRegime,
} from '../../services/fiscal'
import {
  createFiscalTransmission,
  fetchFiscalTransmissionsPaged,
  type FiscalTransmissionListItem,
  processFiscalTransmission,
  type FiscalTransmissionProvider,
  updateFiscalTransmission,
} from '../../services/fiscalTransmission'
import {
  escapeHtml,
  printHtmlDocument,
  printPresetOptions,
  type PrintPreset,
} from '../../services/printing'
import { useStatusToast } from '../../hooks/useStatusToast'
import { useAuth } from '../../contexts/useAuth'
import { can } from '../../lib/permissions'
import { fmtCurrency, fmtDateFull, pageInfoLabel, canGoNextPage, mergeLookupById } from '../../lib/formatters'

type CustomerLookup = {
  id: string
  name: string
  email?: string
  phone?: string
}

type FiscalProfileLookup = {
  id: string
  name: string
  profileType: 'default' | 'custom'
}

type FiscalProviderForm = {
  environment: 'homologation' | 'production'
  apiBaseUrl: string
  apiKey: string
  companyApiKey: string
  integrationId: string
  active: boolean
}

type DraftItemForm = {
  rowId: string
  description: string
  quantity: string
  unitPrice: string
  ncm: string
  cfop: string
  uom: string
}

const DOCUMENTS_PAGE_SIZE = 10
const TRANSMISSIONS_PAGE_SIZE = 8

const docTypeOptions: Array<{ value: FiscalDocumentType | ''; label: string }> = [
  { value: '', label: 'Todos os tipos' },
  { value: 'nfe', label: 'NF-e' },
  { value: 'nfce', label: 'NFC-e' },
  { value: 'nfse', label: 'NFS-e' },
]

const docStatusOptions: Array<{ value: FiscalDocumentStatus | ''; label: string }> = [
  { value: '', label: 'Todos os status' },
  { value: 'draft', label: 'Rascunho' },
  { value: 'authorized', label: 'Autorizado' },
  { value: 'cancelled', label: 'Cancelado' },
  { value: 'denied', label: 'Denegado' },
  { value: 'error', label: 'Erro' },
]

const transmissionStatusOptions: Array<{
  value: 'queued' | 'sent' | 'authorized' | 'rejected' | 'error'
  label: string
}> = [
  { value: 'queued', label: 'Em fila' },
  { value: 'sent', label: 'Enviado' },
  { value: 'authorized', label: 'Autorizado' },
  { value: 'rejected', label: 'Rejeitado' },
  { value: 'error', label: 'Erro' },
]

function docTypeLabel(value: FiscalDocumentType) {
  if (value === 'nfe') return 'NF-e'
  if (value === 'nfce') return 'NFC-e'
  return 'NFS-e'
}

function docStatusLabel(value: FiscalDocumentStatus) {
  if (value === 'draft') return 'Rascunho'
  if (value === 'authorized') return 'Autorizado'
  if (value === 'cancelled') return 'Cancelado'
  if (value === 'denied') return 'Denegado'
  return 'Erro'
}

function docStatusTone(value: FiscalDocumentStatus) {
  if (value === 'authorized') return 'success'
  if (value === 'draft') return 'pending'
  if (value === 'cancelled') return 'muted'
  return 'danger'
}

function transmissionStatusLabel(value: FiscalDocumentListItem['transmissionStatus']) {
  if (!value) return 'Não enfileirado'
  if (value === 'queued') return 'Em fila'
  if (value === 'sent') return 'Enviado'
  if (value === 'authorized') return 'Autorizado'
  if (value === 'rejected') return 'Rejeitado'
  return 'Erro'
}

function transmissionStatusTone(value: FiscalDocumentListItem['transmissionStatus']) {
  if (!value) return 'muted'
  if (value === 'authorized') return 'success'
  if (value === 'queued') return 'pending'
  if (value === 'sent') return 'info'
  return 'danger'
}

function transmissionProviderLabel(value: FiscalDocumentListItem['transmissionProvider']) {
  if (!value) return '—'
  if (value === 'plugnotas') return 'PlugNotas'
  return value
}

function createDraftRowId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function emptyDraftItem(overrides?: Partial<Omit<DraftItemForm, 'rowId'>>): DraftItemForm {
  return {
    rowId: createDraftRowId(),
    description: overrides?.description ?? '',
    quantity: overrides?.quantity ?? '1',
    unitPrice: overrides?.unitPrice ?? '0',
    ncm: overrides?.ncm ?? '',
    cfop: overrides?.cfop ?? '',
    uom: overrides?.uom ?? 'UN',
  }
}

function canQueueTransmission(document: FiscalDocumentListItem) {
  if (document.status !== 'draft' && document.status !== 'error') {
    return false
  }

  return (
    document.transmissionStatus === null
    || document.transmissionStatus === 'error'
    || document.transmissionStatus === 'rejected'
  )
}

export function FiscalPage() {
  const { role } = useAuth()
  const userRole = role ?? 'vendedor'
  const [lookupRefreshToken, setLookupRefreshToken] = useState(0)
  const [customers, setCustomers] = useState<CustomerLookup[]>([])
  const [profiles, setProfiles] = useState<FiscalProfile[]>([])
  const [emitters, setEmitters] = useState<FiscalEmitter[]>([])
  const [lookupStatus, setLookupStatus] = useState('')
  const [emitterStatus, setEmitterStatus] = useState('')
  const [providerStatus, setProviderStatus] = useState('')
  const [providerSaving, setProviderSaving] = useState(false)

  const [profileStatus, setProfileStatus] = useState('')
  const [ruleStatus, setRuleStatus] = useState('')
  const [draftStatus, setDraftStatus] = useState('')
  const [draftPrintPreset, setDraftPrintPreset] = useState<PrintPreset>('a4')
  const [documentPrintPreset, setDocumentPrintPreset] = useState<PrintPreset>('a4')
  const [draftXml, setDraftXml] = useState('')
  const [transmissionStatus, setTransmissionStatus] = useState('')
  useStatusToast(transmissionStatus)
  const [transmissionBusy, setTransmissionBusy] = useState(false)

  const [profileForm, setProfileForm] = useState<{
    name: string
    profileType: 'default' | 'custom'
  }>({
    name: '',
    profileType: 'default',
  })

  const [emitterForm, setEmitterForm] = useState<{
    name: string
    legalName: string
    cnpj: string
    ie: string
    im: string
    taxRegime: FiscalTaxRegime
    city: string
    state: string
    isDefault: boolean
  }>({
    name: '',
    legalName: '',
    cnpj: '',
    ie: '',
    im: '',
    taxRegime: 'simples_nacional',
    city: '',
    state: '',
    isDefault: false,
  })

  const [providerForm, setProviderForm] = useState<FiscalProviderForm>({
    environment: 'homologation',
    apiBaseUrl: '',
    apiKey: '',
    companyApiKey: '',
    integrationId: '',
    active: true,
  })

  const [ruleForm, setRuleForm] = useState({
    profileId: '',
    taxType: 'icms' as const,
    rate: '18',
    baseReduction: '0',
    stMargin: '0',
    cst: '00',
    csosn: '',
    cfop: '5102',
    originState: '',
    destinationState: '',
  })

  const [fiscalForm, setFiscalForm] = useState<{
    emitterId: string
    customerId: string
    profileId: string
    originState: string
    destinationState: string
    docType: 'nfe' | 'nfce'
    environment: 'homologation' | 'production'
    items: DraftItemForm[]
  }>({
    emitterId: '',
    customerId: '',
    profileId: '',
    originState: '',
    destinationState: '',
    docType: 'nfe',
    environment: 'homologation',
    items: [
      emptyDraftItem({
        description: 'Produto exemplo',
        quantity: '1',
        unitPrice: '100',
        ncm: '00000000',
        cfop: '5102',
        uom: 'UN',
      }),
    ],
  })

  const [documentsQuery, setDocumentsQuery] = useState('')
  const [documentsStatusFilter, setDocumentsStatusFilter] = useState<FiscalDocumentStatus | ''>('')
  const [documentsTypeFilter, setDocumentsTypeFilter] = useState<FiscalDocumentType | ''>('')
  const [documentsOffset, setDocumentsOffset] = useState(0)
  const [documentsRows, setDocumentsRows] = useState<FiscalDocumentListItem[]>([])
  const [documentsTotalCount, setDocumentsTotalCount] = useState<number | null>(null)
  const [documentsLoading, setDocumentsLoading] = useState(false)
  const [documentsStatusText, setDocumentsStatusText] = useState('')
  const [documentsRefreshToken, setDocumentsRefreshToken] = useState(0)

  const [transmissionsOffset, setTransmissionsOffset] = useState(0)
  const [transmissionsRows, setTransmissionsRows] = useState<FiscalTransmissionListItem[]>([])
  const [transmissionsTotalCount, setTransmissionsTotalCount] = useState<number | null>(null)
  const [transmissionsLoading, setTransmissionsLoading] = useState(false)
  const [transmissionsStatusText, setTransmissionsStatusText] = useState('')
  const [transmissionsRefreshToken, setTransmissionsRefreshToken] = useState(0)

  const [selectedDocumentId, setSelectedDocumentId] = useState('')
  const [transmissionForm, setTransmissionForm] = useState({
    transmissionId: '',
    provider: 'plugnotas' as FiscalTransmissionProvider,
    status: 'queued' as 'queued' | 'sent' | 'authorized' | 'rejected' | 'error',
    responseCode: '',
    responseMessage: '',
  })

  const selectedDocument = useMemo(
    () => documentsRows.find((document) => document.id === selectedDocumentId) ?? null,
    [documentsRows, selectedDocumentId],
  )

  const customersById = useMemo(() => new Map(customers.map((customer) => [customer.id, customer])), [customers])

  const profileLookupRows = useMemo<FiscalProfileLookup[]>(
    () =>
      profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        profileType: profile.profile_type,
      })),
    [profiles],
  )

  const profilesById = useMemo(
    () => new Map(profileLookupRows.map((profile) => [profile.id, profile])),
    [profileLookupRows],
  )

  const emittersById = useMemo(
    () => new Map(emitters.map((emitter) => [emitter.id, emitter])),
    [emitters],
  )

  const updateDraftItem = useCallback((rowId: string, patch: Partial<DraftItemForm>) => {
    setFiscalForm((state) => ({
      ...state,
      items: state.items.map((row) => (row.rowId === rowId ? { ...row, ...patch } : row)),
    }))
  }, [])

  const removeDraftItem = useCallback((rowId: string) => {
    setFiscalForm((state) => ({
      ...state,
      items:
        state.items.length > 1
          ? state.items.filter((row) => row.rowId !== rowId)
          : state.items,
    }))
  }, [])

  const addDraftItem = useCallback(() => {
    setFiscalForm((state) => ({
      ...state,
      items: [...state.items, emptyDraftItem()],
    }))
  }, [])

  const searchEmitterLookupOptions = useCallback(
    async ({ query, offset, limit, signal }: { query: string; offset: number; limit: number; signal?: AbortSignal }) => {
      const result = await fetchFiscalEmittersPaged({
        query,
        offset,
        limit,
        signal,
      })
      setEmitters((state) => mergeLookupById(state, result.rows))
      return {
        rows: result.rows,
        totalCount: result.totalCount,
      }
    },
    [],
  )

  const searchCustomerLookupOptions = useCallback(
    async ({ query, offset, limit, signal }: { query: string; offset: number; limit: number; signal?: AbortSignal }) => {
      const rows = await searchCustomersPaged(query, {
        limit,
        offset,
        signal,
      })

      const normalizedRows: CustomerLookup[] = rows.map((customer) => ({
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
      }))

      setCustomers((state) => mergeLookupById(state, normalizedRows))

      return {
        rows: normalizedRows,
        totalCount: null,
      }
    },
    [],
  )

  const searchProfileLookupOptions = useCallback(
    async ({ query, offset, limit }: { query: string; offset: number; limit: number; signal?: AbortSignal }) => {
      const normalizedQuery = query.trim().toLowerCase()
      const filteredRows =
        normalizedQuery === ''
          ? profileLookupRows
          : profileLookupRows.filter((profile) => profile.name.toLowerCase().includes(normalizedQuery))

      return {
        rows: filteredRows.slice(offset, offset + limit),
        totalCount: filteredRows.length,
      }
    },
    [profileLookupRows],
  )

  useEffect(() => {
    let cancelled = false

    const loadLookups = async () => {
      try {
        setProviderStatus('')
        const [profilesData, emittersData] = await Promise.all([
          fetchFiscalProfiles(),
          fetchFiscalEmittersPaged({ limit: 50, offset: 0 }),
        ])
        if (cancelled) return
        setProfiles(profilesData)
        setEmitters(emittersData.rows)

        try {
          const providerConfig = await fetchFiscalProviderConfig('plugnotas')
          if (!cancelled && providerConfig) {
            setProviderForm({
              environment: providerConfig.environment,
              apiBaseUrl: providerConfig.apiBaseUrl ?? '',
              apiKey: providerConfig.apiKey ?? '',
              companyApiKey: providerConfig.companyApiKey ?? '',
              integrationId: providerConfig.integrationId ?? '',
              active: providerConfig.active,
            })
          }
        } catch (error) {
          if (!cancelled) {
            const message =
              error instanceof Error
                ? error.message
                : 'Falha ao carregar configuração do provedor fiscal.'
            setProviderStatus(message)
          }
        }

        setLookupStatus('')
      } catch (error) {
        if (cancelled) return
        const message = error instanceof Error ? error.message : 'Erro ao carregar dados iniciais.'
        setLookupStatus(message)
      }
    }

    void loadLookups()
    return () => {
      cancelled = true
    }
  }, [lookupRefreshToken])

  useEffect(() => {
    if (profiles.length === 0) return
    if (!fiscalForm.profileId) {
      setFiscalForm((state) => ({
        ...state,
        profileId: profiles[0].id,
      }))
    }
    if (!ruleForm.profileId) {
      setRuleForm((state) => ({
        ...state,
        profileId: profiles[0].id,
      }))
    }
  }, [fiscalForm.profileId, profiles, ruleForm.profileId])

  useEffect(() => {
    if (emitters.length === 0 || fiscalForm.emitterId) return
    const defaultEmitter = emitters.find((emitter) => emitter.isDefault) ?? emitters[0]
    setFiscalForm((state) => ({
      ...state,
      emitterId: defaultEmitter.id,
    }))
  }, [emitters, fiscalForm.emitterId])

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    const loadDocuments = async () => {
      try {
        setDocumentsLoading(true)
        const result = await fetchFiscalDocumentsPaged({
          query: documentsQuery,
          status: documentsStatusFilter,
          docType: documentsTypeFilter,
          limit: DOCUMENTS_PAGE_SIZE,
          offset: documentsOffset,
          signal: controller.signal,
        })

        if (cancelled) return
        setDocumentsRows(result.rows)
        setDocumentsTotalCount(result.totalCount)
        setDocumentsStatusText('')
      } catch (error) {
        if (cancelled) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        const message = error instanceof Error ? error.message : 'Erro ao carregar documentos fiscais.'
        setDocumentsStatusText(message)
      } finally {
        if (!cancelled) {
          setDocumentsLoading(false)
        }
      }
    }

    void loadDocuments()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [
    documentsOffset,
    documentsQuery,
    documentsRefreshToken,
    documentsStatusFilter,
    documentsTypeFilter,
  ])

  useEffect(() => {
    if (!selectedDocument) {
      setTransmissionForm((state) => ({
        ...state,
        transmissionId: '',
        responseCode: '',
        responseMessage: '',
      }))
      return
    }

    setTransmissionForm((state) => ({
      ...state,
      transmissionId: selectedDocument.transmissionId ?? '',
      provider:
        (selectedDocument.transmissionProvider as FiscalTransmissionProvider | null)
        ?? state.provider,
      status: selectedDocument.transmissionStatus ?? 'queued',
      responseCode: selectedDocument.transmissionResponseCode ?? '',
      responseMessage: selectedDocument.transmissionResponseMessage ?? '',
    }))
  }, [selectedDocument])

  useEffect(() => {
    setTransmissionsOffset(0)
  }, [selectedDocumentId])

  useEffect(() => {
    if (!selectedDocument?.id) {
      setTransmissionsRows([])
      setTransmissionsTotalCount(null)
      setTransmissionsStatusText('')
      return
    }

    const controller = new AbortController()
    let cancelled = false

    const loadTransmissions = async () => {
      try {
        setTransmissionsLoading(true)
        const result = await fetchFiscalTransmissionsPaged({
          documentId: selectedDocument.id,
          limit: TRANSMISSIONS_PAGE_SIZE,
          offset: transmissionsOffset,
          signal: controller.signal,
        })

        if (cancelled) return
        setTransmissionsRows(result.rows)
        setTransmissionsTotalCount(result.totalCount)
        setTransmissionsStatusText('')
      } catch (error) {
        if (cancelled) return
        if (error instanceof DOMException && error.name === 'AbortError') return
        const message = error instanceof Error ? error.message : 'Erro ao carregar histórico de transmissões.'
        setTransmissionsStatusText(message)
      } finally {
        if (!cancelled) {
          setTransmissionsLoading(false)
        }
      }
    }

    void loadTransmissions()

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [selectedDocument?.id, transmissionsOffset, transmissionsRefreshToken])

  const documentsPageInfo = pageInfoLabel(
    documentsOffset,
    documentsRows.length,
    documentsTotalCount,
  )
  const canGoNextDocumentsPage = canGoNextPage(
    documentsOffset,
    documentsRows.length,
    documentsTotalCount,
    DOCUMENTS_PAGE_SIZE,
  )
  const transmissionsPageInfo = pageInfoLabel(
    transmissionsOffset,
    transmissionsRows.length,
    transmissionsTotalCount,
  )
  const canGoNextTransmissionsPage = canGoNextPage(
    transmissionsOffset,
    transmissionsRows.length,
    transmissionsTotalCount,
    TRANSMISSIONS_PAGE_SIZE,
  )

  const refreshDocuments = () => {
    setDocumentsRefreshToken((value) => value + 1)
  }

  const refreshTransmissions = () => {
    setTransmissionsRefreshToken((value) => value + 1)
  }

  const printDraftXml = async () => {
    if (!draftXml.trim()) {
      setDraftStatus('Gere um rascunho para imprimir o XML.')
      return
    }

    setDraftStatus('Preparando impressão do XML fiscal...')
    try {
      await printHtmlDocument({
        title: `Rascunho ${fiscalForm.docType === 'nfe' ? 'NF-e' : 'NFC-e'}`,
        subtitle: `Ambiente: ${fiscalForm.environment === 'production' ? 'Produção' : 'Homologação'}`,
        preset: draftPrintPreset,
        bodyHtml: `<pre>${escapeHtml(draftXml)}</pre>`,
        footerText: `Emitido em ${new Date().toLocaleString('pt-BR')}`,
      })
      setDraftStatus('Impressão do XML enviada para o dispositivo.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao imprimir XML fiscal.'
      setDraftStatus(message)
    }
  }

  const printDocumentSummary = async (document: FiscalDocumentListItem) => {
    setTransmissionStatus('Preparando impressão do resumo fiscal...')
    try {
      await printHtmlDocument({
        title: `Documento fiscal ${docTypeLabel(document.docType)}`,
        subtitle: `Documento ${document.id}`,
        preset: documentPrintPreset,
        bodyHtml: `
          <table class="print-table">
            <tbody>
              <tr><th>Emissão</th><td>${escapeHtml(fmtDateFull(document.issueDate ?? document.createdAt))}</td></tr>
              <tr><th>Tipo</th><td>${escapeHtml(docTypeLabel(document.docType))}</td></tr>
              <tr><th>Emitente</th><td>${escapeHtml(document.emitterName || 'Emitente padrão')}</td></tr>
              <tr><th>Destinatário</th><td>${escapeHtml(document.recipientName || 'Sem destinatário')}</td></tr>
              <tr><th>Total</th><td>${escapeHtml(fmtCurrency(document.totalInvoice))}</td></tr>
              <tr><th>Status</th><td>${escapeHtml(docStatusLabel(document.status))}</td></tr>
              <tr><th>Fila</th><td>${escapeHtml(transmissionStatusLabel(document.transmissionStatus))}</td></tr>
            </tbody>
          </table>
        `,
        footerText: `Gerado em ${new Date().toLocaleString('pt-BR')}`,
      })
      setTransmissionStatus('Impressão do resumo fiscal enviada.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao imprimir resumo fiscal.'
      setTransmissionStatus(message)
    }
  }

  const processSelectedTransmission = async () => {
    if (!transmissionForm.transmissionId) {
      setTransmissionStatus('Enfileire o documento antes de processar no provedor.')
      return
    }

    setTransmissionBusy(true)
    try {
      const result = await processFiscalTransmission({
        id: transmissionForm.transmissionId,
        provider: transmissionForm.provider,
      })

      setTransmissionForm((state) => ({
        ...state,
        provider: result.provider ?? state.provider,
        status: result.status,
        responseCode: result.responseCode ?? '',
        responseMessage: result.responseMessage ?? '',
      }))

      setTransmissionStatus(
        result.status === 'authorized'
          ? 'Documento autorizado pelo provedor fiscal.'
          : `Transmissão processada com status ${transmissionStatusLabel(result.status)}.`,
      )
      refreshDocuments()
      refreshTransmissions()
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Erro ao processar transmissão no provedor fiscal.'
      setTransmissionStatus(message)
    } finally {
      setTransmissionBusy(false)
    }
  }

  const queueDocument = async (document: FiscalDocumentListItem) => {
    if (!canQueueTransmission(document)) {
      setTransmissionStatus('Somente documentos em rascunho/erro e sem fila ativa podem ser enfileirados.')
      return
    }

    setTransmissionBusy(true)
    setTransmissionStatus('Enfileirando documento fiscal...')
    try {
      const result = await createFiscalTransmission({
        documentId: document.id,
        provider: transmissionForm.provider,
      })
      setSelectedDocumentId(document.id)
      setTransmissionForm((state) => ({
        ...state,
        transmissionId: result.id,
        provider: result.provider ?? state.provider,
        status: 'queued',
        responseCode: '',
        responseMessage: '',
      }))
      setTransmissionStatus('Documento enfileirado com sucesso.')
      refreshDocuments()
      setTransmissionsOffset(0)
      refreshTransmissions()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro ao enfileirar documento.'
      setTransmissionStatus(message)
    } finally {
      setTransmissionBusy(false)
    }
  }

  const selectTransmissionRow = (row: FiscalTransmissionListItem) => {
    setTransmissionForm((state) => ({
      ...state,
      transmissionId: row.id,
      provider: row.provider ?? state.provider,
      status: row.status,
      responseCode: row.responseCode ?? '',
      responseMessage: row.responseMessage ?? '',
    }))
    setTransmissionStatus(`Transmissão ${row.id} selecionada para operação.`)
  }

  const [fiscalTab, setFiscalTab] = useState<'emitters' | 'config' | 'draft' | 'documents'>('documents')

  return (
    <div className="page-grid">
      <PageHeader />
      <Tabs
        tabs={[
          { key: 'documents' as const, label: 'Documentos' },
          { key: 'draft' as const, label: 'Emissão' },
          { key: 'emitters' as const, label: 'Emitentes' },
          { key: 'config' as const, label: 'Configurações' },
        ]}
        active={fiscalTab}
        onChange={(k) => setFiscalTab(k as typeof fiscalTab)}
      />
      <TabPanel active={fiscalTab === 'emitters'}>
      <div className="card fiscal-card">

        <div className="fiscal-grid">
          <label>
            Nome fantasia
            <input
              value={emitterForm.name}
              placeholder="Loja Centro"
              onChange={(event) => setEmitterForm((state) => ({ ...state, name: event.target.value }))}
            />
          </label>
          <label>
            Razão social
            <input
              value={emitterForm.legalName}
              placeholder="Empresa LTDA"
              onChange={(event) => setEmitterForm((state) => ({ ...state, legalName: event.target.value }))}
            />
          </label>
          <label>
            CNPJ
            <input
              value={emitterForm.cnpj}
              placeholder="00.000.000/0001-00"
              onChange={(event) => setEmitterForm((state) => ({ ...state, cnpj: event.target.value }))}
            />
          </label>
          <label>
            IE
            <input
              value={emitterForm.ie}
              onChange={(event) => setEmitterForm((state) => ({ ...state, ie: event.target.value }))}
            />
          </label>
          <label>
            IM
            <input
              value={emitterForm.im}
              onChange={(event) => setEmitterForm((state) => ({ ...state, im: event.target.value }))}
            />
          </label>
          <label>
            Regime tributário
            <Select
              value={emitterForm.taxRegime}
              options={[
                { value: 'simples_nacional', label: 'Simples Nacional' },
                { value: 'lucro_presumido', label: 'Lucro Presumido' },
                { value: 'lucro_real', label: 'Lucro Real' },
                { value: 'mei', label: 'MEI' },
              ]}
              onChange={(value) =>
                setEmitterForm((state) => ({
                  ...state,
                  taxRegime: value as FiscalTaxRegime,
                }))
              }
            />
          </label>
          <label>
            Cidade
            <input
              value={emitterForm.city}
              onChange={(event) => setEmitterForm((state) => ({ ...state, city: event.target.value }))}
            />
          </label>
          <label>
            UF
            <input
              value={emitterForm.state}
              placeholder="RJ"
              onChange={(event) =>
                setEmitterForm((state) => ({
                  ...state,
                  state: event.target.value.toUpperCase(),
                }))
              }
            />
          </label>
          <label>
            Emitente padrão
            <Select
              value={emitterForm.isDefault ? 'yes' : 'no'}
              options={[
                { value: 'yes', label: 'Sim' },
                { value: 'no', label: 'Não' },
              ]}
              onChange={(value) =>
                setEmitterForm((state) => ({
                  ...state,
                  isDefault: value === 'yes',
                }))
              }
            />
          </label>
        </div>

        <div className="actions">
          <button
            type="button"
            onClick={async () => {
              const name = emitterForm.name.trim()
              const cnpj = emitterForm.cnpj.trim()
              if (!name || !cnpj) {
                setEmitterStatus('Informe ao menos nome fantasia e CNPJ para salvar o emitente.')
                return
              }
              try {
                const created = await createFiscalEmitter({
                  name,
                  legalName: emitterForm.legalName.trim() || undefined,
                  cnpj,
                  ie: emitterForm.ie.trim() || undefined,
                  im: emitterForm.im.trim() || undefined,
                  taxRegime: emitterForm.taxRegime,
                  city: emitterForm.city.trim() || undefined,
                  state: emitterForm.state.trim().toUpperCase() || undefined,
                  isDefault: emitterForm.isDefault,
                })

                setEmitters((state) => {
                  const normalizedState = emitterForm.isDefault
                    ? state.map((row) => ({ ...row, isDefault: false }))
                    : state
                  return mergeLookupById(normalizedState, [created])
                })
                setFiscalForm((state) => ({
                  ...state,
                  emitterId: created.id,
                }))
                setEmitterStatus('Emitente fiscal salvo com sucesso.')
                setEmitterForm((state) => ({
                  ...state,
                  name: '',
                  legalName: '',
                  cnpj: '',
                  ie: '',
                  im: '',
                  city: '',
                  state: '',
                  isDefault: false,
                }))
              } catch (error) {
                const message = error instanceof Error ? error.message : 'Erro ao salvar emitente fiscal.'
                setEmitterStatus(message)
              }
            }}
          >
            Confirmar emitente
          </button>
        </div>
        
        <p className="hint">
          Emitentes cadastrados: {emitters.length}
          {emitters.find((emitter) => emitter.isDefault)?.name
            ? ` · Padrão: ${emitters.find((emitter) => emitter.isDefault)?.name}`
            : ''}
        </p>

        <div className="divider" />

        <div className="fiscal-grid">
          <label>
            Ambiente fiscal
            <Select
              value={providerForm.environment}
              options={[
                { value: 'homologation', label: 'Homologação' },
                { value: 'production', label: 'Produção' },
              ]}
              onChange={(value) =>
                setProviderForm((state) => ({
                  ...state,
                  environment: value as FiscalProviderForm['environment'],
                }))
              }
            />
          </label>
          <label>
            URL base (opcional)
            <input
              value={providerForm.apiBaseUrl}
              placeholder="https://api.plugnotas.com.br"
              onChange={(event) =>
                setProviderForm((state) => ({ ...state, apiBaseUrl: event.target.value }))
              }
            />
          </label>
          <label>
            API key
            <input
              value={providerForm.apiKey}
              placeholder="Token geral"
              onChange={(event) => setProviderForm((state) => ({ ...state, apiKey: event.target.value }))}
            />
          </label>
          <label>
            API key da empresa
            <input
              value={providerForm.companyApiKey}
              placeholder="Token por empresa"
              onChange={(event) =>
                setProviderForm((state) => ({ ...state, companyApiKey: event.target.value }))
              }
            />
          </label>
          <label>
            Integration ID
            <input
              value={providerForm.integrationId}
              placeholder="ID de integração"
              onChange={(event) =>
                setProviderForm((state) => ({ ...state, integrationId: event.target.value }))
              }
            />
          </label>
          <label>
            Status da integração
            <Select
              value={providerForm.active ? 'active' : 'inactive'}
              options={[
                { value: 'active', label: 'Ativa' },
                { value: 'inactive', label: 'Inativa' },
              ]}
              onChange={(value) =>
                setProviderForm((state) => ({
                  ...state,
                  active: value === 'active',
                }))
              }
            />
          </label>
        </div>

        <div className="actions">
          <button
            type="button"
            onClick={async () => {
              setProviderSaving(true)
              try {
                await upsertFiscalProviderConfig({
                  provider: 'plugnotas',
                  environment: providerForm.environment,
                  apiBaseUrl: providerForm.apiBaseUrl.trim() || undefined,
                  apiKey: providerForm.apiKey.trim() || undefined,
                  companyApiKey: providerForm.companyApiKey.trim() || undefined,
                  integrationId: providerForm.integrationId.trim() || undefined,
                  active: providerForm.active,
                })
                setProviderStatus('Configuração PlugNotas salva com sucesso.')
              } catch (error) {
                const message =
                  error instanceof Error
                    ? error.message
                    : 'Erro ao salvar configuração do provedor fiscal.'
                setProviderStatus(message)
              } finally {
                setProviderSaving(false)
              }
            }}
            disabled={providerSaving}
          >
            {providerSaving ? 'Processando...' : 'Confirmar provedor fiscal'}
          </button>
        </div>
        
      </div>
      </TabPanel>

      <TabPanel active={fiscalTab === 'config'}>
      <div className="card fiscal-card">
        <div className="fiscal-grid">
          <label>
            Nome do perfil
            <input
              value={profileForm.name}
              placeholder="Perfil padrão"
              onChange={(event) => setProfileForm((state) => ({ ...state, name: event.target.value }))}
            />
          </label>
          <label>
            Tipo
            <Select
              value={profileForm.profileType}
              options={[
                { value: 'default', label: 'Padrão' },
                { value: 'custom', label: 'Personalizado' },
              ]}
              onChange={(value) =>
                setProfileForm((state) => ({
                  ...state,
                  profileType: value as 'default' | 'custom',
                }))
              }
            />
          </label>
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={async () => {
              setProfileStatus('Criando perfil fiscal...')
              try {
                const created = await createFiscalProfile({
                  name: profileForm.name.trim() || 'Perfil padrão',
                  profileType: profileForm.profileType,
                })
                setProfileStatus('Perfil fiscal criado com sucesso.')
                setRuleForm((state) => ({ ...state, profileId: created.id }))
                setFiscalForm((state) => ({ ...state, profileId: created.id }))
                setLookupRefreshToken((value) => value + 1)
              } catch (error) {
                const message = error instanceof Error ? error.message : 'Erro ao criar perfil fiscal.'
                setProfileStatus(message)
              }
            }}
          >
            Criar perfil fiscal
          </button>
        </div>

        <div className="divider" />

        <div className="fiscal-grid">
          <label className="purchase-order-lookup">
            Perfil fiscal
            <LookupField<FiscalProfileLookup>
              value={ruleForm.profileId}
              selectedLabel={profilesById.get(ruleForm.profileId)?.name ?? ''}
              placeholder="Buscar perfil fiscal..."
              searchOptions={searchProfileLookupOptions}
              onSelect={(item) =>
                setRuleForm((state) => ({
                  ...state,
                  profileId: item.id,
                }))
              }
              onClear={() =>
                setRuleForm((state) => ({
                  ...state,
                  profileId: '',
                }))
              }
              renderMeta={(item) => (item.profileType === 'default' ? 'Padrão' : 'Personalizado')}
            />
          </label>
          <label>
            Tributo
            <Select
              value={ruleForm.taxType}
              options={[
                { value: 'icms', label: 'ICMS' },
                { value: 'icms_st', label: 'ICMS ST' },
                { value: 'icms_difal', label: 'ICMS DIFAL' },
                { value: 'pis', label: 'PIS' },
                { value: 'cofins', label: 'COFINS' },
                { value: 'ipi', label: 'IPI' },
                { value: 'iss', label: 'ISS' },
              ]}
              onChange={(value) =>
                setRuleForm((state) => ({
                  ...state,
                  taxType: value as typeof state.taxType,
                }))
              }
            />
          </label>
          <label>
            Alíquota (%)
            <NumericInput
              value={ruleForm.rate}
              onChange={(event) => setRuleForm((state) => ({ ...state, rate: event.target.value }))}
            />
          </label>
          <label>
            Redução base (%)
            <NumericInput
              value={ruleForm.baseReduction}
              onChange={(event) =>
                setRuleForm((state) => ({ ...state, baseReduction: event.target.value }))
              }
            />
          </label>
          <label>
            MVA ST (%)
            <NumericInput
              value={ruleForm.stMargin}
              onChange={(event) =>
                setRuleForm((state) => ({ ...state, stMargin: event.target.value }))
              }
            />
          </label>
          <label>
            CST
            <input
              value={ruleForm.cst}
              onChange={(event) => setRuleForm((state) => ({ ...state, cst: event.target.value }))}
            />
          </label>
          <label>
            CSOSN
            <input
              value={ruleForm.csosn}
              onChange={(event) =>
                setRuleForm((state) => ({ ...state, csosn: event.target.value }))
              }
            />
          </label>
          <label>
            CFOP
            <input
              value={ruleForm.cfop}
              onChange={(event) => setRuleForm((state) => ({ ...state, cfop: event.target.value }))}
            />
          </label>
          <label>
            UF origem
            <input
              value={ruleForm.originState}
              placeholder="SP"
              onChange={(event) =>
                setRuleForm((state) => ({ ...state, originState: event.target.value.toUpperCase() }))
              }
            />
          </label>
          <label>
            UF destino
            <input
              value={ruleForm.destinationState}
              placeholder="RJ"
              onChange={(event) =>
                setRuleForm((state) => ({
                  ...state,
                  destinationState: event.target.value.toUpperCase(),
                }))
              }
            />
          </label>
        </div>
        <div className="actions">
          <button
            type="button"
            onClick={async () => {
              if (!ruleForm.profileId) {
                setRuleStatus('Selecione um perfil fiscal para criar a regra.')
                return
              }

              setRuleStatus('Criando regra fiscal...')
              try {
                const created = await createFiscalRule({
                  profileId: ruleForm.profileId,
                  taxType: ruleForm.taxType,
                  rate: Number(ruleForm.rate),
                  baseReduction: Number(ruleForm.baseReduction),
                  stMargin: Number(ruleForm.stMargin),
                  cst: ruleForm.cst || undefined,
                  csosn: ruleForm.csosn || undefined,
                  cfop: ruleForm.cfop || undefined,
                  originState: ruleForm.originState || undefined,
                  destinationState: ruleForm.destinationState || undefined,
                })
                setRuleStatus(`Regra criada com sucesso. Referência: ${created.id.slice(0, 8)}...`)
              } catch (error) {
                const message = error instanceof Error ? error.message : 'Erro ao criar regra fiscal.'
                setRuleStatus(message)
              }
            }}
          >
            Criar regra fiscal
          </button>
        </div>
        
      </div>
      </TabPanel>

      <TabPanel active={fiscalTab === 'draft'}>
      <div className="card fiscal-card">
        <div className="fiscal-grid">
          <label className="purchase-order-lookup">
            Emitente (filial/CNPJ)
            <LookupField<FiscalEmitter>
              value={fiscalForm.emitterId}
              selectedLabel={emittersById.get(fiscalForm.emitterId)?.name ?? ''}
              placeholder="Buscar emitente por nome ou CNPJ..."
              searchOptions={searchEmitterLookupOptions}
              onSelect={(item) => {
                setEmitters((state) => mergeLookupById(state, [item]))
                setFiscalForm((state) => ({
                  ...state,
                  emitterId: item.id,
                }))
              }}
              onClear={() =>
                setFiscalForm((state) => ({
                  ...state,
                  emitterId: '',
                }))
              }
              renderMeta={(item) => {
                const cityState = item.city
                  ? `${item.city}${item.state ? `/${item.state}` : ''}`
                  : (item.state ?? '')
                const parts = [item.cnpj, cityState, item.isDefault ? 'Padrão' : ''].filter(Boolean)
                return parts.join(' · ')
              }}
            />
          </label>
          <label className="purchase-order-lookup">
            Cliente
            <LookupField<CustomerLookup>
              value={fiscalForm.customerId}
              selectedLabel={customersById.get(fiscalForm.customerId)?.name ?? ''}
              placeholder="Buscar cliente por nome..."
              searchOptions={searchCustomerLookupOptions}
              onSelect={(item) => {
                setCustomers((state) => mergeLookupById(state, [item]))
                setFiscalForm((state) => ({
                  ...state,
                  customerId: item.id,
                }))
              }}
              onClear={() =>
                setFiscalForm((state) => ({
                  ...state,
                  customerId: '',
                }))
              }
              renderMeta={(item) => item.email ?? item.phone ?? null}
            />
          </label>
          <label className="purchase-order-lookup">
            Perfil fiscal
            <LookupField<FiscalProfileLookup>
              value={fiscalForm.profileId}
              selectedLabel={profilesById.get(fiscalForm.profileId)?.name ?? ''}
              placeholder="Buscar perfil fiscal..."
              searchOptions={searchProfileLookupOptions}
              onSelect={(item) =>
                setFiscalForm((state) => ({
                  ...state,
                  profileId: item.id,
                }))
              }
              onClear={() =>
                setFiscalForm((state) => ({
                  ...state,
                  profileId: '',
                }))
              }
              renderMeta={(item) => (item.profileType === 'default' ? 'Padrão' : 'Personalizado')}
            />
          </label>
          <label>
            Tipo de documento
            <Select
              value={fiscalForm.docType}
              options={[
                { value: 'nfe', label: 'NF-e' },
                { value: 'nfce', label: 'NFC-e' },
              ]}
              onChange={(value) =>
                setFiscalForm((state) => ({
                  ...state,
                  docType: value as 'nfe' | 'nfce',
                }))
              }
            />
          </label>
          <label>
            Ambiente
            <Select
              value={fiscalForm.environment}
              options={[
                { value: 'homologation', label: 'Homologação' },
                { value: 'production', label: 'Produção' },
              ]}
              onChange={(value) =>
                setFiscalForm((state) => ({
                  ...state,
                  environment: value as 'homologation' | 'production',
                }))
              }
            />
          </label>
          <label>
            UF origem
            <input
              value={fiscalForm.originState}
              placeholder="SP"
              onChange={(event) =>
                setFiscalForm((state) => ({ ...state, originState: event.target.value.toUpperCase() }))
              }
            />
          </label>
          <label>
            UF destino
            <input
              value={fiscalForm.destinationState}
              placeholder="RJ"
              onChange={(event) =>
                setFiscalForm((state) => ({
                  ...state,
                  destinationState: event.target.value.toUpperCase(),
                }))
              }
            />
          </label>
        </div>
        {emitters.length === 0 && (
          <p className="hint">
            Nenhum emitente cadastrado. O sistema usará os dados fiscais da organização como fallback.
          </p>
        )}

        <div className="purchase-section">
          <div className="purchase-items">
            {fiscalForm.items.map((item) => (
              <div key={item.rowId} className="purchase-item-row">
                <div className="fiscal-grid">
                  <label>
                    Descrição
                    <input
                      value={item.description}
                      placeholder="Produto / serviço"
                      onChange={(event) => updateDraftItem(item.rowId, { description: event.target.value })}
                    />
                  </label>
                  <label>
                    Quantidade
                    <NumericInput
                      value={item.quantity}
                      onChange={(event) => updateDraftItem(item.rowId, { quantity: event.target.value })}
                    />
                  </label>
                  <label>
                    Valor unitário
                    <NumericInput
                      value={item.unitPrice}
                      onChange={(event) => updateDraftItem(item.rowId, { unitPrice: event.target.value })}
                    />
                  </label>
                  <label>
                    NCM
                    <input
                      value={item.ncm}
                      onChange={(event) => updateDraftItem(item.rowId, { ncm: event.target.value })}
                    />
                  </label>
                  <label>
                    CFOP
                    <input
                      value={item.cfop}
                      onChange={(event) => updateDraftItem(item.rowId, { cfop: event.target.value })}
                    />
                  </label>
                  <label>
                    Unidade
                    <input
                      value={item.uom}
                      onChange={(event) => updateDraftItem(item.rowId, { uom: event.target.value })}
                    />
                  </label>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => removeDraftItem(item.rowId)}
                    disabled={fiscalForm.items.length === 1}
                  >
                    Remover item
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="actions">
            <button
              type="button"
              className="ghost"
              onClick={addDraftItem}
            >
              Adicionar item
            </button>
            <label>
              Formato de impressão XML
              <Select
                value={draftPrintPreset}
                options={printPresetOptions.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                onChange={(value) => setDraftPrintPreset(value as PrintPreset)}
              />
            </label>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                void printDraftXml()
              }}
              disabled={!draftXml}
            >
              Imprimir XML
            </button>
            <button
              type="button"
              onClick={async () => {
                if (emitters.length > 0 && !fiscalForm.emitterId) {
                  setDraftStatus('Selecione um emitente fiscal para gerar o rascunho.')
                  return
                }
                if (!fiscalForm.customerId) {
                  setDraftStatus('Selecione um cliente para gerar o rascunho fiscal.')
                  return
                }
                if (!fiscalForm.profileId) {
                  setDraftStatus('Selecione um perfil fiscal para gerar o rascunho.')
                  return
                }

                const payloadItems = fiscalForm.items
                  .map((item) => ({
                    description: item.description.trim(),
                    quantity: Number(item.quantity),
                    unit_price: Number(item.unitPrice),
                    ncm: item.ncm.trim() || undefined,
                    cfop: item.cfop.trim() || undefined,
                    uom: item.uom.trim() || undefined,
                  }))
                  .filter(
                    (item) =>
                      item.description.length > 0
                      && Number.isFinite(item.quantity)
                      && item.quantity > 0
                      && Number.isFinite(item.unit_price)
                      && item.unit_price >= 0,
                  )

                if (payloadItems.length === 0) {
                  setDraftStatus('Adicione ao menos um item válido para gerar o rascunho.')
                  return
                }

                setDraftStatus('Gerando rascunho fiscal...')
                try {
                  const result = await createFiscalDraft({
                    emitterId: fiscalForm.emitterId || undefined,
                    customerId: fiscalForm.customerId,
                    profileId: fiscalForm.profileId,
                    originState: fiscalForm.originState || undefined,
                    destinationState: fiscalForm.destinationState || undefined,
                    docType: fiscalForm.docType,
                    environment: fiscalForm.environment,
                    items: payloadItems,
                  })
                  setDraftStatus('Rascunho fiscal criado com sucesso.')
                  setDraftXml(result.xml ?? '')
                  setSelectedDocumentId(result.documentId)
                  setDocumentsOffset(0)
                  refreshDocuments()
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : 'Erro ao gerar rascunho fiscal.'
                  setDraftStatus(message)
                }
              }}
            >
              Gerar rascunho fiscal
            </button>
          </div>
        </div>

        {draftXml && <pre className="xml-preview">{draftXml}</pre>}
      </div>
      </TabPanel>

      <TabPanel active={fiscalTab === 'documents'}>
      <div className="card fiscal-card">
        <div className="fiscal-grid">
          <label>
            Buscar documento
            <input
              value={documentsQuery}
              placeholder="Destinatário, número ou chave"
              onChange={(event) => {
                setDocumentsQuery(event.target.value)
                setDocumentsOffset(0)
              }}
            />
          </label>
          <label>
            Tipo
            <Select
              value={documentsTypeFilter}
              options={docTypeOptions}
              onChange={(value) => {
                setDocumentsTypeFilter(value as FiscalDocumentType | '')
                setDocumentsOffset(0)
              }}
            />
          </label>
          <label>
            Status do documento
            <Select
              value={documentsStatusFilter}
              options={docStatusOptions}
              onChange={(value) => {
                setDocumentsStatusFilter(value as FiscalDocumentStatus | '')
                setDocumentsOffset(0)
              }}
            />
          </label>
        </div>

        <div className="finance-table-wrapper">
          <table className="finance-table">
            <thead>
              <tr>
                <th>Emissão</th>
                <th>Tipo</th>
                <th>Emitente</th>
                <th>Destinatário</th>
                <th>Total</th>
                <th>Status</th>
                <th>Fila</th>
                <th>Ações</th>
              </tr>
            </thead>
            <tbody>
              {documentsRows.length === 0 && (
                <tr>
                  <td colSpan={8}>Nenhum documento fiscal encontrado com os filtros atuais.</td>
                </tr>
              )}
              {documentsRows.map((document) => (
                <tr key={document.id}>
                  <td>{fmtDateFull(document.issueDate ?? document.createdAt)}</td>
                  <td>{docTypeLabel(document.docType)}</td>
                  <td>{document.emitterName || 'Emitente padrão'}</td>
                  <td>{document.recipientName || 'Sem destinatário'}</td>
                  <td>{fmtCurrency(document.totalInvoice)}</td>
                  <td>
                    <span className={`fiscal-status-badge ${docStatusTone(document.status)}`}>
                      {docStatusLabel(document.status)}
                    </span>
                  </td>
                  <td>
                    <span className={`fiscal-status-badge ${transmissionStatusTone(document.transmissionStatus)}`}>
                      {transmissionStatusLabel(document.transmissionStatus)}
                    </span>
                    <br />
                    <small className="hint">{transmissionProviderLabel(document.transmissionProvider)}</small>
                    {document.transmissionResponseCode && (
                      <>
                        <br />
                        <small className="hint">Código: {document.transmissionResponseCode}</small>
                      </>
                    )}
                  </td>
                  <td>
                    <div className="actions">
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => setSelectedDocumentId(document.id)}
                      >
                        {selectedDocumentId === document.id ? 'Selecionado' : 'Selecionar'}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void queueDocument(document)
                        }}
                        disabled={transmissionBusy || !canQueueTransmission(document)}
                      >
                        {canQueueTransmission(document) ? 'Enfileirar' : 'Fila indisponível'}
                      </button>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() => {
                          void printDocumentSummary(document)
                        }}
                      >
                        Imprimir
                      </button>
                      {document.status === 'authorized' && (
                        <>
                          {can(userRole, 'fiscal.cce') && (
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => {
                                const correction = prompt('Texto da Carta de Correção (mín. 15 caracteres):')
                                if (correction && correction.length >= 15) {
                                  void (async () => {
                                    try {
                                      const { createCce } = await import('../../services/fiscal')
                                      await createCce(document.id, correction)
                                      setTransmissionStatus('CC-e registrada com sucesso.')
                                    } catch (err) {
                                      setTransmissionStatus(err instanceof Error ? err.message : 'Erro ao registrar CC-e.')
                                    }
                                  })()
                                }
                              }}
                            >
                              CC-e
                            </button>
                          )}
                          {can(userRole, 'fiscal.cancel') && (
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => {
                                const justification = prompt('Justificativa para cancelamento (mín. 15 caracteres):')
                                if (justification && justification.length >= 15) {
                                  void (async () => {
                                    try {
                                      const { cancelFiscalDocument } = await import('../../services/fiscal')
                                      await cancelFiscalDocument(document.id, justification)
                                      setTransmissionStatus('Documento cancelado com sucesso.')
                                      refreshDocuments()
                                    } catch (err) {
                                      setTransmissionStatus(err instanceof Error ? err.message : 'Erro ao cancelar.')
                                    }
                                  })()
                                }
                              }}
                            >
                              Cancelar
                            </button>
                          )}
                          {can(userRole, 'fiscal.manifest') && (
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => {
                                void (async () => {
                                  try {
                                    const { manifestFiscalDocument } = await import('../../services/fiscal')
                                    await manifestFiscalDocument(document.id, 'confirmacao')
                                    setTransmissionStatus('Manifestação de confirmação registrada.')
                                  } catch (err) {
                                    setTransmissionStatus(err instanceof Error ? err.message : 'Erro na manifestação.')
                                  }
                                })()
                              }}
                            >
                              Manifestar
                            </button>
                          )}
                        </>
                      )}
                      <button
                        type="button"
                        className="ghost"
                        style={{ fontSize: '0.72rem' }}
                        onClick={() => {
                          void (async () => {
                            try {
                              const { fetchFiscalDocumentXml } = await import('../../services/fiscal')
                              const xml = await fetchFiscalDocumentXml(document.id)
                              const blob = new Blob([xml], { type: 'application/xml;charset=utf-8;' })
                              const url = globalThis.URL.createObjectURL(blob)
                              const a = globalThis.document.createElement('a')
                              a.href = url
                              a.download = `${docTypeLabel(document.docType)}-${document.id.slice(0, 8)}.xml`
                              globalThis.document.body.appendChild(a)
                              a.click()
                              a.remove()
                              globalThis.URL.revokeObjectURL(url)
                            } catch (err) {
                              setTransmissionStatus(err instanceof Error ? err.message : 'Erro ao baixar XML.')
                            }
                          })()
                        }}
                      >
                        XML
                      </button>
                      {(document.transmissionStatus === 'error' || document.transmissionStatus === 'rejected') && (
                        <button
                          type="button"
                          className="ghost"
                          style={{ fontSize: '0.72rem' }}
                          disabled={transmissionBusy}
                          onClick={() => void queueDocument(document)}
                        >
                          Reenviar
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="actions fiscal-pagination-row">
          <p className="hint fiscal-pagination-info">{documentsPageInfo}</p>
          <div className="actions">
            <button
              type="button"
              className="ghost"
              onClick={() => setDocumentsOffset((value) => Math.max(value - DOCUMENTS_PAGE_SIZE, 0))}
              disabled={documentsLoading || documentsOffset === 0}
            >
              Página anterior
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => setDocumentsOffset((value) => value + DOCUMENTS_PAGE_SIZE)}
              disabled={documentsLoading || !canGoNextDocumentsPage}
            >
              Próxima página
            </button>
          </div>
        </div>

        <div className="divider" />

        {selectedDocument && (
          <>
            <p className="subtitle">
              Documento selecionado: {docTypeLabel(selectedDocument.docType)} · {selectedDocument.emitterName || 'Emitente padrão'} · {selectedDocument.recipientName || 'Sem destinatário'} · {fmtCurrency(selectedDocument.totalInvoice)}
            </p>
            <p className="hint">
              Última transmissão:{' '}
              <span className={`fiscal-status-badge ${transmissionStatusTone(selectedDocument.transmissionStatus)}`}>
                {transmissionStatusLabel(selectedDocument.transmissionStatus)}
              </span>{' '}
              · {transmissionProviderLabel(selectedDocument.transmissionProvider)}
              {selectedDocument.transmissionProviderReference
                ? ` · Ref.: ${selectedDocument.transmissionProviderReference}`
                : ''}
              {selectedDocument.transmissionResponseCode
                ? ` · Código: ${selectedDocument.transmissionResponseCode}`
                : ''}
              {selectedDocument.transmissionResponseMessage
                ? ` · Msg: ${selectedDocument.transmissionResponseMessage}`
                : ''}
            </p>

            <h4>Histórico de transmissões</h4>

            <div className="finance-table-wrapper">
              <table className="finance-table">
                <thead>
                  <tr>
                    <th>Atualização</th>
                    <th>Status</th>
                    <th>Provedor</th>
                    <th>Ref.</th>
                    <th>Código</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {transmissionsRows.length === 0 && (
                    <tr>
                      <td colSpan={6}>Nenhuma transmissão encontrada para este documento.</td>
                    </tr>
                  )}
                  {transmissionsRows.map((row) => (
                    <tr key={row.id}>
                      <td>{fmtDateFull(row.updatedAt)}</td>
                      <td>
                        <span className={`fiscal-status-badge ${transmissionStatusTone(row.status)}`}>
                          {transmissionStatusLabel(row.status)}
                        </span>
                      </td>
                      <td>{transmissionProviderLabel(row.provider)}</td>
                      <td>{row.providerReference ?? '—'}</td>
                      <td>{row.responseCode ?? '—'}</td>
                      <td>
                        <button
                          type="button"
                          className="ghost"
                          onClick={() => selectTransmissionRow(row)}
                        >
                          {transmissionForm.transmissionId === row.id ? 'Selecionada' : 'Selecionar'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="actions fiscal-pagination-row">
              <p className="hint fiscal-pagination-info">{transmissionsPageInfo}</p>
              <div className="actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setTransmissionsOffset((value) => Math.max(value - TRANSMISSIONS_PAGE_SIZE, 0))}
                  disabled={transmissionsLoading || transmissionsOffset === 0}
                >
                  Página anterior
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setTransmissionsOffset((value) => value + TRANSMISSIONS_PAGE_SIZE)}
                  disabled={transmissionsLoading || !canGoNextTransmissionsPage}
                >
                  Próxima página
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => refreshTransmissions()}
                  disabled={transmissionsLoading}
                >
                  'Atualizar histórico'
                </button>
              </div>
            </div>

            <div className="fiscal-grid">
              <label>
                Provedor fiscal
                <Select
                  value={transmissionForm.provider}
                  options={[{ value: 'plugnotas', label: 'PlugNotas' }]}
                  onChange={(value) =>
                    setTransmissionForm((state) => ({
                      ...state,
                      provider: value as FiscalTransmissionProvider,
                    }))
                  }
                />
              </label>
              <label>
                Status da transmissão
                <Select
                  value={transmissionForm.status}
                  options={transmissionStatusOptions}
                  onChange={(value) =>
                    setTransmissionForm((state) => ({
                      ...state,
                      status: value as typeof state.status,
                    }))
                  }
                />
              </label>
              <label>
                Código de retorno
                <input
                  value={transmissionForm.responseCode}
                  placeholder="Ex.: 100"
                  onChange={(event) =>
                    setTransmissionForm((state) => ({ ...state, responseCode: event.target.value }))
                  }
                />
              </label>
              <label>
                Mensagem de retorno
                <input
                  value={transmissionForm.responseMessage}
                  placeholder="Mensagem da SEFAZ/provedor"
                  onChange={(event) =>
                    setTransmissionForm((state) => ({ ...state, responseMessage: event.target.value }))
                  }
                />
              </label>
              <label>
                Formato da impressão
                <Select
                  value={documentPrintPreset}
                  options={printPresetOptions.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  onChange={(value) => setDocumentPrintPreset(value as PrintPreset)}
                />
              </label>
            </div>

            <div className="actions">
              <button
                type="button"
                onClick={() => {
                  void queueDocument(selectedDocument)
                }}
                disabled={transmissionBusy || !canQueueTransmission(selectedDocument)}
              >
                Enfileirar documento selecionado
              </button>
              <button
                type="button"
                onClick={() => {
                  void processSelectedTransmission()
                }}
                disabled={transmissionBusy || !transmissionForm.transmissionId}
              >
                Processar no provedor
              </button>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  void printDocumentSummary(selectedDocument)
                }}
              >
                Imprimir resumo
              </button>
              <button
                type="button"
                className="ghost"
                onClick={async () => {
                  if (!transmissionForm.transmissionId) {
                    setTransmissionStatus('Enfileire o documento antes de atualizar o status da transmissão.')
                    return
                  }

                  setTransmissionBusy(true)
                  try {
                    const result = await updateFiscalTransmission({
                      id: transmissionForm.transmissionId,
                      status: transmissionForm.status,
                      responseCode: transmissionForm.responseCode || undefined,
                      responseMessage: transmissionForm.responseMessage || undefined,
                    })
                    setTransmissionForm((state) => ({
                      ...state,
                      provider: result.provider ?? state.provider,
                      status: result.status,
                      responseCode: result.responseCode ?? '',
                      responseMessage: result.responseMessage ?? '',
                    }))
                    setTransmissionStatus(
                      result.documentStatus === 'authorized'
                        ? 'Status atualizado: documento autorizado.'
                        : `Status de transmissão atualizado para ${transmissionStatusLabel(result.status)}.`,
                    )
                    refreshDocuments()
                    refreshTransmissions()
                  } catch (error) {
                    const message =
                      error instanceof Error
                        ? error.message
                        : 'Erro ao atualizar status da transmissão.'
                    setTransmissionStatus(message)
                  } finally {
                    setTransmissionBusy(false)
                  }
                }}
                disabled={transmissionBusy || !transmissionForm.transmissionId}
              >
                Atualizar status
              </button>
            </div>
          </>
        )}

      </div>
      </TabPanel>
    </div>
  )
}
