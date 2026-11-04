import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fileSizeText, timeLeftText, uploadTiming } from './uploadProgress'
import { Uploads, type UploadTarget } from './uploads'

const file = (name: string, size = 100) => new File([new Uint8Array(size)], name)
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup() {
  let next = 1
  const puts: { target: UploadTarget; blob: Blob; onProgress: (n: number) => void; resolve: () => void; reject: (e: Error) => void; signal: AbortSignal }[] = []
  const transport = {
    prepare: vi.fn(async (_: number, meta: { thumb?: string }) => ({ file: { id: next++ }, upload: { url: 'main', headers: {} }, thumb_upload: meta.thumb ? { url: 'thumb', headers: {} } : null })),
    restart: vi.fn(async (_: number, id: number) => ({ file: { id }, upload: { url: 'main2', headers: {} }, thumb_upload: { url: 'thumb2', headers: {} } })),
    finish: vi.fn(async (_: number, id: number) => ({ id })),
    cancel: vi.fn(async () => undefined),
    put: vi.fn((target: UploadTarget, blob: Blob, onProgress: (n: number) => void, signal: AbortSignal) => new Promise<void>((resolve, reject) => puts.push({ target, blob, onProgress, resolve, reject, signal }))),
  }
  const onDone = vi.fn()
  const uploads = new Uploads({ transport, onDone, now: () => 1000, prepare: async (f) => ({ blob: f, name: f.name, ...(f.name.endsWith('.png') ? { width: 10, height: 10, thumb: new Blob(['tt']), thumbKind: 'webp' as const } : {}) }) })
  return { uploads, transport, puts, onDone }
}

describe('uploads', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => {
    t = setup()
  })

  it('hands back the record at once, then counts the real bytes', async () => {
    const record = await t.uploads.start(5, file('a.png'))
    expect(record.id).toBe(1)
    expect(t.transport.prepare).toHaveBeenCalledWith(5, { name: 'a.png', size: 100, width: 10, height: 10, thumb: 'webp' })
    await flush()
    t.puts[0].onProgress(40)
    expect(t.uploads.items.get(1)).toMatchObject({ loaded: 40, total: 102, state: 'uploading' })
    t.puts[0].resolve()
    await flush()
    expect(t.puts[1].target.url).toBe('thumb')
    t.puts[1].onProgress(1)
    expect(t.uploads.items.get(1)?.loaded).toBe(101)
    t.puts[1].resolve()
    await flush()
    expect(t.transport.finish).toHaveBeenCalledWith(5, 1)
    expect(t.onDone).toHaveBeenCalledWith({ id: 1 })
    expect(t.uploads.items.size).toBe(0)
    expect(t.uploads.busy).toBe(false)
  })

  it('sends two at a time', async () => {
    await Promise.all([t.uploads.start(5, file('a.txt')), t.uploads.start(5, file('b.txt')), t.uploads.start(5, file('c.txt'))])
    await flush()
    expect(t.puts).toHaveLength(2)
    expect(t.uploads.items.get(3)?.state).toBe('waiting')
    t.puts[0].resolve()
    await flush()
    expect(t.puts).toHaveLength(3)
  })

  it('a refused file never gets a place', async () => {
    t.transport.prepare.mockRejectedValueOnce(new Error('That type of file can\'t be added.'))
    await expect(t.uploads.start(5, file('a.exe'))).rejects.toThrow('type of file')
    expect(t.uploads.items.size).toBe(0)
  })

  it('a failure waits for Try again, with fresh links, and skips what already arrived', async () => {
    await t.uploads.start(5, file('a.png'))
    await flush()
    t.puts[0].resolve()
    await flush()
    t.puts[1].reject(new Error('Network down'))
    await flush()
    expect(t.uploads.items.get(1)).toMatchObject({ state: 'failed', error: 'Network down' })
    expect(t.uploads.busy).toBe(false)
    await t.uploads.retry(1)
    await flush()
    expect(t.puts).toHaveLength(3)
    expect(t.puts[2].target.url).toBe('thumb2')
    expect(t.uploads.items.get(1)?.loaded).toBe(100)
    t.puts[2].resolve()
    await flush()
    expect(t.onDone).toHaveBeenCalledOnce()
  })

  it('a failed finish can be tried again without sending anything', async () => {
    t.transport.finish.mockRejectedValueOnce(new Error('Server busy'))
    await t.uploads.start(5, file('a.txt'))
    await flush()
    t.puts[0].resolve()
    await flush()
    expect(t.uploads.items.get(1)?.state).toBe('failed')
    await t.uploads.retry(1)
    await flush()
    expect(t.puts).toHaveLength(1)
    expect(t.onDone).toHaveBeenCalledOnce()
  })

  it('cancel stops the send and removes the record', async () => {
    await t.uploads.start(5, file('a.txt'))
    await flush()
    await t.uploads.cancel(1)
    expect(t.puts[0].signal.aborted).toBe(true)
    expect(t.transport.cancel).toHaveBeenCalledWith(5, 1)
    expect(t.uploads.items.size).toBe(0)
    t.puts[0].reject(new Error('aborted'))
    await flush()
    expect(t.uploads.items.size).toBe(0)
  })

  it('tells whoever is listening', async () => {
    const heard = vi.fn()
    const stop = t.uploads.subscribe(heard)
    await t.uploads.start(5, file('a.txt'))
    expect(heard).toHaveBeenCalled()
    stop()
  })
})

describe('what an upload says', () => {
  it('stays quiet for a second, shows progress, then time left after ten', () => {
    expect(uploadTiming(10, 100, 500)).toEqual({ percent: 10, showProgress: false, secondsLeft: null })
    expect(uploadTiming(50, 100, 5000)).toEqual({ percent: 50, showProgress: true, secondsLeft: null })
    expect(uploadTiming(50, 100, 10_000)).toEqual({ percent: 50, showProgress: true, secondsLeft: 10 })
    expect(uploadTiming(100, 100, 20_000).secondsLeft).toBeNull()
    expect(uploadTiming(0, 100, 20_000).secondsLeft).toBeNull()
    expect(uploadTiming(0, 0, 2000).percent).toBe(0)
  })

  it('says the time left in plain words', () => {
    expect(timeLeftText(3)).toBe('a few seconds left')
    expect(timeLeftText(22)).toBe('about 25 seconds left')
    expect(timeLeftText(61)).toBe('about 2 minutes left')
    expect(timeLeftText(50)).toBe('about 50 seconds left')
    expect(timeLeftText(60)).toBe('about a minute left')
  })

  it('says sizes in plain words', () => {
    expect(fileSizeText(500)).toBe('500 B')
    expect(fileSizeText(2048)).toBe('2 KB')
    expect(fileSizeText(3.5 * 1024 * 1024)).toBe('3.5 MB')
  })
})
