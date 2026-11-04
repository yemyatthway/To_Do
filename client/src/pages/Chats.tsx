import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { chat, social, type Chat, type ChatMessage, type ChatReaction, type Person, type ScheduledMessage } from '../api'
import { scheduledSummary, sendAtText } from '../chatSchedule'
import { chatSections, dayLabel, isSeen, matchesChat, messageTime, momentLabel } from '../chatTimeline'
import { ConfirmAction } from '../components/ConfirmAction'
import { Dial } from '../components/Dial'
import { EmojiGrid } from '../components/emoji'
import { Loading, SkeletonRows, ThreadSkeleton } from '../components/Loading'
import { MessageMenu, type MessageAction } from '../components/MessageMenu'
import { OptionsMenu } from '../components/OptionsMenu'
import { SearchField } from '../components/SearchField'
import { groupReactions, onlyEmoji, withMyReaction, type ReactionGroup } from '../emojiText'
import { Icon, type IconName } from '../icons'
import { useLiveRefresh } from '../live'
import { gsap, useGsap } from '../motion'
import { pendingMessages, type Outbox, type ShownMessage } from '../outbox'
import { isLive, joinChat, onLive, watchOnline, watchTyping } from '../realtime'
import { toLocalInput } from '../tableLogic'
import { sameDay } from '../time'
import { handle, initials } from '../user'
import { usePageVisible } from '../visibility'
import './Chats.css'
import { tr } from '../i18n'

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
  const [search, setSearch] = useState('')
  const listRef = useRef<HTMLDivElement>(null)

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
        notify(tr('Couldn\'t open that chat'), errorMessage(err))
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

  const sections = chatSections((chats ?? []).filter((c) => matchesChat(c, search)), now)

  // The timeline draws itself when it first appears: the line, then each chat sliding in.
  const listReady = chats !== null && chats.length > 0 && !picking && !search
  useGsap(
    listRef,
    () => {
      if (!listReady || !listRef.current) return
      gsap.fromTo(listRef.current.querySelectorAll('.moment'), { x: 26, opacity: 0 }, { x: 0, opacity: 1, duration: 0.55, stagger: 0.07, ease: 'power3.out', clearProps: 'transform,opacity' })
      gsap.fromTo(listRef.current.querySelectorAll('.moment-dot'), { scale: 0 }, { scale: 1, duration: 0.5, stagger: 0.07, delay: 0.15, ease: 'back.out(2.6)', clearProps: 'transform' })
    },
    [listReady],
  )
  // A chat with a new message hops up to the top.
  const topChat = useRef<number | null>(null)
  const top = chats?.[0]?.id ?? null
  useLayoutEffect(() => {
    const before = topChat.current
    topChat.current = top
    if (before === null || top === null || before === top) return
    const row = listRef.current?.querySelector(`.moment[data-id="${top}"]`)
    if (row) gsap.fromTo(row, { y: 40, scale: 0.97 }, { y: 0, scale: 1, duration: 0.55, ease: 'back.out(1.7)', clearProps: 'transform' })
  }, [top])

  return (
    <div className={`chats-page${openId ? ' has-thread' : ''}`}>
      <section className="card glass panel chat-list-pane" aria-label={tr('Your chats')}>
        <div className="panel-top">
          <SearchField label={tr('Search chats')} placeholder={tr('Search chats')} value={search} onChange={setSearch} />
          {friends.length > 0 && (
            <button className="primary-btn icon-only" aria-label={picking ? tr('Close') : tr('New chat')} aria-expanded={picking} onClick={() => setPicking((p) => !p)}>
              <Icon name={picking ? 'x' : 'plus'} />
            </button>
          )}
        </div>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="text-btn" onClick={refresh}>
              {tr('Retry')}
            </button>
          </div>
        )}

        <div ref={listRef} className="panel-scroll chat-scroll">
          {picking && (
            <ul className="chat-list" aria-label={tr('Start a chat with')}>
              {friends.filter((f) => `${f.full_name} ${f.username}`.toLowerCase().includes(search.trim().toLowerCase())).map((f) => (
                <li key={f.id}>
                  <button className="flat-row" onClick={() => openWith(f.id)}>
                    <Dial id={f.id} initials={initials(f)} ring={online.has(f.id) ? 'live' : null} />
                    <span className="row-main">
                      <span className="person-name">{nameOf(f)}</span>
                      <span className={`row-sub${online.has(f.id) ? ' live-status' : ''}`}>{online.has(f.id) ? tr('Online · {value}', { value: handle(f) }) : handle(f)}</span>
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
              <p className="empty">{friends.length ? tr('No messages yet. Press + to write to a friend.') : tr('Add a friend first, then you can message them here.')}</p>
            ) : sections.length === 0 ? (
              <p className="empty">{tr('No chats match.')}</p>
            ) : (
              sections.map((section) => (
                <div key={section.label} className="chat-section">
                  <h3 className="rail-label">{section.label}</h3>
                  <ul className="timeline">
                    {section.chats.map((c) => (
                      <li key={c.id} className="moment" data-id={c.id}>
                        <span className="moment-time">{c.last_message_at ? momentLabel(new Date(c.last_message_at), now) : ''}</span>
                        <span className={`moment-dot${c.unread ? ' new' : ''}`} aria-hidden="true" />
                        <button
                          className={`flat-row${c.unread ? ' unread' : ''}`}
                          aria-current={c.id === openId ? 'true' : undefined}
                          onClick={() => {
                            setOpened(c) // stays open even if it leaves the list (e.g. cleared)
                            setOpenId(c.id)
                          }}
                        >
                          <Dial id={c.friend.id} initials={initials(c.friend)} ring={c.unread ? 'new' : online.has(c.friend.id) ? 'live' : null} />
                          <span className="row-main">
                            <span className="person-name">{nameOf(c.friend)}</span>
                            {typingIn.has(c.id) ? (
                              <span className="typing">
                                <i />
                                <i />
                                <i />
                                {tr('typing')}
                              </span>
                            ) : (
                              <span className={`row-sub${c.unread ? ' unread' : ''}`}>
                                {isSeen(c) && (
                                  <span className="seen-mark" role="img" aria-label={tr('Seen')}>
                                    <Icon name="seen" />
                                  </span>
                                )}
                                {preview(c)}
                              </span>
                            )}
                          </span>
                          {c.unread > 0 && (
                            <span className="count-badge" aria-label={tr('{unread} unread', { unread: c.unread })}>
                              {c.unread}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            ))}

          {!picking && chats && chats.length > 0 && newFriends.length > 0 && !search && (
            <p className="task-meta chat-hint">{tr('Press + to message')}{' '}{newFriends.length === 1 ? nameOf(newFriends[0]) : tr('{length} more friends', { length: newFriends.length })}.</p>
          )}
        </div>
      </section>

      <section className="card glass chat-thread-pane" aria-label={tr('Messages')}>
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
            <p>{tr('Pick a chat to read and reply.')}</p>
            <p className="task-meta">{tr('Messages are stored encrypted. You can delete your own messages for everyone.')}</p>
          </div>
        )}
      </section>
    </div>
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
  if (!m) return tr('No messages yet')
  if (m.deleted) return m.mine ? tr('You deleted a message') : tr('Message deleted')
  return m.mine ? tr('You: {text}', { text: m.text }) : m.text
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
  const [scheduled, setScheduled] = useState<ScheduledMessage[]>([])
  const [scheduling, setScheduling] = useState<{ item: ScheduledMessage | null; text: string } | null>(null)
  const [showScheduled, setShowScheduled] = useState(false)
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

  const loadScheduled = useCallback(() => {
    chat.scheduled(info.id).then(setScheduled, () => undefined)
  }, [info.id])
  useEffect(loadScheduled, [loadScheduled])
  useLiveRefresh(loadScheduled, 30_000)
  // One of yours just went out.
  useEffect(() => onLive((e) => e.name === 'chat' && loadScheduled()), [loadScheduled])

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

  // When the keyboard opens the box gets shorter but stays scrolled the same, which would hide
  // the newest messages behind it. Stay on them, unless you'd scrolled up to read older ones.
  const scrollerHeight = useRef(0)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    scrollerHeight.current = el.clientHeight
    let frame = 0
    const observer = new ResizeObserver(() => {
      scrollerHeight.current = el.clientHeight
      // On the next frame: moving things during this callback makes the browser warn about a loop.
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (stick.current) el.scrollTop = el.scrollHeight
      })
    })
    observer.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

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
      notify(tr('Couldn\'t load older messages'), errorMessage(err))
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
      notify(tr('Couldn\'t add your reaction'), errorMessage(err))
    }
  }

  /** Tapping a quote: go to the original and show which one it is. */
  function jumpTo(id: number) {
    const target = scroller.current?.querySelector<HTMLElement>(`[data-id="${id}"] .bubble`)
    if (!target) {
      notify(tr('That message is further back'), tr('Load older messages to see it.'))
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
      notify(tr('Couldn\'t edit that message'), errorMessage(err))
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
      notify(tr('Couldn\'t delete that message'), errorMessage(err))
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
      notify(tr('Couldn\'t clear the chat'), errorMessage(err))
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
    if (m.failed) list.push({ icon: 'undo', label: tr('Try again'), run: () => m.key && outbox.retry(m.key) })
    if (!m.deleted && m.id > 0) list.push({ icon: 'reply', label: tr('Reply'), run: () => startReply(m) })
    if (m.mine && !m.deleted && !m.failed && now.getTime() - new Date(m.created_at).getTime() < EDIT_HOURS * 3_600_000) {
      list.push({ icon: 'edit', label: tr('Edit'), run: () => startEdit(m) })
    }
    list.push({ icon: 'trash', label: m.failed ? tr('Discard') : tr('Delete'), danger: true, run: () => setDeleting(m) })
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
  const status = typing ? tr('Typing…') : here ? tr('In this chat') : online ? tr('Online') : tr('Offline')

  return (
    <div className="thread">
      <header className="thread-head">
        <button className="round-btn thread-back" aria-label={tr('Back to chats')} onClick={onBack}>
          <Icon name="back" />
        </button>
        <span className="row-main">
          <span className={`eyebrow${typing || online ? ' live-status' : ''}`}>
            {status} · {handle(friend)}
          </span>
          <h2 className="thread-name">{nameOf(friend)}</h2>
        </span>
        <OptionsMenu label={tr('Chat options')} options={[{ icon: 'trash', label: tr('Clear chat'), danger: true, run: () => setConfirmClear(true) }]} />
      </header>
      {confirmClear && (
        <ConfirmAction danger icon="trash" title={tr('Clear this chat?')} confirmLabel={tr('Clear chat')} onCancel={() => setConfirmClear(false)} onConfirm={clearChat}>
          <p>{tr('It\'s cleared for you.')}{' '}{nameOf(friend)} {tr('keeps their copy.')}</p>
        </ConfirmAction>
      )}

      <div
        className="thread-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          // The box itself is changing size (the keyboard): that's not someone scrolling away.
          if (el.clientHeight !== scrollerHeight.current) return
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
      >
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="text-btn" onClick={() => void loadLatest()}>
              {tr('Retry')}
            </button>
          </div>
        )}
        {more && (
          <button className="text-btn load-older" onClick={loadOlder}>
            {tr('Load older messages')}
          </button>
        )}
        {messages === null ? (
          <Loading active={!error} skeleton={<ThreadSkeleton />} onRetry={() => void loadLatest()} />
        ) : shown?.length === 0 ? (
          <p className="empty">{tr('Say hi to')}{' '}{nameOf(friend)}.</p>
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
                      aria-label={m.pending ? undefined : tr('Message options')}
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
                          aria-label={tr('Go to the message from {value}', { value: m.reply.sender === myId ? tr('you') : nameOf(friend) })}
                          onClick={(e) => {
                            e.stopPropagation()
                            jumpTo(m.reply!.id)
                          }}
                        >
                          <span className="quote-name">{m.reply.sender === myId ? tr('You') : nameOf(friend)}</span>
                          <span className="quote-text">{m.reply.deleted ? tr('Message deleted') : m.reply.text}</span>
                        </button>
                      )}
                      {m.deleted ? (
                        m.mine ? (
                          tr('You deleted this message')
                        ) : (
                          tr('This message was deleted')
                        )
                      ) : big ? (
                        <span className={`sticker-row${big.length === 1 ? ' one' : ''}`}>{big.join('')}</span>
                      ) : (
                        m.text
                      )}
                      <span className="bubble-time">
                        {m.edited && tr('edited · ')}
                        {messageTime(at)}
                      </span>
                    </div>
                    {!m.deleted && !m.pending && !m.failed && (
                      <button
                        type="button"
                        className="bubble-react-hint"
                        aria-label={tr('React or reply')}
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
                  {m.failed && menu?.message.id !== m.id && <div className="bubble-note mine">{tr('Not sent. Tap to try again.')}</div>}
                  {m.waiting && <div className="bubble-note mine">{tr('Waiting for network')}</div>}
                  {lastMine?.id === m.id && <div className="bubble-note mine">{seen ? tr('Seen') : tr('Sent')}</div>}
                </li>
              )
            })}
          </ol>
        )}
        {typing && (
          <div className="bubble-row">
            <div className="bubble typing-bubble" aria-label={tr('{value} is typing', { value: nameOf(friend) })}>
              <span />
              <span />
              <span />
            </div>
          </div>
        )}
      </div>

      {scheduled.length > 0 && (
        <button type="button" className={`scheduled-bar${scheduled.some((s) => s.status === 'failed') ? ' failed' : ''}`} aria-expanded={showScheduled} onClick={() => setShowScheduled((v) => !v)}>
          <Icon name="clock" />
          <span className="row-main">{scheduledSummary(scheduled, now)}</span>
          <Icon name="chevron" className="more-go" />
        </button>
      )}
      {showScheduled && scheduled.length > 0 && (
        <ul className="row-list scheduled-list">
          {scheduled.map((item) => (
            <li key={item.id}>
              <button type="button" className="flat-row" disabled={item.status === 'sending'} onClick={() => setScheduling({ item, text: item.text })}>
                <span className="row-main">
                  <span className="person-name">{item.text}</span>
                  <span className={`row-sub${item.status === 'failed' ? ' is-failed' : ''}`}>{item.status === 'failed' ? item.error || tr('Couldn\'t send') : item.status === 'sending' ? tr('Sending…') : sendAtText(new Date(item.send_at), now)}</span>
                </span>
                <Icon name="chevron" className="more-go" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && <ComposerNote icon="edit" title={tr('Editing your message')} text={editing.text} cancelLabel={tr('Cancel editing')} onCancel={cancelEdit} />}
      {replying && <ComposerNote icon="reply" title={replying.sender === myId ? tr('Replying to your message') : tr('Replying to {value}', { value: nameOf(friend) })} text={replying.text} cancelLabel={tr('Cancel reply')} onCancel={() => setReplying(null)} />}
      {picker && <EmojiPanel onPick={insertEmoji} />}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <button type="button" className="icon-btn composer-emoji" aria-label={tr('Send an emoji')} aria-expanded={picker} onClick={() => setPicker((open) => !open)}>
          <Icon name="smile" />
        </button>
        <textarea
          ref={input}
          onFocus={() => setPicker(false)}
          className="field"
          rows={1}
          value={draft}
          maxLength={MAX_LENGTH}
          placeholder={tr('Message {value}', { value: nameOf(friend) })}
          aria-label={tr('Message')}
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
        {draft.trim() && !editing && !replying && (
          <button type="button" className="icon-btn composer-later" aria-label={tr('Send later')} onMouseDown={(e) => e.preventDefault()} onClick={() => setScheduling({ item: null, text: draft })}>
            <Icon name="clock" />
          </button>
        )}
        <button className="fab send-btn" type="submit" aria-label={editing ? tr('Save edit') : tr('Send')} disabled={!draft.trim()}>
          <Icon name={editing ? 'check' : 'send'} />
        </button>
      </form>

      {scheduling && (
        <ScheduleDialog
          chatId={info.id}
          item={scheduling.item}
          text={scheduling.text}
          now={now}
          friendName={nameOf(friend)}
          onClose={() => setScheduling(null)}
          onDone={(sentNow) => {
            setScheduling(null)
            if (!scheduling.item) setDraft('')
            if (sentNow) {
              stick.current = true
              void loadLatest()
              onChanged()
            }
            loadScheduled()
          }}
        />
      )}

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

/** Pick when a message goes. Also where a waiting one can be changed, sent now or dropped. */
function ScheduleDialog({ chatId, item, text, now, friendName, onClose, onDone }: { chatId: number; item: ScheduledMessage | null; text: string; now: Date; friendName: string; onClose: () => void; onDone: (sentNow: boolean) => void }) {
  const [words, setWords] = useState(text)
  const [when, setWhen] = useState(() => toLocalInput(item && item.status !== 'failed' ? item.send_at : new Date(now.getTime() + 60 * 60_000).toISOString()))
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState('')
  const chosen = when ? new Date(when) : null
  const ahead = Boolean(chosen && chosen.getTime() > now.getTime())
  const ready = Boolean(words.trim() && ahead)

  async function act(action: () => Promise<unknown>, sentNow = false) {
    setError('')
    try {
      await action()
      onDone(sentNow)
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  if (confirmingDelete && item) {
    return (
      <ConfirmAction danger icon="trash" title={tr('Delete this scheduled message?')} confirmLabel={tr('Delete')} onCancel={() => setConfirmingDelete(false)} onConfirm={() => act(() => chat.deleteScheduled(chatId, item.id))}>
        <p>{tr('It won\'t be sent to {friendName}.', { friendName })}</p>
      </ConfirmAction>
    )
  }
  return (
    <ConfirmAction
      icon={null}
      title={item ? tr('Scheduled message') : tr('Send later')}
      confirmLabel={item ? tr('Save') : tr('Schedule')}
      confirmDisabled={!ready}
      onCancel={onClose}
      onConfirm={async () => {
        const iso = new Date(when).toISOString()
        await (item ? chat.updateScheduled(chatId, item.id, words, iso) : chat.schedule(chatId, words, iso))
        onDone(false)
      }}
    >
      <div className="schedule-form">
        {item ? (
          <textarea className="field schedule-text" rows={2} maxLength={MAX_LENGTH} aria-label={tr('Message to {friendName}', { friendName })} value={words} onChange={(e) => setWords(e.target.value)} />
        ) : (
          <p className="schedule-quote">{words}</p>
        )}
        <input data-autofocus className="field" type="datetime-local" aria-label={tr('Date and time')} value={when} min={toLocalInput(now.toISOString())} onChange={(e) => setWhen(e.target.value)} />
        {when && !ahead && <p className="task-meta">{tr('Choose a time in the future.')}</p>}
        {item && (
          <div className="schedule-more">
            <button type="button" className="text-btn" onClick={() => void act(() => chat.sendScheduledNow(chatId, item.id), true)}>
              {tr('Send now')}
            </button>
            <button type="button" className="icon-btn danger" aria-label={tr('Delete')} onClick={() => setConfirmingDelete(true)}>
              <Icon name="trash" />
            </button>
          </div>
        )}
        {error && (
          <span className="field-error" role="alert">
            {error}
          </span>
        )}
      </div>
    </ConfirmAction>
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
      title={message.failed ? tr('Discard this message?') : tr('Delete this message?')}
      confirmLabel={message.failed ? tr('Discard') : tr('Delete')}
      onCancel={onCancel}
      onConfirm={async () => onDelete(!(canChoose && forEveryone))}
    >
      {canChoose ? (
        <div className="delete-choices" role="radiogroup" aria-label={tr('Delete for')}>
          <label className="delete-choice">
            <input type="radio" name="delete-for" checked={forEveryone} onChange={() => setForEveryone(true)} />
            <span>
              <strong>{tr('For everyone')}</strong>
              <small>{tr('{friendName} will see that a message was deleted.', { friendName })}</small>
            </span>
          </label>
          <label className="delete-choice">
            <input type="radio" name="delete-for" checked={!forEveryone} onChange={() => setForEveryone(false)} />
            <span>
              <strong>{tr('Just for me')}</strong>
              <small>{tr('{friendName} can still see it.', { friendName })}</small>
            </span>
          </label>
        </div>
      ) : (
        <p>{message.failed ? tr('It wasn\'t sent, and you can\'t get it back.') : message.deleted ? tr('This removes the note from your chat.') : tr('It goes from your chat only. {friendName} can still see it.', { friendName })}</p>
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
      aria-label={`${group.emoji} ${group.count}. ${group.mine ? tr('Take back') : tr('React the same')}`}
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
