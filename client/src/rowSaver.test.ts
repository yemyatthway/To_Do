import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TableRowData } from './api'
import { clearLeftoverRows, RowSaver, sendLeftoverRows, type RowSaverEvents } from './rowSaver'

const USER = 7
const KEY = `todo:rows:${USER}:3`

function fakeStore(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
  }
}

const row = (id = 1, values: TableRowData['values'] = {}): TableRowData => ({ id, no: id, values, highlighted: false, on_my_tasks: false })
const failure = (status: number, data?: unknown) => Object.assign(new Error('nope'), { status, data })

describe('RowSaver', () => {
  let store: Storage
  let save: ReturnType<typeof vi.fn>
  let events: { [K in keyof RowSaverEvents]: ReturnType<typeof vi.fn> }

  const make = () => {
    const saver = new RowSaver(5, 3, USER, save as never, store)
    saver.start(events as unknown as RowSaverEvents)
    return saver
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', new EventTarget())
    store = fakeStore()
    save = vi.fn().mockImplementation(async (id: number) => row(id))
    events = { onState: vi.fn(), onSaved: vi.fn(), onConflict: vi.fn(), onRefused: vi.fn() }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('shows a change at once and keeps it on the device until saved', async () => {
    const saver = make()
    saver.edit(1, { a: 'new' }, { a: 'old' })
    expect(saver.overlay([row(1, { a: 'old', b: 'x' })])[0].values).toEqual({ a: 'new', b: 'x' })
    expect(store.getItem(KEY)).not.toBeNull()
    expect(saver.state).toBe('saving')
    await vi.advanceTimersByTimeAsync(500)
    expect(save.mock.calls[0]).toEqual([1, { values: { a: 'new' }, base: { a: 'old' }, highlighted: undefined }])
    expect(saver.state).toBe('saved')
    expect(store.getItem(KEY)).toBeNull()
    expect(events.onSaved).toHaveBeenCalledTimes(1)
  })

  it('remembers what a cell held before the first change only', async () => {
    const saver = make()
    saver.edit(1, { a: 'one' }, { a: 'old' })
    saver.edit(1, { a: 'two' }, { a: 'one' })
    await vi.advanceTimersByTimeAsync(500)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][1].values.a).toBe('two')
    expect(save.mock.calls[0][1].base.a).toBe('old')
  })

  it('saves what changed while a save was on its way, based on what was just saved', async () => {
    let finish: (r: TableRowData) => void = () => {}
    save.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const saver = make()
    saver.edit(1, { a: 'one', b: 'keep' }, { a: 'old', b: null })
    await vi.advanceTimersByTimeAsync(500)
    saver.edit(1, { a: 'two' }, { a: 'one' })
    finish(row(1))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(500)
    expect(save.mock.calls[1][1].values).toEqual({ a: 'two' })
    expect(save.mock.calls[1][1].base).toEqual({ a: 'one' })
    expect(saver.state).toBe('saved')
  })

  it('saves rows one at a time', async () => {
    const saver = make()
    saver.edit(1, { a: 1 }, {})
    saver.edit(2, { a: 2 }, {})
    await vi.advanceTimersByTimeAsync(501)
    expect(save.mock.calls.map((c) => c[0])).toEqual([1, 2])
    expect(saver.state).toBe('saved')
  })

  it('keeps a highlight change with the row', async () => {
    const saver = make()
    saver.edit(1, {}, {}, true)
    expect(saver.overlay([row(1)])[0].highlighted).toBe(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(save.mock.calls[0][1].highlighted).toBe(true)
    expect(saver.state).toBe('saved')
  })

  it('waits and retries when the server cannot be reached', async () => {
    save.mockRejectedValueOnce(failure(0)).mockRejectedValueOnce(failure(503))
    const saver = make()
    saver.edit(1, { a: 'x' }, {})
    await vi.advanceTimersByTimeAsync(500)
    expect(saver.state).toBe('waiting')
    expect(store.getItem(KEY)).not.toBeNull()
    expect(saver.overlay([row(1)])[0].values.a).toBe('x')
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4000)
    expect(saver.state).toBe('saved')
    expect(store.getItem(KEY)).toBeNull()
  })

  it('tries again as soon as the connection is back', async () => {
    save.mockRejectedValueOnce(failure(0))
    const saver = make()
    saver.edit(1, { a: 'x' }, {})
    await vi.advanceTimersByTimeAsync(500)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(saver.state).toBe('saved')
  })

  it('keeps the other person’s cell on a conflict, and still saves other rows', async () => {
    const theirs = row(1, { a: 'theirs' })
    save.mockRejectedValueOnce(failure(409, { current: theirs }))
    const saver = make()
    saver.edit(1, { a: 'mine' }, { a: 'old' })
    saver.edit(2, { a: 'other' }, {})
    await vi.advanceTimersByTimeAsync(501)
    expect(events.onConflict).toHaveBeenCalledWith(theirs, { values: { a: 'mine' }, base: { a: 'old' } })
    expect(save.mock.calls[1][0]).toBe(2)
    expect(saver.overlay([row(1, { a: 'theirs' })])[0].values.a).toBe('theirs')
    expect(saver.state).toBe('saved')
  })

  it.each([400, 403, 404])('stops retrying and says why on %i', async (status) => {
    save.mockRejectedValueOnce(failure(status))
    const saver = make()
    saver.edit(1, { a: 'x' }, {})
    await vi.advanceTimersByTimeAsync(500)
    expect(events.onRefused).toHaveBeenCalledWith(1, 'nope')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(save).toHaveBeenCalledTimes(1)
    expect(store.getItem(KEY)).toBeNull()
    expect(saver.state).toBe('saved')
  })

  it('picks up changes left from last time', async () => {
    store.setItem(KEY, JSON.stringify({ workspaceId: 5, tableId: 3, pending: [[1, { values: { a: 'left' }, base: { a: 'old' } }]] }))
    const saver = make()
    expect(saver.overlay([row(1)])[0].values.a).toBe('left')
    await vi.advanceTimersByTimeAsync(0)
    expect(save.mock.calls[0][1].values.a).toBe('left')
    expect(saver.state).toBe('saved')
  })

  it('makes one last try when leaving, and leaves the rest on the device', async () => {
    save.mockRejectedValue(failure(0))
    const saver = make()
    saver.edit(1, { a: 'x' }, {})
    saver.dispose()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(save).toHaveBeenCalledTimes(1)
    expect(store.getItem(KEY)).not.toBeNull()
  })

  it('forgets a row that was deleted', async () => {
    const saver = make()
    saver.edit(1, { a: 'x' }, {})
    saver.forget(1)
    await vi.advanceTimersByTimeAsync(500)
    expect(save).not.toHaveBeenCalled()
    expect(saver.state).toBe('saved')
    expect(store.getItem(KEY)).toBeNull()
  })
})

describe('left-over cell changes', () => {
  const stored = (pending: unknown[]) => JSON.stringify({ workspaceId: 5, tableId: 3, pending })
  const change = { values: { a: 1 }, base: { a: 0 } }

  it('sends them, and only this person’s', async () => {
    const store = fakeStore()
    store.setItem('todo:rows:7:3', stored([[1, change]]))
    store.setItem('todo:rows:8:3', stored([[2, change]]))
    const save = vi.fn().mockResolvedValue(row())
    await sendLeftoverRows(7, store, save)
    expect(save.mock.calls[0].slice(0, 3)).toEqual([5, 3, 1])
    expect(save).toHaveBeenCalledTimes(1)
    expect(store.getItem('todo:rows:7:3')).toBeNull()
    expect(store.getItem('todo:rows:8:3')).not.toBeNull()
  })

  it('keeps only what failed for a temporary reason', async () => {
    const store = fakeStore()
    store.setItem('todo:rows:7:3', stored([[1, change], [2, change], [3, change]]))
    const save = vi.fn().mockRejectedValueOnce(failure(0)).mockRejectedValueOnce(failure(404)).mockResolvedValueOnce(row())
    await sendLeftoverRows(7, store, save)
    expect(JSON.parse(store.getItem('todo:rows:7:3')!).pending.map((p: [number]) => p[0])).toEqual([1])
  })

  it('clears them on log out', () => {
    const store = fakeStore()
    store.setItem('todo:rows:7:3', stored([[1, change]]))
    store.setItem('todo:rows:8:3', stored([[2, change]]))
    clearLeftoverRows(7, store)
    expect(store.getItem('todo:rows:7:3')).toBeNull()
    expect(store.getItem('todo:rows:8:3')).not.toBeNull()
  })
})
