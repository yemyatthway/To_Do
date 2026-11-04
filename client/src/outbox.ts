import type { ChatMessage, ChatReply, Task, TaskInput } from './api'
import { tr } from './i18n'

/**
 * Update first, sync after. A change shows on screen at once and waits here (on the device, so it
 * survives closing the app) until the server confirms it. "Saved" only ever means the server said so.
 *
 *  - New items carry an id chosen here (`key`), so sending one again can't create a second copy.
 *  - Network trouble or a busy server: keep it and retry, waiting longer each time.
 *  - The server refuses it (e.g. a date that's now in the past): stop and tell the person.
 *  - Edits say what they were based on, so an edit from an old copy can't overwrite a newer change.
 */

export type TaskPatch = Partial<TaskInput>

export type Op = { key: string; failed?: string } & (
  | { kind: 'task.create'; tempId: number; input: TaskInput; createdAt: string }
  | { kind: 'task.update'; taskId: number; patch: TaskPatch; base: Record<string, unknown>; announce?: string }
  | { kind: 'task.delete'; taskId: number }
  | { kind: 'chat.send'; tempId: number; conversation: number; text: string; createdAt: string; reply?: ChatReply | null }
)

export interface Transport {
  createTask: (input: TaskInput, clientId: string) => Promise<Task>
  updateTask: (id: number, patch: TaskPatch, base: Record<string, unknown>) => Promise<Task>
  deleteTask: (id: number) => Promise<void>
  sendMessage: (conversation: number, text: string, clientId: string, replyTo?: number) => Promise<ChatMessage>
}

export interface OutboxEvents {
  onTaskSaved?: (previousId: number, task: Task, op: Op) => void
  onTaskGone?: (id: number) => void
  onTaskDeleted?: (id: number) => void
  onConflict?: (op: Extract<Op, { kind: 'task.update' }>, current: Task) => void
  onFailed?: (op: Op, message: string) => void
  /** Everything waiting has been confirmed. */
  onDrained?: () => void
  /** Another tab of this app changed the queue. */
  onExternalChange?: () => void
}

export interface OutboxSnapshot {
  ops: readonly Op[]
  inFlight: string | null
  /** The last try couldn't reach the server; it will try again by itself. */
  blocked: boolean
}

export type SyncState = 'saving' | 'waiting' | 'failed'
export type ShownTask = Task & { sync?: SyncState; syncError?: string }

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const MAX_WAIT_MS = 60_000
const newKey = () => crypto.randomUUID()
const newTempId = () => -(Date.now() * 1000 + Math.floor(Math.random() * 1000))

const isTransient = (status: number | undefined) => status === undefined || status === 0 || status === 408 || status === 425 || status === 429 || status >= 500

function entityOf(op: Op) {
  if (op.kind === 'task.create') return `task:${op.tempId}`
  if (op.kind === 'chat.send') return `chat:${op.key}`
  return `task:${op.taskId}`
}

export class Outbox {
  private snapshot: OutboxSnapshot = { ops: [], inFlight: null, blocked: false }
  private listeners = new Set<() => void>()
  private messageListeners = new Set<(message: ChatMessage, op: Op) => void>()
  private realIds = new Map<number, number>()
  private running: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private stopped = true
  private again = false // something changed while a round was finishing
  private memory = '' // used when the device refuses storage (private browsing)
  events: OutboxEvents = {}

  readonly storageKey: string
  private transport: Transport
  private store: KeyValueStore | null
  private locks: LockManager | null

  constructor(storageKey: string, transport: Transport, store: KeyValueStore | null, locks: LockManager | null = null) {
    this.storageKey = storageKey
    this.transport = transport
    this.store = store
    this.locks = locks
    this.snapshot = { ...this.snapshot, ops: this.read() }
  }

  // --- for React (useSyncExternalStore) ---

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  getSnapshot = () => this.snapshot

  onMessage(listener: (message: ChatMessage, op: Op) => void) {
    this.messageListeners.add(listener)
    return () => void this.messageListeners.delete(listener)
  }

  // --- life cycle ---

  /** Start sending, and pick up anything left from last time. */
  start() {
    this.stopped = false
    this.kick()
  }

  stop() {
    this.stopped = true
    this.clearRetry()
  }

  /** Try again right now (the network came back, the app came to the front). */
  kick = () => {
    if (this.stopped) return
    if (this.running) {
      this.again = true
      return
    }
    this.clearRetry()
    this.running = this.pump().finally(() => {
      this.running = null
      if (this.again) {
        this.again = false
        this.kick()
      }
    })
  }

  /** Waits for the current round of sending to finish. */
  async settle() {
    if (!this.running) this.kick()
    while (this.running) await this.running
    return this.snapshot.ops.length
  }

  /** Another tab changed the queue. */
  reload() {
    this.publish({ ops: this.read() })
    this.events.onExternalChange?.()
  }

  // --- changes ---

  /** The real id once a new task is saved (a sheet or Undo may still hold the temporary one). */
  resolve(id: number) {
    return this.realIds.get(id) ?? id
  }

  createTask(input: TaskInput) {
    const tempId = newTempId()
    this.mutate((ops) => [...ops, { kind: 'task.create', key: newKey(), tempId, input, createdAt: new Date().toISOString() }])
    this.kick()
    return tempId
  }

  /** `current` is the task as shown now. Only the fields in `patch` are sent. */
  updateTask(current: Pick<Task, 'id'> & Partial<Task>, patch: TaskPatch, options: { announce?: string } = {}) {
    const taskId = this.resolve(current.id)
    this.mutate((ops) => {
      const waiting = ops.filter((op) => op.key !== this.snapshot.inFlight)
      const create = waiting.find((op) => op.kind === 'task.create' && op.tempId === taskId)
      if (create?.kind === 'task.create') {
        return ops.map((op) => (op === create ? { kind: op.kind, key: op.key, tempId: op.tempId, createdAt: op.createdAt, input: { ...op.input, ...patch } } : op))
      }
      const base = Object.fromEntries(Object.keys(patch).map((field) => [field, current[field as keyof Task]]))
      const earlier = waiting.find((op) => op.kind === 'task.update' && op.taskId === taskId)
      if (earlier?.kind === 'task.update') {
        return ops.map((op) =>
          op === earlier
            ? { kind: earlier.kind, key: earlier.key, taskId, patch: { ...earlier.patch, ...patch }, base: { ...base, ...earlier.base }, announce: options.announce ?? earlier.announce }
            : op,
        )
      }
      return [...ops, { kind: 'task.update', key: newKey(), taskId, patch, base, announce: options.announce }]
    })
    this.kick()
  }

  deleteTask(id: number) {
    const taskId = this.resolve(id)
    this.mutate((ops) => {
      const isInFlight = (op: Op) => op.key === this.snapshot.inFlight
      const createWaiting = ops.some((op) => op.kind === 'task.create' && op.tempId === taskId && !isInFlight(op))
      const others = ops.filter((op) => isInFlight(op) || op.kind === 'chat.send' || !(entityOf(op) === `task:${taskId}`))
      // Never reached the server: nothing to delete there.
      return createWaiting ? others : [...others, { kind: 'task.delete', key: newKey(), taskId }]
    })
    this.kick()
  }

  sendMessage(conversation: number, text: string, reply?: ChatReply | null) {
    const key = newKey()
    this.mutate((ops) => [...ops, { kind: 'chat.send', key, tempId: newTempId(), conversation, text, reply, createdAt: new Date().toISOString() }])
    this.kick()
    return key
  }

  /** Clears a failure so it's sent again. */
  retry(key: string) {
    this.mutate((ops) => ops.map((op) => (op.key === key ? { ...op, failed: undefined } : op)))
    this.kick()
  }

  /** Send a refused task change again, as it is. */
  retryTask(id: number) {
    const taskId = this.resolve(id)
    this.mutate((ops) => ops.map((op) => (op.kind !== 'chat.send' && entityOf(op) === `task:${taskId}` ? { ...op, failed: undefined } : op)))
    this.kick()
  }

  discard(key: string) {
    this.mutate((ops) => ops.filter((op) => op.key !== key))
  }

  /** Drop everything (logging out anyway, account deleted). */
  clear() {
    this.clearRetry()
    this.publish({ ops: [], blocked: false })
    this.write([])
  }

  // --- sending ---

  private next(ops: readonly Op[]) {
    const stuck = new Set(ops.filter((op) => op.failed).map(entityOf))
    return ops.find((op) => !op.failed && !stuck.has(entityOf(op)))
  }

  private async pump() {
    const round = async () => {
      this.publish({ ops: this.read() })
      let sent = false
      for (let op = this.next(this.snapshot.ops); op && !this.stopped; op = this.next(this.snapshot.ops)) {
        this.publish({ inFlight: op.key })
        try {
          await this.send(op)
          sent = true
          this.attempts = 0
          this.publish({ blocked: false })
        } catch (err) {
          const status = (err as { status?: number }).status
          if (isTransient(status)) {
            this.publish({ blocked: true })
            this.scheduleRetry()
            return
          }
          if (status === 401) return // signed out: it waits for the next login
          this.settleFailure(op, err as { status?: number; message?: string; data?: { task?: Task } })
        } finally {
          this.publish({ inFlight: null })
        }
      }
      if (sent && this.snapshot.ops.length === 0) this.events.onDrained?.()
    }
    // Only one tab sends at a time; the others pick up from storage.
    if (this.locks) await this.locks.request(`${this.storageKey}:send`, round)
    else await round()
  }

  private async send(op: Op) {
    switch (op.kind) {
      case 'task.create': {
        const task = await this.transport.createTask(op.input, op.key)
        this.realIds.set(op.tempId, task.id)
        this.mutate((ops) =>
          ops
            .filter((o) => o.key !== op.key)
            .map((o) => ((o.kind === 'task.update' || o.kind === 'task.delete') && o.taskId === op.tempId ? { ...o, taskId: task.id } : o)),
        )
        this.events.onTaskSaved?.(op.tempId, task, op)
        return
      }
      case 'task.update': {
        const task = await this.transport.updateTask(op.taskId, op.patch, op.base)
        this.remove(op)
        this.events.onTaskSaved?.(op.taskId, task, op)
        return
      }
      case 'task.delete':
        try {
          await this.transport.deleteTask(op.taskId)
        } catch (err) {
          if ((err as { status?: number }).status !== 404) throw err // already gone is fine
        }
        this.remove(op)
        this.events.onTaskDeleted?.(op.taskId)
        return
      case 'chat.send': {
        const message = await this.transport.sendMessage(op.conversation, op.text, op.key, op.reply?.id)
        this.remove(op)
        this.messageListeners.forEach((listener) => listener(message, op))
      }
    }
  }

  private settleFailure(op: Op, err: { status?: number; message?: string; data?: { task?: Task } }) {
    if (op.kind === 'task.update' && err.status === 409 && err.data?.task) {
      this.remove(op)
      this.events.onConflict?.(op, err.data.task)
      return
    }
    if (op.kind === 'task.update' && err.status === 404) {
      this.remove(op) // deleted somewhere else
      this.events.onTaskGone?.(op.taskId)
      return
    }
    const message = err.message || tr('This couldn\'t be saved.')
    if (op.kind === 'task.delete') this.remove(op) // the task simply comes back
    else this.mutate((ops) => ops.map((o) => (o.key === op.key ? { ...o, failed: message } : o)))
    this.events.onFailed?.(op, message)
  }

  private scheduleRetry() {
    this.attempts += 1
    const wait = Math.min(MAX_WAIT_MS, 2000 * 2 ** (this.attempts - 1))
    this.retryTimer = setTimeout(this.kick, wait)
  }

  private clearRetry() {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  // --- storage ---

  private remove(op: Op) {
    this.mutate((ops) => ops.filter((o) => o.key !== op.key))
  }

  /** Read, change, write in one go, so a change is safe the moment this returns. */
  private mutate(change: (ops: readonly Op[]) => readonly Op[]) {
    const ops = change(this.read())
    this.write(ops)
    this.publish({ ops })
  }

  private read(): Op[] {
    try {
      const raw = this.store ? this.store.getItem(this.storageKey) : this.memory
      return raw ? (JSON.parse(raw) as Op[]) : []
    } catch {
      return [...this.snapshot.ops]
    }
  }

  private write(ops: readonly Op[]) {
    const raw = ops.length ? JSON.stringify(ops) : ''
    this.memory = raw
    try {
      if (raw) this.store?.setItem(this.storageKey, raw)
      else this.store?.removeItem(this.storageKey)
    } catch {
      this.store = null // storage is full or blocked: keep going from memory
    }
  }

  private publish(change: Partial<OutboxSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change }
    this.listeners.forEach((listener) => listener())
  }
}

function syncStateOf(op: Op, snapshot: OutboxSnapshot): SyncState {
  if (op.failed) return 'failed'
  return snapshot.blocked ? 'waiting' : 'saving'
}

/** The server's list with everything still waiting applied on top: what the person should see. */
export function overlayTasks(server: readonly Task[], snapshot: OutboxSnapshot): ShownTask[] {
  let shown: ShownTask[] = [...server]
  for (const op of snapshot.ops) {
    if (op.kind === 'task.create') {
      // The reply got lost but the task is already in the list: don't show it twice.
      if (server.some((t) => t.client_id === op.key)) continue
      shown.push({
        ...op.input,
        id: op.tempId,
        client_id: op.key,
        completed_at: null,
        created_at: op.createdAt,
        updated_at: op.createdAt,
        sync: syncStateOf(op, snapshot),
        syncError: op.failed,
      })
    } else if (op.kind === 'task.update') {
      shown = shown.map((t) => (t.id === op.taskId ? { ...t, ...op.patch, sync: syncStateOf(op, snapshot), syncError: op.failed } : t))
    } else if (op.kind === 'task.delete') {
      shown = shown.filter((t) => t.id !== op.taskId)
    }
  }
  return shown
}

export type ShownMessage = ChatMessage & { pending?: boolean; waiting?: boolean; failed?: string; key?: string }

/** Messages still on their way in this chat, except any the server has already delivered. */
export function pendingMessages(snapshot: OutboxSnapshot, conversation: number, delivered: readonly ChatMessage[], myId: number): ShownMessage[] {
  const known = new Set(delivered.map((m) => m.client_id).filter(Boolean))
  return snapshot.ops.flatMap((op) =>
    op.kind === 'chat.send' && op.conversation === conversation && !known.has(op.key)
      ? [
          {
            id: op.tempId,
            client_id: op.key,
            key: op.key,
            conversation,
            sender: myId,
            mine: true,
            text: op.text,
            deleted: false,
            edited: false,
            reply: op.reply ?? null,
            reactions: [],
            created_at: op.createdAt,
            pending: !op.failed,
            waiting: !op.failed && snapshot.blocked,
            failed: op.failed,
          },
        ]
      : [],
  )
}
