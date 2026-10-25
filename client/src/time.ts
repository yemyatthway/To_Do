import type { Task } from './api'

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

export const formatTime = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
export const formatLongDate = (d: Date) => d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
export const formatShortDay = (d: Date) => `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.getDate()}`

export function greeting(now: Date) {
  const h = now.getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
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

export const formatHour = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric' })

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

/** "in 20 min" for tasks starting within the hour, "Overdue" for missed ones. */
export function relativeLabel(task: Task, now: Date) {
  const due = dueDate(task)
  if (!due || task.done) return null
  const minutes = Math.round((due.getTime() - now.getTime()) / 60000)
  if (minutes < -1) return sameDay(due, now) ? 'Overdue' : null
  if (minutes <= 0) return 'Now'
  if (minutes <= 60) return `in ${minutes} min`
  return null
}

export const monthStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1)

/** The six Monday-first weeks a calendar shows for a month. */
export function monthGrid(month: Date) {
  const first = startOfWeek(monthStart(month))
  return Array.from({ length: 42 }, (_, i) => addDays(first, i))
}
