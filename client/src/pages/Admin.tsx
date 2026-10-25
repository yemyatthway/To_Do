import { useCallback, useEffect, useState } from 'react'
import { useLiveRefresh } from '../live'
import { admin, type AdminStats, type AdminUser, type AdminUserDetail, type User } from '../api'
import { ActivityTable } from './admin/ActivityTable'
import { errorMessage } from './admin/useServerTable'
import { ConfirmDialog, UserPanel } from './admin/UserPanel'
import { UsersTable } from './admin/UsersTable'

type Tab = 'users' | 'activity'

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
        notify("Couldn't load that account", errorMessage(err))
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
      notify(action === 'ban' ? 'Account banned' : 'Account restored', updated.email)
    } catch (err) {
      notify(action === 'ban' ? "Couldn't ban the account" : "Couldn't unban the account", errorMessage(err))
    }
  }

  const statCards: { label: string; value: number | undefined; tone?: string }[] = [
    { label: 'Total users', value: stats?.total_users },
    { label: 'Active', value: stats?.active_users, tone: 'ok' },
    { label: 'Banned', value: stats?.banned_users, tone: 'danger' },
    { label: 'Deleted (restorable)', value: stats?.deleted_users },
    { label: 'New this week', value: stats?.new_users_7d },
    { label: 'Logins (24 h)', value: stats?.logins_24h },
  ]

  return (
    <div className="admin-page">
      <section className="admin-stats" aria-label="Overview">
        {statCards.map((card) => (
          <div key={card.label} className={`stat-card neu${card.tone ? ` stat-${card.tone}` : ''}`}>
            <span className="stat-value">{card.value ?? '–'}</span>
            <span className="stat-label">{card.label}</span>
          </div>
        ))}
      </section>
      {statsError && <div className="error-banner">{statsError}</div>}

      <div className="segmented admin-tabs" role="tablist" aria-label="Admin sections">
        {(
          [
            ['users', 'Users'],
            ['activity', 'Activity log'],
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
