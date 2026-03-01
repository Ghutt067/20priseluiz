import { type ReactNode } from 'react'

type SplitPaneProps = {
  readonly list: ReactNode
  readonly detail: ReactNode
  readonly hasSelection?: boolean
}

export function SplitPane({ list, detail, hasSelection }: SplitPaneProps) {
  return (
    <div className={`split-pane${hasSelection ? ' has-selection' : ''}`}>
      <div className="split-pane-list">{list}</div>
      <div className="split-pane-detail">{detail}</div>
    </div>
  )
}
