import { useMemo } from 'react'
import { useAuth } from '../contexts/useAuth'
import { can, canAll, canAny, type ActionKey } from '../lib/permissions'

/**
 * Convenience hook for permission checks in components.
 * Returns memoized permission check results to avoid re-renders.
 */
export function usePermission(action: ActionKey): boolean {
  const { role } = useAuth()
  return useMemo(() => can(role ?? 'vendedor', action), [role, action])
}

export function usePermissions(actions: ActionKey[]): Record<ActionKey, boolean> {
  const { role } = useAuth()
  return useMemo(() => {
    const r = role ?? 'vendedor'
    const result: Partial<Record<ActionKey, boolean>> = {}
    for (const action of actions) {
      result[action] = can(r, action)
    }
    return result as Record<ActionKey, boolean>
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, actions.join(',')])
}

export function useCanAll(actions: ActionKey[]): boolean {
  const { role } = useAuth()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => canAll(role ?? 'vendedor', actions), [role, actions.join(',')])
}

export function useCanAny(actions: ActionKey[]): boolean {
  const { role } = useAuth()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => canAny(role ?? 'vendedor', actions), [role, actions.join(',')])
}
