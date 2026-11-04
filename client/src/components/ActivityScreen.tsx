import { useCallback, useEffect, useRef, useState } from 'react'
import { workspaces as api, type ActivityItem, type Member } from '../api'
import { tr } from '../i18n'
import { Icon } from '../icons'
import { useLiveRefresh } from '../live'
import { memberName } from '../tableLogic'
import { addDays, startOfDay } from '../time'
import { useWorkspaceLive } from '../workspaceLive'
import { ActivityRows } from './Comments'
import { Loading, SkeletonRows } from './Loading'
import { SearchField } from './SearchField'
import { Sheet } from './Sheet'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

interface Filters {
  actor: string
  kind: string
  when: string
}

const NO_FILTERS: Filters = { actor: '', kind: '', when: '' }
/** Reading the history isn't being on any one page or table. */
const HERE = {}

function sinceFor(when: string) {
  const today = startOfDay(new Date())
  if (when === 'today') return today
  if (when === 'last7') return addDays(today, -7)
  if (when === 'last30') return addDays(today, -30)
  return undefined
}

/** A workspace's whole history: searchable, filterable, scrolling on its own, a page at a time. */
export function ActivityScreen({ workspaceId, userId, members, now, onOpen }: { workspaceId: number; userId: number; members: Member[]; now: Date; onOpen: (url: string) => void }) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<Filters>(NO_FILTERS)
  const [filtering, setFiltering] = useState(false)
  const [number, setNumber] = useState(1)
  const [data, setData] = useState<{ items: ActivityItem[]; number: number; pages: number } | null>(null)
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const latest = useRef(0)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim())
      setNumber(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  const load = useCallback(async () => {
    const request = ++latest.current
    try {
      const next = await api.activityPage(workspaceId, { number, q: search, actor: filters.actor, kind: filters.kind, since: sinceFor(filters.when) })
      if (request !== latest.current) return
      setData(next)
      setError('')
      if (next.number !== number) setNumber(next.number)
    } catch (err) {
      if (request === latest.current) setError(errorMessage(err))
    }
  }, [workspaceId, number, search, filters])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
  }, [load])
  useLiveRefresh(load, 30_000)

  // New lines appear as they happen. A burst of edits only looks once.
  const soon = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useWorkspaceLive(
    workspaceId,
    userId,
    HERE,
    (name) => {
      if (name !== 'activity') return
      clearTimeout(soon.current)
      soon.current = setTimeout(() => void load(), 400)
    },
    () => undefined,
  )
  useEffect(() => () => clearTimeout(soon.current), [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [number])

  const change = (next: Filters) => {
    setFilters(next)
    setNumber(1)
  }
  const filterCount = Object.values(filters).filter(Boolean).length
  const narrowed = filterCount > 0 || Boolean(search)

  return (
    <section className="card glass panel activity-panel" aria-label={tr('Activity')}>
      <div className="panel-top">
        <SearchField label={tr('Search activity')} placeholder={tr('Search')} value={query} onChange={setQuery} />
        <button type="button" className={`text-btn icon-only table-filter-btn${filterCount ? ' is-on' : ''}`} aria-label={filterCount ? tr('Filter activity, {filterCount} on', { filterCount }) : tr('Filter activity')} onClick={() => setFiltering(true)}>
          <Icon name="filter" />
          {filterCount > 0 && <span className="count-pill">{filterCount}</span>}
        </button>
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" className="text-btn" onClick={() => void load()}>
            {tr('Retry')}
          </button>
        </div>
      )}

      <div ref={scrollRef} className="panel-scroll">
        {!data ? (
          <Loading active={!error} skeleton={<SkeletonRows count={6} />} onRetry={() => void load()} />
        ) : data.items.length === 0 ? (
          <p className="empty">{narrowed ? tr('Nothing matches these filters.') : tr('Nothing has happened here yet.')}</p>
        ) : (
          <ActivityRows items={data.items} now={now} onOpen={onOpen} />
        )}
      </div>

      {data && data.pages > 1 && (
        <nav className="pager-pages tasks-pager" aria-label={tr('Pages of activity')}>
          <button type="button" className="page-btn" aria-label={tr('Previous page')} disabled={number <= 1} onClick={() => setNumber(number - 1)}>
            <Icon name="back" />
          </button>
          <span className="page-status" aria-live="polite">
            <strong>{data.number}</strong> {tr('of {pages}', { pages: data.pages })}
          </span>
          <button type="button" className="page-btn" aria-label={tr('Next page')} disabled={number >= data.pages} onClick={() => setNumber(number + 1)}>
            <Icon name="chevron" />
          </button>
        </nav>
      )}

      {filtering && (
        <Sheet
          title={tr('Filter activity')}
          onClose={() => setFiltering(false)}
          foot={
            <>
              <button type="button" className="text-btn" disabled={!filterCount} onClick={() => change(NO_FILTERS)}>
                {tr('Clear all')}
              </button>
              <button type="button" className="primary-btn" onClick={() => setFiltering(false)}>
                {tr('Done')}
              </button>
            </>
          }
        >
          <label className="field-group">
            <span className="label">{tr('Who')}</span>
            <select className="field" value={filters.actor} onChange={(e) => change({ ...filters, actor: e.target.value })}>
              <option value="">{tr('Everyone')}</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {memberName(member)}
                </option>
              ))}
            </select>
          </label>
          <label className="field-group">
            <span className="label">{tr('What')}</span>
            <select className="field" value={filters.kind} onChange={(e) => change({ ...filters, kind: e.target.value })}>
              <option value="">{tr('All')}</option>
              <option value="pages">{tr('Pages')}</option>
              <option value="tables">{tr('Tables')}</option>
              <option value="rows">{tr('Rows')}</option>
              <option value="comments">{tr('Comments')}</option>
              <option value="people">{tr('People')}</option>
            </select>
          </label>
          <label className="field-group">
            <span className="label">{tr('When')}</span>
            <select className="field" value={filters.when} onChange={(e) => change({ ...filters, when: e.target.value })}>
              <option value="">{tr('Any time')}</option>
              <option value="today">{tr('Today')}</option>
              <option value="last7">{tr('Last 7 days')}</option>
              <option value="last30">{tr('Last 30 days')}</option>
            </select>
          </label>
        </Sheet>
      )}
    </section>
  )
}
