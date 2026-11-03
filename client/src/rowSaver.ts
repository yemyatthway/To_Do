import type { CellValue, TableRowData } from './api'

/**
 * Saving for table cells, on the same promise as pages: a change shows at once, waits on the device,
 * and only counts as saved once the server says so. Cells are saved one row at a time and say what
 * they were changed from, so two people editing different cells of a row never collide.
 */

export interface RowChange {
  values: Record<string, CellValue>
  /** What each cell held when you changed it. */
  base: Record<string, CellValue>
  highlighted?: boolean
}

export type RowSaveState = 'saved' | 'saving' | 'waiting'
export type RowTransport = (rowId: number, change: RowChange) => Promise<TableRowData>

export interface RowSaverEvents {
  onState: (state: RowSaveState) => void
  onSaved: (row: TableRowData) => void
  /** Someone changed the same cell first: their version stays. */
  onConflict: (row: TableRowData, mine: RowChange) => void
  /** The server said no (no longer allowed, row deleted, not valid). */
  onRefused: (rowId: number, message: string) => void
}

interface Stored {
  workspaceId: number
  tableId: number
  pending: [number, RowChange][]
}

const DEBOUNCE_MS = 500
const RETRY_MIN_MS = 2000
const RETRY_MAX_MS = 60_000

const prefix = (userId: number) => `todo:rows:${userId}:`
const statusOf = (err: unknown) => (err as { status?: number }).status ?? 0
const isTemporary = (status: number) => status === 0 || status === 401 || status === 408 || status === 429 || status >= 500

export class RowSaver {
  state: RowSaveState = 'saved'

  private readonly pending = new Map<number, RowChange>()
  private readonly transport: RowTransport
  private readonly store: Storage | null
  private readonly key: string
  private readonly ids: { workspaceId: number; tableId: number }
  private events: RowSaverEvents | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private sending = false
  private attempt = 0
  private started = false

  constructor(workspaceId: number, tableId: number, userId: number, transport: RowTransport, store: Storage | null) {
    this.transport = transport
    this.store = store
    this.ids = { workspaceId, tableId }
    this.key = `${prefix(userId)}${tableId}`
    try {
      const raw = store?.getItem(this.key)
      if (raw) for (const [rowId, change] of (JSON.parse(raw) as Stored).pending) this.pending.set(rowId, change)
    } catch {
      // Unreadable: nothing to pick up.
    }
    if (this.pending.size) this.state = 'saving'
  }

  start(events: RowSaverEvents) {
    this.events = events
    this.started = true
    window.addEventListener('online', this.retryNow)
    if (this.pending.size) this.schedule(0)
  }

  /** Leaving the screen: one last try. Anything unsent stays on the device. */
  dispose() {
    this.started = false
    window.removeEventListener('online', this.retryNow)
    this.clearTimer()
    if (this.pending.size) void this.send()
  }

  /** Change cells of a row. `seen` is what those cells held before this change. */
  edit(rowId: number, values: Record<string, CellValue>, seen: Record<string, CellValue>, highlighted?: boolean) {
    const change = this.pending.get(rowId) ?? { values: {}, base: {} }
    for (const [column, value] of Object.entries(values)) {
      if (!(column in change.base)) change.base[column] = seen[column] ?? null
      change.values[column] = value
    }
    if (highlighted !== undefined) change.highlighted = highlighted
    this.pending.set(rowId, change)
    this.persist()
    this.setState('saving')
    this.attempt = 0
    this.schedule(DEBOUNCE_MS)
  }

  /** Rows with what's still waiting to be saved laid on top, so nothing flickers back. */
  overlay(rows: TableRowData[]): TableRowData[] {
    if (!this.pending.size) return rows
    return rows.map((row) => {
      const change = this.pending.get(row.id)
      if (!change) return row
      return { ...row, values: { ...row.values, ...change.values }, highlighted: change.highlighted ?? row.highlighted }
    })
  }

  /** The row is being deleted: its unsaved changes no longer matter. */
  forget(rowId: number) {
    this.pending.delete(rowId)
    this.persist()
    if (!this.pending.size && !this.sending) this.setState('saved')
  }

  private readonly retryNow = () => {
    if (this.pending.size && this.state === 'waiting') this.schedule(0)
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
    if (this.sending) return
    const next = this.pending.entries().next()
    if (next.done) return
    const [rowId, change] = next.value
    const sent: RowChange = { values: { ...change.values }, base: { ...change.base }, highlighted: change.highlighted }
    this.sending = true
    try {
      const row = await this.transport(rowId, sent)
      this.attempt = 0
      this.settle(rowId, sent)
      this.events?.onSaved(row)
    } catch (err) {
      this.sending = false
      this.handleFailure(err, rowId)
      return
    }
    this.sending = false
    if (this.pending.size) {
      if (this.started) this.schedule(0)
    } else {
      this.setState('saved')
    }
  }

  /** Whatever was typed while this save was on its way stays queued, based on what was just saved. */
  private settle(rowId: number, sent: RowChange) {
    const current = this.pending.get(rowId)
    if (!current) return
    for (const [column, value] of Object.entries(sent.values)) {
      if (current.values[column] === value) {
        delete current.values[column]
        delete current.base[column]
      } else {
        current.base[column] = value
      }
    }
    if (current.highlighted === sent.highlighted) delete current.highlighted
    if (!Object.keys(current.values).length && current.highlighted === undefined) this.pending.delete(rowId)
    this.persist()
  }

  private handleFailure(err: unknown, rowId: number) {
    const status = statusOf(err)
    if (isTemporary(status)) {
      this.setState('waiting')
      if (this.started) this.schedule(Math.min(RETRY_MIN_MS * 2 ** this.attempt++, RETRY_MAX_MS))
      return
    }
    // Retrying can't help, and shouldn't hold up the other rows.
    const mine = this.pending.get(rowId)
    this.pending.delete(rowId)
    this.persist()
    const current = (err as { data?: { current?: TableRowData } }).data?.current
    if (status === 409 && current && mine) this.events?.onConflict(current, mine)
    else this.events?.onRefused(rowId, err instanceof Error ? err.message : String(err))
    if (this.pending.size) {
      if (this.started) this.schedule(0)
    } else {
      this.setState('saved')
    }
  }

  private setState(state: RowSaveState) {
    if (this.state === state) return
    this.state = state
    this.events?.onState(state)
  }

  private persist() {
    try {
      if (this.pending.size) {
        const stored: Stored = { ...this.ids, pending: [...this.pending.entries()] }
        this.store?.setItem(this.key, JSON.stringify(stored))
      } else {
        this.store?.removeItem(this.key)
      }
    } catch {
      // Storage full or blocked: it still saves while this screen stays open.
    }
  }
}

function keysOf(store: Storage, userId: number) {
  return Array.from({ length: store.length }, (_, i) => store.key(i)).filter((key): key is string => Boolean(key?.startsWith(prefix(userId))))
}

/** Sends cell changes left on this device by a table that was closed before they saved. */
export async function sendLeftoverRows(userId: number, store: Storage | null, save: (workspaceId: number, tableId: number, rowId: number, change: RowChange) => Promise<TableRowData>) {
  if (!store) return
  for (const key of keysOf(store, userId)) {
    let stored: Stored
    try {
      stored = JSON.parse(store.getItem(key) ?? '') as Stored
    } catch {
      store.removeItem(key)
      continue
    }
    const left: [number, RowChange][] = []
    for (const [rowId, change] of stored.pending) {
      try {
        await save(stored.workspaceId, stored.tableId, rowId, change)
      } catch (err) {
        if (isTemporary(statusOf(err))) left.push([rowId, change])
      }
    }
    if (left.length) store.setItem(key, JSON.stringify({ ...stored, pending: left }))
    else store.removeItem(key)
  }
}

/** Logging out: unsaved table text shouldn't stay on a shared device. */
export function clearLeftoverRows(userId: number, store: Storage | null) {
  if (!store) return
  for (const key of keysOf(store, userId)) store.removeItem(key)
}
