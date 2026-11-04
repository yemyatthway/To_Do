import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Task, type TaskPage } from '../api'
import { Loading, SkeletonRows } from '../components/Loading'
import { SearchField } from '../components/SearchField'
import { Sheet } from '../components/Sheet'
import { TaskRow } from '../components/TaskRow'
import { tr } from '../i18n'
import { Icon } from '../icons'
import { useLiveRefresh } from '../live'
import { enter, useGsap } from '../motion'
import { activeFilters, groupByDay, NO_FILTERS, whenBounds, type TaskFilters, type TaskList } from '../taskGroups'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

interface TasksProps {
  now: Date
  /** Being deleted right now (the Undo moment). */
  hidden: ReadonlySet<number>
  /** Goes up whenever every change on this device has been saved. */
  changes: number
  list: TaskList
  onList: (list: TaskList) => void
  onToggle: (task: Task) => void
  onMoveToToday: (tasks: Task[]) => void
  onOpen: (task: Task) => void
  onDelete: (task: Task) => void
}

/** Every task: to do, overdue and done kept apart, each under its own dates, a page at a time. */
export function Tasks({ now, hidden, changes, list, onList, onToggle, onMoveToToday, onOpen, onDelete }: TasksProps) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<TaskFilters>(NO_FILTERS)
  const [filtering, setFiltering] = useState(false)
  const [pageNumber, setPageNumber] = useState(1)
  const [data, setData] = useState<TaskPage | null>(null)
  const [error, setError] = useState('')
  // Finished or moved just now: gone from this list before the server has answered.
  const [leaving, setLeaving] = useState<ReadonlySet<number>>(new Set())
  const panelRef = useRef<HTMLElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const latestRequest = useRef(0)

  // Wait for a pause in typing before searching.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim())
      setPageNumber(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  const load = useCallback(async () => {
    const request = ++latestRequest.current
    const asOf = new Date()
    const { from, to } = whenBounds(filters.when, asOf)
    try {
      const next = await api.browseTasks({ list, page: pageNumber, now: asOf, q: search, category: filters.category, priority: filters.priority, from, to })
      if (request !== latestRequest.current) return // something newer was asked for meanwhile
      setData(next)
      setLeaving(new Set())
      setError('')
      if (next.page !== pageNumber) setPageNumber(next.page)
    } catch (err) {
      if (request === latestRequest.current) setError(errorMessage(err))
    }
  }, [list, pageNumber, search, filters])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
  }, [load, changes])
  useLiveRefresh(load, 30_000)

  // A new list or page starts at its top, with its rows gliding in.
  const shown = `${list}|${pageNumber}`
  const lastShown = useRef(shown)
  useGsap(
    panelRef,
    () => {
      if (lastShown.current === shown || !data) return
      lastShown.current = shown
      scrollRef.current?.scrollTo({ top: 0 })
      enter('.tasks-day, .task-wrap', { y: 10, duration: 0.35, stagger: 0.02 })
    },
    [shown, data],
  )

  const leave = (task: Task) => setLeaving((set) => new Set(set).add(task.id))
  const tasks = data?.results.filter((task) => !hidden.has(task.id) && !leaving.has(task.id)) ?? []
  const groups = groupByDay(tasks, now)
  const filterCount = activeFilters(filters)
  const narrowed = Boolean(search) || filterCount > 0
  const tabs: { id: TaskList; label: string }[] = [
    { id: 'todo', label: tr('To do') },
    { id: 'overdue', label: tr('Overdue') },
    { id: 'done', label: tr('Done') },
  ]
  const emptyText = narrowed ? tr('No tasks match.') : list === 'overdue' ? tr('Nothing overdue. You\'re all caught up.') : list === 'done' ? tr('Nothing finished yet.') : tr('Nothing to do yet. Tap + to add a task.')

  const change = (next: TaskFilters) => {
    setFilters(next)
    setPageNumber(1)
  }

  return (
    <section ref={panelRef} className="card glass panel tasks-panel" aria-label={tr('Tasks')}>
      <div className="panel-top">
        <SearchField label={tr('Search tasks')} placeholder={tr('Search')} value={query} onChange={setQuery} />
        <button type="button" className={`text-btn icon-only table-filter-btn${filterCount ? ' is-on' : ''}`} aria-label={filterCount ? tr('Filter tasks, {filterCount} on', { filterCount }) : tr('Filter tasks')} onClick={() => setFiltering(true)}>
          <Icon name="filter" />
          {filterCount > 0 && <span className="count-pill">{filterCount}</span>}
        </button>
      </div>

      <div className="chips panel-tabs" role="group" aria-label={tr('Show')}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`chip${tab.id === 'overdue' && data?.counts.overdue ? ' chip-late' : ''}`}
            aria-pressed={list === tab.id}
            onClick={() => {
              onList(tab.id)
              setPageNumber(1)
            }}
          >
            {tab.label}
            {data ? ` ${data.counts[tab.id]}` : ''}
          </button>
        ))}
      </div>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button type="button" className="text-btn" onClick={() => void load()}>
            {tr('Retry')}
          </button>
        </div>
      )}

      <div ref={scrollRef} className="list-scroll tasks-scroll">
        {!data ? (
          <Loading active={!error} skeleton={<SkeletonRows count={6} />} onRetry={() => void load()} />
        ) : groups.length === 0 ? (
          <div className="empty-state">
            <p className="empty">{emptyText}</p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.key} className="tasks-group" aria-label={group.label}>
              <h3 className="section-label tasks-day">{group.label}</h3>
              <ul className="task-list">
                {group.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    now={now}
                    fresh={false}
                    timeOnly
                    onToggle={() => {
                      leave(task)
                      onToggle(task)
                    }}
                    onOpen={() => onOpen(task)}
                    onDelete={() => onDelete(task)}
                    action={
                      list === 'overdue' ? (
                        <button
                          type="button"
                          className="move-today"
                          aria-label={tr('Move {title} to today', { title: task.title })}
                          onClick={() => {
                            leave(task)
                            onMoveToToday([task])
                          }}
                        >
                          {tr('Today')}
                          <Icon name="arrow" />
                        </button>
                      ) : undefined
                    }
                  />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>

      {data && data.pages > 1 && (
        <nav className="pager-pages tasks-pager" aria-label={tr('Pages of tasks')}>
          <button type="button" className="page-btn" aria-label={tr('Previous page')} disabled={pageNumber <= 1} onClick={() => setPageNumber(pageNumber - 1)}>
            <Icon name="back" />
          </button>
          <span className="page-status" aria-live="polite">
            <strong>{data.page}</strong> {tr('of {pages}', { pages: data.pages })}
          </span>
          <button type="button" className="page-btn" aria-label={tr('Next page')} disabled={pageNumber >= data.pages} onClick={() => setPageNumber(pageNumber + 1)}>
            <Icon name="chevron" />
          </button>
        </nav>
      )}

      {filtering && (
        <Sheet
          title={tr('Filter tasks')}
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
            <span className="label">{tr('Category')}</span>
            <select className="field" value={filters.category} onChange={(e) => change({ ...filters, category: e.target.value })}>
              <option value="">{tr('All')}</option>
              <option value="work">{tr('Work')}</option>
              <option value="personal">{tr('Personal')}</option>
              <option value="health">{tr('Health')}</option>
            </select>
          </label>
          <label className="field-group">
            <span className="label">{tr('Priority')}</span>
            <select className="field" value={filters.priority} onChange={(e) => change({ ...filters, priority: e.target.value })}>
              <option value="">{tr('All')}</option>
              <option value="high">{tr('High')}</option>
              <option value="medium">{tr('Medium')}</option>
              <option value="low">{tr('Low')}</option>
            </select>
          </label>
          <label className="field-group">
            <span className="label">{tr('Date')}</span>
            <select className="field" value={filters.when} onChange={(e) => change({ ...filters, when: e.target.value })}>
              <option value="">{tr('Any time')}</option>
              <option value="today">{tr('Today')}</option>
              <option value="next7">{tr('Next 7 days')}</option>
              <option value="last7">{tr('Last 7 days')}</option>
            </select>
          </label>
        </Sheet>
      )}
    </section>
  )
}
