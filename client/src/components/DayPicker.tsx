import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { Icon } from '../icons'
import { gsap, useGsap } from '../motion'
import { addDays, monthGrid, sameDay, startOfDay, toDateInput } from '../time'
import { Calendar } from './Calendar'

interface DayPickerProps {
  day: Date
  now: Date
  onChange: (day: Date) => void
  onAddTask: (day: Date) => void
}

const longDay = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

/** "Today" and a calendar button. The calendar opens below it; past days can't be picked. */
export function DayPicker({ day, now, onChange, onAddTask }: DayPickerProps) {
  const [open, setOpen] = useState(false)
  const [marked, setMarked] = useState<Set<string>>(new Set())
  const wrapRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const today = startOfDay(now)
  const isToday = sameDay(day, today)

  useGsap(popRef, () => {
    if (open) gsap.fromTo(popRef.current, { autoAlpha: 0, y: -8, scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.35, transformOrigin: '50% 0%' })
  }, [open])

  // Close on a click outside or Escape (focus goes back to the button).
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Dots for days that have tasks in the month being shown.
  const loadMarks = useCallback((month: Date) => {
    const grid = monthGrid(month)
    api
      .listTasks(grid[0], addDays(grid[grid.length - 1], 1))
      .then((tasks) => setMarked(new Set(tasks.filter((t) => t.due_at).map((t) => toDateInput(new Date(t.due_at!))))))
      .catch(() => undefined)
  }, [])

  return (
    <div className="day-picker" ref={wrapRef} data-tour="day-strip">
      <div className="day-strip" role="group" aria-label="Day">
        <button aria-pressed={isToday} onClick={() => onChange(today)}>
          Today
        </button>
        <button
          ref={buttonRef}
          className="calendar-btn"
          aria-pressed={!isToday}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={() => setOpen(!open)}
        >
          <Icon name="calendar" />
          {isToday ? 'Calendar' : longDay(day)}
        </button>
      </div>

      {open && (
        <div ref={popRef} className="calendar-pop glass" role="dialog" aria-label="Pick a day">
          <Calendar value={day} minDate={today} marked={marked} onMonthChange={loadMarks} onChange={onChange} />
          <div className="calendar-foot">
            <span className="list-sub">
              {sameDay(day, today) ? 'Today' : sameDay(day, addDays(today, 1)) ? 'Tomorrow' : longDay(day)}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" className="text-btn" onClick={() => setOpen(false)}>
                Done
              </button>
              <button
                type="button"
                className="primary-btn calendar-add"
                onClick={() => {
                  setOpen(false)
                  onAddTask(day)
                }}
              >
                <Icon name="plus" />
                Add task
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
