import { useEffect, useState } from 'react'
import { Icon } from '../icons'
import { formatClock, timeLeft, type TimerState } from '../timer/useTimer'
import { tr } from '../i18n'

/**
 * Header button for a timer in progress. While one runs (or is paused) it shows the time left, and
 * the browser tab title shows it too, so you can watch it from any screen. Otherwise it stays out of
 * the way: the Timer page is in the sidebar and under More.
 */
export function TimerPill({ timer, active, onOpen }: { timer: TimerState; active: boolean; onOpen: () => void }) {
  const running = timer.status === 'running'
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])

  const live = running || timer.status === 'paused'
  const label = formatClock(timeLeft(timer, now))

  useEffect(() => {
    document.title = running ? tr('{label} · Todo Clock', { label }) : timer.status === 'done' ? tr('Time\'s up · Todo Clock') : tr('Todo Clock')
  }, [label, running, timer.status])

  useEffect(() => () => void (document.title = tr('Todo Clock')), [])

  if (!live) return null

  return (
    <button className="round-btn timer-pill live" aria-pressed={active} aria-label={tr('Timer, {label} left{value}', { label, value: running ? '' : tr(', paused') })} onClick={onOpen}>
      <Icon name="timer" />
      <span className="timer-pill-time">{label}</span>
    </button>
  )
}
