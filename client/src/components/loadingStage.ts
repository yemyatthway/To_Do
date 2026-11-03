import { useCallback, useEffect, useState } from 'react'

/** Under a second there's nothing to say; then the page's shape; past ten seconds, an honest note. */
export const SKELETON_AFTER_MS = 1000
export const SLOW_AFTER_MS = 10_000

export type LoadingStage = 'hidden' | 'skeleton' | 'slow'

export function stageAfter(elapsedMs: number): LoadingStage {
  if (elapsedMs < SKELETON_AFTER_MS) return 'hidden'
  return elapsedMs < SLOW_AFTER_MS ? 'skeleton' : 'slow'
}

/** Which stage a wait is at. `restart` begins the count again, e.g. after "Try again". */
export function useLoadingStage(active: boolean) {
  const [stage, setStage] = useState<LoadingStage>('hidden')
  const [attempt, setAttempt] = useState(0) // after "Try again" the page keeps its skeleton

  useEffect(() => {
    if (!active) return
    const timers = [
      setTimeout(() => setStage(stageAfter(SKELETON_AFTER_MS)), SKELETON_AFTER_MS),
      setTimeout(() => setStage(stageAfter(SLOW_AFTER_MS)), SLOW_AFTER_MS),
    ]
    return () => {
      timers.forEach(clearTimeout)
      setStage('hidden')
    }
  }, [active, attempt])

  const restart = useCallback(() => setAttempt((n) => n + 1), [])
  const shown: LoadingStage = !active ? 'hidden' : stage === 'hidden' && attempt > 0 ? 'skeleton' : stage
  return { stage: shown, restart }
}
