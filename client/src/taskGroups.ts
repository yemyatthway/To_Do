import type { Task } from './api'
import { formatDate, tr } from './i18n'
import { addDays, sameDay, startOfDay } from './time'

export type TaskList = 'todo' | 'overdue' | 'done'

export interface TaskGroup {
  key: string
  label: string
  tasks: Task[]
}

/** The name of a day: Today, Yesterday, Tomorrow, otherwise its date, with the year once it's not this year. */
export function dayName(date: Date, now: Date) {
  if (sameDay(date, now)) return tr('Today')
  if (sameDay(date, addDays(now, -1))) return tr('Yesterday')
  if (sameDay(date, addDays(now, 1))) return tr('Tomorrow')
  return formatDate(date, date.getFullYear() === now.getFullYear() ? { weekday: 'short', month: 'short', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
}

/** Which day a task belongs under. Finished tasks with no time go under the day they were finished. */
const dayOf = (task: Task) => {
  const when = task.due_at ?? (task.done ? task.completed_at : null)
  return when ? startOfDay(new Date(when)) : null
}

/** Tasks under their own days, keeping the order they came in. */
export function groupByDay(tasks: Task[], now: Date): TaskGroup[] {
  const groups: TaskGroup[] = []
  for (const task of tasks) {
    const day = dayOf(task)
    const key = day ? String(day.getTime()) : 'anytime'
    const last = groups.at(-1)
    if (last?.key === key) last.tasks.push(task)
    else groups.push({ key, label: day ? dayName(day, now) : tr('Anytime'), tasks: [task] })
  }
  return groups
}

export interface TaskFilters {
  category: string
  priority: string
  when: string
}

export const NO_FILTERS: TaskFilters = { category: '', priority: '', when: '' }

export const activeFilters = (filters: TaskFilters) => Object.values(filters).filter(Boolean).length

/** What "When" means in dates, on this device's own days. */
export function whenBounds(when: string, now: Date): { from?: Date; to?: Date } {
  const today = startOfDay(now)
  if (when === 'today') return { from: today, to: addDays(today, 1) }
  if (when === 'next7') return { from: today, to: addDays(today, 8) }
  if (when === 'last7') return { from: addDays(today, -7), to: addDays(today, 1) }
  return {}
}
