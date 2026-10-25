import { useEffect, useState } from 'react'
import type { Task } from '../api'
import { Icon } from '../icons'
import { dueDate, formatTime } from '../time'
import { formatClock, timeLeft, type TimerState } from '../timer/useTimer'
import { usePageVisible } from '../visibility'

const PRESETS = [1, 5, 10, 15, 25, 45, 60]
const R = 104
const CIRCUMFERENCE = 2 * Math.PI * R
const MINUTE_OPTIONS = Array.from({ length: 181 }, (_, i) => i)
const SECOND_OPTIONS = Array.from({ length: 12 }, (_, i) => i * 5)

interface TimerProps {
  timer: TimerState
  tasks: Task[]
  onDuration: (ms: number) => void
  onTask: (taskId: number | null, label: string) => void
  onStart: () => void
  onPause: () => void
  onReset: () => void
  onAddMinute: () => void
}

/** Re-render a few times a second while the timer runs; idle screens don't tick at all. */
function useTicker(active: boolean) {
  const [now, setNow] = useState(() => Date.now())
  const visible = usePageVisible()
  useEffect(() => {
    if (!active || !visible) return
    const tick = () => setNow(Date.now())
    const catchUp = setTimeout(tick, 0) // right away after the tab was hidden
    const id = setInterval(tick, 250)
    return () => {
      clearTimeout(catchUp)
      clearInterval(id)
    }
  }, [active, visible])
  return now
}

export function Timer({ timer, tasks, onDuration, onTask, onStart, onPause, onReset, onAddMinute }: TimerProps) {
  const running = timer.status === 'running'
  const now = useTicker(running)
  const left = timeLeft(timer, now)
  const fraction = timer.duration ? left / timer.duration : 0
  const setting = timer.status === 'idle' || timer.status === 'done'
  const minutes = Math.floor(timer.duration / 60_000)
  const seconds = Math.round((timer.duration % 60_000) / 1000)

  // Where the end of the ring is, for the little marker dot.
  const angle = fraction * 2 * Math.PI
  const dotX = Math.sin(angle) * R
  const dotY = -Math.cos(angle) * R

  const openTasks = tasks.filter((t) => !t.done)
  // A linked task that has since been finished (or deleted) no longer counts.
  const linked = openTasks.find((t) => t.id === timer.taskId)
  const label = linked ? timer.label : ''
  const status =
    timer.status === 'running' ? 'Running' : timer.status === 'paused' ? 'Paused' : timer.status === 'done' ? "Time's up" : 'Ready'

  return (
    <div className="timer-page">
      <section className="timer-dial-panel" aria-label="Timer">
        <div className={`timer-dial${running ? ' is-running' : ''}${timer.status === 'done' ? ' is-done' : ''}`}>
          <div className="clock-face" />
          <svg viewBox="-150 -150 300 300" aria-hidden="true">
            {Array.from({ length: 60 }, (_, i) => {
              const a = (i * Math.PI) / 30
              const long = i % 5 === 0
              return (
                <line
                  key={i}
                  x1={Math.sin(a) * (long ? 116 : 121)}
                  y1={-Math.cos(a) * (long ? 116 : 121)}
                  x2={Math.sin(a) * 128}
                  y2={-Math.cos(a) * 128}
                  className={long ? 'timer-tick long' : 'timer-tick'}
                />
              )
            })}
            <circle r={R} className="timer-track" />
            <circle
              r={R}
              className="timer-progress"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={CIRCUMFERENCE * (1 - fraction)}
              transform="rotate(-90)"
            />
            {fraction > 0 && <circle cx={dotX} cy={dotY} r="9" className="timer-knob" />}
          </svg>
          <div className="timer-readout" role="timer" aria-live="off">
            <span className="timer-digits">{formatClock(left)}</span>
            <span className="timer-status">{status}</span>
            {label && <span className="timer-label">{label}</span>}
          </div>
        </div>

        <div className="timer-controls">
          {setting ? (
            <button className="primary-btn timer-main" onClick={onStart} disabled={timer.duration < 1000}>
              <Icon name="play" />
              {timer.status === 'done' ? 'Start again' : 'Start'}
            </button>
          ) : running ? (
            <button className="primary-btn timer-main" onClick={onPause}>
              <Icon name="pause" />
              Pause
            </button>
          ) : (
            <button className="primary-btn timer-main" onClick={onStart}>
              <Icon name="play" />
              Resume
            </button>
          )}
          {!setting && (
            <>
              <button className="round-btn" aria-label="Add one minute" onClick={onAddMinute}>
                +1
              </button>
              <button className="round-btn" aria-label="Reset timer" onClick={onReset}>
                <Icon name="undo" />
              </button>
            </>
          )}
          {timer.status === 'done' && (
            <button className="round-btn" aria-label="Reset timer" onClick={onReset}>
              <Icon name="undo" />
            </button>
          )}
        </div>
      </section>

      <section className={`card glass timer-setup${setting ? '' : ' locked'}`} aria-labelledby="timer-setup-h">
        <h2 id="timer-setup-h">Set the timer</h2>
        {!setting && <p className="hint">Pause and reset to change the time.</p>}

        <div className="field-group">
          <span className="label">Quick picks</span>
          <div className="chips">
            {PRESETS.map((m) => (
              <button
                key={m}
                type="button"
                className="chip"
                disabled={!setting}
                aria-pressed={timer.duration === m * 60_000}
                onClick={() => onDuration(m * 60_000)}
              >
                {m === 25 ? '25 min · Focus' : m === 60 ? '1 hour' : `${m} min`}
              </button>
            ))}
          </div>
        </div>

        <div className="field-group">
          <span className="label">Exact time</span>
          <div className="time-wheels">
            <label className="time-unit">
              <span className="sr-only">Minutes</span>
              <select
                className="time-select"
                disabled={!setting}
                value={minutes}
                onChange={(e) => onDuration(Number(e.target.value) * 60_000 + seconds * 1000)}
              >
                {MINUTE_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <span className="time-colon" aria-hidden="true">
              min
            </span>
            <label className="time-unit">
              <span className="sr-only">Seconds</span>
              <select
                className="time-select"
                disabled={!setting}
                value={seconds - (seconds % 5)}
                onChange={(e) => onDuration(minutes * 60_000 + Number(e.target.value) * 1000)}
              >
                {SECOND_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {String(s).padStart(2, '0')}
                  </option>
                ))}
              </select>
            </label>
            <span className="time-colon" aria-hidden="true">
              sec
            </span>
          </div>
        </div>

        <label className="field-group">
          <span className="label">For a task (optional)</span>
          <select
            className="field timer-task"
            disabled={!setting}
            value={linked?.id ?? ''}
            onChange={(e) => {
              const task = openTasks.find((t) => t.id === Number(e.target.value))
              onTask(task?.id ?? null, task?.title ?? '')
            }}
          >
            <option value="">No task, just a timer</option>
            {openTasks.map((t) => {
              const due = dueDate(t)
              return (
                <option key={t.id} value={t.id}>
                  {t.title}
                  {due ? ` · ${formatTime(due)}` : ''}
                </option>
              )
            })}
          </select>
          <span className="hint">When time's up you can mark it done in one tap.</span>
        </label>
      </section>
    </div>
  )
}
