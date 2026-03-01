import { useEffect, useRef } from 'react'
import { useToast } from '../components/ui'

/**
 * Bridge hook: watches a status string state and automatically
 * fires a toast when it changes to a non-empty value.
 * 
 * This lets existing pages get toast notifications without
 * rewriting all their status message call sites.
 */
export function useStatusToast(
  statusText: string,
  options?: { inferType?: boolean },
) {
  const { toast } = useToast()
  const prevRef = useRef(statusText)
  const inferType = options?.inferType ?? true

  useEffect(() => {
    if (!statusText || statusText === prevRef.current) return
    prevRef.current = statusText

    if (!inferType) {
      toast(statusText, 'info')
      return
    }

    const lower = statusText.toLowerCase()
    if (lower.includes('erro') || lower.includes('falha') || lower.includes('inválid')) {
      toast(statusText, 'error')
    } else if (lower.includes('sucesso') || lower.includes('salv') || lower.includes('criado') || lower.includes('concluíd') || lower.includes('registrad')) {
      toast(statusText, 'success')
    } else if (lower.includes('atenção') || lower.includes('aviso') || lower.includes('cuidado')) {
      toast(statusText, 'warning')
    } else {
      toast(statusText, 'info')
    }
  }, [statusText, toast, inferType])
}
