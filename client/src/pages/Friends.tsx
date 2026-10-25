import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveRefresh } from '../live'
import { social, type Person, type Share } from '../api'
import { Icon } from '../icons'
import { formatShortDay, formatTime } from '../time'
import { initials, timeAgo } from '../user'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
const nameOf = (p: Person) => p.full_name || p.email

interface FriendsProps {
  now: Date
  notify: (title: string, detail?: string) => void
  /** Open the send dialog, optionally with a friend already picked. */
  onSendTasks: (friend?: Person) => void
  /** Tasks were added to my list: reload them and the badge. */
  onChanged: () => void
}

export function Friends({ now, notify, onSendTasks, onChanged }: FriendsProps) {
  const [inbox, setInbox] = useState<Share[] | null>(null)
  const [lists, setLists] = useState<{ friends: Person[]; incoming: Person[]; outgoing: Person[] } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

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

  const newShares = inbox?.filter((s) => s.status === 'new') ?? []
  const doneShares = inbox?.filter((s) => s.status !== 'new') ?? []

  return (
    <div className="friends-page">
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button className="text-btn" onClick={refresh}>
            Retry
          </button>
        </div>
      )}

      <section className="card glass" aria-labelledby="inbox-h">
        <div className="section-head">
          <h2 id="inbox-h">
            <Icon name="inbox" /> Sent to you
          </h2>
          {newShares.length > 0 && <span className="count-pill">{newShares.length} new</span>}
        </div>
        {inbox === null ? (
          <p className="empty">Loading…</p>
        ) : inbox.length === 0 ? (
          <p className="empty">When a friend sends you tasks, they show up here. Nothing is added to your list until you choose.</p>
        ) : (
          <ul className="share-list">
            {[...newShares, ...doneShares].map((share) => (
              <ShareCard key={share.id} share={share} now={now} busy={busy} onAdd={addShared} onDismiss={() => act(`dismiss-${share.id}`, () => social.dismiss(share.id))} />
            ))}
          </ul>
        )}
      </section>

      {lists && lists.incoming.length > 0 && (
        <section className="card glass" aria-labelledby="requests-h">
          <h2 id="requests-h">Friend requests</h2>
          <ul className="people">
            {lists.incoming.map((p) => (
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
        </section>
      )}

      <section className="card glass" aria-labelledby="friends-h">
        <div className="section-head">
          <h2 id="friends-h">
            <Icon name="users" /> Friends
          </h2>
          {lists && lists.friends.length > 0 && (
            <button className="primary-btn small-btn" onClick={() => onSendTasks()}>
              <Icon name="send" />
              Send tasks
            </button>
          )}
        </div>
        {lists === null ? (
          <p className="empty">Loading…</p>
        ) : lists.friends.length === 0 && lists.outgoing.length === 0 ? (
          <p className="empty">No friends yet. Find people below and send a request.</p>
        ) : (
          <ul className="people">
            {lists.friends.map((p) => (
              <PersonRow key={p.id} person={p}>
                <button className="text-btn" onClick={() => onSendTasks(p)} aria-label={`Send tasks to ${nameOf(p)}`}>
                  <Icon name="send" />
                  <span className="hide-narrow">Send</span>
                </button>
                <RemoveButton name={nameOf(p)} disabled={busy !== null} onConfirm={() => act(`remove-${p.id}`, () => social.remove(p.friendship_id!))} />
              </PersonRow>
            ))}
            {lists.outgoing.map((p) => (
              <PersonRow key={p.id} person={p} note="Request sent">
                <button className="text-btn" disabled={busy !== null} onClick={() => act(`cancel-${p.id}`, () => social.remove(p.friendship_id!))}>
                  Cancel
                </button>
              </PersonRow>
            ))}
          </ul>
        )}
      </section>

      <FindPeople busy={busy} onAct={act} />
    </div>
  )
}

function PersonRow({ person, note, children }: { person: Person; note?: string; children: React.ReactNode }) {
  return (
    <li className="person">
      <span className="avatar" aria-hidden="true">
        {initials(person)}
      </span>
      <span className="person-main">
        <span className="person-name">{nameOf(person)}</span>
        <span className="task-meta">{note ?? person.email}</span>
      </span>
      <span className="person-actions">{children}</span>
    </li>
  )
}

/** Two-step remove so a stray tap doesn't unfriend someone. */
function RemoveButton({ name, disabled, onConfirm }: { name: string; disabled: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false)
  if (!asking) {
    return (
      <button className="icon-btn" aria-label={`Remove ${name}`} disabled={disabled} onClick={() => setAsking(true)}>
        <Icon name="x" />
      </button>
    )
  }
  return (
    <>
      <button className="text-btn danger-text" disabled={disabled} onClick={onConfirm}>
        Remove
      </button>
      <button className="text-btn" onClick={() => setAsking(false)}>
        Keep
      </button>
    </>
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
            sent {share.tasks.length} task{share.tasks.length === 1 ? '' : 's'} · {timeAgo(share.created_at, now)}
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

function FindPeople({ busy, onAct }: { busy: string | null; onAct: (key: string, fn: () => Promise<unknown>, success?: string) => Promise<void> }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Person[] | null>(null)
  const [searching, setSearching] = useState(false)
  const request = useRef(0)

  // Ask the server only once typing pauses, and ignore answers to older searches.
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) return
    const id = setTimeout(async () => {
      const mine = ++request.current
      try {
        const found = await social.search(q)
        if (mine === request.current) setResults(found)
      } catch {
        if (mine === request.current) setResults([])
      } finally {
        if (mine === request.current) setSearching(false)
      }
    }, 300)
    return () => clearTimeout(id)
  }, [query])

  async function run(person: Person, fn: () => Promise<unknown>, success: string) {
    await onAct(`person-${person.id}`, fn, success)
    // Show the new state (e.g. "Request sent") right away.
    if (query.trim().length >= 2) setResults(await social.search(query.trim()).catch(() => results ?? []))
  }

  return (
    <section className="card glass" aria-labelledby="find-h">
      <h2 id="find-h">
        <Icon name="userPlus" /> Find people
      </h2>
      <label className="admin-search" style={{ maxWidth: 'none' }}>
        <span className="sr-only">Search by name or email</span>
        <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5" />
        </svg>
        <input
          className="field"
          type="search"
          placeholder="Name, or their exact email"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            const short = e.target.value.trim().length < 2
            setSearching(!short)
            if (short) setResults(null)
          }}
        />
      </label>
      {searching && <p className="empty">Searching…</p>}
      {!searching && results && results.length === 0 && <p className="empty">No one found. Try their full email address.</p>}
      {!searching && results && results.length > 0 && (
        <ul className="people">
          {results.map((p) => (
            <PersonRow key={p.id} person={p}>
              {p.relationship === 'friends' && <span className="badge badge-active">Friends</span>}
              {p.relationship === 'outgoing' && <span className="badge badge-inactive">Requested</span>}
              {p.relationship === 'incoming' && (
                <button className="primary-btn small-btn" disabled={busy !== null} onClick={() => run(p, () => social.accept(p.friendship_id!), `You and ${nameOf(p)} are now friends`)}>
                  Accept
                </button>
              )}
              {p.relationship === 'none' && (
                <button className="primary-btn small-btn" disabled={busy !== null} onClick={() => run(p, () => social.requestFriend(p.id), `Friend request sent to ${nameOf(p)}`)}>
                  <Icon name="userPlus" />
                  Add
                </button>
              )}
            </PersonRow>
          ))}
        </ul>
      )}
    </section>
  )
}
