import { tr } from './i18n'
/** What to say about an upload. Under a second nothing, then real progress, and past ten seconds the time left too. */
export interface UploadTiming {
  percent: number
  showProgress: boolean
  secondsLeft: number | null
}

export function uploadTiming(loaded: number, total: number, elapsedMs: number): UploadTiming {
  const share = total > 0 ? Math.min(loaded / total, 1) : 0
  const speed = elapsedMs > 0 ? loaded / elapsedMs : 0
  return {
    percent: Math.round(share * 100),
    showProgress: elapsedMs >= 1000,
    secondsLeft: elapsedMs >= 10_000 && speed > 0 && loaded < total ? Math.ceil((total - loaded) / speed / 1000) : null,
  }
}

export function timeLeftText(seconds: number) {
  if (seconds < 5) return tr('a few seconds left')
  if (seconds < 60) return tr('about {value} seconds left', { value: Math.ceil(seconds / 5) * 5 })
  const minutes = Math.ceil(seconds / 60)
  return minutes === 1 ? tr('about a minute left') : tr('about {minutes} minutes left', { minutes })
}

export function fileSizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return tr('{value} KB', { value: Math.round(bytes / 1024) })
  return tr('{value} MB', { value: (bytes / (1024 * 1024)).toFixed(1) })
}
