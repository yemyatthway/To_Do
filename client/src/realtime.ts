import type { PresenceMessage, RealtimeChannel } from 'ably'
import { live as liveApi, type LivePass } from './api'

/**
 * One live connection per device (Ably), opened after login. The server hands out a pass that
 * only allows this person's own channels:
 *   user:<me>    "tasks" / "social" / "chat" events
 *   online:<id>  presence only: I enter mine, and watch my friends' (are they online?)
 *   chat:<id>    a conversation: messages (sent by the server), "typing" and "read"
 *   admin        staff: new sign-ups and logins
 * "tasks", "social" and admin events also fire the page-wide refresh event, so screens that
 * already refresh on a timer update at once. Without a key on the server, nothing connects.
 */

type Client = import('ably/modular').BaseRealtime
let client: Client | null = null
let starting: Promise<void> | null = null
let session = 0 // bumps on stop, so a start still in flight knows to give up
const PUSH_EVENT = 'todo:push' // same event as live.ts: "something changed, refresh"
const LIVE_EVENT = 'todo:live'
/** Channels the current pass allows. A new chat or friend needs a fresh pass first. */
let allowed = new Set<string>()

export interface LiveEvent {
  name: string
  data: unknown
}

/** Events on my own channel ("chat" when any of my chats changes). */
export function onLive(handler: (event: LiveEvent) => void) {
  const listener = (e: Event) => handler((e as CustomEvent<LiveEvent>).detail)
  window.addEventListener(LIVE_EVENT, listener)
  return () => window.removeEventListener(LIVE_EVENT, listener)
}

export const isLive = () => client?.connection.state === 'connected'

function remember(pass: LivePass) {
  if (!pass.enabled) return
  try {
    allowed = new Set(Object.keys(JSON.parse(String(pass.token_request.capability)) as object))
  } catch {
    allowed = new Set()
  }
}

async function ensureAccess(channels: string[]) {
  if (!client || channels.every((c) => allowed.has(c))) return
  await client.auth.authorize().catch(() => undefined)
}

export function startLive(userId: number) {
  if (!starting) starting = connect(String(userId)).catch(() => undefined)
  return starting
}

async function connect(me: string) {
  const mySession = session
  const first = await liveApi.token()
  if (!first.enabled || mySession !== session) return
  remember(first)
  const { BaseRealtime, WebSocketTransport, FetchRequest, RealtimePresence } = await import('ably/modular')
  if (mySession !== session) return
  let pending: LivePass | null = first
  const live = new BaseRealtime({
    clientId: me,
    plugins: { WebSocketTransport, FetchRequest, RealtimePresence },
    // Each renewal asks our server for a fresh, limited pass.
    authCallback: (_params, callback) => {
      const use = pending
      pending = null
      ;(use ? Promise.resolve(use) : liveApi.token())
        .then((pass) => {
          remember(pass)
          if (pass.enabled) callback(null, pass.token_request)
          else callback('Live updates are off', null)
        })
        .catch((err) => callback(String(err), null))
    },
  })
  client = live

  const mine = live.channels.get(`user:${me}`)
  await mine.subscribe((message) => {
    window.dispatchEvent(new CustomEvent<LiveEvent>(LIVE_EVENT, { detail: { name: message.name ?? '', data: message.data } }))
    if (message.name === 'tasks' || message.name === 'social') window.dispatchEvent(new Event(PUSH_EVENT))
  })
  await live.channels.get(`online:${me}`).presence.enter().catch(() => undefined)
}

export async function startAdminLive() {
  await starting
  if (!client) return
  await client.channels
    .get('admin')
    .subscribe(() => window.dispatchEvent(new Event(PUSH_EVENT)))
    .catch(() => undefined)
}

export function stopLive() {
  session++
  starting = null
  client?.close()
  client = null
  allowed = new Set()
}

/** Friends who have the app open right now. Calls `onChange` with the latest set. */
export function watchOnline(friendIds: number[], onChange: (online: Set<number>) => void) {
  const online = new Set<number>()
  const channels: RealtimeChannel[] = []
  let stopped = false
  void (async () => {
    await starting
    const live = client
    if (!live || stopped || !friendIds.length) return
    await ensureAccess(friendIds.map((id) => `online:${id}`))
    if (stopped) return
    for (const id of friendIds) {
      const channel = live.channels.get(`online:${id}`)
      channels.push(channel)
      const owner = String(id) // only the person whose channel it is counts
      channel.presence
        .subscribe((member: PresenceMessage) => {
          if (member.clientId !== owner) return
          if (member.action === 'leave' || member.action === 'absent') online.delete(id)
          else online.add(id)
          onChange(new Set(online))
        })
        .catch(() => undefined)
      channel.presence
        .get()
        .then((members) => {
          if (members.some((m) => m.clientId === owner)) online.add(id)
          onChange(new Set(online))
        })
        .catch(() => undefined)
    }
  })()
  return () => {
    stopped = true
    channels.forEach((c) => c.presence.unsubscribe())
  }
}

export interface ChatHandlers {
  /** Server events: "message", "deleted", "read". */
  onEvent: (name: string, data: unknown) => void
  onTyping: () => void
  /** Is the friend in this chat right now? */
  onHere: (here: boolean) => void
}

/** Open a conversation's channel: get its events, show that I'm here, and say when I type. */
export function joinChat(conversationId: number, friendId: number, handlers: ChatHandlers) {
  const name = `chat:${conversationId}`
  const friend = String(friendId)
  let channel: RealtimeChannel | null = null
  let left = false

  void (async () => {
    await starting
    const live = client
    if (!live || left) return
    await ensureAccess([name])
    if (left) return
    const ch = live.channels.get(name)
    channel = ch
    ch.subscribe((message) => {
      if (message.clientId) {
        // Sent by a person, not our server: only "typing" counts (real messages come from the server).
        if (message.name === 'typing' && message.clientId === friend) handlers.onTyping()
        return
      }
      handlers.onEvent(message.name ?? '', message.data)
    }).catch(() => undefined)
    const refreshHere = () =>
      ch.presence
        .get()
        .then((members) => handlers.onHere(members.some((m) => m.clientId === friend)))
        .catch(() => undefined)
    ch.presence.subscribe(() => void refreshHere()).catch(() => undefined)
    ch.presence.enter().catch(() => undefined) // the server skips the push while I'm here
    void refreshHere()
  })()

  let lastTyping = 0
  return {
    typing() {
      const now = Date.now()
      if (!channel || now - lastTyping < 2500) return
      lastTyping = now
      channel.publish('typing', {}).catch(() => undefined)
    },
    leave() {
      left = true
      if (!channel) return
      channel.presence.leave().catch(() => undefined)
      channel.unsubscribe()
      channel.presence.unsubscribe()
      channel.detach().catch(() => undefined)
    },
  }
}
