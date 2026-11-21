import { describe, expect, it } from 'vitest'
import type { Task } from './api'
import { arcPath } from './clockArc'
import { durationText, relativeLabel, taskEnd } from './time'

const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m)
const task = (over: Partial<Task> = {}) => ({ id: 1, title: 'Gym', due_at: at(10).toISOString(), done: false, duration_minutes: null, ...over }) as Task

describe('a task is meant for its time', () => {
  it('counts down in the hour before', () => {
    expect(relativeLabel(task(), at(9, 40))).toEqual({ text: 'in 20 min', tone: 'soon' })
    expect(relativeLabel(task(), at(8, 30))).toBeNull()
  })

  it('is "Now" at its time, not late straight away', () => {
    expect(relativeLabel(task(), at(10))).toEqual({ text: 'Now', tone: 'now' })
    expect(relativeLabel(task(), at(10, 2))?.tone).toBe('now')
    expect(relativeLabel(task(), at(10, 29))?.tone).toBe('now')
  })

  it('becomes a gentle "Late" after half an hour, counted from its time', () => {
    expect(relativeLabel(task(), at(10, 45))).toEqual({ text: 'Late · 45 min', tone: 'late' })
    expect(relativeLabel(task(), at(12, 30))?.text).toBe('Late · 2 h 30 min')
  })

  it('with a length, stays "Now" until it ends and is late from then', () => {
    const meeting = task({ duration_minutes: 60 })
    expect(relativeLabel(meeting, at(10, 50))?.tone).toBe('now')
    expect(relativeLabel(meeting, at(11, 15))).toEqual({ text: 'Late · 15 min', tone: 'late' })
  })

  it('leaves earlier days to the Overdue list, and done tasks alone', () => {
    expect(relativeLabel(task({ due_at: new Date(2026, 10, 19, 10).toISOString() }), at(9))).toBeNull()
    expect(relativeLabel(task({ done: true }), at(10, 5))).toBeNull()
    expect(relativeLabel(task({ due_at: null }), at(10, 5))).toBeNull()
  })

  it('knows when a task ends', () => {
    expect(taskEnd(task({ duration_minutes: 90 }))?.getTime()).toBe(at(11, 30).getTime())
    expect(taskEnd(task())?.getTime()).toBe(at(10, 30).getTime())
  })
})

describe('lengths read naturally', () => {
  it('in minutes and hours', () => {
    expect([15, 60, 90, 180].map(durationText)).toEqual(['15 min', '1 hour', '1 h 30 min', '3 hours'])
  })
})

describe('the arc on the clock', () => {
  it('goes the long way round only for more than half the face', () => {
    expect(arcPath(0, 90, 80)).toContain(' 0 0 1 ')
    expect(arcPath(0, 270, 80)).toContain(' 0 1 1 ')
  })
})
