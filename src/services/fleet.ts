import { getJson, getJsonWithHeaders, postJson, patchJson, deleteJson } from './http'

export type VehicleFleet = {
  id: string
  plate: string | null
  brand: string | null
  model: string | null
  year: number | null
  color: string | null
  vin: string | null
  kmCurrent: number
  fleetStatus: string
  fuelType: string | null
  tankLiters: number | null
  insuranceExpiry: string | null
  ipvaExpiry: string | null
  customerName: string | null
  createdAt: string
}

export type FleetTire = {
  id: string
  vehicle_id: string
  vehiclePlate: string
  position: string
  fire_number: string | null
  tread_depth_mm: number | null
  km_installed: number | null
  installed_at: string | null
  status: string
  created_at: string
}

export type FleetIncident = {
  id: string
  vehicle_id: string
  vehiclePlate: string
  incident_type: string
  incident_date: string
  description: string | null
  cost: number
  insurer: string | null
  status: string
  created_at: string
}

export type FleetMaintenancePlan = {
  id: string
  vehicle_id: string
  vehiclePlate: string
  name: string
  plan_type: string
  interval_km: number | null
  interval_days: number | null
  next_km: number | null
  next_date: string | null
  active: boolean
  created_at: string
}

export type FleetRefueling = {
  id: string
  vehicle_id: string
  vehiclePlate: string
  refueling_date: string
  km_current: number
  liters: number
  total_cost: number
  fuel_type: string | null
  km_per_liter: number | null
  station: string | null
  created_at: string
}

export type FleetAlert = {
  id: string
  name: string
  planType: string
  nextKm: number | null
  nextDate: string | null
  vehicleId: string
  plate: string
  kmCurrent: number
  alert_level: string
}

export async function fetchVehiclesPaged(options?: {
  query?: string; status?: string; limit?: number; offset?: number; signal?: AbortSignal
}): Promise<{ rows: VehicleFleet[]; totalCount: number }> {
  const p = new URLSearchParams()
  if (options?.query) p.set('query', options.query)
  if (options?.status) p.set('status', options.status)
  if (options?.limit) p.set('limit', String(options.limit))
  if (options?.offset) p.set('offset', String(options.offset))
  const path = p.size > 0 ? `/fleet/vehicles?${p}` : '/fleet/vehicles'
  const { data, headers } = await getJsonWithHeaders<VehicleFleet[]>(path, { signal: options?.signal })
  const raw = headers.get('x-total-count')
  return { rows: data, totalCount: raw ? Math.max(Number.parseInt(raw, 10) || 0, 0) : data.length }
}

export function updateVehicleFleet(id: string, input: {
  kmCurrent?: number; fleetStatus?: string; fuelType?: string
  tankLiters?: number; insuranceExpiry?: string; ipvaExpiry?: string
}) {
  return patchJson<{ id: string }>(`/fleet/vehicles/${id}`, input)
}

export function fetchTires(vehicleId?: string) {
  const q = vehicleId ? `?vehicleId=${vehicleId}` : ''
  return getJson<FleetTire[]>(`/fleet/tires${q}`)
}

export function createTire(input: {
  vehicleId: string; position: string; fireNumber?: string
  treadDepthMm?: number; kmInstalled?: number; installedAt?: string
}) {
  return postJson<{ id: string }>('/fleet/tires', input)
}

export function fetchIncidents(vehicleId?: string) {
  const q = vehicleId ? `?vehicleId=${vehicleId}` : ''
  return getJson<FleetIncident[]>(`/fleet/incidents${q}`)
}

export function createIncident(input: {
  vehicleId: string; incidentType: string; incidentDate: string
  description?: string; cost?: number; insurer?: string
}) {
  return postJson<{ id: string }>('/fleet/incidents', input)
}

export function fetchMaintenancePlans(vehicleId?: string) {
  const q = vehicleId ? `?vehicleId=${vehicleId}` : ''
  return getJson<FleetMaintenancePlan[]>(`/fleet/maintenance-plans${q}`)
}

export function createMaintenancePlan(input: {
  vehicleId: string; name: string; planType: string
  intervalKm?: number; intervalDays?: number; lastKm?: number; lastDate?: string
}) {
  return postJson<{ id: string }>('/fleet/maintenance-plans', input)
}

export function fetchRefueling(vehicleId?: string) {
  const q = vehicleId ? `?vehicleId=${vehicleId}` : ''
  return getJson<FleetRefueling[]>(`/fleet/refueling${q}`)
}

export function createRefueling(input: {
  vehicleId: string; refuelingDate: string; kmCurrent: number
  liters: number; totalCost: number; fuelType?: string; station?: string
}) {
  return postJson<{ id: string; kmPerLiter: number | null }>('/fleet/refueling', input)
}

export function fetchMaintenanceAlerts() {
  return getJson<FleetAlert[]>('/fleet/maintenance-alerts')
}

export function updateTire(id: string, input: { treadDepthMm?: number; status?: string; removedAt?: string }) {
  return patchJson<{ id: string }>(`/fleet/tires/${id}`, input)
}

export function deleteTire(id: string) {
  return deleteJson<{ deleted: boolean }>(`/fleet/tires/${id}`)
}

export function updateIncident(id: string, input: { status?: string; cost?: number; insurer?: string }) {
  return patchJson<{ id: string }>(`/fleet/incidents/${id}`, input)
}

export function updateMaintenancePlan(id: string, input: { active?: boolean; lastKm?: number; nextKm?: number; nextDate?: string }) {
  return patchJson<{ id: string }>(`/fleet/maintenance-plans/${id}`, input)
}

export function deleteMaintenancePlan(id: string) {
  return deleteJson<{ deleted: boolean }>(`/fleet/maintenance-plans/${id}`)
}

export type VehicleLookupItem = { id: string; name: string; plate: string | null; kmCurrent: number }

export async function searchVehiclesLookup(params: {
  query: string; offset: number; limit: number; signal?: AbortSignal
}): Promise<{ rows: VehicleLookupItem[]; totalCount: number | null }> {
  const r = await fetchVehiclesPaged({ query: params.query, offset: params.offset, limit: params.limit, signal: params.signal })
  return {
    rows: r.rows.map(v => ({ id: v.id, name: `${v.plate ?? '—'} — ${v.brand ?? ''} ${v.model ?? ''}`.trim(), plate: v.plate, kmCurrent: v.kmCurrent })),
    totalCount: r.totalCount,
  }
}

export type FleetDashboard = {
  totalVehicles: number
  activeVehicles: number
  inMaintenance: number
  overdueAlerts: number
  monthlyFuelCost: number
  avgKmPerLiter: number
}

export async function fetchFleetDashboard(): Promise<FleetDashboard> {
  const [vehicles, alerts, refueling] = await Promise.all([
    fetchVehiclesPaged({ limit: 1000 }),
    fetchMaintenanceAlerts(),
    fetchRefueling(),
  ])
  const active = vehicles.rows.filter(v => v.fleetStatus === 'active').length
  const inMaint = vehicles.rows.filter(v => v.fleetStatus === 'maintenance').length
  const overdue = alerts.filter(a => a.alert_level.includes('overdue')).length

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
  const monthRefueling = refueling.filter(r => r.refueling_date >= monthStart)
  const monthlyFuel = monthRefueling.reduce((s, r) => s + Number(r.total_cost), 0)
  const withKm = refueling.filter(r => r.km_per_liter && Number(r.km_per_liter) > 0)
  const avgKm = withKm.length > 0 ? withKm.reduce((s, r) => s + Number(r.km_per_liter!), 0) / withKm.length : 0

  return {
    totalVehicles: vehicles.rows.length,
    activeVehicles: active,
    inMaintenance: inMaint,
    overdueAlerts: overdue,
    monthlyFuelCost: monthlyFuel,
    avgKmPerLiter: avgKm,
  }
}
