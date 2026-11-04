import { useEffect, useState } from 'react'
import { usePageVisible } from './visibility'

/** Re-renders every `ms` while the tab is visible. */
export function useTicker(ms: number) {
  const [now, setNow] = useState(() => new Date())
  const visible = usePageVisible()
  useEffect(() => {
    if (!visible) return
    const tick = () => setNow(new Date())
    const catchUp = setTimeout(tick, 0) // right away after the tab was hidden
    const id = setInterval(tick, ms)
    return () => {
      clearTimeout(catchUp)
      clearInterval(id)
    }
  }, [ms, visible])
  return now
}
