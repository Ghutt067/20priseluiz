import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../contexts/useAuth'
import {
  StatusBadge, Tabs, TabPanel, DataTable, type Column, Select,
  SearchToolbar, PageHeader, KpiCard, KpiRow,
  DetailPanel, DetailField, DetailGrid,
} from '../../components/ui'
import { useStatusToast } from '../../hooks/useStatusToast'
import { can } from '../../lib/permissions'
import { fmtCurrency, fmtDate, fmtQty } from '../../lib/formatters'
import {
  fetchProjects, createProject, updateProject, fetchTasks, createTask, updateTaskStatus, deleteTask,
  fetchTimesheets, createTimesheet, fetchMilestones, createMilestone, completeMilestone,
  type ProjectLookup, type ProjectTask, type ProjectTimesheet, type ProjectMilestone,
} from '../../services/projects'

type Tab = 'dashboard' | 'projects' | 'tasks' | 'timesheets' | 'milestones'

const projStatusLabel: Record<string, string> = {
  active: 'Ativo', completed: 'Concluído', on_hold: 'Pausado', cancelled: 'Cancelado',
}
const taskStatusLabel: Record<string, string> = {
  todo: 'A fazer', in_progress: 'Em progresso', review: 'Revisão', done: 'Concluído',
}

function lbl(map: Record<string, string>, key: string | null | undefined): string {
  return map[key ?? ''] ?? key ?? '—'
}

type ProjectDash = { activeCount: number; totalBudget: number; totalSpent: number; overdueTasks: number }

export function ProjetosPage() {
  const { organizationId, role } = useAuth()
  const [tab, setTab] = useState<Tab>('dashboard')
  const [status, setStatus] = useState('')
  const [showForm, setShowForm] = useState(false)

  const [dash, setDash] = useState<ProjectDash | null>(null)
  const [dashLoading, setDashLoading] = useState(false)

  const [projects, setProjects] = useState<ProjectLookup[]>([])
  const [projStatusFilter, setProjStatusFilter] = useState('')
  const [projLoading, setProjLoading] = useState(false)
  const [selectedProject, setSelectedProject] = useState<ProjectLookup | null>(null)
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)

  const [tasks, setTasks] = useState<ProjectTask[]>([])
  const [taskStatusFilter, setTaskStatusFilter] = useState('')
  const [tasksLoading, setTasksLoading] = useState(false)

  const [timesheets, setTimesheets] = useState<ProjectTimesheet[]>([])
  const [tsLoading, setTsLoading] = useState(false)

  const [milestones, setMilestones] = useState<ProjectMilestone[]>([])
  const [msLoading, setMsLoading] = useState(false)

  useStatusToast(status)
  const canManage = can(role ?? '', 'project.create')

  const tabItems = useMemo(() => [
    { key: 'dashboard' as const, label: 'Painel' },
    { key: 'projects' as const, label: 'Projetos', count: projects.length },
    { key: 'tasks' as const, label: 'Tarefas' },
    { key: 'timesheets' as const, label: 'Timesheets' },
    { key: 'milestones' as const, label: 'Milestones' },
  ], [projects.length])

  const loadDash = useCallback(async () => {
    if (!organizationId) return
    setDashLoading(true)
    try {
      const all = await fetchProjects()
      const active = all.filter(p => p.status === 'active')
      setDash({
        activeCount: active.length,
        totalBudget: active.reduce((s, p) => s + Number(p.budget ?? 0), 0),
        totalSpent: active.reduce((s, p) => s + Number(p.spent), 0),
        overdueTasks: 0,
      })
    } catch { /* */ }
    setDashLoading(false)
  }, [organizationId])

  const loadProjects = useCallback(async () => {
    if (!organizationId) return
    setProjLoading(true)
    try { setProjects(await fetchProjects(projStatusFilter || undefined)) }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setProjLoading(false)
  }, [organizationId, projStatusFilter])

  const loadTasks = useCallback(async () => {
    if (!selectedProjectId) return
    setTasksLoading(true)
    try {
      const all = await fetchTasks(selectedProjectId)
      setTasks(taskStatusFilter ? all.filter(t => t.status === taskStatusFilter) : all)
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setTasksLoading(false)
  }, [selectedProjectId, taskStatusFilter])

  const loadTs = useCallback(async () => {
    if (!selectedProjectId) return
    setTsLoading(true)
    try { setTimesheets(await fetchTimesheets(selectedProjectId)) }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setTsLoading(false)
  }, [selectedProjectId])

  const loadMs = useCallback(async () => {
    if (!selectedProjectId) return
    setMsLoading(true)
    try { setMilestones(await fetchMilestones(selectedProjectId)) }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
    setMsLoading(false)
  }, [selectedProjectId])

  useEffect(() => {
    if (tab === 'dashboard') void loadDash()
    if (tab === 'projects') void loadProjects()
    if (tab === 'tasks') void loadTasks()
    if (tab === 'timesheets') void loadTs()
    if (tab === 'milestones') void loadMs()
  }, [tab, loadDash, loadProjects, loadTasks, loadTs, loadMs])

  const handleProjectStatus = async (id: string, s: string) => {
    try { await updateProject(id, { status: s }); setStatus('Status atualizado.'); void loadProjects() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }
  const handleDeleteTask = async (taskId: string) => {
    try { await deleteTask(taskId); setStatus('Tarefa excluída.'); void loadTasks() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }
  const handleCompleteMs = async (msId: string) => {
    try {
      const r = await completeMilestone(msId)
      setStatus(r.billed ? 'Milestone concluído e faturado.' : 'Milestone concluído.')
      void loadMs()
    } catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }
  const handleTaskStatus = async (taskId: string, newStatus: string) => {
    try { await updateTaskStatus(taskId, newStatus); void loadTasks() }
    catch (e) { setStatus(e instanceof Error ? e.message : 'Erro.') }
  }

  const projCols: Column<ProjectLookup>[] = useMemo(() => [
    { key: 'name', header: 'Nome', render: (p) => <strong>{p.name}</strong> },
    { key: 'customer', header: 'Cliente', render: (p) => p.customerName ?? '—' },
    { key: 'status', header: 'Status', render: (p) => <StatusBadge status={p.status} label={lbl(projStatusLabel, p.status)} /> },
    { key: 'budget', header: 'Orçamento', align: 'right', render: (p) => fmtCurrency(p.budget ?? 0) },
    { key: 'spent', header: 'Gasto', align: 'right', render: (p) => fmtCurrency(p.spent) },
    { key: 'burn', header: 'Burn %', render: (p) => {
      const b = Number(p.budget ?? 0)
      const pct = b > 0 ? Math.min(100, Math.round((Number(p.spent) / b) * 100)) : 0
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 50, height: 6, background: 'var(--border)', borderRadius: 3 }}>
            <div style={{ width: `${pct}%`, height: '100%', background: pct > 80 ? '#c44' : 'var(--accent)', borderRadius: 3 }} />
          </div>
          <span style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>{pct}%</span>
        </div>
      )
    }},
    { key: 'start', header: 'Início', render: (p) => fmtDate(p.startDate) },
    { key: 'actions', header: 'Ações', render: (p) => (
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button type="button" className="ghost" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); setSelectedProjectId(p.id); setTab('tasks') }}>Tarefas</button>
        <button type="button" className="ghost" style={{ fontSize: 12 }} onClick={(e) => { e.stopPropagation(); setSelectedProjectId(p.id); setTab('milestones') }}>Milestones</button>
        {canManage && p.status === 'active' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={(e) => { e.stopPropagation(); void handleProjectStatus(p.id, 'completed') }}>Concluir</button>}
        {canManage && p.status === 'active' && <button type="button" className="ghost" style={{ fontSize: 11 }} onClick={(e) => { e.stopPropagation(); void handleProjectStatus(p.id, 'on_hold') }}>Pausar</button>}
      </div>
    )},
  ], [canManage])

  const taskCols: Column<ProjectTask>[] = useMemo(() => [
    { key: 'name', header: 'Tarefa', render: (t) => <strong>{t.name}</strong> },
    { key: 'status', header: 'Status', render: (t) => <StatusBadge status={t.status} label={lbl(taskStatusLabel, t.status)} /> },
    { key: 'start', header: 'Início', render: (t) => fmtDate(t.startDate) },
    { key: 'end', header: 'Fim', render: (t) => fmtDate(t.endDate) },
    { key: 'hours', header: 'Horas Est.', align: 'right', render: (t) => t.estimatedHours != null ? fmtQty(t.estimatedHours, 1) : '—' },
    { key: 'change', header: 'Mudar Status', render: (t) => (
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        <select value={t.status} onChange={e => void handleTaskStatus(t.id, e.target.value)} style={{ fontSize: 12 }}>
          <option value="todo">A fazer</option><option value="in_progress">Em progresso</option>
          <option value="review">Revisão</option><option value="done">Concluído</option>
        </select>
        {canManage && <button type="button" className="ghost" style={{ fontSize: 11, color: '#c44' }} onClick={() => void handleDeleteTask(t.id)}>Excluir</button>}
      </div>
    )},
  ], [canManage])

  const tsCols: Column<ProjectTimesheet>[] = useMemo(() => [
    { key: 'task', header: 'Tarefa', render: (ts) => ts.taskName ?? '—' },
    { key: 'date', header: 'Data', render: (ts) => fmtDate(ts.workDate) },
    { key: 'hours', header: 'Horas', align: 'right', render: (ts) => fmtQty(ts.hours, 2) },
    { key: 'cost', header: 'Custo/h', align: 'right', render: (ts) => fmtCurrency(ts.hourlyCost) },
    { key: 'total', header: 'Total', align: 'right', render: (ts) => <strong>{fmtCurrency(ts.totalCost)}</strong> },
    { key: 'notes', header: 'Notas', render: (ts) => ts.notes ?? '—' },
  ], [])

  const msCols: Column<ProjectMilestone>[] = useMemo(() => [
    { key: 'name', header: 'Milestone', render: (ms) => <strong>{ms.name}</strong> },
    { key: 'planned', header: 'Data Planejada', render: (ms) => fmtDate(ms.plannedDate) },
    { key: 'completed', header: 'Concluído em', render: (ms) => fmtDate(ms.completedDate) },
    { key: 'amount', header: 'Valor Fat.', align: 'right', render: (ms) => fmtCurrency(ms.billingAmount ?? 0) },
    { key: 'billed', header: 'Faturado', render: (ms) => ms.billed ? 'Sim' : 'Não' },
    ...(canManage ? [{
      key: 'actions', header: 'Ações', render: (ms: ProjectMilestone) => (
        !ms.completedDate ? <button type="button" className="ghost" style={{ fontSize: 12 }} onClick={() => void handleCompleteMs(ms.id)}>Concluir</button> : null
      ),
    }] : []),
  ], [canManage])

  const projStatusOpts = [
    { value: '', label: 'Todos' }, { value: 'active', label: 'Ativo' },
    { value: 'completed', label: 'Concluído' }, { value: 'on_hold', label: 'Pausado' },
  ]
  const taskStatusOpts = [
    { value: '', label: 'Todos' }, { value: 'todo', label: 'A fazer' },
    { value: 'in_progress', label: 'Em progresso' }, { value: 'review', label: 'Revisão' },
    { value: 'done', label: 'Concluído' },
  ]

  const tsTotal = useMemo(() => timesheets.reduce((s, ts) => s + Number(ts.totalCost), 0), [timesheets])
  const tsHours = useMemo(() => timesheets.reduce((s, ts) => s + Number(ts.hours), 0), [timesheets])

  return (
    <div className="page">
      <PageHeader />
      <Tabs tabs={tabItems} active={tab} onChange={(k) => { setTab(k); setShowForm(false); setSelectedProject(null) }} />

      <TabPanel active={tab === 'dashboard'}>
        
        {dash && (
          <KpiRow>
            <KpiCard label="Projetos Ativos" value={dash.activeCount} />
            <KpiCard label="Orçamento Total" value={fmtCurrency(dash.totalBudget)} />
            <KpiCard label="Total Gasto" value={fmtCurrency(dash.totalSpent)} tone={dash.totalSpent > dash.totalBudget * 0.8 ? 'warning' : 'default'} />
            <KpiCard label="Burn %" value={dash.totalBudget > 0 ? `${Math.round((dash.totalSpent / dash.totalBudget) * 100)}%` : '—'} />
          </KpiRow>
        )}
      </TabPanel>

      <TabPanel active={tab === 'projects'}>
        <SearchToolbar
          query="" onQueryChange={() => {}} placeholder="Buscar projeto..."
          count={projects.length}
          actions={
            <div style={{ display: 'flex', gap: 8 }}>
              <Select value={projStatusFilter} options={projStatusOpts} onChange={setProjStatusFilter} />
              {canManage && <button type="button" onClick={() => setShowForm(true)}>+ Novo Projeto</button>}
            </div>
          }
        />
        {showForm && <ProjectForm onSaved={() => { setShowForm(false); setStatus('Projeto criado.'); void loadProjects() }} />}
        <DataTable columns={projCols} rows={projects} rowKey={(p) => p.id} loading={projLoading}
          onRowClick={(p) => setSelectedProject(selectedProject?.id === p.id ? null : p)} />

        {selectedProject && (
          <DetailPanel open onClose={() => setSelectedProject(null)} title={selectedProject.name}
            subtitle={`Cliente: ${selectedProject.customerName ?? '—'}`}>
            <DetailGrid columns={4}>
              <DetailField label="Status" value={lbl(projStatusLabel, selectedProject.status)} />
              <DetailField label="Orçamento" value={fmtCurrency(selectedProject.budget ?? 0)} />
              <DetailField label="Gasto" value={fmtCurrency(selectedProject.spent)} />
              <DetailField label="Início" value={fmtDate(selectedProject.startDate)} />
              <DetailField label="Fim Previsto" value={fmtDate(selectedProject.expectedEndDate)} />
              <DetailField label="Criação" value={fmtDate(selectedProject.createdAt)} />
            </DetailGrid>
          </DetailPanel>
        )}
      </TabPanel>

      <TabPanel active={tab === 'tasks'}>
        
        {selectedProjectId && (
          <>
            <SearchToolbar
              query="" onQueryChange={() => {}} placeholder="Filtrar tarefas..."
              count={tasks.length}
              actions={
                <div style={{ display: 'flex', gap: 8 }}>
                  <Select value={taskStatusFilter} options={taskStatusOpts} onChange={setTaskStatusFilter} />
                  {canManage && <button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Nova Tarefa'}</button>}
                </div>
              }
            />
            {showForm && <TaskForm projectId={selectedProjectId} onSaved={() => { setShowForm(false); setStatus('Tarefa criada.'); void loadTasks() }} />}
            <DataTable columns={taskCols} rows={tasks} rowKey={(t) => t.id} loading={tasksLoading} emptyMessage="Nenhuma tarefa neste projeto." />
          </>
        )}
      </TabPanel>

      <TabPanel active={tab === 'timesheets'}>
        
        {selectedProjectId && (
          <>
            <KpiRow>
              <KpiCard label="Total Horas" value={fmtQty(tsHours, 1)} />
              <KpiCard label="Custo Total" value={fmtCurrency(tsTotal)} />
              <KpiCard label="Lançamentos" value={timesheets.length} />
            </KpiRow>
            <SearchToolbar
              query="" onQueryChange={() => {}} placeholder="Filtrar timesheets..."
              count={timesheets.length}
              actions={<button type="button" onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancelar' : '+ Lançar Horas'}</button>}
            />
            {showForm && <TimesheetForm projectId={selectedProjectId} onSaved={() => { setShowForm(false); setStatus('Horas registradas.'); void loadTs() }} />}
            <DataTable columns={tsCols} rows={timesheets} rowKey={(ts) => ts.id} loading={tsLoading} emptyMessage="Nenhum lançamento de horas." />
          </>
        )}
      </TabPanel>

      <TabPanel active={tab === 'milestones'}>
        
        {selectedProjectId && (
          <>
            <SearchToolbar
              query="" onQueryChange={() => {}} placeholder="Filtrar milestones..."
              count={milestones.length}
              actions={canManage ? <button type="button" onClick={() => setShowForm(true)}>+ Milestone</button> : undefined}
            />
            {showForm && <MilestoneForm projectId={selectedProjectId} onSaved={() => { setShowForm(false); setStatus('Milestone criado.'); void loadMs() }} />}
            <DataTable columns={msCols} rows={milestones} rowKey={(ms) => ms.id} loading={msLoading} emptyMessage="Nenhum milestone neste projeto." />
          </>
        )}
      </TabPanel>
    </div>
  )
}

function ProjectForm({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [startDate, setStartDate] = useState('')
  const [budget, setBudget] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!name) return
    setSubmitting(true); setError('')
    try {
      await createProject({ name, customerId: customerId || undefined, startDate: startDate || undefined, budget: budget ? Number(budget) : undefined })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <label>Nome do Projeto * <input value={name} onChange={e => setName(e.target.value)} /></label>
        <label>ID do Cliente <input value={customerId} onChange={e => setCustomerId(e.target.value)} placeholder="UUID (opcional)" /></label>
        <label>Data Início <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></label>
        <label>Orçamento (R$) <input type="number" step="0.01" value={budget} onChange={e => setBudget(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
        <button type="button" disabled={!name || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Criar Projeto'}</button>
      </div>
    </div>
  )
}

function TaskForm({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [estimatedHours, setEstimatedHours] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!name) return
    setSubmitting(true); setError('')
    try {
      await createTask(projectId, { name, startDate: startDate || undefined, endDate: endDate || undefined, estimatedHours: estimatedHours ? Number(estimatedHours) : undefined })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <label>Nome da Tarefa * <input value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Data Início <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} /></label>
        <label>Data Fim <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} /></label>
        <label>Horas Estimadas <input type="number" step="0.5" value={estimatedHours} onChange={e => setEstimatedHours(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
        <button type="button" disabled={!name || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Criar Tarefa'}</button>
      </div>
    </div>
  )
}

function TimesheetForm({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
  const [workDate, setWorkDate] = useState(new Date().toISOString().slice(0, 10))
  const [hours, setHours] = useState('')
  const [hourlyCost, setHourlyCost] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!hours || !hourlyCost) return
    setSubmitting(true); setError('')
    try {
      await createTimesheet(projectId, { workDate, hours: Number(hours), hourlyCost: Number(hourlyCost), notes: notes || undefined })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <label>Data * <input type="date" value={workDate} onChange={e => setWorkDate(e.target.value)} /></label>
        <label>Horas * <input type="number" step="0.5" value={hours} onChange={e => setHours(e.target.value)} /></label>
        <label>Custo/Hora (R$) * <input type="number" step="0.01" value={hourlyCost} onChange={e => setHourlyCost(e.target.value)} /></label>
        <label>Notas <input value={notes} onChange={e => setNotes(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
        <button type="button" disabled={!hours || !hourlyCost || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Lançar Horas'}</button>
      </div>
    </div>
  )
}

function MilestoneForm({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [plannedDate, setPlannedDate] = useState('')
  const [billingAmount, setBillingAmount] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    if (!name) return
    setSubmitting(true); setError('')
    try {
      await createMilestone(projectId, { name, plannedDate: plannedDate || undefined, billingAmount: billingAmount ? Number(billingAmount) : undefined })
      onSaved()
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro.') }
    setSubmitting(false)
  }

  return (
    <div className="inline-create-form" style={{ marginBottom: 16 }}>
      <div className="inline-create-body">
        <label>Nome do Milestone * <input value={name} onChange={e => setName(e.target.value)} /></label>
        <label>Data Planejada <input type="date" value={plannedDate} onChange={e => setPlannedDate(e.target.value)} /></label>
        <label>Valor Faturamento (R$) <input type="number" step="0.01" value={billingAmount} onChange={e => setBillingAmount(e.target.value)} /></label>
        {error && <p style={{ color: '#c44' }}>{error}</p>}
      </div>
      <div className="inline-create-footer">
        <button type="button" className="ghost" onClick={() => setShowForm(false)}>Cancelar</button>
        <button type="button" disabled={!name || submitting} onClick={() => void handleSubmit()}>{submitting ? 'Processando...' : 'Criar Milestone'}</button>
      </div>
    </div>
  )
}
