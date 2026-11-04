import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveRefresh } from '../live'
import { social, type Person, type Share } from '../api'
import { ConfirmAction } from '../components/ConfirmAction'
import { Dial } from '../components/Dial'
import { Loading, SkeletonRows } from '../components/Loading'
import { SearchField } from '../components/SearchField'
import { Icon } from '../icons'
import { useEnterOnChange } from '../motion'
import { watchOnline } from '../realtime'
import { formatShortDay, formatTime } from '../time'
import { handle, initials, timeAgo } from '../user'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
const nameOf = (p: Person) => p.full_name || p.email

type Tab = 'all' | 'requests' | 'sent'

interface FriendsProps {
  now: Date
  /** The friend whose page is open (their child page, /friends/<username>). */
  username?: string
  notify: (title: string, detail?: string) => void
  onOpenFriend: (username: string) => void
  /** Back to the list, after removing the friend whose page was open. */
  onCloseFriend: () => void
  /** The open friend's name, for the page heading. */
  onFriendName: (name: string | null) => void
  /** Open the send dialog, optionally with a friend already picked. */
  onSendTasks: (friend?: Person) => void
  /** Open the chat with this friend. */
  onMessage: (friend: Person) => void
  /** Tasks were added to my list: reload them and the badge. */
  onChanged: () => void
}

export function Friends({ now, username, notify, onOpenFriend, onCloseFriend, onFriendName, onSendTasks, onMessage, onChanged }: FriendsProps) {
  const [inbox, setInbox] = useState<Share[] | null>(null)
  const [lists, setLists] = useState<{ friends: Person[]; incoming: Person[]; outgoing: Person[] } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('all')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Person[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [removing, setRemoving] = useState<Person | null>(null)
  const request = useRef(0)
  const pageRef = useRef<HTMLDivElement>(null)
  useEnterOnChange(pageRef, username ?? '')
  const [online, setOnline] = useState<Set<number>>(new Set())
  const friendIds = lists?.friends.map((f) => f.id).join(',') ?? ''
  useEffect(() => watchOnline(friendIds ? friendIds.split(',').map(Number) : [], setOnline), [friendIds])

  const refresh = useCallback(async () => {
    try {
      const [shares, friends] = await Promise.all([social.inbox(), social.friends()])
      setInbox(shares)
      setLists(friends)
      setError('')
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  // refresh only sets state after the requests finish (the linter can't see through the await).
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    refresh()
  }, [refresh])

  // Requests, accepts and shares from friends appear without reloading.
  useLiveRefresh(refresh, 10_000)

  const trimmed = query.trim()
  const friend = username ? lists?.friends.find((p) => p.username === username) : undefined
  const friendName = friend ? nameOf(friend) : null
  useEffect(() => {
    onFriendName(friendName)
    return () => onFriendName(null)
  }, [friendName, onFriendName])

  // Ask the server only once typing pauses, and ignore answers to older searches.
  useEffect(() => {
    if (trimmed.length < 2) return
    const id = setTimeout(async () => {
      const mine = ++request.current
      try {
        const found = await social.search(trimmed)
        if (mine === request.current) setResults(found)
      } catch {
        if (mine === request.current) setResults([])
      } finally {
        if (mine === request.current) setSearching(false)
      }
    }, 300)
    return () => clearTimeout(id)
  }, [trimmed])

  function typeQuery(value: string) {
    setQuery(value)
    const short = value.trim().length < 2
    setSearching(!short)
    if (short) setResults(null)
    // People results live under All, so searching always shows them.
    if (value.trim()) setTab('all')
  }

  /** Runs an action once at a time per button, then refreshes everything. */
  async function act(key: string, fn: () => Promise<unknown>, success?: string) {
    setBusy(key)
    try {
      await fn()
      if (success) notify(success)
      await refresh()
      onChanged()
    } catch (err) {
      notify("That didn't work", errorMessage(err))
      // Usually it changed elsewhere (they cancelled, accepted, declined): show how things are now.
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  async function actOnResult(person: Person, fn: () => Promise<unknown>, success: string) {
    await act(`person-${person.id}`, fn, success)
    // Show the new state (e.g. "Requested") right away.
    if (trimmed.length >= 2) setResults(await social.search(trimmed).catch(() => results ?? []))
  }

  async function addShared(share: Share, itemIds?: number[]) {
    setBusy(`add-${share.id}-${itemIds?.join(',') ?? 'all'}`)
    try {
      const result = await social.add(share.id, itemIds)
      const notes: string[] = []
      if (result.clashes.length) {
        const c = result.clashes[0]
        notes.push(`You also have "${c.existing}" at ${formatTime(new Date(c.due_at))}. Both are kept.`)
      }
      if (result.moved_to_anytime.length) notes.push(`${result.moved_to_anytime.join(', ')} was on a past day, so it's under Anytime.`)
      notify(`Added ${result.added} task${result.added === 1 ? '' : 's'} to your list`, notes.join(' ') || undefined)
      await refresh()
      onChanged()
    } catch (err) {
      notify("Couldn't add those tasks", errorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const removeDialog = removing && (
    <ConfirmAction
      danger
      icon="users"
      title={`Remove ${nameOf(removing)}?`}
      confirmLabel="Remove friend"
      onCancel={() => setRemoving(null)}
      onConfirm={async () => {
        await social.remove(removing.friendship_id!)
        setRemoving(null)
        onCloseFriend()
        await refresh()
        onChanged()
      }}
    >
      <p>You won't be able to send each other tasks or chat until you're friends again. Your tasks stay in your list.</p>
    </ConfirmAction>
  )

  const errorBanner = error && (
    <div className="error-banner" role="alert">
      <span>{error}</span>
      <button className="text-btn" onClick={refresh}>
        Retry
      </button>
    </div>
  )

  if (username) {
    return (
      <div ref={pageRef} className="panel-page">
        {errorBanner}
        <section className="card glass" aria-label={friendName ?? 'Friend'}>
          {lists === null ? (
            <Loading active={!error} skeleton={<SkeletonRows count={2} avatar />} onRetry={() => void refresh()} />
          ) : !friend ? (
            <p className="empty">@{username} isn't in your friends.</p>
          ) : (
            <>
              <div className="panel-hero">
                <span className="avatar avatar-lg" aria-hidden="true">
                  {initials(friend)}
                </span>
                <span className="person-main">
                  <span className="person-name">{nameOf(friend)}</span>
                  <span className="task-meta">{handle(friend)}</span>
                </span>
              </div>
              <div className="panel-actions">
                <button className="primary-btn" onClick={() => onMessage(friend)}>
                  <Icon name="chat" />
                  Message
                </button>
                <button className="text-btn" onClick={() => onSendTasks(friend)}>
                  <Icon name="send" />
                  Send tasks
                </button>
              </div>
              <div className="panel-rows">
                <button className="more-row danger-row" onClick={() => setRemoving(friend)}>
                  <Icon name="x" />
                  <span className="person-name">Remove friend</span>
                </button>
              </div>
            </>
          )}
        </section>
        {removeDialog}
      </div>
    )
  }

  const matches = (p: Person) => `${p.full_name} ${p.username}`.toLowerCase().includes(trimmed.replace(/^@/, '').toLowerCase())
  const friends = lists?.friends.filter(matches) ?? []
  const onlineFriends = friends.filter((p) => online.has(p.id))
  const otherFriends = friends.filter((p) => !online.has(p.id))
  const outgoing = lists?.outgoing.filter(matches) ?? []
  const incoming = lists?.incoming ?? []
  const shares = [...(inbox?.filter((s) => s.status === 'new') ?? []), ...(inbox?.filter((s) => s.status !== 'new') ?? [])]
  const newShares = inbox?.filter((s) => s.status === 'new').length ?? 0
  // Friends and sent requests are already in the list above.
  const people = results?.filter((p) => p.relationship !== 'friends' && p.relationship !== 'outgoing') ?? []
  const nothingFound = trimmed.length >= 2 && !searching && results !== null && people.length === 0 && friends.length === 0 && outgoing.length === 0
  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'all', label: 'All', count: lists?.friends.length ?? 0 },
    { id: 'requests', label: 'Requests', count: incoming.length },
    { id: 'sent', label: 'Sent to you', count: newShares },
  ]

  return (
    <div ref={pageRef} className="panel-page">
      {errorBanner}
      <section className="card glass panel" aria-label="Friends">
        <div className="panel-top">
          <SearchField label="Search friends or find people" placeholder="Search people" value={query} onChange={typeQuery} />
          {Boolean(lists?.friends.length) && (
            <button className="primary-btn icon-only" aria-label="Send tasks" onClick={() => onSendTasks()}>
              <Icon name="send" />
            </button>
          )}
        </div>
        <div className="chips panel-tabs" role="group" aria-label="Show">
          {tabs.map((t) => (
            <button key={t.id} type="button" className="chip" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
              {t.count > 0 && ` ${t.count}`}
            </button>
          ))}
        </div>

        <div className="panel-scroll">
          {tab === 'all' &&
            (lists === null ? (
              <Loading active={!error} skeleton={<SkeletonRows count={3} avatar />} onRetry={() => void refresh()} />
            ) : (
              <>
                {lists.friends.length === 0 && lists.outgoing.length === 0 && !trimmed && <p className="empty">No friends yet. Search above to find people and send a request.</p>}
                {onlineFriends.length > 0 && (
                  <>
                    <h3 className="section-label">Online now · {onlineFriends.length}</h3>
                    <ul className="people">
                      {onlineFriends.map((p) => (
                        <FriendRow key={p.id} person={p} online onOpen={() => onOpenFriend(p.username)} />
                      ))}
                    </ul>
                  </>
                )}
                {otherFriends.length + outgoing.length > 0 && (
                  <>
                    <h3 className="section-label">{onlineFriends.length > 0 ? 'Everyone' : 'Your friends'}</h3>
                    <ul className="people">
                      {otherFriends.map((p) => (
                        <FriendRow key={p.id} person={p} online={false} onOpen={() => onOpenFriend(p.username)} />
                      ))}
                      {outgoing.map((p) => (
                        <PersonRow key={p.id} person={p} note="Request sent">
                          <button className="text-btn" disabled={busy !== null} onClick={() => act(`cancel-${p.id}`, () => social.remove(p.friendship_id!))}>
                            Cancel
                          </button>
                        </PersonRow>
                      ))}
                    </ul>
                  </>
                )}
                <Loading active={searching} skeleton={<SkeletonRows count={2} avatar />} />
                {!searching && people.length > 0 && (
                  <>
                    <h3 className="section-label">People on To-Do</h3>
                    <ul className="people">
                      {people.map((p) => (
                        <PersonRow key={p.id} person={p}>
                          {p.relationship === 'incoming' && (
                            <button className="primary-btn small-btn" disabled={busy !== null} onClick={() => actOnResult(p, () => social.accept(p.friendship_id!), `You and ${nameOf(p)} are now friends`)}>
                              Accept
                            </button>
                          )}
                          {p.relationship === 'none' && (
                            <button className="primary-btn small-btn" disabled={busy !== null} onClick={() => actOnResult(p, () => social.requestFriend(p.id), `Friend request sent to ${nameOf(p)}`)}>
                              <Icon name="userPlus" />
                              Add friend
                            </button>
                          )}
                        </PersonRow>
                      ))}
                    </ul>
                  </>
                )}
                {nothingFound && <p className="empty">No one found. Try their full email address.</p>}
                {trimmed.length === 1 && friends.length + outgoing.length === 0 && <p className="empty">Keep typing to find people.</p>}
              </>
            ))}

          {tab === 'requests' &&
            (lists === null ? (
              <Loading active={!error} skeleton={<SkeletonRows count={2} avatar />} onRetry={() => void refresh()} />
            ) : incoming.length === 0 ? (
              <p className="empty">No friend requests right now.</p>
            ) : (
              <ul className="people">
                {incoming.map((p) => (
                  <PersonRow key={p.id} person={p}>
                    <button className="primary-btn small-btn" disabled={busy !== null} onClick={() => act(`accept-${p.id}`, () => social.accept(p.friendship_id!), `You and ${nameOf(p)} are now friends`)}>
                      Accept
                    </button>
                    <button className="text-btn" disabled={busy !== null} onClick={() => act(`decline-${p.id}`, () => social.remove(p.friendship_id!))}>
                      Decline
                    </button>
                  </PersonRow>
                ))}
              </ul>
            ))}

          {tab === 'sent' &&
            (inbox === null ? (
              <Loading active={!error} skeleton={<SkeletonRows count={2} avatar />} onRetry={() => void refresh()} />
            ) : shares.length === 0 ? (
              <p className="empty">When a friend sends you tasks, they show up here. Nothing is added to your list until you choose.</p>
            ) : (
              <ul className="share-list">
                {shares.map((share) => (
                  <ShareCard key={share.id} share={share} now={now} busy={busy} onAdd={addShared} onDismiss={() => act(`dismiss-${share.id}`, () => social.dismiss(share.id))} />
                ))}
              </ul>
            ))}
        </div>
      </section>
      {removeDialog}
    </div>
  )
}

/** A friend: the whole row opens their page, where you can message them or send tasks. */
function FriendRow({ person, online, onOpen }: { person: Person; online: boolean; onOpen: () => void }) {
  return (
    <li className="friend-row">
      <button type="button" className="flat-row" onClick={onOpen}>
        <Dial id={person.id} initials={initials(person)} ring={online ? 'live' : null} />
        <span className="row-main">
          <span className="person-name">{nameOf(person)}</span>
          <span className={`row-sub${online ? ' live-status' : ''}`}>{online ? `Online · ${handle(person)}` : handle(person)}</span>
        </span>
        <Icon name="chevron" className="more-go" />
      </button>
    </li>
  )
}

function PersonInfo({ person, note }: { person: Person; note?: string }) {
  return (
    <>
      <span className="avatar" aria-hidden="true">
        {initials(person)}
      </span>
      <span className="person-main">
        <span className="person-name">{nameOf(person)}</span>
        <span className="task-meta">{[handle(person), note].filter(Boolean).join(' · ')}</span>
      </span>
    </>
  )
}

function PersonRow({ person, note, children }: { person: Person; note?: string; children: React.ReactNode }) {
  return (
    <li className="person">
      <PersonInfo person={person} note={note} />
      <span className="person-actions">{children}</span>
    </li>
  )
}

function ShareCard({
  share,
  now,
  busy,
  onAdd,
  onDismiss,
}: {
  share: Share
  now: Date
  busy: string | null
  onAdd: (share: Share, itemIds?: number[]) => void
  onDismiss: () => void
}) {
  const remaining = share.tasks.filter((t) => !t.added)
  return (
    <li className={`share-card${share.status === 'new' ? ' is-new' : ''}`}>
      <div className="share-head">
        <span className="avatar" aria-hidden="true">
          {initials(share.sender)}
        </span>
        <span className="person-main">
          <span className="person-name">{nameOf(share.sender)}</span>
          <span className="task-meta">
            {handle(share.sender)} · sent {share.tasks.length} task{share.tasks.length === 1 ? '' : 's'} · {timeAgo(share.created_at, now)}
          </span>
        </span>
      </div>
      {share.message && <p className="share-message">“{share.message}”</p>}
      <ul className="share-tasks">
        {share.tasks.map((t) => {
          const due = t.due_at ? new Date(t.due_at) : null
          return (
            <li key={t.id} className="share-task" style={{ ['--cat' as string]: `var(--${t.category})` }}>
              <span className="dot" style={{ background: 'var(--cat)' }} aria-hidden="true" />
              <span className="person-main">
                <span className="task-title">{t.title}</span>
                <span className="task-meta">{due ? `${formatShortDay(due)} · ${formatTime(due)}` : 'Anytime'}</span>
              </span>
              {t.added ? (
                <span className="badge badge-active">
                  <Icon name="check" /> Added
                </span>
              ) : (
                <button className="text-btn" disabled={busy !== null} onClick={() => onAdd(share, [t.id])} aria-label={`Add ${t.title} to my list`}>
                  <Icon name="plus" />
                  Add
                </button>
              )}
            </li>
          )
        })}
      </ul>
      {remaining.length > 0 && (
        <div className="share-actions">
          <button className="text-btn" disabled={busy !== null} onClick={onDismiss}>
            Dismiss
          </button>
          {remaining.length > 1 && (
            <button className="primary-btn small-btn" disabled={busy !== null} onClick={() => onAdd(share)}>
              <Icon name="plus" />
              Add all {remaining.length}
            </button>
          )}
        </div>
      )}
    </li>
  )
}
