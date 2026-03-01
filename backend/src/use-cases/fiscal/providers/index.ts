import { PlugNotasAdapter } from './plugnotasAdapter'
import type { FiscalProviderAdapter, FiscalProviderName } from './types'

export function createFiscalProviderAdapter(provider: FiscalProviderName): FiscalProviderAdapter {
  if (provider === 'plugnotas') {
    return new PlugNotasAdapter()
  }

  throw new Error(`Provedor fiscal não suportado: ${provider}`)
}
