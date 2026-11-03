import type { Block, TeamPage } from './api'

/**
 * Auto-save for a page. Typing shows at once and is kept on the device straight away, then goes to
 * the server after a short pause. "Saved" only ever means the server said so.
 *
 *  - Network trouble or a busy server: keep it and retry, waiting longer each time.
 *  - Someone saved first: stop and ask, so nobody's words are overwritten without a choice.
 *  - The server refuses it (too long, role changed, page deleted): stop and say why.
 */

export interface PageDoc {
  title: string
  blocks: Block[]
}

export type SaveStatus =
  | { state: 'saved' }
  | { state: 'saving' }
  | { state: 'waiting' }
  | { state: 'conflict'; theirs: TeamPage }
  | { state: 'refused'; message: string }

export type SaveTransport = (base: number, doc: PageDoc) => Promise<TeamPage>

interface Draft {
  workspaceId: number
  pageId: number
  base: number
  doc: PageDoc
}

const DEBOUNCE_MS = 800
const RETRY_MIN_MS = 2000
const RETRY_MAX_MS = 60_000

const draftPrefix = (userId: number) => `todo:page:${userId}:`
const sameDoc = (a: PageDoc, b: PageDoc) => a.title === b.title && JSON.stringify(a.blocks) === JSON.stringify(b.blocks)
const statusOf = (err: unknown) => (err as { status?: number }).status ?? 0
/** Worth trying again by itself: no connection, a busy server, or a signed-out moment. */
const isTemporary = (status: number) => status === 0 || status === 401 || status === 408 || status === 429 || status >= 500

export class PageSaver {
  doc: PageDoc
  status: SaveStatus = { state: 'saved' }

  private onStatus: (status: SaveStatus) => void = () => {}
  private onSaved: (page: TeamPage) => void = () => {}
  private version: number
  private dirty = false
  private sending = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempt = 0
  private started = false
  private readonly key: string
  private readonly ids: { workspaceId: number; pageId: number }
  private readonly transport: SaveTransport
  private readonly store: Storage | null

  constructor(page: TeamPage, workspaceId: number, userId: number, transport: SaveTransport, store: Storage | null) {
    this.transport = transport
    this.store = store
    this.doc = { title: page.title, blocks: page.blocks }
    this.version = page.version
    this.ids = { workspaceId, pageId: page.id }
    this.key = `${draftPrefix(userId)}${page.id}`

    // Words from last time that never reached the server.
    const draft = this.readDraft()
    if (!draft) return
    if (sameDoc(draft.doc, this.doc)) {
      this.clearDraft()
      return
    }
    this.doc = draft.doc
    this.dirty = true
    this.version = draft.base
    this.status = draft.base === page.version ? { state: 'saving' } : { state: 'conflict', theirs: page }
  }

  start(onStatus: (status: SaveStatus) => void, onSaved: (page: TeamPage) => void) {
    this.onStatus = onStatus
    this.onSaved = onSaved
    this.started = true
    window.addEventListener('online', this.retryNow)
    if (this.dirty && this.status.state !== 'conflict') this.schedule(0)
  }

  /** Leaving the page: one last try now. Anything unsent stays on the device for next time. */
  dispose() {
    this.started = false
    window.removeEventListener('online', this.retryNow)
    this.clearTimer()
    if (this.dirty && this.status.state !== 'conflict') void this.send()
  }

  edit(doc: PageDoc) {
    this.doc = doc
    this.dirty = true
    this.writeDraft()
    if (this.status.state === 'conflict') return
    this.setStatus({ state: 'saving' })
    this.attempt = 0
    this.schedule(DEBOUNCE_MS)
  }

  /** Someone else changed it, and you chose your version. */
  keepMine() {
    if (this.status.state !== 'conflict') return
    this.version = this.status.theirs.version
    this.dirty = true
    this.writeDraft()
    this.setStatus({ state: 'saving' })
    this.schedule(0)
  }

  /** Someone else changed it, and you chose theirs. Returns what to show. */
  useTheirs(): PageDoc {
    if (this.status.state === 'conflict') {
      const { theirs } = this.status
      this.doc = { title: theirs.title, blocks: theirs.blocks }
      this.version = theirs.version
    }
    this.dirty = false
    this.clearDraft()
    this.setStatus({ state: 'saved' })
    return this.doc
  }

  /** A newer copy from the server. Taken only when there's nothing of yours waiting. */
  adopt(page: TeamPage): PageDoc | null {
    if (this.dirty || this.sending || page.version <= this.version) return null
    this.version = page.version
    this.doc = { title: page.title, blocks: page.blocks }
    return this.doc
  }

  /** The page is being deleted: nothing left to save. */
  discard() {
    this.dirty = false
    this.clearTimer()
    this.clearDraft()
  }

  private readonly retryNow = () => {
    if (this.dirty && this.status.state === 'waiting') this.schedule(0)
  }

  private schedule(ms: number) {
    this.clearTimer()
    this.timer = setTimeout(() => void this.send(), ms)
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async send() {
    this.clearTimer()
    if (this.sending || !this.dirty) return
    this.sending = true
    const sent = this.doc
    try {
      const page = await this.transport(this.version, sent)
      this.version = page.version
      this.attempt = 0
      this.onSaved(page)
      if (this.doc === sent) {
        this.dirty = false
        this.clearDraft()
        this.setStatus({ state: 'saved' })
      } else {
        this.writeDraft()
        if (this.started) this.schedule(DEBOUNCE_MS)
      }
    } catch (err) {
      this.handleFailure(err, sent)
    } finally {
      this.sending = false
    }
  }

  private handleFailure(err: unknown, sent: PageDoc) {
    const status = statusOf(err)
    if (status === 409) {
      const theirs = (err as { data?: { current?: TeamPage } }).data?.current
      if (theirs) {
        // Our last save did arrive; only the answer got lost. Nothing is really in conflict.
        if (sameDoc({ title: theirs.title, blocks: theirs.blocks }, sent)) {
          this.version = theirs.version
          if (this.doc === sent) {
            this.dirty = false
            this.clearDraft()
            this.setStatus({ state: 'saved' })
          } else if (this.started) this.schedule(DEBOUNCE_MS)
          return
        }
        this.setStatus({ state: 'conflict', theirs })
        return
      }
    }
    if (isTemporary(status)) {
      this.setStatus({ state: 'waiting' })
      if (this.started) this.schedule(Math.min(RETRY_MIN_MS * 2 ** this.attempt++, RETRY_MAX_MS))
      return
    }
    // Gone, or no longer allowed: retrying can't help. The words stay on screen to copy.
    if (status === 403 || status === 404) this.clearDraft()
    this.setStatus({ state: 'refused', message: err instanceof Error ? err.message : String(err) })
  }

  private setStatus(status: SaveStatus) {
    this.status = status
    this.onStatus(status)
  }

  private readDraft(): Draft | null {
    try {
      const raw = this.store?.getItem(this.key)
      return raw ? (JSON.parse(raw) as Draft) : null
    } catch {
      return null
    }
  }

  private writeDraft() {
    try {
      const draft: Draft = { ...this.ids, base: this.version, doc: this.doc }
      this.store?.setItem(this.key, JSON.stringify(draft))
    } catch {
      // Storage full or blocked: it still saves while this page stays open.
    }
  }

  private clearDraft() {
    try {
      this.store?.removeItem(this.key)
    } catch {
      // Blocked: there was nothing stored anyway.
    }
  }
}

function draftKeys(store: Storage, userId: number) {
  const prefix = draftPrefix(userId)
  return Array.from({ length: store.length }, (_, i) => store.key(i)).filter((key): key is string => Boolean(key?.startsWith(prefix)))
}

/** Sends words left on this device by a page that was closed before they saved. */
export async function sendLeftoverDrafts(userId: number, store: Storage | null, save: (workspaceId: number, pageId: number, base: number, doc: PageDoc) => Promise<TeamPage>) {
  if (!store) return
  for (const key of draftKeys(store, userId)) {
    try {
      const draft = JSON.parse(store.getItem(key) ?? 'null') as Draft | null
      if (!draft) continue
      await save(draft.workspaceId, draft.pageId, draft.base, draft.doc)
      store.removeItem(key)
    } catch (err) {
      // Gone or not allowed: drop it. Anything else waits until the page is opened again.
      const status = statusOf(err)
      if (status === 403 || status === 404) store.removeItem(key)
    }
  }
}

/** Logging out: unsaved page text shouldn't stay on a shared device. */
export function clearPageDrafts(userId: number, store: Storage | null) {
  if (!store) return
  for (const key of draftKeys(store, userId)) store.removeItem(key)
}

export function pageStorage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}
