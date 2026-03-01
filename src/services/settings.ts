import { getJson, putJson } from './http'

export type OrgSettings = {
  id: string
  name: string
  legalName: string | null
  cnpj: string | null
  ie: string | null
  im: string | null
  taxRegime: 'simples_nacional' | 'lucro_presumido' | 'lucro_real' | 'mei'
  logoUrl: string | null
  phone: string | null
  email: string | null
  website: string | null
  addressStreet: string | null
  addressNumber: string | null
  addressComplement: string | null
  addressNeighborhood: string | null
  addressCity: string | null
  addressState: string | null
  addressZip: string | null
  settings: Record<string, unknown>
}

export function fetchSettings() {
  return getJson<OrgSettings>('/settings')
}

export function updateSettings(data: Partial<Omit<OrgSettings, 'id'>>) {
  return putJson<{ ok: boolean }>('/settings', data)
}
