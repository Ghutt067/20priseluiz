export const DROPDOWN_VISIBLE_ROWS = 4.5
export const DROPDOWN_OVERSCAN = 0

export function getDropdownViewportHeight(
  rowHeight: number,
  visibleRows = DROPDOWN_VISIBLE_ROWS,
) {
  return Math.max(rowHeight * visibleRows, rowHeight)
}

export function getEstimatedTotalRowCount(
  loadedRowCount: number,
  hasMore: boolean,
  pageSize: number,
  bufferPages = 4,
) {
  const loaded = Math.max(Math.floor(loadedRowCount), 0)
  if (!hasMore) return loaded
  const safePageSize = Math.max(Math.floor(pageSize), 1)
  const safeBufferPages = Math.max(Math.floor(bufferPages), 1)
  const bufferedTotal = loaded + safePageSize * safeBufferPages
  return Math.max(bufferedTotal, safePageSize)
}

export type VirtualDropdownWindow = {
  start: number
  end: number
  offsetTop: number
  offsetBottom: number
}

export function createVirtualDropdownWindow(
  totalCount: number,
  scrollTop: number,
  rowHeight: number,
  options?: {
    visibleRows?: number
    overscan?: number
  },
): VirtualDropdownWindow {
  const safeTotalCount = Math.max(Math.floor(totalCount), 0)
  const overscan = Math.max(options?.overscan ?? DROPDOWN_OVERSCAN, 0)
  const visibleRows = Math.max(options?.visibleRows ?? DROPDOWN_VISIBLE_ROWS, 1)
  const visibleCount = Math.max(Math.ceil(visibleRows) + overscan * 2, 1)
  const firstVisible = Math.max(Math.floor(scrollTop / rowHeight), 0)
  const start = Math.min(Math.max(firstVisible - overscan, 0), safeTotalCount)
  const end = Math.min(start + visibleCount, safeTotalCount)
  const offsetTop = start * rowHeight
  const offsetBottom = Math.max((safeTotalCount - end) * rowHeight, 0)

  return {
    start,
    end,
    offsetTop,
    offsetBottom,
  }
}

export function createVirtualDropdownSlice<T>(
  items: T[],
  scrollTop: number,
  rowHeight: number,
  options?: {
    visibleRows?: number
    overscan?: number
    totalCount?: number
  },
) {
  const totalCount = Math.max(
    typeof options?.totalCount === 'number' && Number.isFinite(options.totalCount)
      ? Math.floor(options.totalCount)
      : items.length,
    items.length,
  )
  const window = createVirtualDropdownWindow(totalCount, scrollTop, rowHeight, {
    visibleRows: options?.visibleRows,
    overscan: options?.overscan,
  })

  const endLoaded = Math.min(window.end, items.length)

  return {
    start: window.start,
    end: window.end,
    offsetTop: window.offsetTop,
    offsetBottom: window.offsetBottom,
    items: items.slice(window.start, endLoaded),
  }
}

export function isNearDropdownBottom(
  element: HTMLElement,
  rowHeight: number,
  thresholdRows = 1.1,
) {
  const threshold = rowHeight * thresholdRows
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold
}

export function isNearLoadedRowsBottom(
  element: HTMLElement,
  loadedRowCount: number,
  rowHeight: number,
  thresholdRows = 1.1,
) {
  const threshold = rowHeight * thresholdRows
  const loadedBottom = Math.max(loadedRowCount * rowHeight, 0)
  return element.scrollTop + element.clientHeight >= loadedBottom - threshold
}

export function ensureDropdownItemVisible(
  container: HTMLDivElement | null,
  index: number,
  rowHeight: number,
) {
  if (!container || index < 0) return

  const top = index * rowHeight
  const bottom = top + rowHeight

  if (top < container.scrollTop) {
    container.scrollTop = top
    return
  }

  const visibleBottom = container.scrollTop + container.clientHeight
  if (bottom > visibleBottom) {
    container.scrollTop = bottom - container.clientHeight
  }
}
