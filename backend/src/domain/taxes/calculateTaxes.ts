export type TaxRule = {
  tax_type: string
  rate: number
  base_reduction: number
  st_margin: number
  cst: string | null
  csosn: string | null
  cfop: string | null
  origin_state: string | null
  destination_state: string | null
}

export type TaxItemInput = {
  id: string
  cfop?: string | null
  total_price: number
}

export type TaxLine = {
  document_item_id: string
  tax_type: string
  base_value: number
  rate: number
  amount: number
  cst?: string | null
  csosn?: string | null
}

export type TaxCalculationResult = {
  lines: TaxLine[]
  total_taxes: number
  total_products: number
  total_invoice: number
}

function pickBestRule(rules: TaxRule[], taxType: string, cfop?: string | null) {
  const candidates = rules.filter((rule) => rule.tax_type === taxType)

  const filtered = candidates.filter((rule) => {
    if (cfop && rule.cfop && rule.cfop !== cfop) return false
    if (!cfop && rule.cfop) return false
    return true
  })

  const scored = filtered.map((rule) => ({
    rule,
    score:
      (rule.cfop ? 1 : 0) +
      (rule.origin_state ? 1 : 0) +
      (rule.destination_state ? 1 : 0),
  }))

  scored.sort((a, b) => b.score - a.score)
  return scored[0]?.rule ?? null
}

export function calculateTaxes(items: TaxItemInput[], rules: TaxRule[]) {
  const lines: TaxLine[] = []
  let totalProducts = 0
  let totalTaxes = 0

  for (const item of items) {
    totalProducts += item.total_price

    for (const taxType of [
      'icms',
      'icms_st',
      'icms_difal',
      'pis',
      'cofins',
      'ipi',
      'iss',
    ]) {
      const rule = pickBestRule(rules, taxType, item.cfop ?? null)
      if (!rule) continue

      const base = item.total_price
      const rate = Number(rule.rate ?? 0)
      const baseReduction = Number(rule.base_reduction ?? 0)
      const stMargin = Number(rule.st_margin ?? 0)

      const baseReduced = base * (1 - baseReduction / 100)
      const baseAdjusted =
        taxType === 'icms_st' ? baseReduced * (1 + stMargin / 100) : baseReduced

      const amount = (baseAdjusted * rate) / 100

      if (amount === 0) continue

      lines.push({
        document_item_id: item.id,
        tax_type: taxType,
        base_value: Number(baseAdjusted.toFixed(2)),
        rate: Number(rate.toFixed(4)),
        amount: Number(amount.toFixed(2)),
        cst: rule.cst,
        csosn: rule.csosn,
      })

      totalTaxes += amount
    }
  }

  return {
    lines,
    total_products: Number(totalProducts.toFixed(2)),
    total_taxes: Number(totalTaxes.toFixed(2)),
    total_invoice: Number((totalProducts + totalTaxes).toFixed(2)),
  } satisfies TaxCalculationResult
}
