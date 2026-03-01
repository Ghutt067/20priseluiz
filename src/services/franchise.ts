import { getJson, postJson, deleteJson } from './http'

export type FranchiseGroup = {
  id: string; name: string; parentOrgId: string
  memberCount: number; createdAt: string
}

export type FranchiseMember = {
  id: string; organizationId: string; organizationName: string
  memberType: string; active: boolean; joinedAt: string
}

export type RoyaltyRule = {
  id: string; ruleType: string; percentage: number; base: string; active: boolean
}

export type CatalogOverride = {
  id: string; organizationId: string; orgName: string
  productId: string; productName: string
  regionalPrice: number; globalPrice: number; active: boolean
}

export type ConsolidatedDre = {
  byOrg: Array<{ title_type: string; orgName: string; total: number }>
  intercompanyElimination: number
}

export function fetchGroups() {
  return getJson<FranchiseGroup[]>('/franchise/groups')
}

export function createGroup(name: string) {
  return postJson<{ id: string }>('/franchise/groups', { name })
}

export function fetchMembers(groupId: string) {
  return getJson<FranchiseMember[]>(`/franchise/groups/${groupId}/members`)
}

export function addMember(groupId: string, input: { organizationId: string; memberType: string }) {
  return postJson<{ id: string }>(`/franchise/groups/${groupId}/members`, input)
}

export function fetchRoyaltyRules(groupId: string) {
  return getJson<RoyaltyRule[]>(`/franchise/groups/${groupId}/royalty-rules`)
}

export function createRoyaltyRule(groupId: string, input: {
  ruleType: string; percentage: number; base?: string
}) {
  return postJson<{ id: string }>(`/franchise/groups/${groupId}/royalty-rules`, input)
}

export function fetchCatalogOverrides(groupId: string) {
  return getJson<CatalogOverride[]>(`/franchise/groups/${groupId}/catalog`)
}

export function createCatalogOverride(groupId: string, input: {
  organizationId: string; productId: string; regionalPrice: number
}) {
  return postJson<{ id: string }>(`/franchise/groups/${groupId}/catalog`, input)
}

export function fetchConsolidatedDre(groupId: string, from?: string, to?: string) {
  const p = new URLSearchParams()
  if (from) p.set('from', from)
  if (to) p.set('to', to)
  const q = p.size > 0 ? `?${p}` : ''
  return getJson<ConsolidatedDre>(`/franchise/groups/${groupId}/consolidated-dre${q}`)
}

export function removeMember(groupId: string, memberId: string) {
  return deleteJson<{ deleted: boolean }>(`/franchise/groups/${groupId}/members/${memberId}`)
}

export function removeRoyaltyRule(groupId: string, ruleId: string) {
  return deleteJson<{ deleted: boolean }>(`/franchise/groups/${groupId}/royalty-rules/${ruleId}`)
}
