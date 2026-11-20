import type { Task } from './api'
import { tr } from './i18n'
import { formatTime } from './time'

/**
 * Reminders on the iPhone app are scheduled on the phone itself, so they ring on time even with no
 * signal and without the server. iOS keeps at most 64 waiting, so the soonest ones go first.
 */

export const MAX_SCHEDULED = 60

function lead(minutes: number) {
  if (minutes <= 0) return tr('Starting now')
  if (minutes < 60) return tr('in {minutes} min', { minutes })
  if (minutes < 24 * 60) return tr('in {hours} h', { hours: Math.round(minutes / 60) })
  return tr('in {days} d', { days: Math.round(minutes / (24 * 60)) })
}

export function reminderPlan(tasks: Task[], now: Date) {
  return tasks
    .filter((task) => !task.done && task.due_at && task.remind_before_minutes !== null && task.id > 0)
    .map((task) => {
      const due = new Date(task.due_at!)
      const at = new Date(due.getTime() - task.remind_before_minutes! * 60_000)
      const text = `${lead(task.remind_before_minutes!)} · ${formatTime(due)}`
      return {
        id: task.id,
        title: task.title,
        body: task.priority === 'high' ? `${tr('High priority')} · ${text}` : text,
        at,
        // An alarm shows one line, so it carries the time too.
        alarm: task.alarm,
        alarmTitle: `${task.title} · ${formatTime(due)}`,
      }
    })
    .filter((item) => item.at.getTime() > now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, MAX_SCHEDULED)
}
