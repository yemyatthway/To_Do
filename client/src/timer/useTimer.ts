import { useCallback, useEffect, useRef, useState } from 'react'
import { primeChime, playChime } from './chime'

export type TimerStatus = 'idle' | 'running' | 'paused' | 'done'

export interface TimerState {
  status: TimerStatus
  /** Total length in ms (grows with +1 min). */
  duration: number
  /** The length that was picked; Reset goes back to it. */
  base?: number
  /** When it ends (epoch ms), while running. */
  endsAt: number | null
  /** Time left (ms), while paused. */
  left: number
  /** Optional task it's for. */
  taskId: number | null
  label: string
}

const STORAGE_KEY = 'timer'
const IDLE: TimerState = { status: 'idle', duration: 25 * 60_000, base: 25 * 60_000, endsAt: null, left: 25 * 60_000, taskId: null, label: '' }

function load(): TimerState {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as TimerState | null
    if (!saved) return IDLE
    // Ran out while the app was closed.
    if (saved.status === 'running' && saved.endsAt && saved.endsAt <= Date.now()) return { ...saved, status: 'done', endsAt: null, left: 0 }
    return saved
  } catch {
    return IDLE
  }
}

/** Time left right now, in ms. */
export function timeLeft(state: TimerState, now = Date.now()) {
  if (state.status === 'running' && state.endsAt) return Math.max(0, state.endsAt - now)
  return state.left
}

export function formatClock(ms: number) {
  const total = Math.ceil(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(m).padStart(h ? 2 : 1, '0')
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`
}

/**
 * Countdown timer kept in one place for the whole app. It stores the end time (not a ticking
 * counter), so it stays exact in background tabs and survives a reload. Screens that show the
 * time run their own light ticker; this hook only wakes up once, when the time is up.
 */
export function useTimer(onFinish: (state: TimerState) => void) {
  const [state, setState] = useState<TimerState>(load)
  const finishRef = useRef(onFinish)
  useEffect(() => {
    finishRef.current = onFinish
  }, [onFinish])

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      // Not saved; the timer still works for this visit.
    }
  }, [state])

  // One timeout to the end time; the browser may run it a little late in a background tab, never early.
  useEffect(() => {
    if (state.status !== 'running' || !state.endsAt) return
    const id = window.setTimeout(() => {
      const done = { ...state, status: 'done' as const, endsAt: null, left: 0 }
      setState(done)
      playChime()
      finishRef.current(done)
    }, Math.max(0, state.endsAt - Date.now()))
    return () => clearTimeout(id)
  }, [state])

  const setDuration = useCallback((ms: number) => {
    setState((s) => (s.status === 'running' ? s : { ...s, status: 'idle', duration: ms, base: ms, left: ms, endsAt: null }))
  }, [])

  const setTask = useCallback((taskId: number | null, label: string) => setState((s) => ({ ...s, taskId, label })), [])

  const start = useCallback(() => {
    primeChime() // unlock sound now, while we have the click
    setState((s) => {
      if (s.status === 'paused') return { ...s, status: 'running', endsAt: Date.now() + s.left }
      // A fresh start (or "Start again") uses the length that was picked, without earlier +1 mins.
      const length = s.base ?? s.duration
      return { ...s, status: 'running', duration: length, endsAt: Date.now() + length, left: length }
    })
  }, [])

  const pause = useCallback(() => setState((s) => (s.status === 'running' ? { ...s, status: 'paused', left: timeLeft(s), endsAt: null } : s)), [])

  const reset = useCallback(() => setState((s) => {
    const base = s.base ?? s.duration
    return { ...s, status: 'idle', endsAt: null, duration: base, left: base }
  }), [])

  const addMinute = useCallback(
    () =>
      setState((s) => {
        if (s.status === 'running' && s.endsAt) return { ...s, endsAt: s.endsAt + 60_000, duration: s.duration + 60_000 }
        if (s.status === 'paused') return { ...s, left: s.left + 60_000, duration: s.duration + 60_000 }
        return s
      }),
    [],
  )

  return { state, setDuration, setTask, start, pause, reset, addMinute }
}

/** Forget the saved timer (on logout, so the next person on this device doesn't see it). */
export function clearSavedTimer() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage blocked; nothing saved.
  }
}
