import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { Category, Priority, Task, TaskInput } from '../api'
import { Icon } from '../icons'
import { Calendar } from './Calendar'
import { TimePicker } from './TimePicker'
import { gsap, useGsap } from '../motion'
import { addDays, dueDate, fromInputs, startOfDay, toDateInput, toTimeInput } from '../time'

const parseDate = (value: string) => {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d)
}
const dateLabel = (value: string) => parseDate(value).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })

const CATEGORIES: { value: Category; label: string; color: string }[] = [
  { value: 'work', label: 'Work', color: '#2f6fd6' },
  { value: 'personal', label: 'Personal', color: '#6a5ae0' },
  { value: 'health', label: 'Health', color: '#17766b' },
]
const PRIORITIES: { value: Priority; label: string; color: string }[] = [
  { value: 'low', label: 'Low', color: '#2f6fd6' },
  { value: 'medium', label: 'Medium', color: '#2f6fd6' },
  { value: 'high', label: 'High', color: '#b8431f' },
]
const REMIND_MINUTES = 10

export interface SheetDefaults {
  date: Date
  /** "14:00", or "" for anytime. */
  time: string
  /** True when the time came from pressing an hour on the clock. */
  fromClock?: boolean
}

interface TaskSheetProps {
  task: Task | null
  defaults: SheetDefaults
  remindersOn: boolean
  onClose: () => void
  onSave: (input: TaskInput) => Promise<void>
  onDelete: (task: Task) => void
  /** Send a copy of this (saved) task to a friend. */
  onSend?: (task: Task) => void
}

export function TaskSheet({ task, defaults, remindersOn, onClose, onSave, onDelete, onSend }: TaskSheetProps) {
  const due = task ? dueDate(task) : null
  const [title, setTitle] = useState(task?.title ?? '')
  const [notes, setNotes] = useState(task?.notes ?? '')
  const [date, setDate] = useState(toDateInput(due ?? defaults.date))
  const [time, setTime] = useState(task ? (due ? toTimeInput(due) : '') : defaults.time)
  const [category, setCategory] = useState<Category>(task?.category ?? 'personal')
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'medium')
  const [remind, setRemind] = useState(task ? task.remind_before_minutes !== null : true)
  const [done, setDone] = useState(task?.done ?? false)
  const canRemind = Boolean(time) && remindersOn
  // Turning the time off and on again brings back the last time, so a mistaken tap costs nothing.
  const lastTime = useRef(time || defaults.time || '09:00')

  function toggleTime() {
    if (time) {
      lastTime.current = time
      setTime('')
    } else {
      setTime(lastTime.current)
    }
  }
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const sheetRef = useRef<HTMLFormElement>(null)
  const leaving = useRef(false)
  const headingId = useId()

  // Slide up on open; slide back down before anything closes the sheet.
  useGsap(scrimRef, () => {
    const desktop = window.matchMedia('(min-width: 960px)').matches
    gsap.fromTo(scrimRef.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25, ease: 'power1.out' })
    gsap.fromTo(
      sheetRef.current,
      desktop ? { autoAlpha: 0, y: 28, scale: 0.97 } : { yPercent: 100 },
      desktop
        ? { autoAlpha: 1, y: 0, scale: 1, duration: 0.45, ease: 'power3.out' }
        : { yPercent: 0, duration: 0.55, ease: 'expo.out' },
    )
  }, [])

  const leave = useCallback((then: () => void) => {
    if (leaving.current) return
    leaving.current = true
    const desktop = window.matchMedia('(min-width: 960px)').matches
    gsap.to(scrimRef.current, { autoAlpha: 0, duration: 0.22 })
    gsap.to(sheetRef.current, {
      ...(desktop ? { autoAlpha: 0, y: 16, scale: 0.98 } : { yPercent: 100 }),
      duration: 0.3,
      ease: 'power2.in',
      onComplete: then,
    })
  }, [])

  const close = useCallback(() => leave(onClose), [leave, onClose])

  // If this sheet is replaced mid-exit (opened again quickly), stop its exit so it can't close the new one.
  useEffect(() => {
    const els = [scrimRef.current, sheetRef.current]
    return () => {
      gsap.killTweensOf(els)
    }
  }, [])

  const [showCalendar, setShowCalendar] = useState(false)
  const originalDate = useRef(date)

  function pickDate(value: string, fromCalendar = false) {
    setDate(value)
    setError('')
    if (fromCalendar) setShowCalendar(false)
  }

  const [[today, tomorrow]] = useState(() => {
    const start = startOfDay(new Date())
    return [toDateInput(start), toDateInput(addDays(start, 1))]
  })

  useEffect(() => {
    if (!task) titleRef.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [task, close])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) {
      setError('Enter a title.')
      titleRef.current?.focus()
      return
    }
    if (!date) {
      setError('Pick a date.')
      return
    }
    // A past day is only kept when editing a task that was already on it.
    if (date < today && date !== originalDate.current) {
      setError('Pick today or a later date.')
      return
    }
    setSaving(true)
    try {
      await onSave({
        title: title.trim(),
        notes: notes.trim(),
        due_at: time ? fromInputs(date, time).toISOString() : null,
        category,
        priority,
        // With reminders off account-wide the switch is locked, so keep whatever the task already had.
        remind_before_minutes: !remindersOn ? (task?.remind_before_minutes ?? null) : time && remind ? REMIND_MINUTES : null,
        done,
      })
      leave(onClose)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  return (
    <div ref={scrimRef} className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <form ref={sheetRef} className="sheet" role="dialog" aria-modal="true" aria-labelledby={headingId} onSubmit={submit} noValidate>
        <div className="sheet-top">
        <div className="grabber" aria-hidden="true" />
        <div className="sheet-head">
          <h2 id={headingId}>{task ? 'Edit task' : 'New task'}</h2>
          <div style={{ display: 'flex', gap: 10 }}>
            {task && (
              <button type="button" className="icon-btn danger" aria-label="Delete task" onClick={() => leave(() => onDelete(task))}>
                <Icon name="trash" />
              </button>
            )}
            <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
              <Icon name="x" />
            </button>
          </div>
        </div>
        </div>

        <div className="sheet-body">
        <label className="field-group">
          <span className="label">Title</span>
          <input
            ref={titleRef}
            className="field"
            value={title}
            maxLength={200}
            placeholder="Call the dentist"
            aria-invalid={error === 'Enter a title.'}
            onChange={(e) => {
              setTitle(e.target.value)
              setError('')
            }}
          />
        </label>

        <label className="field-group">
          <span className="label">Notes</span>
          <textarea className="field" rows={2} value={notes} placeholder="Ask about Thursday appointment" onChange={(e) => setNotes(e.target.value)} />
        </label>

        <div className="field-group">
          <span className="label">When</span>
          <div className="chips">
            <button type="button" className="chip" aria-pressed={date === today} onClick={() => pickDate(today)}>
              Today
            </button>
            <button type="button" className="chip" aria-pressed={date === tomorrow} onClick={() => pickDate(tomorrow)}>
              Tomorrow
            </button>
            <button
              type="button"
              className="chip date-chip"
              aria-pressed={date !== today && date !== tomorrow}
              aria-expanded={showCalendar}
              onClick={() => setShowCalendar(!showCalendar)}
            >
              <Icon name="calendar" />
              {date !== today && date !== tomorrow ? dateLabel(date) : 'Pick a date'}
            </button>
          </div>
          {showCalendar && (
            <div className="sheet-calendar">
              <Calendar value={parseDate(date)} minDate={parseDate(today)} onChange={(d) => pickDate(toDateInput(d), true)} />
            </div>
          )}
          <div className="toggle-row time-toggle">
            <span>
              <Icon name="clock" />
              Set a time
            </span>
            <button type="button" className="switch" role="switch" aria-checked={Boolean(time)} aria-label="Set a time" onClick={toggleTime} />
          </div>
          {time ? (
            <>
              <TimePicker value={time} onChange={setTime} />
              {!task && defaults.fromClock && time === defaults.time && (
                <span className="hint">Time picked from the clock. Change it here if you like.</span>
              )}
            </>
          ) : (
            <span className="hint">No time: the task goes under Anytime. Turn the switch on to pick one.</span>
          )}
        </div>

        <div className="field-group">
          <span className="label">Category</span>
          <div className="chips">
            {CATEGORIES.map((c) => (
              <button
                key={c.value}
                type="button"
                className="chip"
                aria-pressed={category === c.value}
                style={{ ['--chip-on' as string]: c.color }}
                onClick={() => setCategory(c.value)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field-group">
          <span className="label">Priority</span>
          <div className="chips">
            {PRIORITIES.map((p) => (
              <button
                key={p.value}
                type="button"
                className="chip"
                aria-pressed={priority === p.value}
                style={{ ['--chip-on' as string]: p.color }}
                onClick={() => setPriority(p.value)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="toggle-row">
          <span>
            <Icon name="bell" />
            Remind me {REMIND_MINUTES} min before
          </span>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={canRemind && remind}
            aria-label="Remind me 10 minutes before"
            aria-describedby={canRemind ? undefined : 'remind-hint'}
            disabled={!canRemind}
            onClick={() => setRemind(!remind)}
          />
        </div>
        {!remindersOn ? (
          <span className="hint" id="remind-hint">
            Reminders are off. Turn them on with the bell button or in your profile.
          </span>
        ) : (
          !time && (
            <span className="hint" id="remind-hint">
              Pick a time to get a reminder.
            </span>
          )
        )}

        {task?.added_by_name && (
          <p className="hint friend-note">
            <Icon name="users" />
            {task.linked
              ? `Shared plan from ${task.added_by_name}. Changes anyone makes to the time, title or notes reach everyone, and the others are notified. Done is just for you.`
              : `Added by ${task.added_by_name}. It's no longer shared, so changes stay here.`}
          </p>
        )}
        {!task?.added_by_name && Boolean(task?.shared_with?.length) && (
          <p className="hint friend-note">
            <Icon name="users" />
            {`Shared with ${task!.shared_with!.join(', ')}. Changes anyone makes reach everyone, and the others are notified. Deleting it cancels it for everyone.`}
          </p>
        )}

        {task && (
          <div className="task-actions">
            <button type="button" className={`task-action done-action${done ? ' is-done' : ''}`} onClick={() => setDone(!done)} aria-pressed={done}>
              <Icon name={done ? 'undo' : 'check'} />
              {done ? 'Mark as not done' : 'Mark as done'}
            </button>
            {onSend && (
              <button type="button" className="task-action send-action" onClick={() => leave(() => onSend(task))}>
                <Icon name="send" />
                Send to a friend
              </button>
            )}
          </div>
        )}
        </div>

        <div className="sheet-foot">
          {error && (
            <span className="field-error" role="alert">
              {error}
            </span>
          )}
          <button type="submit" className="primary-btn" disabled={saving}>
            {saving ? 'Saving…' : task ? 'Save changes' : 'Add task'}
          </button>
        </div>
      </form>
    </div>
  )
}
