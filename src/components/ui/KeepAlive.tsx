import { Component, type ErrorInfo, type ReactNode, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'

const KNOWN_PATHS = new Set([
  '/dashboard', '/compras', '/vendas', '/estoque', '/financeiro', '/relatorios',
  '/fiscal', '/servicos', '/crm', '/pdv', '/contratos', '/frota', '/producao',
  '/wms', '/patrimonio', '/projetos', '/comex', '/qualidade', '/tesouraria',
  '/automacao', '/esg', '/franquias', '/cadastros', '/equipe', '/configuracoes',
])

type KeepAliveProps = {
  readonly path: string
  readonly fallback?: boolean
  readonly children: ReactNode
}

type ModuleErrorBoundaryProps = {
  readonly path: string
  readonly children: ReactNode
}

type ModuleErrorBoundaryState = {
  readonly hasError: boolean
  readonly message: string
}

class ModuleErrorBoundary extends Component<ModuleErrorBoundaryProps, ModuleErrorBoundaryState> {
  state: ModuleErrorBoundaryState = {
    hasError: false,
    message: '',
  }

  static getDerivedStateFromError(error: unknown): ModuleErrorBoundaryState {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : 'Erro inesperado neste módulo.',
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error(`[module-error:${this.props.path}]`, error, info)
  }

  private readonly handleRetry = () => {
    this.setState({ hasError: false, message: '' })
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children
    }

    return (
      <section className="card" role="alert">
        <h3>Falha ao carregar módulo</h3>
        <p className="hint">Módulo: {this.props.path}</p>
        <p className="hint">{this.state.message}</p>
        <div className="actions">
          <button type="button" className="ghost" onClick={this.handleRetry}>Tentar novamente</button>
          <button type="button" onClick={() => globalThis.window.location.reload()}>Recarregar sistema</button>
        </div>
      </section>
    )
  }
}

export function KeepAlive({ path, fallback, children }: KeepAliveProps) {
  const location = useLocation()
  const currentPath = location.pathname
  const exactMatch = currentPath === path
  const isFallbackActive = fallback && !KNOWN_PATHS.has(currentPath)
  const active = exactMatch || isFallbackActive
  const [mounted, setMounted] = useState(active)

  useEffect(() => {
    if (active && !mounted) setMounted(true)
  }, [active, mounted])

  if (!mounted) return null

  return (
    <div style={{ display: active ? 'contents' : 'none' }}>
      <ModuleErrorBoundary path={path}>
        {children}
      </ModuleErrorBoundary>
    </div>
  )
}
