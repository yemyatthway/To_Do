import { useEffect, useRef } from 'react'
import type { Task } from '../api'
import { useHourPress } from '../hourPress'
import { gsap } from '../motion'
import { formatHour } from '../time'
import { useTicker } from '../useTicker'
import { tr } from '../i18n'

const HOUR = 60 * 60_000
const pad = (n: number) => String(n).padStart(2, '0')

/** One digit that lifts in when it changes. */
function Digit({ value, tiny }: { value: string; tiny?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const shown = useRef(value)
  useEffect(() => {
    if (shown.current === value) return
    shown.current = value
    gsap.fromTo(ref.current, { y: tiny ? 8 : 18, opacity: 0, scale: 0.92 }, { y: 0, opacity: 1, scale: 1, duration: 0.42, ease: 'back.out(2)', clearProps: 'transform,opacity' })
  }, [value, tiny])
  return (
    <span ref={ref} className="digit">
      {value}
    </span>
  )
}

interface DigitalClockProps {
  tasks: Task[]
  /** When the 12 hours on show begin. */
  start: Date
  showNow: boolean
  selectedHour: number | null
  onSelectHour: (hour: number) => void
  onLongPressHour: (hour: number) => void
}

/** The same clock as numbers: the time, then the next 12 hours as one quiet row, with each hour's tasks as dots. */
export function DigitalClock({ tasks, start, showNow, selectedHour, onSelectHour, onLongPressHour }: DigitalClockProps) {
  const now = useTicker(1000)
  const press = useHourPress(onSelectHour, onLongPressHour)
  const hours = now.getHours() % 12 || 12
  const slots = Array.from({ length: 12 }, (_, i) => new Date(start.getTime() + i * HOUR))
  const time = `${hours}:${pad(now.getMinutes())}`

  return (
    <div className="digital-clock" data-tour="clock">
      <div className={`digital-face${showNow ? '' : ' ghost'}`} role="timer" aria-label={tr('The time is {time} {value}', { time, value: now.getHours() < 12 ? 'AM' : 'PM' })}>
        <span className="digital-time" aria-hidden="true">
          {pad(hours)
            .split('')
            .map((digit, i) => (
              <Digit key={`h${i}`} value={digit} />
            ))}
          <span className="digital-colon">:</span>
          {pad(now.getMinutes())
            .split('')
            .map((digit, i) => (
              <Digit key={`m${i}`} value={digit} />
            ))}
        </span>
        <span className="digital-side" aria-hidden="true">
          <span className="digital-seconds">
            {pad(now.getSeconds())
              .split('')
              .map((digit, i) => (
                <Digit key={`s${i}`} value={digit} tiny />
              ))}
          </span>
          <span className="digital-period">{now.getHours() < 12 ? 'AM' : 'PM'}</span>
        </span>
      </div>
      <div className="digital-hours" role="group" aria-label={tr('The next 12 hours. Tap an hour to see its tasks, press and hold to add one.')}>
        {slots.map((slot, index) => {
          const hour = slot.getHours() % 12 || 12
          const inHour = tasks.filter((task) => {
            const due = new Date(task.due_at!).getTime()
            return due >= slot.getTime() && due < slot.getTime() + HOUR
          })
          return (
            <button
              key={slot.getTime()}
              type="button"
              className={`digital-hour${showNow && index === 0 ? ' is-now' : ''}`}
              data-tour={index === 3 ? 'clock-hour' : undefined}
              aria-pressed={selectedHour === hour}
              aria-label={`${formatHour(slot)}, ${inHour.length} ${inHour.length === 1 ? 'task' : 'tasks'}`}
              {...press(hour)}
            >
              {hour}
              <span className="digital-dots" aria-hidden="true">
                {inHour.slice(0, 3).map((task) => (
                  <span key={task.id} className={`dot dot-${task.category}${task.done ? ' is-done' : ''}`} />
                ))}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
