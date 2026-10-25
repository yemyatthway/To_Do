import { useEffect, useState } from 'react'
import { Icon } from '../icons'
import { formatClock, timeLeft, type TimerState } from '../timer/useTimer'

/**
 * Header button for the timer. While a timer runs (or is paused) it shows the time left, and the
 * browser tab title shows it too, so you can watch it from any screen.
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
    document.title = running ? `${label} · To-Do` : timer.status === 'done' ? "Time's up · To-Do" : 'To-Do'
  }, [label, running, timer.status])

  useEffect(() => () => void (document.title = 'To-Do'), [])

  return (
    <button
      className={`round-btn timer-pill${live ? ' live' : ''}`}
      data-tour="timer"
      aria-pressed={active}
      aria-label={live ? `Timer, ${label} left${running ? '' : ', paused'}` : 'Timer'}
      onClick={onOpen}
    >
      <Icon name="timer" />
      {live && <span className="timer-pill-time">{label}</span>}
    </button>
  )
}
