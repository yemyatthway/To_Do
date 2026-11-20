import { describe, expect, it } from 'vitest'
import type { Task } from './api'
import { MAX_SCHEDULED, reminderPlan } from './nativeReminders'

const NOW = new Date('2026-11-04T12:00:00Z')
const task = (over: Partial<Task>) => ({ id: 1, title: 'Back muscles', due_at: '2026-11-04T12:40:00Z', remind_before_minutes: 10, done: false, priority: 'medium', ...over }) as Task

describe('reminders scheduled on the phone', () => {
  it('rings the chosen time before the task', () => {
    const [item] = reminderPlan([task({})], NOW)
    expect(item.at.toISOString()).toBe('2026-11-04T12:30:00.000Z')
    expect(item.title).toBe('Back muscles')
    expect(item.body.startsWith('in 10 min · ')).toBe(true)
  })

  it('says high priority', () => {
    expect(reminderPlan([task({ priority: 'high' })], NOW)[0].body.startsWith('High priority · in 10 min')).toBe(true)
  })

  it('leaves out done tasks, no time, no reminder, unsaved ones, and times already past', () => {
    const skipped = [task({ done: true }), task({ due_at: null }), task({ remind_before_minutes: null }), task({ id: -3 }), task({ due_at: '2026-11-04T12:05:00Z' })]
    expect(reminderPlan(skipped, NOW)).toEqual([])
  })

  it('reads well for hours, days and "at the time"', () => {
    expect(reminderPlan([task({ remind_before_minutes: 120, due_at: '2026-11-04T15:00:00Z' })], NOW)[0].body.startsWith('in 2 h')).toBe(true)
    expect(reminderPlan([task({ remind_before_minutes: 1440, due_at: '2026-11-06T12:00:00Z' })], NOW)[0].body.startsWith('in 1 d')).toBe(true)
    expect(reminderPlan([task({ remind_before_minutes: 0 })], NOW)[0].body.startsWith('Starting now')).toBe(true)
  })

  it('keeps the soonest ones within what iOS allows', () => {
    const many = Array.from({ length: 80 }, (_, i) => task({ id: i + 1, due_at: new Date(NOW.getTime() + (80 - i) * 3_600_000).toISOString() }))
    const plan = reminderPlan(many, NOW)
    expect(plan).toHaveLength(MAX_SCHEDULED)
    expect(plan[0].id).toBe(80)
    expect(plan.every((item, i) => i === 0 || item.at >= plan[i - 1].at)).toBe(true)
  })
})
