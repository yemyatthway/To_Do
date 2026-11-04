import type { Task, TaskInput } from './api'
import { formatDate, tr } from './i18n'
import { formatLead } from './time'

export interface TaskChange {
  label: string
  from: string
  to: string
}

const CATEGORY = () => ({ work: tr('Work'), personal: tr('Personal'), health: tr('Health') })
const PRIORITY = () => ({ low: tr('Low'), medium: tr('Medium'), high: tr('High') })

const whenText = (iso: string | null) => (iso ? formatDate(new Date(iso), { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : tr('Anytime'))
const leadText = (minutes: number | null) => (minutes === null ? tr('None') : formatLead(minutes))
const sameMoment = (a: string | null, b: string | null) => (a ? new Date(a).getTime() : null) === (b ? new Date(b).getTime() : null)

/** What an edit would change, in words, for the warning before saving it. */
export function describeChanges(task: Task, input: TaskInput): TaskChange[] {
  const changes: TaskChange[] = []
  if (task.title !== input.title) changes.push({ label: tr('Title'), from: task.title, to: input.title })
  if (!sameMoment(task.due_at, input.due_at)) changes.push({ label: tr('Date and time'), from: whenText(task.due_at), to: whenText(input.due_at) })
  if (task.category !== input.category) changes.push({ label: tr('Category'), from: CATEGORY()[task.category], to: CATEGORY()[input.category] })
  if (task.priority !== input.priority) changes.push({ label: tr('Priority'), from: PRIORITY()[task.priority], to: PRIORITY()[input.priority] })
  if (task.remind_before_minutes !== input.remind_before_minutes) changes.push({ label: tr('Reminder'), from: leadText(task.remind_before_minutes), to: leadText(input.remind_before_minutes) })
  if (task.notes !== input.notes) changes.push({ label: tr('Notes'), from: task.notes || tr('None'), to: input.notes || tr('None') })
  if (task.done !== input.done) changes.push({ label: tr('Status'), from: task.done ? tr('Done') : tr('Not done'), to: input.done ? tr('Done') : tr('Not done') })
  return changes
}
