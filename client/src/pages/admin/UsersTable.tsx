import { useEffect } from 'react'
import { admin, type AdminUser } from '../../api'
import { formatDateTime, initials, timeAgo } from '../../user'
import { STATUS_LABEL } from './labels'
import { FilterSelect, Pager, SearchBox, SortHeader, TableError } from './table'
import { useLiveRefresh } from '../../live'
import { useServerTable } from './useServerTable'

const STATUS_OPTIONS = [
  ['', 'All statuses'],
  ['active', 'Active'],
  ['banned', 'Banned'],
  ['inactive', 'Inactive'],
  ['deleted', 'Deleted'],
] as const

const VERIFIED_OPTIONS = [
  ['', 'Any email'],
  ['yes', 'Verified'],
  ['no', 'Not verified'],
] as const

interface UsersTableProps {
  now: Date
  selectedId: number | null
  onOpen: (id: number) => void
  /** A user changed elsewhere (ban/unban in the account drawer): update that row. */
  changed: AdminUser | null
}

export function UsersTable({ now, selectedId, onOpen, changed }: UsersTableProps) {
  const table = useServerTable(admin.users, { ordering: '-joined', filters: { status: '', verified: '' } })
  useLiveRefresh(table.refreshSilently, 30_000) // new sign-ups, logins and bans appear by themselves
  const { patchRows } = table

  useEffect(() => {
    if (changed) patchRows((rows) => rows.map((u) => (u.id === changed.id ? { ...u, ...changed } : u)))
  }, [changed, patchRows])

  const filtered = Boolean(table.query || table.filters.status || table.filters.verified)

  return (
    <section className="card glass admin-table-card" aria-labelledby="users-h">
      <div className="admin-toolbar">
        <h2 id="users-h">Users</h2>
        <SearchBox label="Search name or email" value={table.search} onChange={table.setSearch} />
        <FilterSelect label="Status" value={table.filters.status} options={STATUS_OPTIONS} onChange={(v) => table.setFilter('status', v)} />
        <FilterSelect label="Email" value={table.filters.verified} options={VERIFIED_OPTIONS} onChange={(v) => table.setFilter('verified', v)} />
      </div>

      {table.error && <TableError message={table.error} onRetry={table.reload} />}

      <div className="table-wrap" aria-busy={table.loading}>
        <table className={`data-table${table.loading && !table.firstLoad ? ' is-loading' : ''}`}>
          <thead>
            <tr>
              <SortHeader table={table} field="name">
                User
              </SortHeader>
              <th scope="col">Status</th>
              <th scope="col">Email</th>
              <SortHeader table={table} field="tasks" descFirst className="num">
                Tasks
              </SortHeader>
              <SortHeader table={table} field="joined" descFirst>
                Joined
              </SortHeader>
              <SortHeader table={table} field="last_login" descFirst>
                Last login
              </SortHeader>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((u) => (
              <tr
                key={u.id}
                className={`clickable${selectedId === u.id ? ' selected' : ''}`}
                tabIndex={0}
                aria-label={`Open ${u.full_name || u.email}`}
                onClick={() => onOpen(u.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpen(u.id)
                  }
                }}
              >
                <td className="cell-user">
                  <span className={`avatar${u.status === 'banned' ? ' avatar-muted' : ''}`} aria-hidden="true">
                    {initials(u)}
                  </span>
                  <span className="cell-user-text">
                    <span className="cell-strong">
                      {u.full_name || 'No name'}
                      {u.is_staff && <span className="badge badge-staff">Admin</span>}
                    </span>
                    <span className="task-meta">
                      @{u.username} · {u.email}
                    </span>
                  </span>
                </td>
                <td data-label="Status">
                  <span className={`badge badge-${u.status}`}>{STATUS_LABEL[u.status]}</span>
                </td>
                <td data-label="Email">
                  <span className={`badge ${u.email_verified ? 'badge-active' : 'badge-inactive'}`}>{u.email_verified ? 'Verified' : 'Not verified'}</span>
                </td>
                <td data-label="Tasks" className="num">
                  {u.task_count}
                </td>
                <td data-label="Joined" title={formatDateTime(u.date_joined)}>
                  {new Date(u.date_joined).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                </td>
                <td data-label="Last login" title={u.last_login_at ? formatDateTime(u.last_login_at) : undefined}>
                  {timeAgo(u.last_login_at, now)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {table.firstLoad && <p className="empty">Loading…</p>}
        {!table.loading && !table.error && table.rows.length === 0 && <p className="empty">{filtered ? 'No users match these filters.' : 'No users yet.'}</p>}
      </div>

      <Pager table={table} noun="users" />
    </section>
  )
}
