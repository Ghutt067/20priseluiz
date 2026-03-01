import { type ReactNode } from 'react'

type Tab<T extends string> = {
  key: T
  label: string
  count?: number
}

type TabsProps<T extends string> = {
  readonly tabs: readonly Tab<T>[]
  readonly active: T
  readonly onChange: (key: T) => void
}

export function Tabs<T extends string>({ tabs, active, onChange }: TabsProps<T>) {
  return (
    <div className="v-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          className={`v-tab${active === tab.key ? ' active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.count !== undefined && <span className="v-tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  )
}

type TabPanelProps = {
  readonly active: boolean
  readonly children: ReactNode
}

export function TabPanel({ active, children }: TabPanelProps) {
  if (!active) return null
  return <div role="tabpanel">{children}</div>
}
