/**
 * Granular permission system for ERP actions.
 * Each role has a set of allowed actions beyond module visibility.
 */

export type ActionKey =
  | 'purchase.order.create'
  | 'purchase.order.approve'
  | 'purchase.order.cancel'
  | 'purchase.receive'
  | 'purchase.xml.import'
  | 'sales.order.create'
  | 'sales.order.invoice'
  | 'sales.discount.above_limit'
  | 'sales.quote.create'
  | 'sales.quote.convert'
  | 'stock.transfer'
  | 'stock.adjust'
  | 'stock.inventory.count'
  | 'stock.minmax.update'
  | 'finance.title.create'
  | 'finance.installment.pay'
  | 'finance.bank.transaction'
  | 'finance.ofx.import'
  | 'finance.reconcile'
  | 'fiscal.draft.create'
  | 'fiscal.transmit'
  | 'fiscal.cancel'
  | 'fiscal.cce'
  | 'fiscal.manifest'
  | 'service.order.create'
  | 'service.order.invoice'
  | 'crm.appointment.create'
  | 'crm.campaign.create'
  | 'crm.promotion.create'
  | 'pos.session.open'
  | 'pos.session.close'
  | 'pos.sale.create'
  | 'pos.sangria'
  | 'pos.reforco'
  | 'contract.create'
  | 'contract.status.update'
  | 'cadastro.customer.create'
  | 'cadastro.customer.edit'
  | 'cadastro.customer.deactivate'
  | 'cadastro.supplier.create'
  | 'cadastro.supplier.edit'
  | 'cadastro.supplier.deactivate'
  | 'cadastro.product.create'
  | 'cadastro.product.edit'
  | 'cadastro.product.deactivate'
  | 'cadastro.warehouse.create'
  | 'cadastro.warehouse.edit'
  | 'team.invite'
  | 'team.role.change'
  | 'settings.update'
  | 'report.view'
  | 'report.export'
  | 'fleet.vehicle.manage'
  | 'fleet.tire.manage'
  | 'fleet.refueling.create'
  | 'fleet.maintenance.manage'
  | 'fleet.incident.create'
  | 'mrp.bom.create'
  | 'mrp.production.create'
  | 'mrp.production.report'
  | 'mrp.cost.create'
  | 'mrp.waste.create'
  | 'wms.location.manage'
  | 'wms.picklist.manage'
  | 'wms.cubage.calculate'
  | 'asset.create'
  | 'asset.depreciation.calculate'
  | 'asset.transfer'
  | 'project.create'
  | 'project.task.manage'
  | 'project.timesheet.create'
  | 'project.milestone.manage'
  | 'comex.process.create'
  | 'comex.nationalize'
  | 'comex.container.manage'
  | 'quality.ncr.create'
  | 'quality.ncr.manage'
  | 'quality.calibration.manage'
  | 'quality.document.manage'
  | 'treasury.loan.create'
  | 'treasury.intercompany.create'
  | 'automation.rule.manage'
  | 'automation.signature.create'
  | 'esg.carbon.manage'
  | 'esg.compliance.manage'
  | 'franchise.group.manage'
  | 'franchise.royalty.manage'
  | 'franchise.catalog.manage'
  | 'portal.token.manage'
  | 'audit.version.view'
  | 'audit.approval.manage'
  | 'audit.approval.decide'
  | 'ai.churn.calculate'
  | 'ai.anomaly.detect'
  | 'ai.anomaly.review'
  | 'bi.snapshot.create'
  | 'bi.abc.view'
  | 'bi.cohort.view'
  | 'bi.executive.view'
  | 'finance.cost_center.manage'
  | 'finance.billing_rule.manage'
  | 'finance.cnab.upload'
  | 'finance.cnab.process'

type RoleKey = 'chefe' | 'vendedor' | 'estoquista' | 'financeiro'

const CHEFE_ALL: ActionKey[] = [
  'purchase.order.create', 'purchase.order.approve', 'purchase.order.cancel', 'purchase.receive', 'purchase.xml.import',
  'sales.order.create', 'sales.order.invoice', 'sales.discount.above_limit', 'sales.quote.create', 'sales.quote.convert',
  'stock.transfer', 'stock.adjust', 'stock.inventory.count', 'stock.minmax.update',
  'finance.title.create', 'finance.installment.pay', 'finance.bank.transaction', 'finance.ofx.import', 'finance.reconcile',
  'fiscal.draft.create', 'fiscal.transmit', 'fiscal.cancel', 'fiscal.cce', 'fiscal.manifest',
  'service.order.create', 'service.order.invoice',
  'crm.appointment.create', 'crm.campaign.create', 'crm.promotion.create',
  'pos.session.open', 'pos.session.close', 'pos.sale.create', 'pos.sangria', 'pos.reforco',
  'contract.create', 'contract.status.update',
  'cadastro.customer.create', 'cadastro.customer.edit', 'cadastro.customer.deactivate',
  'cadastro.supplier.create', 'cadastro.supplier.edit', 'cadastro.supplier.deactivate',
  'cadastro.product.create', 'cadastro.product.edit', 'cadastro.product.deactivate',
  'cadastro.warehouse.create', 'cadastro.warehouse.edit',
  'team.invite', 'team.role.change', 'settings.update',
  'report.view', 'report.export',
  'fleet.vehicle.manage', 'fleet.tire.manage', 'fleet.refueling.create', 'fleet.maintenance.manage', 'fleet.incident.create',
  'mrp.bom.create', 'mrp.production.create', 'mrp.production.report', 'mrp.cost.create', 'mrp.waste.create',
  'wms.location.manage', 'wms.picklist.manage', 'wms.cubage.calculate',
  'asset.create', 'asset.depreciation.calculate', 'asset.transfer',
  'project.create', 'project.task.manage', 'project.timesheet.create', 'project.milestone.manage',
  'comex.process.create', 'comex.nationalize', 'comex.container.manage',
  'quality.ncr.create', 'quality.ncr.manage', 'quality.calibration.manage', 'quality.document.manage',
  'treasury.loan.create', 'treasury.intercompany.create',
  'automation.rule.manage', 'automation.signature.create',
  'esg.carbon.manage', 'esg.compliance.manage',
  'franchise.group.manage', 'franchise.royalty.manage', 'franchise.catalog.manage',
  'portal.token.manage',
  'audit.version.view', 'audit.approval.manage', 'audit.approval.decide',
  'ai.churn.calculate', 'ai.anomaly.detect', 'ai.anomaly.review',
  'bi.snapshot.create', 'bi.abc.view', 'bi.cohort.view', 'bi.executive.view',
  'finance.cost_center.manage', 'finance.billing_rule.manage', 'finance.cnab.upload', 'finance.cnab.process',
]

const rolePermissions: Record<RoleKey, ActionKey[]> = {
  chefe: CHEFE_ALL,
  vendedor: [
    'sales.order.create', 'sales.quote.create', 'sales.quote.convert', 'sales.order.invoice',
    'crm.appointment.create', 'crm.campaign.create', 'crm.promotion.create',
    'pos.session.open', 'pos.session.close', 'pos.sale.create',
    'cadastro.customer.create', 'cadastro.customer.edit',
    'cadastro.product.create',
    'report.view',
  ],
  estoquista: [
    'purchase.order.create', 'purchase.receive', 'purchase.xml.import',
    'stock.transfer', 'stock.adjust', 'stock.inventory.count', 'stock.minmax.update',
    'cadastro.product.create', 'cadastro.product.edit',
    'cadastro.supplier.create', 'cadastro.supplier.edit',
    'cadastro.warehouse.create', 'cadastro.warehouse.edit',
    'report.view',
    'fleet.vehicle.manage', 'fleet.tire.manage', 'fleet.refueling.create', 'fleet.maintenance.manage', 'fleet.incident.create',
    'mrp.bom.create', 'mrp.production.create', 'mrp.production.report', 'mrp.cost.create', 'mrp.waste.create',
    'wms.location.manage', 'wms.picklist.manage', 'wms.cubage.calculate',
    'comex.process.create', 'comex.container.manage',
    'quality.ncr.create', 'quality.calibration.manage',
  ],
  financeiro: [
    'finance.title.create', 'finance.installment.pay', 'finance.bank.transaction',
    'finance.ofx.import', 'finance.reconcile',
    'fiscal.draft.create', 'fiscal.transmit', 'fiscal.cancel', 'fiscal.cce', 'fiscal.manifest',
    'contract.create', 'contract.status.update',
    'purchase.order.approve',
    'report.view', 'report.export',
    'asset.create', 'asset.depreciation.calculate', 'asset.transfer',
    'treasury.loan.create', 'treasury.intercompany.create',
    'finance.cost_center.manage', 'finance.billing_rule.manage', 'finance.cnab.upload', 'finance.cnab.process',
    'bi.abc.view', 'bi.cohort.view',
  ],
}

const permissionCache = new Map<string, Set<ActionKey>>()

function getPermissionSet(role: string): Set<ActionKey> {
  if (permissionCache.has(role)) return permissionCache.get(role)!
  const actions = rolePermissions[role as RoleKey] ?? []
  const set = new Set(actions)
  permissionCache.set(role, set)
  return set
}

/**
 * Check if a role has a specific action permission.
 */
export function can(role: string, action: ActionKey): boolean {
  return getPermissionSet(role).has(action)
}

/**
 * Check multiple permissions at once. Returns true if ALL are allowed.
 */
export function canAll(role: string, actions: ActionKey[]): boolean {
  const set = getPermissionSet(role)
  return actions.every((a) => set.has(a))
}

/**
 * Check multiple permissions. Returns true if ANY is allowed.
 */
export function canAny(role: string, actions: ActionKey[]): boolean {
  const set = getPermissionSet(role)
  return actions.some((a) => set.has(a))
}

/**
 * Get all allowed actions for a role.
 */
export function getAllowedActions(role: string): ActionKey[] {
  return rolePermissions[role as RoleKey] ?? []
}
