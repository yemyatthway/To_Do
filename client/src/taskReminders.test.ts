import { describe, expect, it } from 'vitest'
import type { Task } from './api'
import { reminderKey, remindersDue } from './taskReminders'

const NOW = new Date('2026-11-04T12:05:00Z')
const task = (over: Partial<Task>) => ({ id: 1, title: 'Back muscles', due_at: '2026-11-04T12:10:00Z', remind_before_minutes: 10, done: false, ...over }) as Task

describe('reminders inside the open app', () => {
  it('shows one whose time has come', () => {
    expect(remindersDue([task({})], NOW, {}).map((t) => t.id)).toEqual([1])
  })

  it('waits until it is time', () => {
    expect(remindersDue([task({ due_at: '2026-11-04T12:30:00Z' })], NOW, {})).toEqual([])
  })

  it('shows on the exact minute', () => {
    expect(remindersDue([task({ due_at: '2026-11-04T12:15:00Z' })], NOW, {})).toHaveLength(1)
  })

  it('stops once the task has started', () => {
    expect(remindersDue([task({ due_at: '2026-11-04T12:05:00Z' })], NOW, {})).toEqual([])
  })

  it('skips done tasks, tasks with no time, no reminder, or not saved yet', () => {
    const skipped = [task({ done: true }), task({ due_at: null }), task({ remind_before_minutes: null }), task({ id: -5 })]
    expect(remindersDue(skipped, NOW, {})).toEqual([])
  })

  it('shows each reminder once', () => {
    expect(remindersDue([task({})], NOW, { [reminderKey(task({}))]: NOW.getTime() })).toEqual([])
  })

  it('shows again if the time was changed', () => {
    const moved = task({ due_at: '2026-11-04T12:12:00Z' })
    expect(remindersDue([moved], NOW, { [reminderKey(task({}))]: NOW.getTime() })).toHaveLength(1)
  })

  it('waits a minute after a task is made, so it does not cover "Task added"', () => {
    const fresh = task({ updated_at: '2026-11-04T12:04:30Z' })
    expect(remindersDue([fresh], NOW, {})).toEqual([])
    expect(remindersDue([fresh], new Date('2026-11-04T12:05:31Z'), {})).toHaveLength(1)
  })

  it('puts the soonest first', () => {
    const list = [task({ id: 2, due_at: '2026-11-04T12:12:00Z' }), task({ id: 3, due_at: '2026-11-04T12:08:00Z' })]
    expect(remindersDue(list, NOW, {}).map((t) => t.id)).toEqual([3, 2])
  })
})
