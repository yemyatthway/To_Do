import type { Task } from './api'

/**
 * Showing a reminder inside the app while it's open. A phone often hides a notification from the
 * app you're looking at, and this works even if a push never arrives. Kept apart from the screen
 * so it can be tested.
 */

const SHOWN = 'todo:reminders-shown'
const KEEP_MS = 2 * 24 * 60 * 60 * 1000
const JUST_CHANGED_MS = 60_000

/** A new time means a new reminder. */
export const reminderKey = (task: Task) => `${task.id}:${new Date(task.due_at ?? 0).getTime()}`

/** Tasks whose reminder time has come and that haven't started yet, soonest first. */
export function remindersDue(tasks: Task[], now: Date, shown: Record<string, number>) {
  const at = now.getTime()
  return tasks
    .filter((task) => {
      if (task.done || !task.due_at || task.remind_before_minutes === null || task.id <= 0 || reminderKey(task) in shown) return false
      // Just made or moved: the person knows, and "Task added" with its Undo is still on screen.
      if (task.updated_at && at - new Date(task.updated_at).getTime() < JUST_CHANGED_MS) return false
      const due = new Date(task.due_at).getTime()
      return due - task.remind_before_minutes * 60_000 <= at && at < due
    })
    .sort((a, b) => a.due_at!.localeCompare(b.due_at!))
}

export function loadShownReminders(now: Date): Record<string, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(SHOWN) ?? '{}') as Record<string, number>
    return Object.fromEntries(Object.entries(saved).filter(([, when]) => now.getTime() - when < KEEP_MS))
  } catch {
    return {}
  }
}

export function saveShownReminders(shown: Record<string, number>) {
  try {
    localStorage.setItem(SHOWN, JSON.stringify(shown))
  } catch {
    // Without it, a reminder might show once more after reopening the app.
  }
}
