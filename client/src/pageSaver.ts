import type { Block, TeamPage } from './api'
import { mergeContent, sameContent } from './pageMerge'

/**
 * Auto-save for a page. Typing shows at once and is kept on the device straight away, then goes to
 * the server after a short pause. "Saved" only ever means the server said so.
 *
 *  - Network trouble or a busy server: keep it and retry, waiting longer each time.
 *  - Someone saved first: their changes and yours are put together (pageMerge.ts), then sent again.
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
  | { state: 'refused'; message: string }

export type SaveTransport = (base: number, doc: PageDoc) => Promise<TeamPage>

interface Draft {
  workspaceId: number
  pageId: number
  base: number
  /** The page as the server last had it, so these edits can still be merged later. */
  baseDoc?: PageDoc
  doc: PageDoc
}

const DEBOUNCE_MS = 800
/** With others on the page, whole lines and new blocks reach them sooner. */
const TOGETHER_DEBOUNCE_MS = 350
const RETRY_MIN_MS = 2000
const RETRY_MAX_MS = 60_000

const draftPrefix = (userId: number) => `todo:page:${userId}:`
const docOf = (page: TeamPage): PageDoc => ({ title: page.title, blocks: page.blocks })
const statusOf = (err: unknown) => (err as { status?: number }).status ?? 0
/** Worth trying again by itself: no connection, a busy server, or a signed-out moment. */
const isTemporary = (status: number) => status === 0 || status === 401 || status === 408 || status === 429 || status >= 500

export class PageSaver {
  doc: PageDoc
  status: SaveStatus = { state: 'saved' }

  private onStatus: (status: SaveStatus) => void = () => {}
  private onSaved: (page: TeamPage) => void = () => {}
  private onMerged: (doc: PageDoc) => void = () => {}
  private version: number
  /** The page as the server has it at `version`: what both sides' changes are measured against. */
  private base: PageDoc
  /** A newer copy that came in while a save was on its way. */
  private held: TeamPage | null = null
  private debounce = DEBOUNCE_MS
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
    this.doc = docOf(page)
    this.base = this.doc
    this.version = page.version
    this.ids = { workspaceId, pageId: page.id }
    this.key = `${draftPrefix(userId)}${page.id}`

    // Words from last time that never reached the server.
    const draft = this.readDraft()
    if (!draft) return
    const merged = draft.base === page.version ? draft.doc : mergeContent(draft.baseDoc ?? this.base, draft.doc, this.base)
    if (sameContent(merged, this.base)) {
      this.clearDraft()
      return
    }
    this.doc = merged
    this.dirty = true
    this.status = { state: 'saving' }
  }

  start(onStatus: (status: SaveStatus) => void, onSaved: (page: TeamPage) => void, onMerged: (doc: PageDoc) => void = () => {}) {
    this.onStatus = onStatus
    this.onSaved = onSaved
    this.onMerged = onMerged
    this.started = true
    window.addEventListener('online', this.retryNow)
    if (this.dirty) this.schedule(0)
  }

  /** Others are on the page, so save a little sooner. */
  setTogether(together: boolean) {
    this.debounce = together ? TOGETHER_DEBOUNCE_MS : DEBOUNCE_MS
  }

  /** Leaving the page: one last try now. Anything unsent stays on the device for next time. */
  dispose() {
    this.started = false
    window.removeEventListener('online', this.retryNow)
    this.clearTimer()
    if (this.dirty) void this.send()
  }

  edit(doc: PageDoc) {
    this.doc = doc
    this.dirty = true
    this.writeDraft()
    this.setStatus({ state: 'saving' })
    this.attempt = 0
    this.schedule(this.debounce)
  }

  /** A newer copy from the server: anything of yours still waiting is merged into it, then sent. */
  receive(page: TeamPage) {
    if (page.version <= this.version) return
    if (this.sending) {
      if (!this.held || page.version > this.held.version) this.held = page
      return
    }
    this.absorb(page)
  }

  private absorb(page: TeamPage) {
    const theirs = docOf(page)
    const merged = this.dirty ? mergeContent(this.base, this.doc, theirs) : theirs
    this.base = theirs
    this.version = page.version
    this.doc = merged
    this.onMerged(merged)
    this.onSaved(page)
    if (!this.dirty) return
    if (sameContent(merged, theirs)) {
      this.dirty = false
      this.clearTimer()
      this.clearDraft()
      this.setStatus({ state: 'saved' })
      return
    }
    this.writeDraft()
    if (this.started) this.schedule(this.debounce)
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
      this.base = docOf(page)
      this.attempt = 0
      this.onSaved(page)
      if (this.doc === sent) {
        this.dirty = false
        this.clearDraft()
        this.setStatus({ state: 'saved' })
      } else {
        this.writeDraft()
        if (this.started) this.schedule(this.debounce)
      }
    } catch (err) {
      this.handleFailure(err)
    } finally {
      this.sending = false
      const held = this.held
      this.held = null
      if (held) this.receive(held)
    }
  }

  private handleFailure(err: unknown) {
    const status = statusOf(err)
    if (status === 409) {
      const theirs = (err as { data?: { current?: TeamPage } }).data?.current
      if (theirs && theirs.version > this.version) {
        // Someone saved first (or our own save arrived and only its answer got lost). Merge and go again.
        this.attempt = 0
        this.absorb(theirs)
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
      const draft: Draft = { ...this.ids, base: this.version, baseDoc: this.base, doc: this.doc }
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
