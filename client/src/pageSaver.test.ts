import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TeamPage } from './api'
import { clearPageDrafts, PageSaver, sendLeftoverDrafts, type PageDoc, type SaveStatus } from './pageSaver'

const USER = 7
const KEY = `todo:page:${USER}:1`

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

const page = (over: Partial<TeamPage> = {}): TeamPage => ({ id: 1, title: 'Plan', blocks: [], version: 1, updated_at: '', updated_by: null, ...over })
const doc = (title: string): PageDoc => ({ title, blocks: [{ id: 'a', type: 'p', text: title }] })
const failure = (status: number, data?: unknown) => Object.assign(new Error('nope'), { status, data })

describe('PageSaver', () => {
  let store: Storage
  let save: ReturnType<typeof vi.fn>
  let statuses: SaveStatus['state'][]

  const saved = () => save.mockImplementation(async (base: number, d: PageDoc) => page({ ...d, version: base + 1 }))
  const make = (initial = page()) => {
    const saver = new PageSaver(initial, 5, USER, save as never, store)
    saver.start((s) => statuses.push(s.state), () => {})
    return saver
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', new EventTarget())
    store = fakeStore()
    save = vi.fn()
    statuses = []
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('keeps typing on the device at once and saves after a pause', async () => {
    saved()
    const saver = make()
    saver.edit(doc('one'))
    expect(JSON.parse(store.getItem(KEY)!).doc.title).toBe('one')
    expect(saver.status.state).toBe('saving')
    expect(save).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(800)
    expect(save).toHaveBeenCalledTimes(1)
    expect(saver.status.state).toBe('saved')
    expect(store.getItem(KEY)).toBeNull()
  })

  it('sends one save for a burst of typing', async () => {
    saved()
    const saver = make()
    for (const text of ['a', 'ab', 'abc']) {
      saver.edit(doc(text))
      await vi.advanceTimersByTimeAsync(300)
    }
    await vi.advanceTimersByTimeAsync(800)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][1].title).toBe('abc')
  })

  it('saves what was typed while another save was on its way, on the new version', async () => {
    let finish: (p: TeamPage) => void = () => {}
    save.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const saver = make()
    saver.edit(doc('first'))
    await vi.advanceTimersByTimeAsync(800)
    saver.edit(doc('second'))
    await vi.advanceTimersByTimeAsync(800)
    expect(save).toHaveBeenCalledTimes(1)
    saved()
    finish(page({ ...doc('first'), version: 2 }))
    await vi.advanceTimersByTimeAsync(0)
    expect(saver.status.state).toBe('saving')
    expect(JSON.parse(store.getItem(KEY)!).base).toBe(2)
    await vi.advanceTimersByTimeAsync(800)
    expect(save.mock.calls[1][0]).toBe(2)
    expect(save.mock.calls[1][1].title).toBe('second')
    expect(saver.status.state).toBe('saved')
    expect(store.getItem(KEY)).toBeNull()
  })

  it('waits and retries, longer each time, when the server cannot be reached', async () => {
    save.mockRejectedValue(failure(0))
    const saver = make()
    saver.edit(doc('one'))
    await vi.advanceTimersByTimeAsync(800)
    expect(saver.status.state).toBe('waiting')
    expect(store.getItem(KEY)).not.toBeNull()
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).toHaveBeenCalledTimes(3)
    saved()
    await vi.advanceTimersByTimeAsync(8000)
    expect(saver.status.state).toBe('saved')
    expect(store.getItem(KEY)).toBeNull()
  })

  it('tries again as soon as the connection is back', async () => {
    save.mockRejectedValueOnce(failure(0))
    saved()
    const saver = make()
    saver.edit(doc('one'))
    await vi.advanceTimersByTimeAsync(800)
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(0)
    expect(saver.status.state).toBe('saved')
  })

  it('merges and goes again when someone saved first, without asking', async () => {
    const two = (one: string, other: string): PageDoc => ({ title: 'Plan', blocks: [{ id: 'a', type: 'p', text: one }, { id: 'b', type: 'p', text: other }] })
    const start = page({ ...two('one', 'two'), version: 1 })
    save.mockRejectedValueOnce(failure(409, { current: page({ ...two('one', 'two theirs'), version: 5 }) }))
    saved()
    const merges: PageDoc[] = []
    const saver = new PageSaver(start, 5, USER, save as never, store)
    saver.start((s) => statuses.push(s.state), () => {}, (d) => merges.push(d))
    saver.edit(two('one mine', 'two'))
    await vi.advanceTimersByTimeAsync(800)
    expect(merges[0].blocks.map((b) => b.text)).toEqual(['one mine', 'two theirs'])
    await vi.advanceTimersByTimeAsync(800)
    expect(save.mock.calls[1][0]).toBe(5)
    expect(save.mock.calls[1][1].blocks.map((b: { text: string }) => b.text)).toEqual(['one mine', 'two theirs'])
    expect(saver.status.state).toBe('saved')
    expect(store.getItem(KEY)).toBeNull()
  })

  it('is simply saved when only the answer to its own save got lost', async () => {
    const sent = doc('mine')
    save.mockRejectedValueOnce(failure(0))
    save.mockRejectedValueOnce(failure(409, { current: page({ ...sent, version: 2 }) }))
    const saver = make()
    saver.edit(sent)
    await vi.advanceTimersByTimeAsync(800)
    await vi.advanceTimersByTimeAsync(2000)
    expect(saver.status.state).toBe('saved')
    expect(save).toHaveBeenCalledTimes(2)
    expect(store.getItem(KEY)).toBeNull()
  })

  it('holds a newer copy that arrives during a save, then merges it', async () => {
    const two = (one: string, other: string): PageDoc => ({ title: 'Plan', blocks: [{ id: 'a', type: 'p', text: one }, { id: 'b', type: 'p', text: other }] })
    let finish: (p: TeamPage) => void = () => {}
    save.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
    const merges: PageDoc[] = []
    const saver = new PageSaver(page({ ...two('one', 'two'), version: 1 }), 5, USER, save as never, store)
    saver.start((s) => statuses.push(s.state), () => {}, (d) => merges.push(d))
    saver.edit(two('one!', 'two'))
    await vi.advanceTimersByTimeAsync(800)
    saver.receive(page({ ...two('one', 'two?'), version: 2 })) // someone else's save, on top of the old one
    expect(merges).toEqual([])
    finish(page({ ...two('one!', 'two'), version: 3 }))
    await vi.advanceTimersByTimeAsync(0)
    // It's older than what our save just made, so a newer copy from the server will follow.
    expect(merges).toEqual([])
    expect(saver.status.state).toBe('saved')
    saver.receive(page({ ...two('one!', 'two?'), version: 4 }))
    expect(merges[0].blocks.map((b) => b.text)).toEqual(['one!', 'two?'])
  })

  it('saves sooner with others on the page', async () => {
    saved()
    const saver = make()
    saver.setTogether(true)
    saver.edit(doc('one'))
    await vi.advanceTimersByTimeAsync(350)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('stops and says why when the server refuses, keeping too-long text to fix', async () => {
    save.mockRejectedValue(failure(400))
    const saver = make()
    saver.edit(doc('long'))
    await vi.advanceTimersByTimeAsync(800)
    expect(saver.status).toEqual({ state: 'refused', message: 'nope' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(save).toHaveBeenCalledTimes(1)
    expect(store.getItem(KEY)).not.toBeNull()
    saved()
    saver.edit(doc('short'))
    await vi.advanceTimersByTimeAsync(800)
    expect(saver.status.state).toBe('saved')
  })

  it.each([403, 404])('drops the draft when the answer is %i', async (status) => {
    save.mockRejectedValue(failure(status))
    const saver = make()
    saver.edit(doc('one'))
    await vi.advanceTimersByTimeAsync(800)
    expect(saver.status.state).toBe('refused')
    expect(store.getItem(KEY)).toBeNull()
  })

  it('picks up words left from last time', async () => {
    store.setItem(KEY, JSON.stringify({ workspaceId: 5, pageId: 1, base: 1, doc: doc('left over') }))
    saved()
    const saver = make()
    expect(saver.doc.title).toBe('left over')
    await vi.advanceTimersByTimeAsync(0)
    expect(save.mock.calls[0][1].title).toBe('left over')
    expect(saver.status.state).toBe('saved')
  })

  it('merges left-over words into a page that has moved on', async () => {
    const line = (text: string, other = 'x'): PageDoc => ({ title: 'Plan', blocks: [{ id: 'a', type: 'p', text }, { id: 'b', type: 'p', text: other }] })
    store.setItem(KEY, JSON.stringify({ workspaceId: 5, pageId: 1, base: 1, baseDoc: line('old'), doc: line('old mine') }))
    saved()
    const saver = make(page({ ...line('old', 'x newer'), version: 4 }))
    expect(saver.doc.blocks.map((b) => b.text)).toEqual(['old mine', 'x newer'])
    await vi.advanceTimersByTimeAsync(0)
    expect(save.mock.calls[0][0]).toBe(4)
    expect(saver.status.state).toBe('saved')
  })

  it('shows a newer copy at once, and ignores older ones', async () => {
    saved()
    const merges: PageDoc[] = []
    const saver = new PageSaver(page(), 5, USER, save as never, store)
    saver.start(() => {}, () => {}, (d) => merges.push(d))
    saver.receive(page({ title: 'same version', version: 1 }))
    expect(merges).toEqual([])
    saver.receive(page({ title: 'newer', version: 2 }))
    expect(merges[0].title).toBe('newer')
    saver.receive(page({ title: 'old', version: 2 }))
    expect(merges).toHaveLength(1)
    expect(saver.status.state).toBe('saved')
  })

  it('makes one last try when leaving the page', async () => {
    saved()
    const saver = make()
    saver.edit(doc('one'))
    saver.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(save).toHaveBeenCalledTimes(1)
    expect(store.getItem(KEY)).toBeNull()
  })

  it('leaves unsent words on the device when that last try fails, and stops retrying', async () => {
    save.mockRejectedValue(failure(0))
    const saver = make()
    saver.edit(doc('one'))
    saver.dispose()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(save).toHaveBeenCalledTimes(1)
    expect(store.getItem(KEY)).not.toBeNull()
  })

  it('forgets everything when the page is deleted', async () => {
    saved()
    const saver = make()
    saver.edit(doc('one'))
    saver.discard()
    await vi.advanceTimersByTimeAsync(5000)
    expect(save).not.toHaveBeenCalled()
    expect(store.getItem(KEY)).toBeNull()
  })
})

describe('left-over drafts', () => {
  const draft = (pageId: number) => JSON.stringify({ workspaceId: 5, pageId, base: 2, doc: doc('text') })

  it('sends them, and only this person’s', async () => {
    const store = fakeStore()
    store.setItem('todo:page:7:1', draft(1))
    store.setItem('todo:page:8:2', draft(2))
    const save = vi.fn().mockResolvedValue(page())
    await sendLeftoverDrafts(7, store, save)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0].slice(0, 3)).toEqual([5, 1, 2])
    expect(store.getItem('todo:page:7:1')).toBeNull()
    expect(store.getItem('todo:page:8:2')).not.toBeNull()
  })

  it('keeps them through network trouble and conflicts, and drops them when gone', async () => {
    const store = fakeStore()
    for (const id of [1, 2, 3]) store.setItem(`todo:page:7:${id}`, draft(id))
    const save = vi.fn().mockRejectedValueOnce(failure(0)).mockRejectedValueOnce(failure(409)).mockRejectedValueOnce(failure(404))
    await sendLeftoverDrafts(7, store, save)
    expect(store.getItem('todo:page:7:1')).not.toBeNull()
    expect(store.getItem('todo:page:7:2')).not.toBeNull()
    expect(store.getItem('todo:page:7:3')).toBeNull()
  })

  it('clears them on log out', () => {
    const store = fakeStore()
    store.setItem('todo:page:7:1', draft(1))
    store.setItem('todo:page:8:2', draft(2))
    clearPageDrafts(7, store)
    expect(store.getItem('todo:page:7:1')).toBeNull()
    expect(store.getItem('todo:page:8:2')).not.toBeNull()
  })
})
