import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { social, type Person, type Task } from '../api'
import { Icon } from '../icons'
import { gsap, useGsap } from '../motion'
import { dueDate, formatShortDay, formatTime } from '../time'
import { initials } from '../user'

interface SendTasksDialogProps {
  /** Your own tasks to choose from. */
  tasks: Task[]
  initialFriendId?: number
  initialTaskIds?: number[]
  onClose: () => void
  /** Done: a short summary for the toast. */
  onSent: (title: string, detail: string) => void
}

type Mode = 'remind' | 'copy'

const nameOf = (p: Person) => p.full_name || p.email

/** Pick a friend and some of your tasks; they receive copies, never access to your list. */
export function SendTasksDialog({ tasks, initialFriendId, initialTaskIds, onClose, onSent }: SendTasksDialogProps) {
  const [friends, setFriends] = useState<Person[] | null>(null)
  const [friendId, setFriendId] = useState<number | null>(initialFriendId ?? null)
  const [selected, setSelected] = useState<Set<number>>(() => new Set(initialTaskIds))
  const [message, setMessage] = useState('')
  // Remind: straight into their list with reminders, kept in sync. Copy: they choose to add it.
  const [mode, setMode] = useState<Mode>('remind')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const cardRef = useRef<HTMLFormElement>(null)

  useGsap(cardRef, () => {
    gsap.fromTo(cardRef.current, { autoAlpha: 0, y: 24, scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.45 })
  }, [])

  useEffect(() => {
    social
      .friends()
      .then((lists) => {
        setFriends(lists.friends)
        if (lists.friends.length === 1) setFriendId((id) => id ?? lists.friends[0].id)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  // Upcoming tasks first (soonest on top), then anytime ones.
  const choices = tasks
    .filter((t) => !t.done)
    .sort((a, b) => (dueDate(a)?.getTime() ?? Infinity) - (dueDate(b)?.getTime() ?? Infinity))

  const allSelected = choices.length > 0 && choices.every((t) => selected.has(t.id))

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setError('')
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const friend = friends?.find((f) => f.id === friendId)
    if (!friend) return setError('Pick a friend to send to.')
    if (selected.size === 0) return setError('Pick at least one task.')
    setBusy(true)
    const name = nameOf(friend)
    const plural = (n: number) => `${n} task${n === 1 ? '' : 's'}`
    try {
      if (mode === 'copy') {
        await social.send(friend.id, [...selected], message.trim())
        onSent(`Sent ${plural(selected.size)}`, `${name} can add them to their list.`)
        return
      }
      const result = await social.remind(friend.id, [...selected])
      if (result.mode === 'inbox') {
        onSent(`Sent to ${name}'s inbox`, `${name} adds tasks from friends themself, so they'll choose to add it.`)
        return
      }
      const notes = [
        result.already ? `${plural(result.already)} they already had` : '',
        result.past ? `${plural(result.past)} already over, skipped` : '',
      ].filter(Boolean)
      onSent(
        result.added ? `Added ${plural(result.added)} for ${name}` : `Nothing new for ${name}`,
        [result.added ? "They'll get a reminder, and your changes reach them too." : '', ...notes].filter(Boolean).join(' · '),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return createPortal(
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form ref={cardRef} className="send-card glass" role="dialog" aria-modal="true" aria-labelledby="send-h" onSubmit={submit} noValidate>
        <div className="sheet-head">
          <h2 id="send-h">Share with a friend</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="segmented" role="group" aria-label="How to share">
          <button type="button" aria-pressed={mode === 'remind'} onClick={() => setMode('remind')}>
            Add &amp; remind
          </button>
          <button type="button" aria-pressed={mode === 'copy'} onClick={() => setMode('copy')}>
            Send a copy
          </button>
        </div>
        <p className="list-sub" style={{ margin: 0 }}>
          {mode === 'remind'
            ? "It goes straight into their list with a reminder, as a shared plan: changes either of you make reach the other, with a notification."
            : 'They get a copy in their inbox and choose whether to add it. Later changes stay separate.'}{' '}
          They never see the rest of your tasks.
        </p>

        <div className="field-group">
          <span className="label">To</span>
          {friends === null ? (
            <p className="empty" style={{ padding: 0, textAlign: 'left' }}>
              Loading friends…
            </p>
          ) : friends.length === 0 ? (
            <p className="hint">You don't have any friends here yet. Add some on the Friends screen first.</p>
          ) : (
            <div className="chips" role="radiogroup" aria-label="Friend">
              {friends.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  role="radio"
                  aria-checked={friendId === f.id}
                  aria-pressed={friendId === f.id}
                  className="chip friend-chip"
                  onClick={() => {
                    setFriendId(f.id)
                    setError('')
                  }}
                >
                  <span className="avatar" aria-hidden="true">
                    {initials(f)}
                  </span>
                  {nameOf(f)}
                </button>
              ))}
            </div>
          )}
        </div>

        <fieldset className="field-group send-tasks">
          <div className="send-tasks-head">
            <legend className="label">
              Tasks <span className="hint">({selected.size} of {choices.length} selected)</span>
            </legend>
            {choices.length > 1 && (
              <button
                type="button"
                className="text-btn small-btn"
                onClick={() => {
                  setSelected(allSelected ? new Set() : new Set(choices.map((t) => t.id)))
                  setError('')
                }}
              >
                {allSelected ? 'Clear' : 'Select all'}
              </button>
            )}
          </div>
          {choices.length === 0 ? (
            <p className="hint">You have no open tasks to send.</p>
          ) : (
            <ul>
              {choices.map((t) => {
                const due = dueDate(t)
                const on = selected.has(t.id)
                return (
                  <li key={t.id}>
                    <label className={`send-task${on ? ' on' : ''}`} style={{ ['--cat' as string]: `var(--${t.category})` }}>
                      <input type="checkbox" className="sr-only" checked={on} onChange={() => toggle(t.id)} />
                      <span className={`check${on ? ' on' : ''}`} aria-hidden="true">
                        {on && <Icon name="check" />}
                      </span>
                      <span className="person-main">
                        <span className="task-title">{t.title}</span>
                        <span className="task-meta">{due ? `${formatShortDay(due)} · ${formatTime(due)}` : 'Anytime'}</span>
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>
          )}
        </fieldset>

        {mode === 'copy' && (
          <label className="field-group">
            <span className="label">Note (optional)</span>
            <textarea className="field" rows={2} maxLength={280} placeholder="Want to join me?" value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
        )}

        {error && (
          <span className="field-error" role="alert">
            {error}
          </span>
        )}
        <button type="submit" className="primary-btn" disabled={busy || !friends?.length}>
          <Icon name={mode === 'remind' ? 'bell' : 'send'} />
          {busy
            ? 'Sending…'
            : `${mode === 'remind' ? 'Add & remind' : 'Send'}${selected.size ? ` ${selected.size} task${selected.size === 1 ? '' : 's'}` : ''}`}
        </button>
      </form>
    </div>,
    document.body,
  )
}
