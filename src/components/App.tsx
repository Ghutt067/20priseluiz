import { useEffect, useMemo, useState } from 'react'
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { KeepAlive } from './ui/KeepAlive'
import { AppShell } from './layout/AppShell'
import { modeHome, modulesForMode, modeLabels } from '../config/modes'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { ComprasPage } from '../features/purchases/ComprasPage'
import { VendasPage } from '../features/sales/VendasPage'
import { EstoquePage } from '../features/inventory/EstoquePage'
import { FinanceiroWorkspace } from '../features/finance/FinanceiroWorkspace'
import { RelatoriosPage } from '../features/finance/RelatoriosPage'
import { FiscalPage } from '../features/fiscal/FiscalPage'
import { ServicosPage } from '../features/service/ServicosPage'
import { CrmPage } from '../features/crm/CrmPage'
import { PdvPage } from '../features/pos/PdvPage'
import { ContratosPage } from '../features/finance/ContratosPage'
import { FrotaPage } from '../features/fleet/FrotaPage'
import { ProducaoPage } from '../features/mrp/ProducaoPage'
import { WmsPage } from '../features/wms/WmsPage'
import { PatrimonioPage } from '../features/assets/PatrimonioPage'
import { ProjetosPage } from '../features/projects/ProjetosPage'
import { ComexPage } from '../features/comex/ComexPage'
import { QualidadePage } from '../features/quality/QualidadePage'
import { TesourariaPage } from '../features/treasury/TesourariaPage'
import { AutomacaoPage } from '../features/automation/AutomacaoPage'
import { EsgPage } from '../features/esg/EsgPage'
import { FranquiasPage } from '../features/franchise/FranquiasPage'
import { CadastrosPage } from '../features/core/CadastrosPage'
import { CommandPalette } from './ui/CommandPalette'
import { LoginPage } from '../features/auth/LoginPage'
import { SignupPage } from '../features/auth/SignupPage'
import { TeamPage } from '../features/admin/TeamPage'
import { ConfiguracoesPage } from '../features/admin/ConfiguracoesPage'
import { useAuth } from '../contexts/useAuth'
import { useRipple } from '../hooks/useRipple'
import '../styles/app.css'

function App() {
  useRipple()
  const [search, setSearch] = useState('')
  const navigate = useNavigate()
  const location = useLocation()
  const { user, role, loading, organizationId } = useAuth()
  const [pendingUpdate, setPendingUpdate] = useState<{
    downloadAndInstall: () => Promise<void>
  } | null>(null)
  const [updateInstalling, setUpdateInstalling] = useState(false)

  const mode = role ?? 'chefe'

  const allowedPaths = useMemo(
    () => new Set(modulesForMode(mode).map((module) => module.path)),
    [mode],
  )

  useEffect(() => {
    if (!user) return
    if (location.pathname === '/login' || location.pathname === '/signup') {
      navigate(modeHome[mode], { replace: true })
      return
    }
    const isAllowed = allowedPaths.has(location.pathname)
    if (!isAllowed) {
      navigate(modeHome[mode], { replace: true })
    }
  }, [allowedPaths, location.pathname, mode, navigate, user])

  useEffect(() => {
    const tauriDetected = globalThis.window !== undefined && '__TAURI__' in globalThis.window
    if (!tauriDetected) return

    let cancelled = false

    const checkUpdates = async () => {
      try {
        const { check } = await import('@tauri-apps/plugin-updater')
        const update = await check()

        if (!update || cancelled) {
          return
        }
        setPendingUpdate(update)
      } catch (error) {
        console.info('Updater indisponível.', error)
      }
    }

    void checkUpdates()
    const timer = globalThis.window.setInterval(checkUpdates, 30000)

    return () => {
      cancelled = true
      globalThis.window.clearInterval(timer)
    }
  }, [])

  const handleUpdateInstall = async () => {
    if (!pendingUpdate || updateInstalling) return
    setUpdateInstalling(true)
    try {
      await pendingUpdate.downloadAndInstall()
    } catch (error) {
      console.info('Falha ao instalar a atualização.', error)
      setUpdateInstalling(false)
    }
  }

  if (loading) {
    if (location.pathname === '/login') return <LoginPage />
    if (location.pathname === '/signup') return <SignupPage />
    return (
      <AppShell mode={mode} roleLabel={modeLabels[mode]} search={search} onSearchChange={setSearch}>
        {null}
      </AppShell>
    )
  }

  if (!loading && !user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="*" element={<Navigate to="/signup" replace />} />
      </Routes>
    )
  }

  if (!organizationId) {
    return (
      <AppShell mode={mode} roleLabel={modeLabels[mode]} search={search} onSearchChange={setSearch}>
        {null}
      </AppShell>
    )
  }

  return (
    <AppShell
      mode={mode}
      roleLabel={modeLabels[mode]}
      search={search}
      onSearchChange={setSearch}
    >
      {pendingUpdate && (
        <div className="update-toast">
          <output aria-live="polite">Nova versão do ERP disponível.</output>
          <button
            type="button"
            onClick={handleUpdateInstall}
            disabled={updateInstalling}
          >
            {updateInstalling ? 'Instalando...' : 'Atualizar sistema'}
          </button>
        </div>
      )}
      <CommandPalette mode={mode} />
      <KeepAlive path="/dashboard" fallback><DashboardPage /></KeepAlive>
      <KeepAlive path="/compras"><ComprasPage /></KeepAlive>
      <KeepAlive path="/vendas"><VendasPage /></KeepAlive>
      <KeepAlive path="/estoque"><EstoquePage /></KeepAlive>
      <KeepAlive path="/financeiro"><FinanceiroWorkspace /></KeepAlive>
      <KeepAlive path="/relatorios"><RelatoriosPage /></KeepAlive>
      <KeepAlive path="/fiscal"><FiscalPage /></KeepAlive>
      <KeepAlive path="/servicos"><ServicosPage /></KeepAlive>
      <KeepAlive path="/crm"><CrmPage /></KeepAlive>
      <KeepAlive path="/pdv"><PdvPage /></KeepAlive>
      <KeepAlive path="/contratos"><ContratosPage /></KeepAlive>
      <KeepAlive path="/frota"><FrotaPage /></KeepAlive>
      <KeepAlive path="/producao"><ProducaoPage /></KeepAlive>
      <KeepAlive path="/wms"><WmsPage /></KeepAlive>
      <KeepAlive path="/patrimonio"><PatrimonioPage /></KeepAlive>
      <KeepAlive path="/projetos"><ProjetosPage /></KeepAlive>
      <KeepAlive path="/comex"><ComexPage /></KeepAlive>
      <KeepAlive path="/qualidade"><QualidadePage /></KeepAlive>
      <KeepAlive path="/tesouraria"><TesourariaPage /></KeepAlive>
      <KeepAlive path="/automacao"><AutomacaoPage /></KeepAlive>
      <KeepAlive path="/esg"><EsgPage /></KeepAlive>
      <KeepAlive path="/franquias"><FranquiasPage /></KeepAlive>
      <KeepAlive path="/cadastros"><CadastrosPage /></KeepAlive>
      <KeepAlive path="/equipe"><TeamPage /></KeepAlive>
      <KeepAlive path="/configuracoes"><ConfiguracoesPage /></KeepAlive>
    </AppShell>
  )
}

export default App
