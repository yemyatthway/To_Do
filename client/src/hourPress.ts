import { useRef } from 'react'

const LONG_PRESS_MS = 550

/** A tap filters an hour, and pressing and holding adds a task there, on either clock. */
export function useHourPress(onSelect: (hour: number) => void, onLongPress: (hour: number) => void) {
  const timer = useRef<number | undefined>(undefined)
  const longPressed = useRef(false)

  const cancel = () => window.clearTimeout(timer.current)
  return (hour: number) => ({
    onPointerDown: () => {
      longPressed.current = false
      cancel()
      timer.current = window.setTimeout(() => {
        longPressed.current = true
        onLongPress(hour)
      }, LONG_PRESS_MS)
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onClick: () => {
      cancel()
      // The click that ends a long-press shouldn't also filter.
      if (longPressed.current) {
        longPressed.current = false
        return
      }
      onSelect(hour)
    },
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onSelect(hour)
      }
    },
  })
}
