import { admin } from '../../api'
import { Icon } from '../../icons'
import { formatDateTime, timeAgo } from '../../user'
import { EVENT_ICON, EVENT_LABEL } from './labels'
import { FilterSelect, Pager, SearchBox, SortHeader, TableError } from './table'
import { useLiveRefresh } from '../../live'
import { useServerTable } from './useServerTable'

const KIND_OPTIONS = [
  ['', 'All events'],
  ['signup', 'Created account'],
  ['login', 'Logged in'],
  ['logout', 'Logged out'],
  ['deleted', 'Deleted account'],
  ['restored', 'Restored account'],
] as const

const SINCE_OPTIONS = [
  ['', 'Any time'],
  ['24h', 'Last 24 hours'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
] as const

/** The sign-up / login / logout log for every account. */
export function ActivityTable({ now, initialSearch, onOpenUser }: { now: Date; initialSearch?: string; onOpenUser: (id: number) => void }) {
  const table = useServerTable(admin.events, { ordering: '-time', filters: { kind: '', since: '' }, search: initialSearch })
  useLiveRefresh(table.refreshSilently, 30_000) // new sign-ups, logins and bans appear by themselves
  const filtered = Boolean(table.query || table.filters.kind || table.filters.since)

  return (
    <section className="card glass admin-table-card" aria-labelledby="activity-h">
      <div className="admin-toolbar">
        <h2 id="activity-h">Activity log</h2>
        <SearchBox label="Search email or IP" value={table.search} onChange={table.setSearch} />
        <FilterSelect label="Event" value={table.filters.kind} options={KIND_OPTIONS} onChange={(v) => table.setFilter('kind', v)} />
        <FilterSelect label="Period" value={table.filters.since} options={SINCE_OPTIONS} onChange={(v) => table.setFilter('since', v)} />
      </div>

      {table.error && <TableError message={table.error} onRetry={table.reload} />}

      <div className="table-wrap" aria-busy={table.loading}>
        <table className={`data-table${table.loading && !table.firstLoad ? ' is-loading' : ''}`}>
          <thead>
            <tr>
              <SortHeader table={table} field="time" descFirst>
                Time
              </SortHeader>
              <SortHeader table={table} field="kind">
                Event
              </SortHeader>
              <SortHeader table={table} field="email">
                Account
              </SortHeader>
              <th scope="col">IP address</th>
            </tr>
          </thead>
          <tbody>
            {table.rows.map((event) => (
              <tr key={event.id}>
                <td className="cell-time">
                  <span className="cell-strong">{formatDateTime(event.created_at)}</span>
                  <span className="task-meta">{timeAgo(event.created_at, now)}</span>
                </td>
                <td data-label="Event">
                  <span className={`badge badge-event badge-${event.kind}`}>
                    <Icon name={EVENT_ICON[event.kind]} />
                    {EVENT_LABEL[event.kind]}
                  </span>
                </td>
                <td data-label="Account" className="cell-ellipsis">
                  {event.user ? (
                    <button type="button" className="link-btn" onClick={() => onOpenUser(event.user!)}>
                      {event.email}
                    </button>
                  ) : (
                    <span title="This account was deleted">
                      {event.email} <span className="task-meta">(deleted)</span>
                    </span>
                  )}
                </td>
                <td data-label="IP address" className="mono">
                  {event.ip_address ?? '–'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {table.firstLoad && <p className="empty">Loading…</p>}
        {!table.loading && !table.error && table.rows.length === 0 && <p className="empty">{filtered ? 'No activity matches these filters.' : 'No activity yet.'}</p>}
      </div>

      <Pager table={table} noun="events" />
    </section>
  )
}
