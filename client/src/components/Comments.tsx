import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ApiError, workspaces as api, type ActivityItem, type Comment, type Member } from '../api'
import { insertMention, mentionAt, splitMentions } from '../commentText'
import { Icon } from '../icons'
import { useLiveRefresh } from '../live'
import { memberName } from '../tableLogic'
import { initials, timeAgo } from '../user'
import { pickFiles, uploads, useUploads } from '../filesClient'
import { ConfirmAction } from './ConfirmAction'
import { FileView } from './Files'
import { Loading, SkeletonRows } from './Loading'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
const MAX_COMMENT_FILES = 6

export type CommentTarget = { workspaceId: number; pageId: number } | { workspaceId: number; tableId: number; rowId: number }

interface CommentsProps {
  target: CommentTarget
  now: Date
  members: Member[]
  canComment: boolean
  /** Comments changed, so anything counting them can catch up. */
  onChanged?: () => void
}

/** The comments on a page or a table row. */
export function Comments({ target, now, members, canComment, onChanged }: CommentsProps) {
  const [comments, setComments] = useState<Comment[] | null>(null)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState<Comment | null>(null)
  const usernames = useMemo(() => members.map((m) => m.username), [members])
  const { workspaceId } = target
  const pageId = 'pageId' in target ? target.pageId : undefined
  const tableId = 'tableId' in target ? target.tableId : undefined
  const rowId = 'rowId' in target ? target.rowId : undefined

  const load = useCallback(async () => {
    try {
      setComments(pageId ? await api.pageComments(workspaceId, pageId) : await api.rowComments(workspaceId, tableId!, rowId!))
      setError('')
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) setError(errorMessage(err))
    }
  }, [workspaceId, pageId, tableId, rowId])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])
  useLiveRefresh(load, 15_000)

  async function send(body: string, files: number[]) {
    const comment = pageId ? await api.addPageComment(workspaceId, pageId, body, files) : await api.addRowComment(workspaceId, tableId!, rowId!, body, files)
    setComments((list) => [...(list ?? []), comment])
    onChanged?.()
  }

  return (
    <section className="comments" aria-label="Comments">
      <h3 className="section-label">Comments{comments?.length ? ` · ${comments.length}` : ''}</h3>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
      {comments === null && !error && <Loading skeleton={<SkeletonRows count={1} avatar />} quiet />}
      {comments?.length === 0 && <p className="task-meta">{canComment ? 'No comments yet. Start the conversation.' : 'No comments yet.'}</p>}
      {comments?.map((comment) => (
        <article key={comment.id} className="comment">
          <span className="avatar" aria-hidden="true">
            {comment.author ? initials({ full_name: comment.author.name, email: comment.author.username }) : '?'}
          </span>
          <div className="comment-main">
            <div className="comment-head">
              <span className="person-name">{comment.author?.name ?? 'Someone'}</span>
              <span className="task-meta">{timeAgo(comment.created_at, now)}</span>
              {comment.can_delete && (
                <button type="button" className="comment-delete" aria-label="Delete this comment" onClick={() => setDeleting(comment)}>
                  <Icon name="x" />
                </button>
              )}
            </div>
            {comment.body && (
              <p className="comment-body">
                {splitMentions(comment.body, usernames).map((part, index) =>
                  part.mention ? (
                    <span key={index} className="mention">
                      {part.text}
                    </span>
                  ) : (
                    part.text
                  ),
                )}
              </p>
            )}
            {comment.files.length > 0 && (
              <div className="comment-files">
                {comment.files.map((id) => (
                  <FileView key={id} workspaceId={workspaceId} id={id} compact />
                ))}
              </div>
            )}
          </div>
        </article>
      ))}
      {canComment && <Composer workspaceId={workspaceId} members={members} onSend={send} />}
      {deleting && (
        <ConfirmAction
          danger
          icon="trash"
          title="Delete this comment?"
          confirmLabel="Delete comment"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteComment(workspaceId, deleting.id)
            setComments((list) => list?.filter((c) => c.id !== deleting.id) ?? null)
            setDeleting(null)
            onChanged?.()
          }}
        >
          <p>It's removed for everyone.</p>
        </ConfirmAction>
      )}
    </section>
  )
}

function Composer({ workspaceId, members, onSend }: { workspaceId: number; members: Member[]; onSend: (body: string, files: number[]) => Promise<void> }) {
  const [attached, setAttached] = useState<number[]>([])
  const running = useUploads()
  const stillSending = attached.some((id) => running.has(id))

  async function attach(files: File[]) {
    setError('')
    for (const file of files) {
      try {
        const record = await uploads.start(workspaceId, file)
        setAttached((list) => (list.length >= MAX_COMMENT_FILES ? list : [...list, record.id]))
      } catch (err) {
        setError(`${file.name}: ${errorMessage(err)}`)
      }
    }
  }

  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const nextCaret = useRef<number | null>(null)

  const at = mentionAt(text, caret)
  const q = at?.query ?? ''
  const matches = at ? members.filter((m) => `${m.username} ${m.full_name}`.toLowerCase().includes(q)).slice(0, 5) : []
  const choice = Math.min(picked, Math.max(matches.length - 1, 0))

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
    if (nextCaret.current !== null) {
      el.focus()
      el.setSelectionRange(nextCaret.current, nextCaret.current)
      nextCaret.current = null
    }
  }, [text])

  function choose(member: Member) {
    if (!at) return
    const next = insertMention(text, at, caret, member.username)
    nextCaret.current = next.caret
    setText(next.text)
    setCaret(next.caret)
    setPicked(0)
  }

  async function send() {
    if (busy || stillSending || (!text.trim() && !attached.length)) return
    setBusy(true)
    setError('')
    try {
      await onSend(text, attached)
      setText('')
      setCaret(0)
      setAttached([])
    } catch (err) {
      // Your words stay in the box to try again.
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="comment-composer">
      {matches.length > 0 && (
        <div className="mention-menu glass" role="listbox" aria-label="People in this workspace">
          {matches.map((member, index) => (
            <button
              key={member.id}
              type="button"
              role="option"
              aria-selected={index === choice}
              className={index === choice ? 'on' : ''}
              // Keep the caret in the box.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(member)}
            >
              <span className="person-name">{memberName(member)}</span>
              <span className="task-meta">@{member.username}</span>
            </button>
          ))}
        </div>
      )}
      {attached.length > 0 && (
        <div className="comment-files composer-files">
          {attached.map((id) => (
            <FileView key={id} workspaceId={workspaceId} id={id} compact onRemove={() => setAttached((list) => list.filter((other) => other !== id))} />
          ))}
        </div>
      )}
      <button type="button" className="icon-btn comment-attach" aria-label="Add a screenshot or file" disabled={attached.length >= MAX_COMMENT_FILES} onClick={() => pickFiles((files) => void attach(files))}>
        <Icon name="attach" />
      </button>
      <textarea
        ref={ref}
        className="field comment-input"
        rows={1}
        maxLength={2000}
        aria-label="Write a comment"
        placeholder="Comment, or type @ to mention"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setCaret(e.target.selectionStart)
          setPicked(0)
          setError('')
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData.files)
          if (files.length) {
            e.preventDefault()
            void attach(files)
          }
        }}
        onKeyDown={(e) => {
          if (matches.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setPicked((choice + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length)
              return
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault()
              choose(matches[choice])
              return
            }
            if (e.key === 'Escape') {
              e.stopPropagation()
              setCaret(-1)
              return
            }
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <button type="button" className="primary-btn" disabled={busy || stillSending || (!text.trim() && !attached.length)} onClick={() => void send()}>
        {busy ? 'Sending…' : stillSending ? 'Uploading…' : 'Send'}
      </button>
      {error && (
        <span className="field-error comment-error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}

interface ActivityListProps {
  workspaceId: number
  now: Date
  pageId?: number
  rowId?: number
  /** Opens what a line is about. Leave out when already looking at it. */
  onOpen?: (url: string) => void
}

/** A workspace's history, or one page's or row's. */
export function ActivityList({ workspaceId, now, pageId, rowId, onOpen }: ActivityListProps) {
  const [items, setItems] = useState<ActivityItem[] | null>(null)
  const [more, setMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const first = await api.activity(workspaceId, { page: pageId, row: rowId })
      // Keep older lines already loaded with "Show more".
      setItems((current) => {
        if (!current || current.length <= first.items.length) {
          setMore(first.more)
          return first.items
        }
        const newest = first.items.filter((item) => !current.some((c) => c.id === item.id))
        return [...newest, ...current.map((c) => first.items.find((item) => item.id === c.id) ?? c)]
      })
      setError('')
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [workspaceId, pageId, rowId])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])
  useLiveRefresh(load, 30_000)

  async function showMore() {
    if (!items?.length || loadingMore) return
    setLoadingMore(true)
    try {
      const next = await api.activity(workspaceId, { page: pageId, row: rowId, before: Math.min(...items.map((i) => i.id)) })
      setItems([...items, ...next.items])
      setMore(next.more)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoadingMore(false)
    }
  }

  if (items === null) {
    if (error) {
      return (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button className="text-btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )
    }
    return <Loading skeleton={<SkeletonRows count={4} avatar />} onRetry={() => void load()} />
  }

  return (
    <>
      {items.length === 0 && <p className="empty">Nothing has happened here yet.</p>}
      <ul className="activity-list">
        {items.map((item) => {
          const line = (
            <>
              <span className="activity-text">
                <strong>{item.actor}</strong> {item.text}
              </span>
              <span className="task-meta">{timeAgo(item.created_at, now)}</span>
            </>
          )
          return (
            <li key={item.id}>
              {onOpen && item.url ? (
                <button type="button" className="activity-row" onClick={() => onOpen(item.url!)}>
                  {line}
                </button>
              ) : (
                <div className="activity-row">{line}</div>
              )}
            </li>
          )
        })}
      </ul>
      {more && (
        <button type="button" className="text-btn activity-more" disabled={loadingMore} onClick={() => void showMore()}>
          {loadingMore ? 'Loading…' : 'Show more'}
        </button>
      )}
    </>
  )
}

/** A folded "History" for one page or row: loads only when opened. */
export function HistoryFold({ workspaceId, now, pageId, rowId }: { workspaceId: number; now: Date; pageId?: number; rowId?: number }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="history-fold">
      <button type="button" className="history-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="chevron" />
        History
      </button>
      {open && <ActivityList workspaceId={workspaceId} now={now} pageId={pageId} rowId={rowId} />}
    </section>
  )
}
