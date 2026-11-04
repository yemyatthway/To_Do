import { Loading, SkeletonRows } from '../../components/Loading'
import { admin } from '../../api'
import { Icon } from '../../icons'
import { formatDateTime, timeAgo } from '../../user'
import { EVENT_ICON, EVENT_LABEL } from './labels'
import { FilterSelect, Pager, SearchBox, SortHeader, TableError } from './table'
import { useLiveRefresh } from '../../live'
import { useServerTable } from './useServerTable'
import { tr } from '../../i18n'

const KIND_OPTIONS = [
  ['', tr('All events')],
  ['signup', tr('Created account')],
  ['login', tr('Logged in')],
  ['logout', tr('Logged out')],
  ['password', tr('Reset password')],
  ['deleted', tr('Deleted account')],
  ['restored', tr('Restored account')],
] as const

const SINCE_OPTIONS = [
  ['', tr('Any time')],
  ['24h', tr('Last 24 hours')],
  ['7d', tr('Last 7 days')],
  ['30d', tr('Last 30 days')],
] as const

/** The sign-up / login / logout log for every account. */
export function ActivityTable({ now, initialSearch, onOpenUser }: { now: Date; initialSearch?: string; onOpenUser: (id: number) => void }) {
  const table = useServerTable(admin.events, { ordering: '-time', filters: { kind: '', since: '' }, search: initialSearch })
  useLiveRefresh(table.refreshSilently, 30_000) // new sign-ups, logins and bans appear by themselves
  const filtered = Boolean(table.query || table.filters.kind || table.filters.since)

  return (
    <section className="card glass admin-table-card" aria-labelledby="activity-h">
      <div className="admin-toolbar">
        <h2 id="activity-h">{tr('Activity log')}</h2>
        <SearchBox label={tr('Search email or IP')} value={table.search} onChange={table.setSearch} />
        <FilterSelect label={tr('Event')} value={table.filters.kind} options={KIND_OPTIONS} onChange={(v) => table.setFilter('kind', v)} />
        <FilterSelect label={tr('Period')} value={table.filters.since} options={SINCE_OPTIONS} onChange={(v) => table.setFilter('since', v)} />
      </div>

      {table.error && <TableError message={table.error} onRetry={table.reload} />}

      <div className="table-wrap" aria-busy={table.loading}>
        <table className={`data-table${table.loading && !table.firstLoad ? ' is-loading' : ''}`}>
          <thead>
            <tr>
              <SortHeader table={table} field="time" descFirst>
                {tr('Time')}
              </SortHeader>
              <SortHeader table={table} field="kind">
                {tr('Event')}
              </SortHeader>
              <SortHeader table={table} field="email">
                {tr('Account')}
              </SortHeader>
              <th scope="col">{tr('IP address')}</th>
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
                    <span title={tr('This account was deleted')}>
                      {event.email} <span className="task-meta">{tr('(deleted)')}</span>
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
        {table.firstLoad && <Loading active={!table.error} skeleton={<SkeletonRows count={5} avatar />} onRetry={table.reload} />}
        {!table.loading && !table.error && table.rows.length === 0 && <p className="empty">{filtered ? tr('No activity matches these filters.') : tr('No activity yet.')}</p>}
      </div>

      <Pager table={table} noun="events" />
    </section>
  )
}
