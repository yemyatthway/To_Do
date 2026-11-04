import { describe, expect, it } from 'vitest'
import type { Task, TaskInput } from './api'
import { describeChanges } from './taskChanges'

const due = new Date(2026, 10, 4, 15, 0).toISOString()
const task = { id: 1, title: 'Call mom', notes: '', due_at: due, category: 'personal', priority: 'medium', remind_before_minutes: 10, done: false } as Task
const same: TaskInput = { title: 'Call mom', notes: '', due_at: due, category: 'personal', priority: 'medium', remind_before_minutes: 10, done: false }

describe('describing an edit', () => {
  it('finds nothing when nothing changed', () => {
    expect(describeChanges(task, same)).toEqual([])
  })

  it('does not count the same moment written differently', () => {
    expect(describeChanges(task, { ...same, due_at: new Date(due).toISOString().replace('.000Z', 'Z') })).toEqual([])
  })

  it('says what changed, from what to what', () => {
    const changes = describeChanges(task, { ...same, title: 'Call dad', category: 'work', priority: 'high', done: true })
    expect(changes).toEqual([
      { label: 'Title', from: 'Call mom', to: 'Call dad' },
      { label: 'Category', from: 'Personal', to: 'Work' },
      { label: 'Priority', from: 'Medium', to: 'High' },
      { label: 'Status', from: 'Not done', to: 'Done' },
    ])
  })

  it('says Anytime when the time is taken off, and None for no reminder', () => {
    const changes = describeChanges(task, { ...same, due_at: null, remind_before_minutes: null })
    expect(changes[0].to).toBe('Anytime')
    expect(changes[1]).toEqual({ label: 'Reminder', from: '10 min before', to: 'None' })
  })
})
