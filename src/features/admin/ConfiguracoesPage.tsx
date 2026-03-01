import { useEffect, useState } from 'react'
import { useStatusToast } from '../../hooks/useStatusToast'
import { fetchSettings, updateSettings, type OrgSettings } from '../../services/settings'
import {
  createBankIntegration,
  fetchBankIntegrations,
  toggleBankIntegration,
  fetchWebhookEvents,
  fetchFinancialAccounts,
  createFinancialAccount,
  type BankIntegrationLookup,
  type WebhookEventLookup,
  type FinancialAccountLookup,
} from '../../services/bank'
import { createSintegraExport, generateSintegraExport, fetchSintegraExports, type SintegraExportLookup } from '../../services/sintegra'
import { DateInput, Select, StatusBadge, Tabs, PageHeader } from '../../components/ui'
import { fmtDate, fmtDateTime, fmtCurrency } from '../../lib/formatters'

const TAX_REGIME_OPTIONS = [
  { value: 'simples_nacional', label: 'Simples Nacional' },
  { value: 'lucro_presumido', label: 'Lucro Presumido' },
  { value: 'lucro_real', label: 'Lucro Real' },
  { value: 'mei', label: 'MEI' },
]

const STATES = [
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'
]

type SettingsTab = 'empresa' | 'pdv' | 'fiscal' | 'notificacoes' | 'preferencias' | 'bancario' | 'webhooks' | 'sintegra' | 'contas'

const intApiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000'
const PL: Record<string, string> = { pix: 'PIX', boleto: 'Boleto', bank_api: 'API Bancária' }
const ATL: Record<string, string> = { bank: 'Banco', cash: 'Caixa', card: 'Cartão' }

export function ConfiguracoesPage() {
  const [tab, setTab] = useState<SettingsTab>('empresa')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  useStatusToast(msg)

  const [form, setForm] = useState<Partial<OrgSettings>>({})
  const [pdvSettings, setPdvSettings] = useState({
    fundoCaixa: '',
    emitirNfce: false,
    serieNfce: '1',
    impressora: '',
  })
  const [fiscalSettings, setFiscalSettings] = useState({
    serieNfe: '1',
    proximoNumero: '',
    ambiente: 'homologation',
  })
  const [notifSettings, setNotifSettings] = useState({
    emailEstoque: '',
    emailNfRejeitada: '',
    emailVencimentos: '',
  })
  const [prefSettings, setPrefSettings] = useState({
    descontoMaxVendedor: '10',
  })

  const [integrations, setIntegrations] = useState<BankIntegrationLookup[]>([])
  const [webhooks, setWebhooks] = useState<WebhookEventLookup[]>([])
  const [sintegraExports, setSintegraExports] = useState<SintegraExportLookup[]>([])
  const [accounts, setAccounts] = useState<FinancialAccountLookup[]>([])
  const [showIntForm, setShowIntForm] = useState(false)
  const [bankForm, setBankForm] = useState<{ provider: 'pix' | 'boleto' | 'bank_api'; name: string }>({ provider: 'pix', name: '' })
  const [sintegraForm, setSintegraForm] = useState({ periodStart: '', periodEnd: '' })
  const [accountForm, setAccountForm] = useState<{ name: string; type: 'bank' | 'cash' | 'card' }>({ name: '', type: 'bank' })

  const loadIntTab = async (t: SettingsTab) => {
    setLoading(true)
    try {
      if (t === 'bancario') setIntegrations(await fetchBankIntegrations())
      else if (t === 'webhooks') setWebhooks(await fetchWebhookEvents(50))
      else if (t === 'sintegra') setSintegraExports(await fetchSintegraExports())
      else if (t === 'contas') setAccounts(await fetchFinancialAccounts())
    } catch (e) { flash(e instanceof Error ? e.message : 'Erro ao carregar.') }
    setLoading(false)
  }

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000) }

  useEffect(() => {
    const load = async () => {
      try {
        const data = await fetchSettings()
        if (data) {
          setForm(data)
          const s = data.settings ?? {}
          setPdvSettings({
            fundoCaixa: String((s.fundoCaixa as number) ?? ''),
            emitirNfce: Boolean(s.emitirNfce ?? false),
            serieNfce: String((s.serieNfce as string) ?? '1'),
            impressora: String((s.impressora as string) ?? ''),
          })
          setFiscalSettings({
            serieNfe: String((s.serieNfe as string) ?? '1'),
            proximoNumero: String((s.proximoNumero as string) ?? ''),
            ambiente: String((s.ambiente as string) ?? 'homologation'),
          })
          setNotifSettings({
            emailEstoque: String((s.emailEstoque as string) ?? ''),
            emailNfRejeitada: String((s.emailNfRejeitada as string) ?? ''),
            emailVencimentos: String((s.emailVencimentos as string) ?? ''),
          })
          setPrefSettings({
            descontoMaxVendedor: String((s.descontoMaxVendedor as number) ?? '10'),
          })
        }
      } catch (e) { setMsg(e instanceof Error ? e.message : 'Erro ao carregar configurações.') }
      setLoading(false)
    }
    void load()
  }, [])

  const handleSave = async () => {
    setSaving(true)
    try {
      await updateSettings({
        ...form,
        settings: {
          ...pdvSettings,
          fundoCaixa: Number(pdvSettings.fundoCaixa) || 0,
          ...fiscalSettings,
          proximoNumero: Number(fiscalSettings.proximoNumero) || null,
          ...notifSettings,
          ...prefSettings,
          descontoMaxVendedor: Number(prefSettings.descontoMaxVendedor) || 10,
        },
      })
      flash('Configurações salvas com sucesso.')
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Erro ao salvar.')
    }
    setSaving(false)
  }

  const set = (key: keyof OrgSettings, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const tabs: { key: SettingsTab; label: string }[] = [
    { key: 'empresa', label: 'Empresa' },
    { key: 'pdv', label: 'PDV' },
    { key: 'fiscal', label: 'Fiscal' },

    { key: 'preferencias', label: 'Preferências' },
    { key: 'bancario', label: 'Bancário' },
    { key: 'webhooks', label: 'Webhooks' },
    { key: 'sintegra', label: 'Sintegra' },
    { key: 'contas', label: 'Contas' },
  ]

  const handleTabChange = (t: SettingsTab) => {
    setTab(t)
    setShowIntForm(false)
    if (['bancario', 'webhooks', 'sintegra', 'contas'].includes(t)) void loadIntTab(t)
  }

  return (
    <div className="page">
      <PageHeader />

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
        <button type="button" onClick={handleSave} disabled={saving}>
          {saving ? 'Processando...' : 'Confirmar Configurações'}
        </button>
      </div>

      <Tabs tabs={tabs} active={tab} onChange={handleTabChange} />

      {tab === 'empresa' && (
        <div className="card" style={{ padding: '20px 24px' }}>
          <div className="fiscal-grid">
            <label>
              Nome fantasia *
              <input value={form.name ?? ''} onChange={(e) => set('name', e.target.value)} />
            </label>
            <label>
              Razão social
              <input value={form.legalName ?? ''} onChange={(e) => set('legalName', e.target.value)} />
            </label>
            <label>
              CNPJ
              <input value={form.cnpj ?? ''} placeholder="00.000.000/0000-00" onChange={(e) => set('cnpj', e.target.value)} />
            </label>
            <label>
              Inscrição Estadual (IE)
              <input value={form.ie ?? ''} onChange={(e) => set('ie', e.target.value)} />
            </label>
            <label>
              Inscrição Municipal (IM)
              <input value={form.im ?? ''} onChange={(e) => set('im', e.target.value)} />
            </label>
            <label>
              Regime tributário
              <Select
                value={form.taxRegime ?? 'simples_nacional'}
                options={TAX_REGIME_OPTIONS}
                onChange={(v) => set('taxRegime', v as OrgSettings['taxRegime'])}
              />
            </label>
            <label>
              Telefone
              <input value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} />
            </label>
            <label>
              E-mail
              <input type="email" value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} />
            </label>
            <label>
              Website
              <input value={form.website ?? ''} placeholder="https://..." onChange={(e) => set('website', e.target.value)} />
            </label>
            <label>
              Logo (URL)
              <input value={form.logoUrl ?? ''} placeholder="https://..." onChange={(e) => set('logoUrl', e.target.value)} />
            </label>
          </div>
          <div className="divider" />
          <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: 8 }}>Endereço da empresa (usado em NF-e)</p>
          <div className="cadastro-form-grid">
            <label>
              CEP
              <input value={form.addressZip ?? ''} placeholder="00000-000" onChange={(e) => set('addressZip', e.target.value)} />
            </label>
            <label>
              Logradouro
              <input value={form.addressStreet ?? ''} onChange={(e) => set('addressStreet', e.target.value)} />
            </label>
            <label>
              Número
              <input value={form.addressNumber ?? ''} onChange={(e) => set('addressNumber', e.target.value)} />
            </label>
            <label>
              Complemento
              <input value={form.addressComplement ?? ''} onChange={(e) => set('addressComplement', e.target.value)} />
            </label>
            <label>
              Bairro
              <input value={form.addressNeighborhood ?? ''} onChange={(e) => set('addressNeighborhood', e.target.value)} />
            </label>
            <label>
              Cidade
              <input value={form.addressCity ?? ''} onChange={(e) => set('addressCity', e.target.value)} />
            </label>
            <label>
              UF
              <Select
                value={form.addressState ?? ''}
                options={[{ value: '', label: '(UF)' }, ...STATES.map((s) => ({ value: s, label: s }))]}
                onChange={(v) => set('addressState', v)}
              />
            </label>
          </div>
        </div>
      )}

      {tab === 'pdv' && (
        <div className="cadastro-panel">
          <div className="cadastro-form-grid">
            <label>
              Fundo de caixa padrão (R$)
              <input type="number" step="0.01" min="0" value={pdvSettings.fundoCaixa} onChange={(e) => setPdvSettings((s) => ({ ...s, fundoCaixa: e.target.value }))} placeholder="0,00" />
            </label>
          </div>
        </div>
      )}

      {tab === 'fiscal' && (
        <div className="cadastro-panel">
          <div className="cadastro-form-grid">
            <label>
              Série padrão NF-e
              <input value={fiscalSettings.serieNfe} onChange={(e) => setFiscalSettings((s) => ({ ...s, serieNfe: e.target.value }))} />
            </label>
            <label>
              Próximo número NF-e
              <input type="number" value={fiscalSettings.proximoNumero} onChange={(e) => setFiscalSettings((s) => ({ ...s, proximoNumero: e.target.value }))} placeholder="1" />
            </label>
            <label>
              Ambiente
              <Select
                value={fiscalSettings.ambiente}
                options={[
                  { value: 'homologation', label: 'Homologação (testes)' },
                  { value: 'production', label: 'Produção' },
                ]}
                onChange={(v) => setFiscalSettings((s) => ({ ...s, ambiente: v }))}
              />
            </label>
          </div>
        </div>
      )}


      {tab === 'preferencias' && (
        <div className="cadastro-panel">
          <div className="cadastro-form-grid">
            <label>
              Desconto máximo para vendedor (%)
              <input type="number" min="0" max="100" step="1" value={prefSettings.descontoMaxVendedor} onChange={(e) => setPrefSettings((s) => ({ ...s, descontoMaxVendedor: e.target.value }))} />
            </label>
          </div>
        </div>
      )}

      {/* ===== BANCÁRIO ===== */}
      {tab === 'bancario' && !loading && (
        <div className="cadastro-panel">
          <div className="cadastro-toolbar">
            <span style={{ flex: 1 }}>{integrations.length} integração(ões)</span>
            <button type="button" onClick={() => setShowIntForm(!showIntForm)}>{showIntForm ? 'Cancelar' : 'Nova Integração'}</button>
          </div>
          {showIntForm && (
            <div className="cadastro-form">
              <h3>Nova Integração</h3>
              <div className="cadastro-form-grid">
                <label>Provedor
                  <Select value={bankForm.provider} options={[{ value: 'pix', label: 'PIX' }, { value: 'boleto', label: 'Boleto' }, { value: 'bank_api', label: 'API Bancária' }]}
                    onChange={(v) => setBankForm((s) => ({ ...s, provider: v as 'pix' | 'boleto' | 'bank_api' }))} />
                </label>
                <label>Nome<input value={bankForm.name} onChange={(e) => setBankForm((s) => ({ ...s, name: e.target.value }))} /></label>
              </div>
              <div className="actions">
                <button type="button" disabled={!bankForm.name.trim()} onClick={async () => {
                  try {
                    await createBankIntegration({ provider: bankForm.provider, name: bankForm.name })
                    flash('Integração criada.'); setShowIntForm(false); setBankForm({ provider: 'pix', name: '' }); void loadIntTab('bancario')
                  } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
                }}>Confirmar</button>
              </div>
            </div>
          )}
          <div className="cadastro-list">
            {integrations.map((i) => (
              <div key={i.id} className="cadastro-row">
                <div>
                  <span className="cadastro-row-name">{i.name || PL[i.provider] || i.provider}</span>
                  <span className="cadastro-row-meta"> — {PL[i.provider] || i.provider}</span>
                </div>
                <div className="row-actions">
                  <StatusBadge status={i.active ? 'active' : 'inactive'} />
                  <button type="button" className={`btn-inline ${i.active ? 'off' : 'ok'}`} onClick={async () => {
                    try { await toggleBankIntegration(i.id); void loadIntTab('bancario') } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
                  }}>{i.active ? 'Desativar' : 'Ativar'}</button>
                </div>
              </div>
            ))}
            {integrations.length === 0 && null}
          </div>
        </div>
      )}

      {/* ===== WEBHOOKS ===== */}
      {tab === 'webhooks' && !loading && (
        <div className="cadastro-panel">
          <div className="cadastro-toolbar"><span style={{ flex: 1 }}>{webhooks.length} evento(s)</span></div>
          <div className="cadastro-list">
            {webhooks.map((w) => (
              <div key={w.id} className="cadastro-row" style={{ cursor: 'default' }}>
                <div>
                  <span className="cadastro-row-name">{w.eventType}</span>
                  {w.integrationName && <span className="cadastro-row-meta"> — {w.integrationName}</span>}
                </div>
                <div className="row-actions">
                  <span className="cadastro-row-meta">{fmtDateTime(w.createdAt)}</span>
                  <StatusBadge status={w.status} />
                </div>
              </div>
            ))}
            {webhooks.length === 0 && null}
          </div>
        </div>
      )}

      {/* ===== SINTEGRA ===== */}
      {tab === 'sintegra' && !loading && (
        <div className="cadastro-panel">
          <div className="cadastro-toolbar">
            <span style={{ flex: 1 }}>{sintegraExports.length} exportação(ões)</span>
            <button type="button" onClick={() => setShowIntForm(!showIntForm)}>{showIntForm ? 'Cancelar' : 'Nova Exportação'}</button>
          </div>
          {showIntForm && (
            <div className="cadastro-form">
              <h3>Nova Exportação Sintegra</h3>
              <div className="cadastro-form-grid">
                <label>Início<DateInput value={sintegraForm.periodStart} onChange={(e) => setSintegraForm((s) => ({ ...s, periodStart: e.target.value }))} /></label>
                <label>Fim<DateInput value={sintegraForm.periodEnd} onChange={(e) => setSintegraForm((s) => ({ ...s, periodEnd: e.target.value }))} /></label>
              </div>
              <div className="actions">
                <button type="button" disabled={!sintegraForm.periodStart || !sintegraForm.periodEnd} onClick={async () => {
                  try {
                    await createSintegraExport({ periodStart: sintegraForm.periodStart, periodEnd: sintegraForm.periodEnd })
                    flash('Exportação criada.'); setShowIntForm(false); setSintegraForm({ periodStart: '', periodEnd: '' }); void loadIntTab('sintegra')
                  } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
                }}>Criar</button>
              </div>
            </div>
          )}
          <div className="cadastro-list">
            {sintegraExports.map((se) => (
              <div key={se.id} className="cadastro-row">
                <div><span className="cadastro-row-name">{fmtDate(se.periodStart)} — {fmtDate(se.periodEnd)}</span></div>
                <div className="row-actions">
                  <StatusBadge status={se.status} />
                  {se.status === 'draft' && (
                    <button type="button" className="btn-inline ok" onClick={async () => {
                      try { await generateSintegraExport(se.id); flash('Arquivo gerado.'); void loadIntTab('sintegra') } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
                    }}>Gerar</button>
                  )}
                  {se.status === 'generated' && (
                    <a href={`${intApiUrl}/sintegra/exports/${se.id}/download`} target="_blank" rel="noreferrer" className="btn-inline ok" style={{ textDecoration: 'none' }}>Download</a>
                  )}
                </div>
              </div>
            ))}
            {sintegraExports.length === 0 && null}
          </div>
        </div>
      )}

      {/* ===== CONTAS FINANCEIRAS ===== */}
      {tab === 'contas' && !loading && (
        <div className="cadastro-panel">
          <div className="cadastro-toolbar">
            <span style={{ flex: 1 }}>{accounts.length} conta(s)</span>
            <button type="button" onClick={() => setShowIntForm(!showIntForm)}>{showIntForm ? 'Cancelar' : 'Nova Conta'}</button>
          </div>
          {showIntForm && (
            <div className="cadastro-form">
              <h3>Nova Conta Financeira</h3>
              <div className="cadastro-form-grid">
                <label>Nome<input value={accountForm.name} onChange={(e) => setAccountForm((s) => ({ ...s, name: e.target.value }))} /></label>
                <label>Tipo
                  <Select value={accountForm.type} options={[{ value: 'bank', label: 'Banco' }, { value: 'cash', label: 'Caixa' }, { value: 'card', label: 'Cartão' }]}
                    onChange={(v) => setAccountForm((s) => ({ ...s, type: v as 'bank' | 'cash' | 'card' }))} />
                </label>
              </div>
              <div className="actions">
                <button type="button" disabled={!accountForm.name.trim()} onClick={async () => {
                  try {
                    await createFinancialAccount({ name: accountForm.name, type: accountForm.type })
                    flash('Conta criada.'); setShowIntForm(false); setAccountForm({ name: '', type: 'bank' }); void loadIntTab('contas')
                  } catch (e) { flash(e instanceof Error ? e.message : 'Erro.') }
                }}>Confirmar</button>
              </div>
            </div>
          )}
          <div className="cadastro-list">
            {accounts.map((a) => (
              <div key={a.id} className="cadastro-row" style={{ cursor: 'default' }}>
                <div>
                  <span className="cadastro-row-name">{a.name}</span>
                  <span className="cadastro-row-meta"> — {ATL[a.type] ?? a.type}</span>
                </div>
                <span className="cadastro-row-meta">{fmtCurrency(a.balance)}</span>
              </div>
            ))}
            {accounts.length === 0 && null}
          </div>
        </div>
      )}
    </div>
  )
}
