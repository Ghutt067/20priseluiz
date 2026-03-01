import { useCallback, useEffect, useRef, useState } from 'react'

type FetchFn<T> = (options: {
  offset: number
  limit: number
  signal: AbortSignal
}) => Promise<{ rows: T[]; totalCount: number }>

type UsePagedDataOptions<T> = {
  fetchFn: FetchFn<T>
  pageSize?: number
  deps?: unknown[]
}

type UsePagedDataResult<T> = {
  rows: T[]
  total: number
  offset: number
  loading: boolean
  setOffset: (offset: number) => void
  reload: () => void
}

export function usePagedData<T>(options: UsePagedDataOptions<T>): UsePagedDataResult<T> {
  const { fetchFn, pageSize = 20, deps = [] } = options
  const [rows, setRows] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const generationRef = useRef(0)

  const load = useCallback(() => {
    const generation = ++generationRef.current
    const controller = new AbortController()
    setLoading(true)

    fetchFn({ offset, limit: pageSize, signal: controller.signal })
      .then((result) => {
        if (generation !== generationRef.current) return
        setRows(result.rows)
        setTotal(result.totalCount)
      })
      .catch(() => {
        if (generation !== generationRef.current) return
        setRows([])
        setTotal(0)
      })
      .finally(() => {
        if (generation !== generationRef.current) return
        setLoading(false)
      })

    return () => {
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, pageSize, ...deps])

  useEffect(() => {
    const cleanup = load()
    return cleanup
  }, [load])

  const reload = useCallback(() => {
    generationRef.current++
    const controller = new AbortController()
    setLoading(true)

    fetchFn({ offset, limit: pageSize, signal: controller.signal })
      .then((result) => {
        setRows(result.rows)
        setTotal(result.totalCount)
      })
      .catch(() => {
        setRows([])
        setTotal(0)
      })
      .finally(() => {
        setLoading(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offset, pageSize, ...deps])

  return { rows, total, offset, loading, setOffset, reload }
}
