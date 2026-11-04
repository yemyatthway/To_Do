import type { PreparedFile } from './imageShrink'
import { tr } from './i18n'

/** Uploads run here, not in a screen, so they keep going if you move to another page. A file's
 *  record is made first, which lets a page or row hold its place while the bytes travel. */

export interface UploadTarget {
  url: string
  headers: Record<string, string>
}

export interface UploadRecord {
  id: number
}

export interface PreparedUpload<F extends UploadRecord = UploadRecord> {
  file: F
  upload: UploadTarget
  thumb_upload: UploadTarget | null
}

export interface UploadMeta {
  name: string
  size: number
  width?: number
  height?: number
  thumb?: 'webp' | 'jpeg'
}

export interface UploadTransport<F extends UploadRecord = UploadRecord> {
  prepare: (workspaceId: number, meta: UploadMeta) => Promise<PreparedUpload<F>>
  restart: (workspaceId: number, fileId: number) => Promise<PreparedUpload<F>>
  finish: (workspaceId: number, fileId: number) => Promise<F>
  cancel: (workspaceId: number, fileId: number) => Promise<void>
  put: (target: UploadTarget, blob: Blob, onProgress: (loaded: number) => void, signal: AbortSignal) => Promise<void>
}

export type UploadState = 'waiting' | 'uploading' | 'finishing' | 'failed'

export interface UploadItem {
  fileId: number
  workspaceId: number
  name: string
  total: number
  loaded: number
  state: UploadState
  error?: string
  startedAt: number
  /** Shows the picture before it's on the server. */
  previewUrl?: string
}

interface Part {
  blob: Blob
  target: UploadTarget | null
  done: boolean
}

const MAX_AT_ONCE = 2
const errorText = (err: unknown) => (err instanceof Error ? err.message : tr('The upload didn\'t finish.'))

export class Uploads<F extends UploadRecord = UploadRecord> {
  items: ReadonlyMap<number, UploadItem> = new Map()

  private readonly listeners = new Set<() => void>()
  private readonly parts = new Map<number, Part[]>()
  private readonly aborts = new Map<number, AbortController>()
  private readonly queue: number[] = []
  private readonly transport: UploadTransport<F>
  private readonly prepare: (file: File) => Promise<PreparedFile>
  private readonly preview: (blob: Blob) => string | undefined
  private readonly onDone: (file: F) => void
  private readonly now: () => number
  private active = 0

  constructor(options: {
    transport: UploadTransport<F>
    prepare: (file: File) => Promise<PreparedFile>
    preview?: (blob: Blob) => string | undefined
    onDone: (file: F) => void
    now?: () => number
  }) {
    this.transport = options.transport
    this.prepare = options.prepare
    this.preview = options.preview ?? (() => undefined)
    this.onDone = options.onDone
    this.now = options.now ?? Date.now
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = () => this.items

  get busy() {
    return [...this.items.values()].some((item) => item.state !== 'failed')
  }

  private set(fileId: number, change: Partial<UploadItem> | null) {
    const next = new Map(this.items)
    const item = next.get(fileId)
    if (change === null) next.delete(fileId)
    else if (item) next.set(fileId, { ...item, ...change })
    this.items = next
    this.listeners.forEach((listener) => listener())
  }

  /** Makes the record and starts sending. Resolves with the record as soon as there's an id to hold on to. */
  async start(workspaceId: number, file: File): Promise<F> {
    const ready = await this.prepare(file)
    const prepared = await this.transport.prepare(workspaceId, {
      name: ready.name,
      size: ready.blob.size,
      width: ready.width,
      height: ready.height,
      thumb: ready.thumb ? ready.thumbKind : undefined,
    })
    const id = prepared.file.id
    this.parts.set(id, [{ blob: ready.blob, target: prepared.upload, done: false }, ...(ready.thumb && prepared.thumb_upload ? [{ blob: ready.thumb, target: prepared.thumb_upload, done: false }] : [])])
    const next = new Map(this.items)
    next.set(id, {
      fileId: id,
      workspaceId,
      name: ready.name,
      total: ready.blob.size + (ready.thumb?.size ?? 0),
      loaded: 0,
      state: 'waiting',
      startedAt: this.now(),
      previewUrl: ready.width ? this.preview(ready.blob) : undefined,
    })
    this.items = next
    this.listeners.forEach((listener) => listener())
    this.queue.push(id)
    this.pump()
    return prepared.file
  }

  private pump() {
    while (this.active < MAX_AT_ONCE && this.queue.length) {
      const id = this.queue.shift()!
      if (this.items.has(id)) {
        this.active++
        void this.run(id).finally(() => {
          this.active--
          this.pump()
        })
      }
    }
  }

  private async run(id: number) {
    const parts = this.parts.get(id)
    const item = this.items.get(id)
    if (!parts || !item) return
    const abort = new AbortController()
    this.aborts.set(id, abort)
    const sent = parts.reduce((sum, part) => sum + (part.done ? part.blob.size : 0), 0)
    this.set(id, { state: 'uploading', loaded: sent, error: undefined, startedAt: this.now() })
    try {
      let base = sent
      for (const part of parts) {
        if (part.done) continue
        await this.transport.put(part.target!, part.blob, (loaded) => this.set(id, { loaded: base + Math.min(loaded, part.blob.size) }), abort.signal)
        part.done = true
        base += part.blob.size
        this.set(id, { loaded: base })
      }
      this.set(id, { state: 'finishing' })
      const file = await this.transport.finish(item.workspaceId, id)
      this.parts.delete(id)
      this.onDone(file)
      this.set(id, null)
    } catch (err) {
      if (!abort.signal.aborted) this.set(id, { state: 'failed', error: errorText(err) })
    } finally {
      this.aborts.delete(id)
    }
  }

  /** Fresh links, since the first ones may have run out. What already arrived isn't sent again. */
  async retry(id: number) {
    const item = this.items.get(id)
    const parts = this.parts.get(id)
    if (!item || !parts || item.state !== 'failed') return
    this.set(id, { state: 'waiting', error: undefined })
    try {
      const fresh = await this.transport.restart(item.workspaceId, id)
      parts[0].target = fresh.upload
      if (parts[1]) parts[1].target = fresh.thumb_upload
      if (parts[1] && !fresh.thumb_upload) parts[1].done = true
      this.queue.push(id)
      this.pump()
    } catch (err) {
      this.set(id, { state: 'failed', error: errorText(err) })
    }
  }

  async cancel(id: number) {
    const item = this.items.get(id)
    if (!item) return
    this.aborts.get(id)?.abort()
    this.parts.delete(id)
    this.set(id, null)
    await this.transport.cancel(item.workspaceId, id).catch(() => undefined)
  }
}
