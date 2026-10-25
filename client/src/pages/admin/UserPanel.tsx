import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AdminUser, AdminUserDetail, AuthEvent, User } from '../../api'
import { Icon } from '../../icons'
import { gsap, useGsap } from '../../motion'
import { formatDateTime, initials, timeAgo } from '../../user'
import { EVENT_ICON, EVENT_LABEL, STATUS_LABEL } from './labels'

interface UserPanelProps {
  me: User
  now: Date
  detail: AdminUserDetail | null
  loading: boolean
  open: boolean
  onClose: () => void
  onBan: () => void
  onUnban: () => void
  /** Open the Activity log tab filtered to this account. */
  onShowActivity: (email: string) => void
}

const wideQuery = window.matchMedia('(min-width: 900px)')

/**
 * Account details: a drawer from the right on wide screens, a sheet from the bottom on phones.
 * It renders into <body> so an animating parent (its transform) can't trap its fixed positioning.
 */
export function UserPanel({ me, now, detail, loading, open, onClose, onBan, onUnban, onShowActivity }: UserPanelProps) {
  const ref = useRef<HTMLElement>(null)

  useGsap(ref, () => {
    if (!open || !ref.current) return
    if (wideQuery.matches) gsap.fromTo(ref.current, { xPercent: 100 }, { xPercent: 0, duration: 0.5, ease: 'expo.out' })
    else gsap.fromTo(ref.current, { yPercent: 100 }, { yPercent: 0, duration: 0.55, ease: 'expo.out' })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const self = detail?.id === me.id
  const banBlocked = self
    ? "You can't ban your own account."
    : detail?.is_staff
      ? "Admin accounts can't be banned here."
      : detail?.status === 'deleted'
        ? 'The owner deleted this account; it can only be restored by them.'
        : ''

  const panel = (
    <div className="admin-detail-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={ref} className="card glass admin-detail" aria-label="Account details" aria-busy={loading}>
        <div className="admin-detail-head">
          <h2>Account</h2>
          <button type="button" className="icon-btn" aria-label="Close details" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>

        {!detail ? (
          <p className="empty">Loading…</p>
        ) : (
          <>
            <div className="admin-identity">
              <span className={`avatar avatar-lg${detail.status === 'banned' ? ' avatar-muted' : ''}`} aria-hidden="true">
                {initials(detail)}
              </span>
              <div style={{ minWidth: 0 }}>
                <p className="profile-name">{detail.full_name || 'No name'}</p>
                <p className="list-sub profile-email">{detail.email}</p>
                <span className={`badge badge-${detail.status}`}>{STATUS_LABEL[detail.status]}</span>
                {detail.is_staff && <span className="badge badge-staff">Admin</span>}
              </div>
            </div>

            {detail.status === 'deleted' && detail.erase_after && (
              <div className="ban-note" role="note">
                <strong>Deleted by its owner {detail.deleted_at ? timeAgo(detail.deleted_at, now).toLowerCase() : ''}</strong>
                <span>Erased for good on {formatDateTime(detail.erase_after)} unless they log in and restore it.</span>
              </div>
            )}

            {detail.status === 'banned' && (
              <div className="ban-note" role="note">
                <strong>Banned {detail.banned_at ? timeAgo(detail.banned_at, now).toLowerCase() : ''}</strong>
                <span>{detail.ban_reason || 'No reason given.'}</span>
              </div>
            )}

            <dl className="admin-facts">
              <div>
                <dt>Joined</dt>
                <dd>{formatDateTime(detail.date_joined)}</dd>
              </div>
              <div>
                <dt>Last login</dt>
                <dd>{detail.last_login_at ? formatDateTime(detail.last_login_at) : 'Never'}</dd>
              </div>
              <div>
                <dt>Last login IP</dt>
                <dd className="mono">{detail.last_login_ip ?? '–'}</dd>
              </div>
              <div>
                <dt>Tasks</dt>
                <dd>{detail.task_count}</dd>
              </div>
              <div>
                <dt>Time zone</dt>
                <dd>{detail.timezone || '–'}</dd>
              </div>
              <div>
                <dt>Reminders</dt>
                <dd>{detail.reminders_enabled ? 'On' : 'Off'}</dd>
              </div>
            </dl>

            <div>
              {detail.status === 'banned' ? (
                <button type="button" className="primary-btn admin-action" onClick={onUnban}>
                  <Icon name="undo" />
                  Unban account
                </button>
              ) : (
                <button
                  type="button"
                  className="danger-btn admin-action"
                  onClick={onBan}
                  disabled={Boolean(banBlocked)}
                  aria-describedby={banBlocked ? 'ban-blocked' : undefined}
                >
                  <Icon name="ban" />
                  Ban account
                </button>
              )}
              {banBlocked && detail.status !== 'banned' && (
                <p className="hint" id="ban-blocked" style={{ margin: '8px 0 0' }}>
                  {banBlocked}
                </p>
              )}
            </div>

            <section aria-labelledby="history-h">
              <div className="history-head">
                <h3 id="history-h" className="section-label">
                  Recent activity
                </h3>
                <button type="button" className="text-btn" onClick={() => onShowActivity(detail.email)}>
                  See all in the log
                </button>
              </div>
              {detail.recent_events.length === 0 ? (
                <p className="empty" style={{ padding: '8px 0' }}>
                  No activity recorded yet.
                </p>
              ) : (
                <ol className="history">
                  {detail.recent_events.slice(0, 10).map((event) => (
                    <HistoryItem key={event.id} event={event} />
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </aside>
    </div>
  )
  return createPortal(panel, document.body)
}

function HistoryItem({ event }: { event: AuthEvent }) {
  const icon = EVENT_ICON[event.kind]
  return (
    <li className={`history-item history-${event.kind}`}>
      <span className="history-icon" aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span className="history-main">
        <strong>{EVENT_LABEL[event.kind]}</strong>
        <span className="task-meta">{formatDateTime(event.created_at)}</span>
      </span>
      {event.ip_address && <span className="history-ip mono">{event.ip_address}</span>}
    </li>
  )
}

interface ConfirmProps {
  action: 'ban' | 'unban'
  user: AdminUser
  onCancel: () => void
  onConfirm: (reason: string) => Promise<void>
}

export function ConfirmDialog({ action, user, onCancel, onConfirm }: ConfirmProps) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const cardRef = useRef<HTMLFormElement>(null)
  const first = useRef<HTMLTextAreaElement & HTMLButtonElement>(null)
  const banning = action === 'ban'

  useGsap(cardRef, () => {
    gsap.fromTo(cardRef.current, { autoAlpha: 0, scale: 0.94, y: 14 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.45, ease: 'back.out(1.5)' })
  }, [])

  useEffect(() => {
    first.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    await onConfirm(reason.trim())
    setBusy(false)
  }

  return createPortal(
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form ref={cardRef} className="welcome-card glass confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-h" aria-describedby="confirm-body" onSubmit={submit}>
        <span className={`confirm-icon${banning ? ' danger' : ''}`} aria-hidden="true">
          <Icon name={banning ? 'ban' : 'undo'} />
        </span>
        <h2 id="confirm-h">{banning ? 'Ban this account?' : 'Unban this account?'}</h2>
        <p id="confirm-body">
          {banning ? (
            <>
              <strong>{user.email}</strong> will be logged out everywhere right away and won't be able to log in again until you unban them.
              Their tasks are kept.
            </>
          ) : (
            <>
              <strong>{user.email}</strong> will be able to log in again with their existing password.
            </>
          )}
        </p>
        {banning && (
          <label className="field-group" style={{ width: '100%', textAlign: 'left' }}>
            <span className="label">Reason (shown to admins only)</span>
            <textarea
              ref={first}
              className="field"
              rows={2}
              maxLength={255}
              placeholder="Spam, abuse, requested by the user…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
        )}
        <div className="confirm-actions">
          <button type="button" className="text-btn" onClick={onCancel} ref={banning ? undefined : first}>
            Cancel
          </button>
          <button type="submit" className={banning ? 'danger-btn' : 'primary-btn'} disabled={busy}>
            {busy ? (banning ? 'Banning…' : 'Restoring…') : banning ? 'Ban account' : 'Unban account'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
