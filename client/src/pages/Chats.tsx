import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { chat, social, type Chat, type ChatMessage, type ChatReaction, type Person } from '../api'
import { ConfirmAction } from '../components/ConfirmAction'
import { EmojiGrid } from '../components/emoji'
import { Loading, SkeletonRows, ThreadSkeleton } from '../components/Loading'
import { MessageMenu, type MessageAction } from '../components/MessageMenu'
import { groupReactions, onlyEmoji, withMyReaction, type ReactionGroup } from '../emojiText'
import { Icon, type IconName } from '../icons'
import { useLiveRefresh } from '../live'
import { gsap, useGsap } from '../motion'
import { pendingMessages, type Outbox, type ShownMessage } from '../outbox'
import { isLive, joinChat, onLive, watchOnline, watchTyping } from '../realtime'
import { addDays, formatLongDate, formatShortDay, formatTime, sameDay } from '../time'
import { handle, initials } from '../user'
import { usePageVisible } from '../visibility'
import './Chats.css'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
const nameOf = (p: Person) => p.full_name || p.email
const MAX_LENGTH = 2000
const PAGE = 50
const EDIT_HOURS = 24 // same as the server

interface ChatsProps {
  myId: number
  now: Date
  notify: (title: string, detail?: string) => void
  /** Open straight into a chat: from a notification, or "Message" on a friend. */
  start?: { chatId?: number; friendId?: number; at: number }
  onUnread: (count: number) => void
  /** The chat in `start` is open: forget it, so the Chats tab shows the list next time. */
  onStarted: () => void
  outbox: Outbox
}

export function Chats({ myId, now, notify, start, onUnread, onStarted, outbox }: ChatsProps) {
  const [chats, setChats] = useState<Chat[] | null>(null)
  const [friends, setFriends] = useState<Person[]>([])
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState<number | null>(start?.chatId ?? null)
  // The open chat, kept even when it isn't in the list (no messages yet, or just cleared).
  const [opened, setOpened] = useState<Chat | null>(null)
  const [picking, setPicking] = useState(false)
  const [online, setOnline] = useState<Set<number>>(new Set())

  const refresh = useCallback(async () => {
    try {
      const [list, people] = await Promise.all([chat.list(), social.friends()])
      setChats(list.chats)
      setFriends(people.friends)
      onUnread(list.unread)
      setError('')
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [onUnread])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    refresh()
  }, [refresh])
  // With the live connection every change arrives as an event; without it, check now and then.
  useLiveRefresh(refresh, isLive() ? 60_000 : 8_000)
  useEffect(() => onLive((e) => e.name === 'chat' && void refresh()), [refresh])

  // "typing…" under a friend's name in the list (most recent chats).
  const [typingIn, setTypingIn] = useState<Set<number>>(new Set())
  const typingTimers = useRef(new Map<number, number>())
  const watched = (chats ?? [])
    .slice(0, 20)
    .map((c) => `${c.id}:${c.friend.id}`)
    .join(',')
  useEffect(() => {
    const list = watched ? watched.split(',').map((pair) => pair.split(':').map(Number)) : []
    const timers = typingTimers.current
    const stop = watchTyping(
      list.map(([id, friendId]) => ({ id, friendId })),
      (chatId) => {
        setTypingIn((s) => new Set(s).add(chatId))
        clearTimeout(timers.get(chatId))
        timers.set(
          chatId,
          window.setTimeout(() => setTypingIn((s) => new Set([...s].filter((id) => id !== chatId))), 4000),
        )
      },
    )
    return () => {
      stop()
      timers.forEach((t) => clearTimeout(t))
    }
  }, [watched])
  // A new message ends their "typing…".
  useEffect(
    () =>
      onLive((e) => {
        const id = (e.data as { conversation?: number } | null)?.conversation
        if (e.name === 'chat' && id) setTypingIn((s) => (s.has(id) ? new Set([...s].filter((x) => x !== id)) : s))
      }),
    [],
  )

  const friendIds = friends.map((f) => f.id).join(',')
  useEffect(() => {
    const ids = friendIds ? friendIds.split(',').map(Number) : []
    return watchOnline(ids, setOnline)
  }, [friendIds])

  const openWith = useCallback(
    async (friendId: number) => {
      setPicking(false)
      try {
        const c = await chat.open(friendId)
        setOpened(c)
        setOpenId(c.id)
      } catch (err) {
        notify("Couldn't open that chat", errorMessage(err))
      }
    },
    [notify],
  )

  // "Message" on a friend, or a notification tap, while this screen is already open.
  useEffect(() => {
    if (!start) return
    // oxlint-disable-next-line react/set-state-in-effect
    if (start.chatId) setOpenId(start.chatId)
    else if (start.friendId) void openWith(start.friendId)
    onStarted()
  }, [start, openWith, onStarted])

  const active = chats?.find((c) => c.id === openId) ?? (opened?.id === openId ? opened : null)
  const withMessages = new Set(chats?.map((c) => c.friend.id))
  const newFriends = friends.filter((f) => !withMessages.has(f.id))

  return (
    <div className={`chats-page${openId ? ' has-thread' : ''}`}>
      <section className="card glass chat-list-pane" aria-labelledby="chats-h">
        <div className="section-head">
          <h2 id="chats-h">
            <Icon name="chat" /> Chats
          </h2>
          {friends.length > 0 && (
            <button className="primary-btn small-btn" aria-expanded={picking} onClick={() => setPicking((p) => !p)}>
              <Icon name={picking ? 'x' : 'plus'} />
              {picking ? 'Close' : 'New'}
            </button>
          )}
        </div>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="text-btn" onClick={refresh}>
              Retry
            </button>
          </div>
        )}

        {picking && (
          <ul className="chat-list picker" aria-label="Start a chat with">
            {friends.map((f) => (
              <li key={f.id}>
                <button className="chat-row" onClick={() => openWith(f.id)}>
                  <Avatar person={f} online={online.has(f.id)} />
                  <span className="chat-row-main">
                    <span className="person-name">{nameOf(f)}</span>
                    <span className="task-meta">{online.has(f.id) ? `${handle(f)} · Online` : handle(f)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {!picking &&
          (chats === null ? (
            <Loading active={!error} skeleton={<SkeletonRows count={4} avatar />} onRetry={() => void refresh()} />
          ) : chats.length === 0 ? (
            <p className="empty">
              {friends.length ? 'No messages yet. Tap New to write to a friend.' : 'Add a friend first, then you can message them here.'}
            </p>
          ) : (
            <ul className="chat-list">
              {chats.map((c) => (
                <li key={c.id}>
                  <button
                    className="chat-row"
                    aria-current={c.id === openId ? 'true' : undefined}
                    onClick={() => {
                      setOpened(c) // stays open even if it leaves the list (e.g. cleared)
                      setOpenId(c.id)
                    }}
                  >
                    <Avatar person={c.friend} online={online.has(c.friend.id)} />
                    <span className="chat-row-main">
                      <span className="chat-row-top">
                        <span className="person-name">{nameOf(c.friend)}</span>
                        {c.last_message_at && <span className="chat-when">{listTime(new Date(c.last_message_at), now)}</span>}
                      </span>
                      <span className="chat-row-bottom">
                        {typingIn.has(c.id) ? (
                          <span className="task-meta chat-preview live-status">typing…</span>
                        ) : (
                          <span className={`task-meta chat-preview${c.unread ? ' unread' : ''}`}>{preview(c)}</span>
                        )}
                        {c.unread > 0 && (
                          <span className="nav-badge static" aria-label={`${c.unread} unread`}>
                            {c.unread}
                          </span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ))}

        {!picking && chats && chats.length > 0 && newFriends.length > 0 && (
          <p className="task-meta chat-hint">Tap New to message {newFriends.length === 1 ? nameOf(newFriends[0]) : `${newFriends.length} more friends`}.</p>
        )}
      </section>

      <section className="card glass chat-thread-pane" aria-label="Messages">
        {active ? (
          <Thread
            key={active.id}
            chat={active}
            myId={myId}
            now={now}
            online={online.has(active.friend.id)}
            notify={notify}
            outbox={outbox}
            onBack={() => setOpenId(null)}
            onChanged={refresh}
          />
        ) : openId ? (
          <Loading skeleton={<ThreadSkeleton />} onRetry={() => void refresh()} />
        ) : (
          <div className="chat-placeholder">
            <Icon name="chat" />
            <p>Pick a chat to read and reply.</p>
            <p className="task-meta">Messages are stored encrypted. You can delete your own messages for everyone.</p>
          </div>
        )}
      </section>
    </div>
  )
}

function Avatar({ person, online }: { person: Person; online: boolean }) {
  return (
    <span className="avatar chat-avatar" aria-hidden="true">
      {initials(person)}
      {online && <span className="online-dot" />}
    </span>
  )
}

/** A message deleted for everyone: its words go, including from any reply that quotes it. */
function withDeleted<T extends ChatMessage>(list: T[], id: number): T[] {
  return list.map((m) => {
    if (m.id === id) return { ...m, deleted: true, edited: false, text: '', reactions: [] }
    return m.reply?.id === id ? { ...m, reply: { ...m.reply, deleted: true, text: '' } } : m
  })
}

function preview(c: Chat) {
  const m = c.last_message
  if (!m) return 'No messages yet'
  if (m.deleted) return m.mine ? 'You deleted a message' : 'Message deleted'
  return `${m.mine ? 'You: ' : ''}${m.text}`
}

function listTime(d: Date, now: Date) {
  if (sameDay(d, now)) return formatTime(d)
  if (sameDay(d, addDays(now, -1))) return 'Yesterday'
  return formatShortDay(d)
}

function dayLabel(d: Date, now: Date) {
  if (sameDay(d, now)) return 'Today'
  if (sameDay(d, addDays(now, -1))) return 'Yesterday'
  return formatLongDate(d)
}

/** A message on screen: real ones from the server, plus my own still in the save queue. */
type Shown = ShownMessage

interface ThreadProps {
  chat: Chat
  myId: number
  now: Date
  online: boolean
  notify: (title: string, detail?: string) => void
  outbox: Outbox
  onBack: () => void
  onChanged: () => void
}

function Thread({ chat: info, myId, now, online, notify, outbox, onBack, onChanged }: ThreadProps) {
  const friend = info.friend
  const [messages, setMessages] = useState<Shown[] | null>(null)
  const [more, setMore] = useState(false)
  const [friendReadAt, setFriendReadAt] = useState(info.friend_read_at)
  const [typing, setTyping] = useState(false)
  const [here, setHere] = useState(false)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<{ message: Shown; anchor: DOMRect; actions: MessageAction[] } | null>(null)
  const [editing, setEditing] = useState<Shown | null>(null)
  const [replying, setReplying] = useState<Shown | null>(null)
  const [picker, setPicker] = useState(false)
  const [deleting, setDeleting] = useState<Shown | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [error, setError] = useState('')
  const visible = usePageVisible()
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true) // keep the newest message in view unless they scrolled up
  const live = useRef<ReturnType<typeof joinChat> | null>(null)
  const typingTimer = useRef(0)
  const firstLoad = useRef(true)

  const own = useCallback((m: ChatMessage): Shown => ({ ...m, mine: m.sender === myId }), [myId])

  /** Merge the latest page with what's on screen (keeps older pages and messages still sending).
   *  `replace` starts over, e.g. after the chat was cleared on another device. */
  const loadLatest = useCallback(async (replace = false) => {
    try {
      const page = await chat.messages(info.id)
      setFriendReadAt(page.chat.friend_read_at)
      if (firstLoad.current) {
        firstLoad.current = false
        setMore(page.messages.length === PAGE)
      }
      const latest = page.messages.map(own)
      setMessages((list) => {
        if (!list || replace) return latest
        const ids = new Set(latest.map((m) => m.id))
        const oldest = latest[0]?.id ?? Infinity
        const older = list.filter((m) => m.id < oldest && !ids.has(m.id))
        return [...older, ...latest]
      })
      setError('')
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [info.id, own])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    loadLatest()
  }, [loadLatest])
  // Fallback when there's no live connection.
  useLiveRefresh(loadLatest, isLive() ? 60_000 : 5_000)

  // Live: new and deleted messages, "Seen", "typing…", and whether they're in this chat now.
  useEffect(() => {
    const connection = joinChat(info.id, friend.id, {
      onEvent: (name, data) => {
        if (name === 'message') {
          const m = own(data as ChatMessage)
          setMessages((list) => (list && !list.some((x) => x.id === m.id) ? [...list, m] : list))
          if (m.sender === friend.id) {
            setTyping(false)
            clearTimeout(typingTimer.current)
          }
        } else if (name === 'deleted') {
          const id = (data as { id: number }).id
          setMessages((list) => list && withDeleted(list, id))
        } else if (name === 'reacted') {
          const changed = data as { id: number; reactions: ChatReaction[] }
          setMessages((list) => list?.map((m) => (m.id === changed.id ? { ...m, reactions: changed.reactions } : m)) ?? list)
        } else if (name === 'edited') {
          const changed = data as ChatMessage
          setMessages((list) => list?.map((m) => (m.id === changed.id ? { ...m, text: changed.text, edited: true } : m)) ?? list)
        } else if (name === 'read') {
          const read = data as { user: number; at: string }
          if (read.user === friend.id) setFriendReadAt(read.at)
        }
      },
      onTyping: () => {
        setTyping(true)
        clearTimeout(typingTimer.current)
        typingTimer.current = window.setTimeout(() => setTyping(false), 4000)
      },
      onHere: setHere,
    })
    live.current = connection
    return () => {
      connection.leave()
      live.current = null
      clearTimeout(typingTimer.current)
    }
  }, [info.id, friend.id, own])

  // Deleted for me or cleared on another of my devices: show what the server shows.
  useEffect(
    () =>
      onLive((e) => {
        const d = e.data as { conversation?: number; hidden?: number; cleared?: boolean } | null
        if (e.name === 'chat' && d?.conversation === info.id && (d.hidden || d.cleared)) void loadLatest(true)
      }),
    [info.id, loadLatest],
  )

  // Reading: mark as read whenever their newest message is on screen.
  const lastFromFriend = messages?.filter((m) => m.sender === friend.id).at(-1)?.id
  useEffect(() => {
    if (!visible || !lastFromFriend) return
    chat
      .read(info.id)
      .then(() => onChanged())
      .catch(() => undefined)
  }, [visible, lastFromFriend, info.id, onChanged])

  // Messages still on their way, from the queue on this device (they survive closing the app).
  const sync = useSyncExternalStore(outbox.subscribe, outbox.getSnapshot)
  const shown = useMemo(() => (messages ? [...messages, ...pendingMessages(sync, info.id, messages, myId)] : null), [messages, sync, info.id, myId])
  useEffect(
    () =>
      outbox.onMessage((message) => {
        if (message.conversation !== info.id) return
        const m = own(message)
        setMessages((list) => (list && !list.some((x) => x.id === m.id) ? [...list, m] : list))
        onChanged()
      }),
    [outbox, info.id, own, onChanged],
  )

  // Scroll to the newest message when one arrives (if they were already at the bottom).
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [shown, typing])

  // New messages rise in, big emoji with a bounce. Not the ones already there when the chat opens.
  const seenBubbles = useRef<Set<string> | null>(null)
  const seenChips = useRef(new Set<string>())
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || !shown) return
    const items = [...el.querySelectorAll<HTMLElement>('.bubble-item')]
    const known = seenBubbles.current
    seenBubbles.current = new Set(items.map((item) => item.dataset.id ?? ''))
    // A reaction pops when it lands on a message that was already here, whoever sent it.
    const chips = [...el.querySelectorAll<HTMLElement>('.reaction-chip')]
    for (const chip of chips) {
      const id = chip.closest<HTMLElement>('.bubble-item')?.dataset.id ?? ''
      if (known?.has(id) && !seenChips.current.has(`${id}:${chip.dataset.emoji}`)) gsap.fromTo(chip, { scale: 0, rotate: -25 }, { scale: 1, rotate: 0, duration: 0.5, ease: 'back.out(3)', clearProps: 'transform' })
    }
    seenChips.current = new Set(chips.map((chip) => `${chip.closest<HTMLElement>('.bubble-item')?.dataset.id}:${chip.dataset.emoji}`))
    if (!known) return
    for (const item of items) {
      const id = item.dataset.id ?? ''
      if (known.has(id) || (Number(id) > 0 && !stick.current)) continue
      // My own message keeps its place when the server confirms it: only the row's id changed.
      if (item.querySelector('.bubble-row.mine') && Number(id) > 0 && known.size && [...known].some((k) => Number(k) < 0)) continue
      const bubble = item.querySelector('.bubble')
      if (item.classList.contains('is-sticker')) gsap.fromTo(bubble, { scale: 0.2, rotate: -12 }, { scale: 1, rotate: 0, duration: 0.55, ease: 'back.out(2.6)', clearProps: 'transform' })
      else gsap.fromTo(item, { y: 14, opacity: 0 }, { y: 0, opacity: 1, duration: 0.32, ease: 'power3.out', clearProps: 'transform,opacity' })
    }
  }, [shown])

  async function loadOlder() {
    const oldest = messages?.find((m) => m.id > 0)
    if (!oldest) return
    const el = scroller.current
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0
    try {
      const page = await chat.messages(info.id, oldest.id)
      stick.current = false
      setMore(page.messages.length === PAGE)
      setMessages((list) => [...page.messages.map(own), ...(list ?? [])])
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - fromBottom
      })
    } catch (err) {
      notify("Couldn't load older messages", errorMessage(err))
    }
  }

  function send(text: string) {
    const body = text.trim()
    if (!body) return
    stick.current = true
    outbox.sendMessage(info.id, body, replying && replying.id > 0 ? { id: replying.id, sender: replying.sender, text: replying.text.slice(0, 200), deleted: false } : null)
    setReplying(null)
  }

  function openMenu(m: Shown, el: Element) {
    setPicker(false)
    setMenu({ message: m, anchor: el.getBoundingClientRect(), actions: menuActions(m) })
  }

  function startReply(m: Shown) {
    setEditing(null)
    setReplying(m)
    requestAnimationFrame(() => input.current?.focus())
  }

  /** Update first, sync after: your reaction shows at once, and comes back off if the server says no. */
  async function react(m: Shown, emoji: string | null) {
    const before = m.reactions ?? []
    setMessages((list) => list?.map((x) => (x.id === m.id ? { ...x, reactions: withMyReaction(x.reactions ?? [], myId, emoji) } : x)) ?? null)
    try {
      const saved = await chat.react(info.id, m.id, emoji)
      setMessages((list) => list?.map((x) => (x.id === m.id ? { ...x, reactions: saved.reactions } : x)) ?? null)
    } catch (err) {
      setMessages((list) => list?.map((x) => (x.id === m.id ? { ...x, reactions: before } : x)) ?? null)
      notify("Couldn't add your reaction", errorMessage(err))
    }
  }

  /** Tapping a quote: go to the original and show which one it is. */
  function jumpTo(id: number) {
    const target = scroller.current?.querySelector<HTMLElement>(`[data-id="${id}"] .bubble`)
    if (!target) {
      notify('That message is further back', 'Load older messages to see it.')
      return
    }
    stick.current = false
    target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    gsap.fromTo(target, { scale: 1 }, { scale: 1.05, duration: 0.2, delay: 0.25, yoyo: true, repeat: 3, ease: 'power1.inOut', clearProps: 'transform' })
  }

  function submit() {
    const text = draft
    if (!text.trim()) return
    setDraft('')
    if (editing) void saveEdit(editing, text)
    else void send(text)
    input.current?.focus()
  }

  function startEdit(m: Shown) {
    setReplying(null)
    setEditing(m)
    setDraft(m.text)
    requestAnimationFrame(() => input.current?.focus())
  }

  function cancelEdit() {
    setEditing(null)
    setDraft('')
  }

  async function saveEdit(m: Shown, text: string) {
    setEditing(null)
    const body = text.trim()
    if (body === m.text) return
    setMessages((list) => list?.map((x) => (x.id === m.id ? { ...x, text: body, edited: true } : x)) ?? null)
    try {
      await chat.edit(info.id, m.id, body)
      onChanged()
    } catch (err) {
      setMessages((list) => list?.map((x) => (x.id === m.id ? m : x)) ?? null)
      notify("Couldn't edit that message", errorMessage(err))
    }
  }

  /** For everyone (your own message: it shows as deleted on both sides), or just for you (gone from your side). */
  async function remove(m: Shown, forMe: boolean) {
    if (m.key) {
      outbox.discard(m.key)
      return
    }
    const before = messages
    setMessages((list) =>
      forMe ? (list?.filter((x) => x.id !== m.id) ?? null) : list && withDeleted(list, m.id),
    )
    if (editing?.id === m.id) cancelEdit()
    try {
      await chat.remove(info.id, m.id, forMe)
      onChanged()
    } catch (err) {
      setMessages(before)
      notify("Couldn't delete that message", errorMessage(err))
    }
  }

  async function clearChat() {
    setConfirmClear(false)
    const before = messages
    setMessages([])
    try {
      await chat.clear(info.id)
      onChanged()
    } catch (err) {
      setMessages(before)
      notify("Couldn't clear the chat", errorMessage(err))
    }
  }

  // Grow the box with the text, up to a few lines.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [draft])

  const myReaction = (m: Shown) => m.reactions?.find((r) => r.user === myId)?.emoji ?? null

  const menuActions = (m: Shown): MessageAction[] => {
    const list: MessageAction[] = []
    if (m.failed) list.push({ icon: 'undo', label: 'Try again', run: () => m.key && outbox.retry(m.key) })
    if (!m.deleted && m.id > 0) list.push({ icon: 'reply', label: 'Reply', run: () => startReply(m) })
    if (m.mine && !m.deleted && !m.failed && now.getTime() - new Date(m.created_at).getTime() < EDIT_HOURS * 3_600_000) {
      list.push({ icon: 'edit', label: 'Edit', run: () => startEdit(m) })
    }
    list.push({ icon: 'trash', label: m.failed ? 'Discard' : 'Delete', danger: true, run: () => setDeleting(m) })
    return list
  }

  /** Adds to what's being typed, where the cursor is, and keeps the panel open for more. */
  function insertEmoji(emoji: string) {
    const el = input.current
    if (!el || draft.length + emoji.length > MAX_LENGTH) return
    const start = el.selectionStart
    const next = draft.slice(0, start) + emoji + draft.slice(el.selectionEnd)
    setDraft(next)
    live.current?.typing()
    requestAnimationFrame(() => el.setSelectionRange(start + emoji.length, start + emoji.length))
  }

  const lastMine = messages?.filter((m) => m.mine && !m.deleted && m.id > 0).at(-1)
  const seen = lastMine && friendReadAt && new Date(friendReadAt) >= new Date(lastMine.created_at)
  const status = typing ? 'Typing…' : here ? 'In this chat' : online ? 'Online' : 'Offline'

  return (
    <div className="thread">
      <header className="thread-head">
        <button className="icon-btn thread-back" aria-label="Back to chats" onClick={onBack}>
          <Icon name="back" />
        </button>
        <Avatar person={friend} online={online} />
        <span className="chat-row-main">
          <span className="person-name">{nameOf(friend)}</span>
          <span className="task-meta">
            {handle(friend)} · <span className={typing || online ? 'live-status' : undefined}>{status}</span>
          </span>
        </span>
        <button className="icon-btn" aria-label="Clear chat" aria-expanded={confirmClear} onClick={() => setConfirmClear((c) => !c)}>
          <Icon name="trash" />
        </button>
      </header>
      {confirmClear && (
        <div className="clear-bar" role="alert">
          <span>Clear this chat for you? {nameOf(friend)} keeps their copy.</span>
          <button className="text-btn" onClick={() => setConfirmClear(false)}>
            Cancel
          </button>
          <button className="text-btn danger" onClick={clearChat}>
            Clear
          </button>
        </div>
      )}

      <div
        className="thread-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
      >
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="text-btn" onClick={() => void loadLatest()}>
              Retry
            </button>
          </div>
        )}
        {more && (
          <button className="text-btn load-older" onClick={loadOlder}>
            Load older messages
          </button>
        )}
        {messages === null ? (
          <Loading active={!error} skeleton={<ThreadSkeleton />} onRetry={() => void loadLatest()} />
        ) : shown?.length === 0 ? (
          <p className="empty">Say hi to {nameOf(friend)}.</p>
        ) : (
          <ol className="bubbles" aria-live="polite">
            {shown?.map((m, i) => {
              const at = new Date(m.created_at)
              const prev = shown[i - 1]
              const newDay = !prev || !sameDay(new Date(prev.created_at), at)
              const grouped = !newDay && prev.sender === m.sender
              const big = m.deleted ? null : onlyEmoji(m.text)
              const reactions = m.deleted ? [] : groupReactions(m.reactions ?? [], myId)
              return (
                <li key={m.id} className={`bubble-item${big ? ' is-sticker' : ''}`} data-id={m.id}>
                  {newDay && <div className="day-sep">{dayLabel(at, now)}</div>}
                  <div className={`bubble-row${m.mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`}>
                    <div className="bubble-line">
                    <div
                      className={`bubble${m.deleted ? ' deleted' : ''}${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}${editing?.id === m.id ? ' editing' : ''}${menu?.message.id === m.id ? ' is-open' : ''}${big ? ' sticker' : ''}`}
                      role={m.pending ? undefined : 'button'}
                      tabIndex={m.pending ? undefined : 0}
                      aria-label={m.pending ? undefined : 'Message options'}
                      onMouseDown={(e) => {
                        // Typing? Keep the keyboard up, so the screen doesn't jump while the menu opens.
                        if (document.activeElement === input.current) e.preventDefault()
                      }}
                      onClick={(e) => {
                        if (m.pending) return
                        e.stopPropagation()
                        openMenu(m, e.currentTarget)
                      }}
                      onKeyDown={(e) => {
                        if (!m.pending && e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault()
                          openMenu(m, e.currentTarget)
                        }
                      }}
                    >
                      {m.reply && (
                        <button
                          type="button"
                          className="bubble-quote"
                          aria-label={`Go to the message from ${m.reply.sender === myId ? 'you' : nameOf(friend)}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            jumpTo(m.reply!.id)
                          }}
                        >
                          <span className="quote-name">{m.reply.sender === myId ? 'You' : nameOf(friend)}</span>
                          <span className="quote-text">{m.reply.deleted ? 'Message deleted' : m.reply.text}</span>
                        </button>
                      )}
                      {m.deleted ? (
                        m.mine ? (
                          'You deleted this message'
                        ) : (
                          'This message was deleted'
                        )
                      ) : big ? (
                        <span className={`sticker-row${big.length === 1 ? ' one' : ''}`}>{big.join('')}</span>
                      ) : (
                        m.text
                      )}
                      <span className="bubble-time">
                        {m.edited && 'edited · '}
                        {formatTime(at)}
                      </span>
                    </div>
                    {!m.deleted && !m.pending && !m.failed && (
                      <button
                        type="button"
                        className="bubble-react-hint"
                        aria-label="React or reply"
                        onClick={(e) => {
                          e.stopPropagation()
                          openMenu(m, e.currentTarget.parentElement?.querySelector('.bubble') ?? e.currentTarget)
                        }}
                      >
                        <Icon name="reactPlus" />
                      </button>
                    )}
                    </div>
                  </div>
                  {reactions.length > 0 && (
                    <div className={`reaction-chips${m.mine ? ' mine' : ''}`}>
                      {reactions.map((group) => (
                        <ReactionChip key={group.emoji} group={group} onToggle={() => react(m, group.mine ? null : group.emoji)} />
                      ))}
                    </div>
                  )}
                  {m.failed && menu?.message.id !== m.id && <div className="bubble-note mine">Not sent. Tap to try again.</div>}
                  {m.waiting && <div className="bubble-note mine">Waiting for network</div>}
                  {lastMine?.id === m.id && <div className="bubble-note mine">{seen ? 'Seen' : 'Sent'}</div>}
                </li>
              )
            })}
          </ol>
        )}
        {typing && (
          <div className="bubble-row">
            <div className="bubble typing-bubble" aria-label={`${nameOf(friend)} is typing`}>
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      {editing && <ComposerNote icon="edit" title="Editing your message" text={editing.text} cancelLabel="Cancel editing" onCancel={cancelEdit} />}
      {replying && <ComposerNote icon="reply" title={replying.sender === myId ? 'Replying to your message' : `Replying to ${nameOf(friend)}`} text={replying.text} cancelLabel="Cancel reply" onCancel={() => setReplying(null)} />}
      {picker && <EmojiPanel onPick={insertEmoji} />}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <button type="button" className="icon-btn composer-emoji" aria-label="Send an emoji" aria-expanded={picker} onClick={() => setPicker((open) => !open)}>
          <Icon name="smile" />
        </button>
        <textarea
          ref={input}
          onFocus={() => setPicker(false)}
          className="field"
          rows={1}
          value={draft}
          maxLength={MAX_LENGTH}
          placeholder={`Message ${nameOf(friend)}`}
          aria-label="Message"
          onChange={(e) => {
            setDraft(e.target.value)
            if (e.target.value.trim()) live.current?.typing()
          }}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter makes a new line (phones keep their own return key).
            if (e.key === 'Escape' && editing) cancelEdit()
            if (e.key === 'Escape' && replying) setReplying(null)
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(hover: hover)').matches) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button className="primary-btn send-btn" type="submit" aria-label={editing ? 'Save edit' : 'Send'} disabled={!draft.trim()}>
          <Icon name={editing ? 'check' : 'send'} />
        </button>
      </form>

      {menu && (
        <MessageMenu
          anchor={menu.anchor}
          mine={menu.message.mine}
          reaction={!menu.message.deleted && !menu.message.failed && menu.message.id > 0 ? { current: myReaction(menu.message), onPick: (emoji) => void react(menu.message, emoji) } : null}
          actions={menu.actions}
          onClose={() => setMenu(null)}
        />
      )}
      {deleting && (
        <DeleteMessage
          message={deleting}
          friendName={nameOf(friend)}
          onCancel={() => setDeleting(null)}
          onDelete={(forMe) => {
            setDeleting(null)
            void remove(deleting, forMe)
          }}
        />
      )}
    </div>
  )
}

/** What's above the box while replying or editing: says so, and lets you back out. */
function ComposerNote({ icon, title, text, cancelLabel, onCancel }: { icon: IconName; title: string; text: string; cancelLabel: string; onCancel: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useGsap(ref, () => {
    gsap.fromTo(ref.current, { y: 12, opacity: 0 }, { y: 0, opacity: 1, duration: 0.28, ease: 'power3.out', clearProps: 'transform,opacity' })
  }, [])
  return (
    <div ref={ref} className="composer-note">
      <Icon name={icon} />
      <span className="composer-note-main">
        <span className="quote-name">{title}</span>
        <span className="quote-text">{text}</span>
      </span>
      <button type="button" className="icon-btn" aria-label={cancelLabel} onClick={onCancel}>
        <Icon name="x" />
      </button>
    </div>
  )
}

function EmojiPanel({ onPick }: { onPick: (emoji: string) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useGsap(ref, () => {
    gsap.fromTo(ref.current, { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.3, ease: 'power3.out', clearProps: 'transform,opacity' })
  }, [])
  return (
    <div ref={ref} className="composer-picker">
      <EmojiGrid onPick={onPick} />
    </div>
  )
}

/** Asks before a message goes, and says who it goes for. */
function DeleteMessage({ message, friendName, onCancel, onDelete }: { message: Shown; friendName: string; onCancel: () => void; onDelete: (forMe: boolean) => void }) {
  const canChoose = message.mine && !message.deleted && !message.failed
  const [forEveryone, setForEveryone] = useState(true)
  return (
    <ConfirmAction
      danger
      icon="trash"
      title={message.failed ? 'Discard this message?' : 'Delete this message?'}
      confirmLabel={message.failed ? 'Discard' : 'Delete'}
      onCancel={onCancel}
      onConfirm={async () => onDelete(!(canChoose && forEveryone))}
    >
      {canChoose ? (
        <div className="delete-choices" role="radiogroup" aria-label="Delete for">
          <label className="delete-choice">
            <input type="radio" name="delete-for" checked={forEveryone} onChange={() => setForEveryone(true)} />
            <span>
              <strong>For everyone</strong>
              <small>{friendName} will see that a message was deleted.</small>
            </span>
          </label>
          <label className="delete-choice">
            <input type="radio" name="delete-for" checked={!forEveryone} onChange={() => setForEveryone(false)} />
            <span>
              <strong>Just for me</strong>
              <small>{friendName} can still see it.</small>
            </span>
          </label>
        </div>
      ) : (
        <p>{message.failed ? "It wasn't sent, and you can't get it back." : message.deleted ? "This removes the note from your chat." : `It goes from your chat only. ${friendName} can still see it.`}</p>
      )}
    </ConfirmAction>
  )
}

/** A reaction under a message. */
function ReactionChip({ group, onToggle }: { group: ReactionGroup; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`reaction-chip${group.mine ? ' mine' : ''}`}
      data-emoji={group.emoji}
      aria-pressed={group.mine}
      aria-label={`${group.emoji} ${group.count}. ${group.mine ? 'Take back' : 'React the same'}`}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      <span className="reaction-emoji">{group.emoji}</span>
      {group.count > 1 && <span className="reaction-count">{group.count}</span>}
    </button>
  )
}
