import type { Task } from './api'
import { formatDate, tr } from './i18n'

export function startOfDay(date: Date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

export function addDays(date: Date, days: number) {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d
}

/** Monday of the week containing `date`. */
export function startOfWeek(date: Date) {
  const d = startOfDay(date)
  return addDays(d, -((d.getDay() + 6) % 7))
}

export function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** Reminder choices, in minutes before the task (0 = at the task's time). */
export const REMINDER_LEADS = [0, 5, 10, 15, 30, 60, 120, 1440] as const

/** 0 -> 'At the time', 30 -> '30 min before', 60 -> '1 hour before', 1440 -> '1 day before'. */
export function formatLead(minutes: number) {
  if (minutes === 0) return tr('At the time')
  if (minutes % 1440 === 0) return tr('{value} day{value2} before', { value: minutes / 1440, value2: minutes === 1440 ? '' : 's' })
  if (minutes % 60 === 0) return tr('{value} hour{value2} before', { value: minutes / 60, value2: minutes === 60 ? '' : 's' })
  return tr('{minutes} min before', { minutes })
}

export const formatTime = (d: Date) => formatDate(d, { hour: 'numeric', minute: '2-digit' })
export const formatLongDate = (d: Date) => formatDate(d, { weekday: 'long', day: 'numeric', month: 'long' })
export const formatShortDay = (d: Date) => `${formatDate(d, { weekday: 'short' })} ${d.getDate()}`

export function greeting(now: Date) {
  const h = now.getHours()
  if (h < 12) return tr('Good morning')
  if (h < 18) return tr('Good afternoon')
  return tr('Good evening')
}

const pad = (n: number) => String(n).padStart(2, '0')
export const toDateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const toTimeInput = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** Local date ("2026-10-25") + local time ("14:30") → Date. */
export function fromInputs(date: string, time: string) {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  return new Date(y, m - 1, d, hh, mm)
}

export const dueDate = (task: Task) => (task.due_at ? new Date(task.due_at) : null)

/** The device's IANA time zone, e.g. "Asia/Yangon". Dates on screen always use it. */
export const deviceTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''

export const formatHour = (d: Date) => formatDate(d, { hour: 'numeric' })

/**
 * The 12 hours the clock face shows. Today: starting at the current hour (so "2" always means
 * the next 2 o'clock). Other days: starting at the first task's hour, 8 AM if there are none,
 * and never later than noon so the window stays inside that day.
 */
export function clockWindow(day: Date, now: Date, firstTaskHour: number | null) {
  const start = new Date(day)
  if (sameDay(day, now)) {
    start.setHours(now.getHours(), 0, 0, 0)
  } else {
    start.setHours(Math.min(firstTaskHour ?? 8, 12), 0, 0, 0)
  }
  return { start, end: new Date(start.getTime() + 12 * 3600_000) }
}

/** The start of the hour on the clock face labelled `hour` (1–12) inside the window. */
export function hourSlot(windowStart: Date, hour: number) {
  for (let k = 0; k < 12; k++) {
    const slot = new Date(windowStart.getTime() + k * 3600_000)
    if (slot.getHours() % 12 === hour % 12) return slot
  }
  return windowStart
}

/** A task with no length still counts as "Now" for this long after its time. */
export const NOW_MINUTES = 30

/** The choices for how long a task takes. */
export const TASK_LENGTHS = [15, 30, 45, 60, 90, 120, 180, 240] as const

/** 45 -> "45 min", 60 -> "1 hour", 90 -> "1 h 30 min", 180 -> "3 hours". */
export function durationText(minutes: number) {
  if (minutes < 60) return tr('{minutes} min', { minutes })
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (rest) return tr('{hours} h {minutes} min', { hours, minutes: rest })
  return hours === 1 ? tr('1 hour') : tr('{hours} hours', { hours })
}

/** When a task is over: its start plus its length, or plus NOW_MINUTES if it has none. */
export function taskEnd(task: Task) {
  const due = dueDate(task)
  return due ? new Date(due.getTime() + (task.duration_minutes ?? NOW_MINUTES) * 60000) : null
}

export type RelativeTone = 'soon' | 'now' | 'late'

/**
 * A task is meant for its time, not earlier: "in 20 min" before it, "Now" from its time until it's
 * over, then a gentle "Late · 45 min" for the rest of the day. From the next day it's in Overdue.
 */
export function relativeLabel(task: Task, now: Date): { text: string; tone: RelativeTone } | null {
  const due = dueDate(task)
  const end = taskEnd(task)
  if (!due || !end || task.done) return null
  const at = now.getTime()
  if (at < due.getTime()) {
    const minutes = Math.round((due.getTime() - at) / 60000)
    if (minutes <= 0) return { text: tr('Now'), tone: 'now' }
    return minutes <= 60 ? { text: tr('in {minutes} min', { minutes }), tone: 'soon' } : null
  }
  if (at < end.getTime()) return { text: tr('Now'), tone: 'now' }
  if (!sameDay(due, now)) return null
  // Late counted from when it should have been finished, or from its time if it has no length.
  const since = task.duration_minutes ? end.getTime() : due.getTime()
  return { text: tr('Late · {time}', { time: durationText(Math.max(1, Math.round((at - since) / 60000))) }), tone: 'late' }
}

export const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)

/** The six Monday-first weeks a calendar shows for a month. */
export function monthGrid(month: Date) {
  const first = startOfWeek(monthStart(month))
  return Array.from({ length: 42 }, (_, i) => addDays(first, i))
}
