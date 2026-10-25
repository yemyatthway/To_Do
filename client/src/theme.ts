import { useEffect, useState } from 'react'

export type ThemePreference = 'light' | 'dark' | 'auto'

const STORAGE_KEY = 'theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'light' || saved === 'dark' || saved === 'auto') return saved
  } catch {
    // Storage blocked (private mode); fall back to the system setting.
  }
  return 'auto'
}

/** Light / dark / auto (follows the system). Sets data-theme on <html> for the CSS tokens. */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readPreference)
  const [systemDark, setSystemDark] = useState(media.matches)

  useEffect(() => {
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  const resolved = preference === 'auto' ? (systemDark ? 'dark' : 'light') : preference

  useEffect(() => {
    document.documentElement.dataset.theme = resolved
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#131a29' : '#e6eef8')
  }, [resolved])

  function choose(next: ThemePreference) {
    setPreference(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Not persisted; still applies for this visit.
    }
  }

  return { preference, resolved, choose, toggle: () => choose(resolved === 'dark' ? 'light' : 'dark') }
}
