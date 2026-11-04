import { useEffect, useState, useSyncExternalStore } from 'react'

function subscribe(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

/**
 * False while the tab is in the background or the phone screen is off. Tickers and polling stop
 * then (no wasted re-renders or network wake-ups draining the battery) and catch up on return.
 */
export function usePageVisible() {
  return useSyncExternalStore(subscribe, () => !document.hidden, () => true)
}

export function usePhoneLayout() {
  const [phone, setPhone] = useState(() => window.matchMedia('(max-width: 759px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 759px)')
    const onChange = () => setPhone(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return phone
}
