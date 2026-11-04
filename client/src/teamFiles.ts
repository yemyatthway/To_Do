import type { TeamFile } from './api'

const MAX_ASKED = 100
const LINK_MARGIN_MS = 5 * 60_000

/** What's known about files, shared by every screen. A table full of pictures asks once, in batches. */
export class TeamFiles {
  version = 0

  private readonly known = new Map<number, TeamFile | 'gone'>()
  private readonly asking = new Map<number, Set<number>>()
  private readonly inFlight = new Set<number>()
  private readonly listeners = new Set<() => void>()
  private readonly fetcher: (workspaceId: number, ids: number[]) => Promise<TeamFile[]>
  private readonly now: () => number
  private scheduled = false

  constructor(fetcher: (workspaceId: number, ids: number[]) => Promise<TeamFile[]>, now: () => number = Date.now) {
    this.fetcher = fetcher
    this.now = now
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getVersion = () => this.version

  get(id: number) {
    return this.known.get(id)
  }

  put(file: TeamFile) {
    this.known.set(file.id, file)
    this.changed()
  }

  private changed() {
    this.version++
    this.listeners.forEach((listener) => listener())
  }

  /** Still uploading on someone's device, or its links are about to run out. */
  isStale(id: number) {
    const file = this.known.get(id)
    if (!file || file === 'gone') return false
    return file.status === 'pending' || new Date(file.expires_at).getTime() - this.now() < LINK_MARGIN_MS
  }

  want(workspaceId: number, ids: number[], refresh = false) {
    const missing = ids.filter((id) => !this.inFlight.has(id) && (refresh || !this.known.has(id)))
    if (!missing.length) return
    const set = this.asking.get(workspaceId) ?? new Set<number>()
    missing.forEach((id) => set.add(id))
    this.asking.set(workspaceId, set)
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      void this.flush()
    })
  }

  private async flush() {
    const batches = [...this.asking.entries()]
    this.asking.clear()
    await Promise.all(
      batches.flatMap(([workspaceId, set]) => {
        const ids = [...set]
        const chunks: number[][] = []
        for (let i = 0; i < ids.length; i += MAX_ASKED) chunks.push(ids.slice(i, i + MAX_ASKED))
        return chunks.map((chunk) => this.ask(workspaceId, chunk))
      }),
    )
  }

  private async ask(workspaceId: number, ids: number[]) {
    ids.forEach((id) => this.inFlight.add(id))
    try {
      const files = await this.fetcher(workspaceId, ids)
      const found = new Map(files.map((file) => [file.id, file]))
      ids.forEach((id) => this.known.set(id, found.get(id) ?? 'gone'))
      this.changed()
    } catch {
      // Nothing changes; the next check asks again.
    } finally {
      ids.forEach((id) => this.inFlight.delete(id))
    }
  }
}
