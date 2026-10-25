import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'
import { addDays, monthGrid, monthStart, sameDay, startOfDay, toDateInput } from '../time'

const WEEKDAYS = Array.from({ length: 7 }, (_, i) =>
  // 2024-01-01 was a Monday; only the weekday names are used.
  new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'narrow' }),
)
const WEEKDAY_NAMES = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString(undefined, { weekday: 'long' }))

const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1)

interface CalendarProps {
  /** The selected day. */
  value: Date
  onChange: (day: Date) => void
  /** Today: days before it can't be picked, and it gets the "today" ring. */
  minDate: Date
  /** "YYYY-MM-DD" keys of days that have tasks, for the little dots. */
  marked?: Set<string>
  onMonthChange?: (month: Date) => void
}

/**
 * Month view. Arrow keys move between days, Enter picks; days before `minDate` are disabled
 * and the month before `minDate`'s month can't be opened.
 */
export function Calendar({ value, onChange, minDate, marked, onMonthChange }: CalendarProps) {
  const [month, setMonth] = useState(() => monthStart(value))
  const [focused, setFocused] = useState(() => startOfDay(value))
  const gridRef = useRef<HTMLDivElement>(null)
  const keyboard = useRef(false)
  const min = startOfDay(minDate)
  const today = min
  const days = useMemo(() => monthGrid(month), [month])
  const canGoBack = monthStart(month) > monthStart(min)

  useEffect(() => {
    onMonthChange?.(month)
  }, [month, onMonthChange])

  // Keep keyboard focus on the focused day after arrow-key moves.
  useEffect(() => {
    if (!keyboard.current) return
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${toDateInput(focused)}"]`)?.focus()
  }, [focused, month])

  function moveFocus(next: Date) {
    if (next < min) return
    keyboard.current = true
    setFocused(next)
    if (next.getMonth() !== month.getMonth() || next.getFullYear() !== month.getFullYear()) setMonth(monthStart(next))
  }

  function onKeyDown(e: React.KeyboardEvent, day: Date) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key]
    if (step) {
      e.preventDefault()
      moveFocus(addDays(day, step))
    } else if (e.key === 'PageUp' && canGoBack) {
      e.preventDefault()
      setMonth(addMonths(month, -1))
    } else if (e.key === 'PageDown') {
      e.preventDefault()
      setMonth(addMonths(month, 1))
    }
  }

  const title = month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

  return (
    <div className="calendar">
      <div className="calendar-head">
        <button
          type="button"
          className="icon-btn"
          aria-label="Previous month"
          disabled={!canGoBack}
          onClick={() => setMonth(addMonths(month, -1))}
        >
          <Icon name="back" />
        </button>
        <span className="calendar-title" aria-live="polite">
          {title}
        </span>
        <button type="button" className="icon-btn" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))}>
          <Icon name="chevron" />
        </button>
      </div>

      <div className="calendar-grid" role="grid" aria-label={title} ref={gridRef}>
        <div className="calendar-row" role="row">
          {WEEKDAYS.map((d, i) => (
            <span key={i} className="calendar-weekday" role="columnheader" aria-label={WEEKDAY_NAMES[i]}>
              {d}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, week) => (
          <div key={week} className="calendar-row" role="row">
            {days.slice(week * 7, week * 7 + 7).map((day) => {
              const key = toDateInput(day)
              const past = day < min
              const outside = day.getMonth() !== month.getMonth()
              const selected = sameDay(day, value)
              const isToday = sameDay(day, today)
              const hasTasks = marked?.has(key)
              const classes = ['calendar-day', outside && 'outside', isToday && 'today', selected && 'selected', hasTasks && 'marked']
                .filter(Boolean)
                .join(' ')
              const label = day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
              return (
                <span key={key} role="gridcell" aria-selected={selected}>
                  <button
                    type="button"
                    className={classes}
                    data-day={key}
                    disabled={past}
                    tabIndex={sameDay(day, focused) ? 0 : -1}
                    aria-label={`${label}${isToday ? ', today' : ''}${hasTasks ? ', has tasks' : ''}${past ? ', past' : ''}`}
                    aria-current={isToday ? 'date' : undefined}
                    onClick={() => {
                      keyboard.current = false
                      setFocused(day)
                      if (outside) setMonth(monthStart(day))
                      onChange(day)
                    }}
                    onKeyDown={(e) => onKeyDown(e, day)}
                  >
                    {day.getDate()}
                  </button>
                </span>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
