import { useCallback, useEffect, useState } from 'react'
import { workspaces as api, type WorkspaceNotification } from '../api'
import { Loading, SkeletonRows } from '../components/Loading'
import { useLiveRefresh } from '../live'
import { timeAgo } from '../user'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

interface NotificationsProps {
  now: Date
  notify: (title: string, detail?: string) => void
  onOpen: (url: string) => void
  onUnread: (count: number) => void
}

/** What's for you across your workspaces: mentions, rows assigned to you, comments. */
export function Notifications({ now, notify, onOpen, onUnread }: NotificationsProps) {
  const [items, setItems] = useState<WorkspaceNotification[] | null>(null)
  const [more, setMore] = useState(false)
  const [error, setError] = useState('')
  const [loadingMore, setLoadingMore] = useState(false)

  const load = useCallback(async () => {
    try {
      const first = await api.notifications()
      setItems((current) => {
        if (!current || current.length <= first.items.length) {
          setMore(first.more)
          return first.items
        }
        const newest = first.items.filter((item) => !current.some((c) => c.id === item.id))
        return [...newest, ...current.map((c) => first.items.find((item) => item.id === c.id) ?? c)]
      })
      onUnread(first.unread)
      setError('')
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [onUnread])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])
  useLiveRefresh(load, 20_000)

  const unread = items?.filter((n) => !n.read).length ?? 0

  async function open(item: WorkspaceNotification) {
    if (!item.read) {
      setItems((list) => list?.map((n) => (n.id === item.id ? { ...n, read: true } : n)) ?? null)
      // Not worth stopping you from opening it if this fails: it stays unread next time.
      api.readNotifications([item.id]).then(() => void load(), () => undefined)
    }
    onOpen(item.url)
  }

  async function readAll() {
    try {
      await api.readNotifications()
      setItems((list) => list?.map((n) => ({ ...n, read: true })) ?? null)
      onUnread(0)
    } catch (err) {
      notify("Couldn't mark them as read", errorMessage(err))
    }
  }

  async function showMore() {
    if (!items?.length || loadingMore) return
    setLoadingMore(true)
    try {
      const next = await api.notifications(Math.min(...items.map((i) => i.id)))
      setItems([...items, ...next.items])
      setMore(next.more)
    } catch (err) {
      notify("Couldn't load more", errorMessage(err))
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <div className="panel-page">
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button className="text-btn" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      <section className="card glass panel" aria-label="Notifications">
        {unread > 0 && (
          <div className="notice-top">
            <span className="task-meta">{unread} unread</span>
            <button type="button" className="text-btn" onClick={() => void readAll()}>
              Mark all as read
            </button>
          </div>
        )}
        <div className="panel-scroll">
          {items === null && <Loading active={!error} skeleton={<SkeletonRows count={4} />} onRetry={() => void load()} />}
          {items?.length === 0 && <p className="empty">Nothing yet. You'll see it here when someone adds work, finishes it, mentions you or comments.</p>}
          <ul className="notice-list">
            {items?.map((item) => (
              <li key={item.id}>
                <button type="button" className={`notice-row${item.read ? '' : ' unread'}`} onClick={() => void open(item)}>
                  <span className="notice-dot" aria-hidden="true" />
                  <span className="person-main">
                    <span className="notice-title">
                      {item.title}
                      {!item.read && <span className="sr-only"> (unread)</span>}
                    </span>
                    {item.body && <span className="notice-body">{item.body}</span>}
                    <span className="task-meta">{timeAgo(item.created_at, now)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {more && (
            <button type="button" className="text-btn activity-more" disabled={loadingMore} onClick={() => void showMore()}>
              {loadingMore ? 'Loading…' : 'Show more'}
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
