const currencyFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

export function toNumber(value: string | number | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function fmtCurrency(value: string | number | null | undefined): string {
  return currencyFmt.format(toNumber(value))
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return String(iso)
  return parsed.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return String(iso)
  return parsed.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function fmtDateFull(iso: string | null | undefined): string {
  if (!iso) return '—'
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return String(iso)
  return parsed.toLocaleDateString('pt-BR')
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

export function fmtRelative(iso: string): string {
  try {
    const diff = Date.now() - new Date(iso).getTime()
    const minutes = Math.floor(diff / 60000)
    if (minutes < 1) return 'agora'
    if (minutes < 60) return `${minutes}min atrás`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h atrás`
    return fmtDate(iso)
  } catch {
    return ''
  }
}

export function fmtQty(value: string | number, maximumFractionDigits = 4): string {
  return toNumber(value).toLocaleString('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  })
}

export function pageInfoLabel(offset: number, rowCount: number, totalCount: number | null): string {
  if (rowCount === 0) return 'Nenhum registro encontrado.'
  const start = offset + 1
  const end = offset + rowCount
  if (typeof totalCount === 'number') {
    return `Exibindo ${start}-${end} de ${totalCount}`
  }
  return `Exibindo ${start}-${end}`
}

export function canGoNextPage(offset: number, rowCount: number, totalCount: number | null, pageSize: number): boolean {
  if (rowCount === 0) return false
  if (typeof totalCount === 'number') {
    return offset + rowCount < totalCount
  }
  return rowCount >= pageSize
}

export function mergeLookupById<T extends { id: string }>(state: T[], incoming: T[]): T[] {
  if (incoming.length === 0) return state
  const next = new Map(state.map((item) => [item.id, item]))
  for (const item of incoming) {
    next.set(item.id, item)
  }
  return Array.from(next.values())
}
