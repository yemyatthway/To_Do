import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { chat, social, type Chat, type ChatMessage, type Person } from '../api'
import { Icon } from '../icons'
import { useLiveRefresh } from '../live'
import { isLive, joinChat, onLive, watchOnline } from '../realtime'
import { addDays, formatLongDate, formatShortDay, formatTime, sameDay } from '../time'
import { handle, initials } from '../user'
import { usePageVisible } from '../visibility'
import './Chats.css'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
const nameOf = (p: Person) => p.full_name || p.email
const MAX_LENGTH = 2000
const PAGE = 50

interface ChatsProps {
  myId: number
  now: Date
  notify: (title: string, detail?: string) => void
  /** Open straight into a chat: from a notification, or "Message" on a friend. */
  start?: { chatId?: number; friendId?: number; at: number }
  onUnread: (count: number) => void
  /** The chat in `start` is open: forget it, so the Chats tab shows the list next time. */
  onStarted: () => void
}

export function Chats({ myId, now, notify, start, onUnread, onStarted }: ChatsProps) {
  const [chats, setChats] = useState<Chat[] | null>(null)
  const [friends, setFriends] = useState<Person[]>([])
  const [error, setError] = useState('')
  const [openId, setOpenId] = useState<number | null>(start?.chatId ?? null)
  const [opened, setOpened] = useState<Chat | null>(null) // a chat with no messages yet isn't in the list
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
            <p className="empty">Loading…</p>
          ) : chats.length === 0 ? (
            <p className="empty">
              {friends.length ? 'No messages yet. Tap New to write to a friend.' : 'Add a friend first, then you can message them here.'}
            </p>
          ) : (
            <ul className="chat-list">
              {chats.map((c) => (
                <li key={c.id}>
                  <button className="chat-row" aria-current={c.id === openId ? 'true' : undefined} onClick={() => setOpenId(c.id)}>
                    <Avatar person={c.friend} online={online.has(c.friend.id)} />
                    <span className="chat-row-main">
                      <span className="chat-row-top">
                        <span className="person-name">{nameOf(c.friend)}</span>
                        {c.last_message_at && <span className="chat-when">{listTime(new Date(c.last_message_at), now)}</span>}
                      </span>
                      <span className="chat-row-bottom">
                        <span className={`task-meta chat-preview${c.unread ? ' unread' : ''}`}>{preview(c)}</span>
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
            onBack={() => setOpenId(null)}
            onChanged={refresh}
          />
        ) : openId ? (
          <p className="empty">Loading…</p>
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

/** A message on screen: real ones from the server, plus my own while they're on the way. */
type Shown = ChatMessage & { pending?: boolean; failed?: boolean }

interface ThreadProps {
  chat: Chat
  myId: number
  now: Date
  online: boolean
  notify: (title: string, detail?: string) => void
  onBack: () => void
  onChanged: () => void
}

function Thread({ chat: info, myId, now, online, notify, onBack, onChanged }: ThreadProps) {
  const friend = info.friend
  const [messages, setMessages] = useState<Shown[] | null>(null)
  const [more, setMore] = useState(false)
  const [friendReadAt, setFriendReadAt] = useState(info.friend_read_at)
  const [typing, setTyping] = useState(false)
  const [here, setHere] = useState(false)
  const [draft, setDraft] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [error, setError] = useState('')
  const visible = usePageVisible()
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true) // keep the newest message in view unless they scrolled up
  const live = useRef<ReturnType<typeof joinChat> | null>(null)
  const typingTimer = useRef(0)
  const tempId = useRef(-1)
  const firstLoad = useRef(true)

  const own = useCallback((m: ChatMessage): Shown => ({ ...m, mine: m.sender === myId }), [myId])

  /** Merge the latest page with what's on screen (keeps older pages and messages still sending). */
  const loadLatest = useCallback(async () => {
    try {
      const page = await chat.messages(info.id)
      setFriendReadAt(page.chat.friend_read_at)
      if (firstLoad.current) {
        firstLoad.current = false
        setMore(page.messages.length === PAGE)
      }
      const latest = page.messages.map(own)
      setMessages((list) => {
        if (!list) return latest
        const ids = new Set(latest.map((m) => m.id))
        const oldest = latest[0]?.id ?? Infinity
        const older = list.filter((m) => m.id > 0 && m.id < oldest && !ids.has(m.id))
        const sending = list.filter((m) => m.id < 0)
        return [...older, ...latest, ...sending]
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
          setMessages((list) => {
            if (!list || list.some((x) => x.id === m.id)) return list
            // My own message can arrive here before the send finishes: it replaces the faded copy.
            const waiting = m.mine ? list.findIndex((x) => x.pending && x.text === m.text) : -1
            return waiting >= 0 ? list.map((x, i) => (i === waiting ? m : x)) : [...list, m]
          })
          if (m.sender === friend.id) {
            setTyping(false)
            clearTimeout(typingTimer.current)
          }
        } else if (name === 'deleted') {
          const id = (data as { id: number }).id
          setMessages((list) => list?.map((m) => (m.id === id ? { ...m, deleted: true, text: '' } : m)) ?? list)
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

  // Reading: mark as read whenever their newest message is on screen.
  const lastFromFriend = messages?.filter((m) => m.sender === friend.id).at(-1)?.id
  useEffect(() => {
    if (!visible || !lastFromFriend) return
    chat
      .read(info.id)
      .then(() => onChanged())
      .catch(() => undefined)
  }, [visible, lastFromFriend, info.id, onChanged])

  // Scroll to the newest message when one arrives (if they were already at the bottom).
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages, typing])

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

  async function send(text: string, retryId?: number) {
    const body = text.trim()
    if (!body) return
    const id = retryId ?? tempId.current--
    // Runs on send, not during render (the linter can't tell).
    // oxlint-disable-next-line react/purity
    const temp: Shown = { id, conversation: info.id, sender: myId, mine: true, text: body, deleted: false, created_at: new Date().toISOString(), pending: true }
    stick.current = true
    setMessages((list) => (retryId ? list?.map((m) => (m.id === id ? temp : m)) : [...(list ?? []), temp]) ?? null)
    try {
      const saved = own(await chat.send(info.id, body))
      // The live event may have added it already.
      setMessages((list) => {
        const rest = (list ?? []).filter((m) => m.id !== id)
        return rest.some((m) => m.id === saved.id) ? rest : [...rest, saved]
      })
      onChanged()
    } catch (err) {
      setMessages((list) => list?.map((m) => (m.id === id ? { ...m, pending: false, failed: true } : m)) ?? null)
      notify("Couldn't send", errorMessage(err))
    }
  }

  function submit() {
    const text = draft
    if (!text.trim()) return
    setDraft('')
    void send(text)
    input.current?.focus()
  }

  async function remove(m: Shown) {
    setSelected(null)
    if (m.failed) {
      setMessages((list) => list?.filter((x) => x.id !== m.id) ?? null)
      return
    }
    try {
      await chat.remove(info.id, m.id)
      setMessages((list) => list?.map((x) => (x.id === m.id ? { ...x, deleted: true, text: '' } : x)) ?? null)
      onChanged()
    } catch (err) {
      notify("Couldn't delete that message", errorMessage(err))
    }
  }

  // Grow the box with the text, up to a few lines.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [draft])

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
      </header>

      <div
        className="thread-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
        }}
        onClick={() => setSelected(null)}
      >
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="text-btn" onClick={loadLatest}>
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
          <p className="empty">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="empty">Say hi to {nameOf(friend)}.</p>
        ) : (
          <ol className="bubbles" aria-live="polite">
            {messages.map((m, i) => {
              const at = new Date(m.created_at)
              const prev = messages[i - 1]
              const newDay = !prev || !sameDay(new Date(prev.created_at), at)
              const grouped = !newDay && prev.sender === m.sender
              return (
                <li key={m.id} className="bubble-item">
                  {newDay && <div className="day-sep">{dayLabel(at, now)}</div>}
                  <div className={`bubble-row${m.mine ? ' mine' : ''}${grouped ? ' grouped' : ''}`}>
                    <div
                      className={`bubble${m.deleted ? ' deleted' : ''}${m.pending ? ' pending' : ''}${m.failed ? ' failed' : ''}`}
                      role={m.mine && !m.deleted ? 'button' : undefined}
                      tabIndex={m.mine && !m.deleted ? 0 : undefined}
                      aria-label={m.mine && !m.deleted ? 'Message options' : undefined}
                      onClick={(e) => {
                        if (!m.mine || m.deleted || m.pending) return
                        e.stopPropagation()
                        setSelected((s) => (s === m.id ? null : m.id))
                      }}
                      onKeyDown={(e) => {
                        if (m.mine && !m.deleted && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault()
                          setSelected((s) => (s === m.id ? null : m.id))
                        }
                      }}
                    >
                      {m.deleted ? (m.mine ? 'You deleted this message' : 'This message was deleted') : m.text}
                      <span className="bubble-time">{formatTime(at)}</span>
                    </div>
                    {selected === m.id && (
                      <div className="bubble-actions" onClick={(e) => e.stopPropagation()}>
                        {m.failed && (
                          <button className="text-btn" onClick={() => send(m.text, m.id)}>
                            <Icon name="undo" /> Try again
                          </button>
                        )}
                        <button className="text-btn danger" onClick={() => remove(m)}>
                          <Icon name="trash" /> {m.failed ? 'Discard' : 'Delete for everyone'}
                        </button>
                      </div>
                    )}
                  </div>
                  {m.failed && selected !== m.id && <div className="bubble-note mine">Not sent. Tap to try again.</div>}
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

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <textarea
          ref={input}
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
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia('(hover: hover)').matches) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <button className="primary-btn send-btn" type="submit" aria-label="Send" disabled={!draft.trim()}>
          <Icon name="send" />
        </button>
      </form>
    </div>
  )
}
