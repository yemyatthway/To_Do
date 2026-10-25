import { useEffect, useRef } from 'react'
import { usePageVisible } from './visibility'

const PUSH_EVENT = 'todo:push'

/** Forward "a push arrived" from the service worker to the page (call once at startup). */
export function listenForPushes() {
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'push') window.dispatchEvent(new Event(PUSH_EVENT))
  })
}

/**
 * Keeps a screen fresh without a permanent connection: runs `refresh` every `everyMs` while the
 * page is visible, as soon as it becomes visible again, and the moment a push notification
 * arrives (friend request, task added for you...). Nothing runs in the background, so it costs
 * no battery when the app isn't on screen.
 */
export function useLiveRefresh(refresh: () => unknown, everyMs: number) {
  const visible = usePageVisible()
  const latest = useRef(refresh)
  useEffect(() => {
    latest.current = refresh
  }, [refresh])

  useEffect(() => {
    if (!visible) return
    const run = () => void latest.current()
    const id = window.setInterval(run, everyMs)
    window.addEventListener(PUSH_EVENT, run)
    return () => {
      clearInterval(id)
      window.removeEventListener(PUSH_EVENT, run)
    }
  }, [visible, everyMs])

  // Coming back to the app: catch up straight away.
  const wasVisible = useRef(visible)
  useEffect(() => {
    if (visible && !wasVisible.current) void latest.current()
    wasVisible.current = visible
  }, [visible])
}
