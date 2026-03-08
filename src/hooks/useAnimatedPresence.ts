import { useEffect, useRef, useState } from 'react'

/**
 * Keeps an element mounted while its exit animation plays.
 *
 * @param visible - whether the element should be logically visible
 * @param duration - exit animation duration in ms (default 200)
 * @returns `mounted` (render the element), `animating` (entry/exit in progress),
 *          `exiting` (exit animation playing)
 */
export function useAnimatedPresence(visible: boolean, duration = 200) {
  const [mounted, setMounted] = useState(visible)
  const [exiting, setExiting] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (visible) {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      setExiting(false)
      setMounted(true)
    } else if (mounted) {
      setExiting(true)
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setExiting(false)
        setMounted(false)
      }, duration)
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, duration])

  return { mounted, exiting }
}
