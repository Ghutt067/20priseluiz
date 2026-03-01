export type ModeKey = 'chefe' | 'vendedor' | 'estoquista' | 'financeiro'

export type ModuleKey =
  | 'dashboard'
  | 'compras'
  | 'vendas'
  | 'estoque'
  | 'financeiro'
  | 'relatorios'
  | 'fiscal'
  | 'servicos'
  | 'crm'
  | 'pdv'
  | 'contratos'
  | 'frota'
  | 'producao'
  | 'wms'
  | 'patrimonio'
  | 'projetos'
  | 'comex'
  | 'qualidade'
  | 'tesouraria'
  | 'automacao'
  | 'esg'
  | 'franquias'
  | 'cadastros'
  | 'equipe'
  | 'configuracoes'

export type ModuleGroup =
  | 'Geral'
  | 'Comercial'
  | 'Estoque'
  | 'Financeiro'
  | 'Fiscal'
  | 'Serviços'
  | 'CRM'
  | 'PDV'
  | 'Logística'
  | 'Frota'
  | 'Indústria'
  | 'Patrimônio'
  | 'Projetos'
  | 'Comércio Exterior'
  | 'Qualidade'
  | 'Automação'
  | 'ESG'
  | 'Rede'
  | 'Administração'
  | 'Sistema'

export type ModuleConfig = {
  key: ModuleKey
  label: string
  path: string
  group: ModuleGroup
  modes: ModeKey[]
  description?: string
}

export const modules: ModuleConfig[] = [
  {
    key: 'dashboard',
    label: 'Dashboard',
    path: '/dashboard',
    group: 'Geral',
    modes: ['chefe', 'vendedor', 'estoquista', 'financeiro'],
    description: 'Indicadores operacionais e atalhos rápidos.',
  },
  {
    key: 'vendas',
    label: 'Vendas',
    path: '/vendas',
    group: 'Comercial',
    modes: ['chefe', 'vendedor'],
  },
  {
    key: 'compras',
    label: 'Compras',
    path: '/compras',
    group: 'Estoque',
    modes: ['chefe', 'estoquista'],
    description: 'Gestão de suprimentos e recebimentos.',
  },
  {
    key: 'estoque',
    label: 'Estoque',
    path: '/estoque',
    group: 'Estoque',
    modes: ['chefe', 'estoquista'],
    description: 'Posição, kardex e operações de inventário.',
  },
  {
    key: 'financeiro',
    label: 'Financeiro',
    path: '/financeiro',
    group: 'Financeiro',
    modes: ['chefe', 'financeiro'],
    description: 'Contas, fluxo de caixa e baixas.',
  },
  {
    key: 'relatorios',
    label: 'Relatórios & Conciliação',
    path: '/relatorios',
    group: 'Financeiro',
    modes: ['chefe', 'financeiro'],
    description: 'Demonstrativos e conciliação bancária (OFX).',
  },
  {
    key: 'fiscal',
    label: 'Fiscal',
    path: '/fiscal',
    group: 'Fiscal',
    modes: ['chefe', 'financeiro'],
    description: 'Documentos fiscais e parametrização.',
  },
  {
    key: 'servicos',
    label: 'Serviços',
    path: '/servicos',
    group: 'Serviços',
    modes: ['chefe', 'vendedor', 'financeiro'],
    description: 'Ordens de serviço (OS) e apontamentos.',
  },
  {
    key: 'crm',
    label: 'Comercial (CRM)',
    path: '/crm',
    group: 'CRM',
    modes: ['chefe', 'vendedor'],
    description: 'Gestão de relacionamento e funil B2B.',
  },
  {
    key: 'pdv',
    label: 'Frente de Caixa (PDV)',
    path: '/pdv',
    group: 'PDV',
    modes: ['chefe', 'vendedor'],
    description: 'Emissão rápida e controle de turno.',
  },
  {
    key: 'contratos',
    label: 'Contratos',
    path: '/contratos',
    group: 'Financeiro',
    modes: ['chefe', 'financeiro'],
    description: 'Faturamento recorrente e gestão de SLA.',
  },
  {
    key: 'frota',
    label: 'Frota',
    path: '/frota',
    group: 'Frota',
    modes: ['chefe', 'estoquista'],
    description: 'Telemetria, manutenção e sinistros.',
  },
  {
    key: 'producao',
    label: 'Produção (PCP)',
    path: '/producao',
    group: 'Indústria',
    modes: ['chefe', 'estoquista'],
    description: 'Ficha técnica, ordens de produção, apontamento e custos.',
  },
  {
    key: 'wms',
    label: 'Armazém (WMS)',
    path: '/wms',
    group: 'Logística',
    modes: ['chefe', 'estoquista'],
    description: 'Endereçamento, picking e cubagem.',
  },
  {
    key: 'patrimonio',
    label: 'Ativo Imobilizado',
    path: '/patrimonio',
    group: 'Patrimônio',
    modes: ['chefe', 'financeiro'],
    description: 'Controle patrimonial e depreciação mensal.',
  },
  {
    key: 'projetos',
    label: 'Projetos',
    path: '/projetos',
    group: 'Projetos',
    modes: ['chefe', 'vendedor'],
    description: 'Gantt, timesheets, milestones e faturamento por etapa.',
  },
  {
    key: 'comex',
    label: 'Comércio Exterior',
    path: '/comex',
    group: 'Comércio Exterior',
    modes: ['chefe', 'estoquista'],
    description: 'Processos de importação e desembaraço.',
  },
  {
    key: 'qualidade',
    label: 'Qualidade (QMS)',
    path: '/qualidade',
    group: 'Qualidade',
    modes: ['chefe', 'estoquista'],
    description: 'Conformidade, auditorias e instrumentos.',
  },
  {
    key: 'tesouraria',
    label: 'Tesouraria',
    path: '/tesouraria',
    group: 'Financeiro',
    modes: ['chefe', 'financeiro'],
    description: 'Empréstimos SAC/PRICE, aplicações e intercompany.',
  },
  {
    key: 'automacao',
    label: 'Automação',
    path: '/automacao',
    group: 'Automação',
    modes: ['chefe'],
    description: 'Regras de notificação e assinatura digital.',
  },
  {
    key: 'esg',
    label: 'ESG & Compliance',
    path: '/esg',
    group: 'ESG',
    modes: ['chefe'],
    description: 'Inventário de carbono e canal de denúncias.',
  },
  {
    key: 'franquias',
    label: 'Franquias & Filiais',
    path: '/franquias',
    group: 'Rede',
    modes: ['chefe'],
    description: 'Royalties, catálogo global/local e DRE consolidado.',
  },
  {
    key: 'cadastros',
    label: 'Cadastros',
    path: '/cadastros',
    group: 'Administração',
    modes: ['chefe', 'vendedor', 'estoquista', 'financeiro'],
    description: 'Clientes, fornecedores, produtos, depósitos e mais.',
  },
  {
    key: 'equipe',
    label: 'Equipe',
    path: '/equipe',
    group: 'Administração',
    modes: ['chefe'],
    description: 'Adicionar e gerenciar funcionários.',
  },
  {
    key: 'configuracoes',
    label: 'Configurações',
    path: '/configuracoes',
    group: 'Sistema',
    modes: ['chefe'],
    description: 'Dados da empresa, PDV, fiscal e preferências.',
  },
]

export const modeLabels: Record<ModeKey, string> = {
  chefe: 'Chefe',
  vendedor: 'Vendedor',
  estoquista: 'Estoquista',
  financeiro: 'Financeiro',
}

export const modeHome: Record<ModeKey, string> = {
  chefe: '/dashboard',
  vendedor: '/vendas',
  estoquista: '/estoque',
  financeiro: '/financeiro',
}

export function modulesForMode(mode: ModeKey, search = '') {
  const query = search.trim().toLowerCase()
  return modules.filter((module) => {
    if (!module.modes.includes(mode)) return false
    if (!query) return true
    return (
      module.label.toLowerCase().includes(query) ||
      module.group.toLowerCase().includes(query)
    )
  })
}
