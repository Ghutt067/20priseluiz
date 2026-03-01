import { getJson, postJson, patchJson, deleteJson } from './http'

export type ProjectLookup = {
  id: string; name: string; status: string; startDate: string | null
  expectedEndDate: string | null; budget: number | null; spent: number
  customerName: string | null; createdAt: string
}

export type ProjectTask = {
  id: string; name: string; description: string | null; assignedUserId: string | null
  status: string; startDate: string | null; endDate: string | null
  dependsOnTaskId: string | null; sortOrder: number; estimatedHours: number | null; createdAt: string
}

export type ProjectTimesheet = {
  id: string; taskId: string | null; taskName: string | null; userId: string
  workDate: string; hours: number; hourlyCost: number; totalCost: number
  notes: string | null; createdAt: string
}

export type ProjectMilestone = {
  id: string; name: string; plannedDate: string | null; completedDate: string | null
  billingAmount: number | null; billed: boolean; financialTitleId: string | null
}

export function fetchProjects(status?: string) {
  const q = status ? `?status=${status}` : ''
  return getJson<ProjectLookup[]>(`/projects${q}`)
}

export function createProject(input: {
  name: string; customerId?: string; startDate?: string
  expectedEndDate?: string; budget?: number; notes?: string
}) {
  return postJson<{ id: string }>('/projects', input)
}

export function fetchTasks(projectId: string) {
  return getJson<ProjectTask[]>(`/projects/${projectId}/tasks`)
}

export function createTask(projectId: string, input: {
  name: string; description?: string; assignedUserId?: string
  startDate?: string; endDate?: string; dependsOnTaskId?: string; estimatedHours?: number
}) {
  return postJson<{ id: string }>(`/projects/${projectId}/tasks`, input)
}

export function updateTaskStatus(taskId: string, status: string) {
  return patchJson<{ id: string }>(`/projects/tasks/${taskId}/status`, { status })
}

export function fetchTimesheets(projectId: string) {
  return getJson<ProjectTimesheet[]>(`/projects/${projectId}/timesheets`)
}

export function createTimesheet(projectId: string, input: {
  taskId?: string; workDate: string; hours: number; hourlyCost: number; notes?: string
}) {
  return postJson<{ id: string; totalCost: number }>(`/projects/${projectId}/timesheets`, input)
}

export function fetchMilestones(projectId: string) {
  return getJson<ProjectMilestone[]>(`/projects/${projectId}/milestones`)
}

export function createMilestone(projectId: string, input: {
  name: string; plannedDate?: string; billingAmount?: number
}) {
  return postJson<{ id: string }>(`/projects/${projectId}/milestones`, input)
}

export function completeMilestone(milestoneId: string) {
  return postJson<{ completed: boolean; billed: boolean }>(`/projects/milestones/${milestoneId}/complete`, {})
}

export function updateProject(id: string, input: { name?: string; status?: string; budget?: number; notes?: string }) {
  return patchJson<{ id: string }>(`/projects/${id}`, input)
}

export function deleteTask(taskId: string) {
  return deleteJson<{ deleted: boolean }>(`/projects/tasks/${taskId}`)
}
