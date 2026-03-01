import { useLocation } from 'react-router-dom'
import { modules } from '../../config/modes'

export function Breadcrumbs() {
  const location = useLocation()
  const currentModule = modules.find((m) => m.path === location.pathname)

  if (!currentModule) return null

  return (
    <nav className="v-breadcrumbs" aria-label="Breadcrumb">
      <span className="v-breadcrumb-item">{currentModule.group}</span>
      <span className="v-breadcrumb-sep">›</span>
      <span className="v-breadcrumb-item v-breadcrumb-current">{currentModule.label}</span>
    </nav>
  )
}
