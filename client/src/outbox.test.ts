import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ChatMessage, Task, TaskInput } from './api'
import { Outbox, overlayTasks, pendingMessages, type Transport } from './outbox'

const INPUT: TaskInput = { title: 'Call the dentist', notes: '', due_at: null, category: 'personal', priority: 'medium', remind_before_minutes: null, done: false }
const lost = () => Object.assign(new Error("Couldn't reach the server."), { status: 0 })
const refused = (status: number, message = 'Pick today or a later date.', data?: unknown) => Object.assign(new Error(message), { status, data })

function saved(id: number, input: Partial<Task> = {}): Task {
  return { ...INPUT, id, completed_at: null, created_at: '2026-11-03T00:00:00Z', updated_at: '2026-11-03T00:00:00Z', ...input }
}

function memoryStore() {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) }
}

function transport() {
  return {
    createTask: vi.fn(async (input: TaskInput, clientId: string) => saved(101, { ...input, client_id: clientId })),
    updateTask: vi.fn(async (id: number, patch: Partial<TaskInput>) => saved(id, patch)),
    deleteTask: vi.fn(async () => undefined),
    sendMessage: vi.fn(async (conversation: number, text: string, clientId: string) => ({ id: 7, client_id: clientId, conversation, sender: 1, mine: true, text, deleted: false, edited: false, created_at: 'x' }) as ChatMessage),
  } as unknown as Transport & Record<keyof Transport, Mock>
}

describe('Outbox', () => {
  let store: ReturnType<typeof memoryStore>
  let api: ReturnType<typeof transport>
  let box: Outbox

  beforeEach(() => {
    vi.useFakeTimers()
    store = memoryStore()
    api = transport()
    box = new Outbox('box', api, store)
    box.start()
  })

  it('shows a new task at once and removes it from the queue only after the server confirms', async () => {
    let confirm: (t: Task) => void = () => {}
    api.createTask.mockImplementationOnce(() => new Promise((resolve) => (confirm = resolve)))
    const saw = vi.fn()
    box.events.onTaskSaved = saw
    const temp = box.createTask(INPUT)
    expect(overlayTasks([], box.getSnapshot()).map((t) => [t.id, t.title, t.sync])).toEqual([[temp, INPUT.title, 'saving']])
    expect(store.getItem('box')).toContain(INPUT.title) // safe before any reply
    await vi.advanceTimersByTimeAsync(0)
    expect(saw).not.toHaveBeenCalled()
    confirm(saved(101))
    await box.settle()
    expect(saw).toHaveBeenCalledWith(temp, expect.objectContaining({ id: 101 }), expect.anything())
    expect(box.getSnapshot().ops).toEqual([])
    expect(store.getItem('box')).toBeNull()
  })

  it('keeps changes when the network is down, says so, and sends them when it returns', async () => {
    api.createTask.mockRejectedValueOnce(lost())
    box.createTask(INPUT)
    await box.settle()
    const snap = box.getSnapshot()
    expect(snap.blocked).toBe(true)
    expect(snap.ops).toHaveLength(1)
    expect(overlayTasks([], snap)[0].sync).toBe('waiting')
    await vi.advanceTimersByTimeAsync(2000)
    await box.settle()
    expect(api.createTask).toHaveBeenCalledTimes(2)
    expect(box.getSnapshot()).toMatchObject({ ops: [], blocked: false })
  })

  it('sends the same id again after a lost reply, so the server can spot the duplicate', async () => {
    api.createTask.mockRejectedValueOnce(lost())
    box.createTask(INPUT)
    await box.settle()
    await vi.advanceTimersByTimeAsync(2000)
    await box.settle()
    const [first, second] = api.createTask.mock.calls
    expect(first[1]).toBe(second[1])
  })

  it('does not show a task twice if the list already has it after a lost reply', async () => {
    api.createTask.mockRejectedValueOnce(lost())
    box.createTask(INPUT)
    await box.settle()
    const key = box.getSnapshot().ops[0].key
    expect(overlayTasks([saved(101, { client_id: key })], box.getSnapshot()).map((t) => t.id)).toEqual([101])
  })

  it('survives closing the app: a new start sends what was waiting', async () => {
    api.createTask.mockRejectedValueOnce(lost())
    box.createTask(INPUT)
    await box.settle()
    box.stop()
    const reopened = new Outbox('box', api, store)
    expect(reopened.getSnapshot().ops).toHaveLength(1)
    reopened.start()
    await reopened.settle()
    expect(api.createTask).toHaveBeenCalledTimes(2)
    expect(store.getItem('box')).toBeNull()
  })

  it('merges edits to a waiting new task instead of sending twice', async () => {
    box.stop()
    const temp = box.createTask(INPUT)
    box.updateTask({ id: temp }, { title: 'Call the clinic' })
    expect(box.getSnapshot().ops).toHaveLength(1)
    box.start()
    await box.settle()
    expect(api.createTask.mock.calls[0][0].title).toBe('Call the clinic')
    expect(api.updateTask).not.toHaveBeenCalled()
  })

  it('cancels a new task deleted before it was ever sent', async () => {
    box.stop()
    const temp = box.createTask(INPUT)
    box.deleteTask(temp)
    box.start()
    await box.settle()
    expect(api.createTask).not.toHaveBeenCalled()
    expect(api.deleteTask).not.toHaveBeenCalled()
  })

  it('points later changes at the real id once a new task is saved', async () => {
    let confirm: (t: Task) => void = () => {}
    api.createTask.mockImplementationOnce(() => new Promise((resolve) => (confirm = resolve)))
    const temp = box.createTask(INPUT)
    await vi.advanceTimersByTimeAsync(0) // now in flight
    box.updateTask({ id: temp, title: INPUT.title }, { title: 'Renamed' })
    confirm(saved(101))
    await box.settle()
    expect(api.updateTask).toHaveBeenCalledWith(101, { title: 'Renamed' }, { title: INPUT.title })
    expect(box.resolve(temp)).toBe(101)
  })

  it('keeps the first base when merging edits, so conflicts compare with what the server had', async () => {
    box.stop()
    box.updateTask(saved(5, { title: 'A' }), { title: 'B' })
    box.updateTask(saved(5, { title: 'B' }), { title: 'C', done: true })
    box.start()
    await box.settle()
    expect(api.updateTask).toHaveBeenCalledTimes(1)
    expect(api.updateTask).toHaveBeenCalledWith(5, { title: 'C', done: true }, { title: 'A', done: false })
  })

  it('stops and reports when the server refuses, keeping the work, and retries when asked', async () => {
    const failed = vi.fn()
    box.events.onFailed = failed
    api.createTask.mockRejectedValueOnce(refused(400))
    box.createTask(INPUT)
    await box.settle()
    expect(failed).toHaveBeenCalledOnce()
    const op = box.getSnapshot().ops[0]
    expect(overlayTasks([], box.getSnapshot())[0]).toMatchObject({ sync: 'failed', syncError: 'Pick today or a later date.' })
    box.retry(op.key)
    await box.settle()
    expect(box.getSnapshot().ops).toEqual([])
  })

  it('one refused item does not hold up other tasks, but holds its own later changes', async () => {
    api.updateTask.mockRejectedValueOnce(refused(400))
    box.updateTask(saved(5), { title: 'bad' })
    box.updateTask(saved(6), { title: 'fine' })
    await box.settle()
    expect(api.updateTask).toHaveBeenCalledWith(6, { title: 'fine' }, expect.anything())
    expect(box.getSnapshot().ops).toHaveLength(1)
  })

  it('hands conflicts back with the newer version instead of overwriting', async () => {
    const conflict = vi.fn()
    box.events.onConflict = conflict
    const newer = saved(5, { title: 'Changed elsewhere' })
    api.updateTask.mockRejectedValueOnce(refused(409, 'Changed', { task: newer }))
    box.updateTask(saved(5), { title: 'Mine' })
    await box.settle()
    expect(conflict).toHaveBeenCalledWith(expect.objectContaining({ patch: { title: 'Mine' } }), newer)
    expect(box.getSnapshot().ops).toEqual([])
  })

  it('treats deleting something already gone as done', async () => {
    api.deleteTask.mockRejectedValueOnce(refused(404, 'Not found'))
    box.deleteTask(5)
    await box.settle()
    expect(box.getSnapshot().ops).toEqual([])
  })

  it('leaves everything in place when the session has expired', async () => {
    api.createTask.mockRejectedValueOnce(refused(401, 'Log in again'))
    box.createTask(INPUT)
    await box.settle()
    expect(box.getSnapshot().ops).toHaveLength(1)
    expect(box.getSnapshot().ops[0].failed).toBeUndefined()
  })

  it('retries a busy server, waiting longer each time up to a minute', async () => {
    api.createTask.mockRejectedValue(refused(503, 'Busy'))
    box.createTask(INPUT)
    await box.settle()
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.createTask).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(3999)
    expect(api.createTask).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.createTask).toHaveBeenCalledTimes(3)
  })

  it('shows chat messages until delivered, without a double when the live copy arrives first', async () => {
    box.stop()
    const key = box.sendMessage(3, 'Hello')
    const delivered = { id: 7, client_id: key } as ChatMessage
    expect(pendingMessages(box.getSnapshot(), 3, [], 1)).toMatchObject([{ text: 'Hello', pending: true, key }])
    expect(pendingMessages(box.getSnapshot(), 4, [], 1)).toEqual([])
    expect(pendingMessages(box.getSnapshot(), 3, [delivered], 1)).toEqual([])
    box.start()
    const heard = vi.fn()
    box.onMessage(heard)
    await box.settle()
    expect(api.sendMessage).toHaveBeenCalledWith(3, 'Hello', key)
    expect(heard).toHaveBeenCalledOnce()
  })

  it('still works when the device refuses storage', async () => {
    const broken = { getItem: () => null, setItem: () => { throw new Error('full') }, removeItem: () => undefined }
    const memoryOnly = new Outbox('box', api, broken)
    memoryOnly.start()
    memoryOnly.createTask(INPUT)
    expect(memoryOnly.getSnapshot().ops).toHaveLength(1)
    await memoryOnly.settle()
    expect(api.createTask).toHaveBeenCalledOnce()
  })
})
