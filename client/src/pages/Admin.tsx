import { useCallback, useEffect, useRef, useState } from 'react'
import { EMAIL_NAMES, resultsMessage } from '../emailResults'
import { useLiveRefresh } from '../live'
import { Bone, Loading } from '../components/Loading'
import { admin, type AdminStats, type AdminUser, type AdminUserDetail, type User } from '../api'
import { ActivityTable } from './admin/ActivityTable'
import { errorMessage } from './admin/useServerTable'
import { ConfirmDialog, UserPanel } from './admin/UserPanel'
import { UsersTable } from './admin/UsersTable'
import { timeAgo } from '../user'
import { tr } from '../i18n'

type Tab = 'users' | 'activity' | 'emails'

interface AdminProps {
  me: User
  now: Date
  notify: (title: string, detail?: string) => void
}

/** Staff dashboard: totals on top, then two separate tables, Users and the Activity log. */
export function Admin({ me, now, notify }: AdminProps) {
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [statsError, setStatsError] = useState('')
  const [tab, setTab] = useState<Tab>('users')
  // "See all in the log" from an account opens the log searched for that email (a fresh table).
  const [activity, setActivity] = useState({ key: 0, search: '' })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<AdminUserDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [changed, setChanged] = useState<AdminUser | null>(null)
  const [confirm, setConfirm] = useState<'ban' | 'unban' | null>(null)

  const loadStats = useCallback(
    () =>
      admin.stats().then(
        (s) => {
          setStats(s)
          setStatsError('')
        },
        (err) => setStatsError(errorMessage(err)),
      ),
    [],
  )
  useEffect(() => {
    loadStats()
  }, [loadStats])
  useLiveRefresh(loadStats, 30_000)

  const openUser = useCallback(
    async (id: number) => {
      setSelectedId(id)
      setDetail(null)
      setDetailLoading(true)
      try {
        setDetail(await admin.user(id))
      } catch (err) {
        notify(tr('Couldn\'t load that account'), errorMessage(err))
        setSelectedId(null)
      } finally {
        setDetailLoading(false)
      }
    },
    [notify],
  )

  const closeUser = useCallback(() => {
    setSelectedId(null)
    setDetail(null)
  }, [])

  async function applyAction(reason: string) {
    if (!detail || !confirm) return
    const action = confirm
    try {
      const updated = action === 'ban' ? await admin.ban(detail.id, reason) : await admin.unban(detail.id)
      setChanged(updated)
      setDetail({ ...detail, ...updated })
      setConfirm(null)
      loadStats()
      notify(action === 'ban' ? tr('Account banned') : tr('Account restored'), updated.email)
    } catch (err) {
      notify(action === 'ban' ? tr('Couldn\'t ban the account') : tr('Couldn\'t unban the account'), errorMessage(err))
    }
  }

  const statCards: { label: string; value: number | undefined; tone?: string }[] = [
    { label: tr('Total users'), value: stats?.total_users },
    { label: tr('Active'), value: stats?.active_users, tone: 'ok' },
    { label: tr('Banned'), value: stats?.banned_users, tone: 'danger' },
    { label: tr('Deleted (restorable)'), value: stats?.deleted_users },
    { label: tr('New this week'), value: stats?.new_users_7d },
    { label: tr('Logins (24 h)'), value: stats?.logins_24h },
  ]

  return (
    <div className="admin-page">
      <section className="admin-stats" aria-label={tr('Overview')}>
        {statCards.map((card) => (
          <div key={card.label} className={`stat-card neu${card.tone ? ` stat-${card.tone}` : ''}`}>
            <span className="stat-value">
              {card.value ?? (statsError ? '–' : <Loading quiet skeleton={<Bone width={46} height={26} />} />)}
            </span>
            <span className="stat-label">{card.label}</span>
          </div>
        ))}
      </section>
      {statsError && <div className="error-banner">{statsError}</div>}
      {stats && <ServiceStatus lastRun={stats.reminders_last_run} now={now} />}

      <div className="segmented admin-tabs" role="tablist" aria-label={tr('Admin sections')}>
        {(
          [
            ['users', tr('Users')],
            ['activity', tr('Activity log')],
            ['emails', tr('Emails')],
          ] as const
        ).map(([value, label]) => (
          <button key={value} type="button" role="tab" aria-selected={tab === value} aria-pressed={tab === value} onClick={() => setTab(value)}>
            {label}
          </button>
        ))}
      </div>

      {/* Both stay mounted so each keeps its search, filters and page when you switch. */}
      <div hidden={tab !== 'users'}>
        <UsersTable now={now} selectedId={selectedId} onOpen={openUser} changed={changed} />
      </div>
      <div hidden={tab !== 'activity'}>
        <ActivityTable key={activity.key} now={now} initialSearch={activity.search} onOpenUser={openUser} />
      </div>

      {/* Stays mounted too, so a result shows up as a notification on any admin tab. */}
      <div hidden={tab !== 'emails'}>
        <EmailResults now={now} notify={notify} />
      </div>

      <UserPanel
        me={me}
        now={now}
        detail={detail}
        loading={detailLoading}
        open={selectedId !== null}
        onClose={closeUser}
        onBan={() => setConfirm('ban')}
        onUnban={() => setConfirm('unban')}
        onShowActivity={(email) => {
          setActivity((a) => ({ key: a.key + 1, search: email }))
          setTab('activity')
          closeUser()
        }}
      />

      {confirm && detail && <ConfirmDialog action={confirm} user={detail} onCancel={() => setConfirm(null)} onConfirm={applyAction} />}
    </div>
  )
}

/** Did our emails leave? New results pop up as notifications; nothing is emailed to staff. */
function EmailResults({ now, notify }: { now: Date; notify: AdminProps['notify'] }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof admin.emails>> | null>(null)
  const [error, setError] = useState('')
  const lastSeen = useRef<number | null>(null)

  const load = useCallback(async () => {
    try {
      const next = await admin.emails()
      setData(next)
      setError('')
      const newest = next.items[0]?.id ?? 0
      if (lastSeen.current !== null) {
        const message = resultsMessage(next.items.filter((e) => e.id > lastSeen.current!))
        if (message) notify(message.title, message.detail)
      }
      lastSeen.current = Math.max(newest, lastSeen.current ?? 0)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [notify])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
  }, [load])
  useLiveRefresh(load, 15_000)

  return (
    <section className="card glass email-results" aria-label={tr('Email results')}>
      {error && <div className="error-banner">{error}</div>}
      {data === null && !error && <Loading skeleton={<Bone width="60%" height={18} />} />}
      {data && (
        <>
          <p className="task-meta">
            {tr('Last 24 hours: {sent_24h} sent · {failed_24h} failed', { sent_24h: data.sent_24h, failed_24h: data.failed_24h })}
          </p>
          {data.items.length === 0 && <p className="empty">{tr('No emails yet.')}</p>}
          <ul className="row-list">
            {data.items.map((item) => (
              <li key={item.id}>
                <div className="flat-row">
                  <span className={`row-status ${item.ok ? 'done' : 'failed'}`}>{item.ok ? tr('Sent') : tr('Failed')}</span>
                  <span className="row-main">
                    <span className="person-name">{EMAIL_NAMES[item.kind] ?? item.kind}</span>
                    <span className="row-sub">
                      {item.recipient} · {timeAgo(item.created_at, now).toLowerCase()}
                      {item.error && ` · ${item.error}`}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

/** Is the every-minute reminder job (cron-job.org) still calling the server? */
function ServiceStatus({ lastRun, now }: { lastRun: string | null; now: Date }) {
  const running = Boolean(lastRun && now.getTime() - new Date(lastRun).getTime() < 3 * 60_000)
  return (
    <div className={`service-status ${running ? 'ok' : 'bad'}`} role="status">
      <span className="dot" aria-hidden="true" />
      {tr('Reminder service:')}{' '}{running ? 'running' : tr('not running')} {tr('· last check')}{' '}{timeAgo(lastRun, now).toLowerCase()}
      {!running && tr(' · check the cron-job.org job')}
    </div>
  )
}
