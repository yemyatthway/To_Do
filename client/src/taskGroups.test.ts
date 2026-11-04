import { describe, expect, it } from 'vitest'
import type { Task } from './api'
import { activeFilters, dayName, groupByDay, NO_FILTERS, whenBounds } from './taskGroups'

const now = new Date(2026, 10, 4, 15, 0)
const task = (id: number, due_at: Date | null, over: Partial<Task> = {}) => ({ id, title: `t${id}`, due_at: due_at?.toISOString() ?? null, done: false, completed_at: null, ...over }) as Task

describe('naming days', () => {
  it('uses plain words for the days around today', () => {
    expect(dayName(new Date(2026, 10, 4, 1), now)).toBe('Today')
    expect(dayName(new Date(2026, 10, 3, 23), now)).toBe('Yesterday')
    expect(dayName(new Date(2026, 10, 5, 8), now)).toBe('Tomorrow')
  })

  it('gives the date otherwise, and the year only when it differs', () => {
    expect(dayName(new Date(2026, 10, 1), now)).toMatch(/Nov 1/)
    expect(dayName(new Date(2026, 10, 1), now)).not.toMatch(/2026/)
    expect(dayName(new Date(2025, 10, 1), now)).toMatch(/2025/)
    // Far ahead is a date too, not a weekday that could mean this week.
    expect(dayName(new Date(2026, 11, 25), now)).toMatch(/Dec 25/)
  })
})

describe('grouping tasks by day', () => {
  it('puts each task under its own day, in the order given', () => {
    const groups = groupByDay([task(1, new Date(2026, 10, 4, 9)), task(2, new Date(2026, 10, 4, 7)), task(3, new Date(2026, 10, 3, 20)), task(4, new Date(2026, 9, 30, 8))], now)
    expect(groups.map((g) => g.label.replace(/\s+/g, ' '))).toEqual(['Today', 'Yesterday', expect.stringMatching(/Oct 30/)])
    expect(groups[0].tasks.map((t) => t.id)).toEqual([1, 2])
  })

  it('puts tasks with no time under Anytime', () => {
    const groups = groupByDay([task(1, new Date(2026, 10, 5, 9)), task(2, null), task(3, null)], now)
    expect(groups.map((g) => g.label)).toEqual(['Tomorrow', 'Anytime'])
    expect(groups[1].tasks).toHaveLength(2)
  })

  it('puts finished tasks with no time under the day they were finished', () => {
    const finished = task(1, null, { done: true, completed_at: new Date(2026, 10, 3, 18).toISOString() })
    expect(groupByDay([finished], now)[0].label).toBe('Yesterday')
  })
})

describe('filters', () => {
  it('counts only what is turned on', () => {
    expect(activeFilters(NO_FILTERS)).toBe(0)
    expect(activeFilters({ ...NO_FILTERS, category: 'work', when: 'today' })).toBe(2)
  })

  it('turns When into dates on this device', () => {
    expect(whenBounds('', now)).toEqual({})
    const today = whenBounds('today', now)
    expect(today.from).toEqual(new Date(2026, 10, 4))
    expect(today.to).toEqual(new Date(2026, 10, 5))
    expect(whenBounds('last7', now).from).toEqual(new Date(2026, 9, 28))
    expect(whenBounds('next7', now).to).toEqual(new Date(2026, 10, 12))
  })
})
