import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import { modules, modulesForMode, type ModeKey, type ModuleConfig } from '../../config/modes'
import logo from '../../assets/icons/20EnterpriseWHITE.svg'

const RECENTS_KEY = 'vinteenterprise.recentModules'
const MAX_RECENTS = 4

function getRecents(): string[] {
  try { return JSON.parse(globalThis.localStorage.getItem(RECENTS_KEY) ?? '[]') }
  catch { return [] }
}

function pushRecent(path: string) {
  const list = getRecents().filter((p) => p !== path)
  list.unshift(path)
  globalThis.localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)))
}

type AppShellProps = {
  mode: ModeKey
  roleLabel: string
  search: string
  onSearchChange: (value: string) => void
  children: ReactNode
}

export function AppShell({
  mode,
  roleLabel,
  search,
  onSearchChange,
  children,
}: AppShellProps) {
  const location = useLocation()
  const visibleModules = modulesForMode(mode)
  const grouped = useMemo(() => {
    return visibleModules.reduce<Record<string, typeof visibleModules>>((acc, item) => {
      acc[item.group] ??= []
      acc[item.group].push(item)
      return acc
    }, {})
  }, [visibleModules])

  const currentModule = modules.find((m) => m.path === location.pathname)

  const [recents, setRecents] = useState<ModuleConfig[]>([])

  const refreshRecents = useCallback(() => {
    const paths = getRecents()
    const found = paths.map((p) => modules.find((m) => m.path === p)).filter(Boolean) as ModuleConfig[]
    setRecents(found)
  }, [])

  useEffect(() => {
    if (currentModule) pushRecent(currentModule.path)
    refreshRecents()
  }, [location.pathname, currentModule, refreshRecents])

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-header">
          <img src={logo} alt="VinteEnterprise" className="brand" />
        </div>

        {recents.length > 0 && (
          <div className="sidebar-recents">
            <span className="sidebar-group-title">Recentes</span>
            {recents.map((item) => (
              <NavLink
                key={`recent-${item.key}`}
                to={item.path}
                className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
              >
                {item.label}
              </NavLink>
            ))}
          </div>
        )}

        <nav className="sidebar-nav">
          {Object.entries(grouped).map(([group, items]) => (
            <div className="sidebar-group" key={group}>
              <span className="sidebar-group-title">{group}</span>
              {items.map((item) => (
                <NavLink
                  key={item.key}
                  to={item.path}
                  className={({ isActive }) => `sidebar-link${isActive ? ' active' : ''}`}
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div className="shell-body">
        <header className="topbar">
          <div className="topbar-left">
            <span className="topbar-module-name">{currentModule?.label ?? 'VinteEnterprise'}</span>
            <span className="topbar-role">{roleLabel}</span>
          </div>
          <div className="topbar-right">
            <input
              type="search"
              className="topbar-spotlight"
              placeholder="Buscar... (Ctrl+K)"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
            />
          </div>
        </header>

        <main className="shell-content">{children}</main>
      </div>
    </div>
  )
}
