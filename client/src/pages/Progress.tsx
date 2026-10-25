import type { Category, Task } from '../api'
import { Segments } from '../components/Segments'
import { addDays, dueDate, formatTime, sameDay, startOfDay, startOfWeek } from '../time'

const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'work', label: 'Work' },
  { value: 'personal', label: 'Personal' },
  { value: 'health', label: 'Health' },
]

const pct = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0)

export function Progress({ tasks, now }: { tasks: Task[]; now: Date }) {
  const weekStart = startOfWeek(now)
  const weekEnd = addDays(weekStart, 7)
  const timed = tasks.filter((t) => t.due_at)
  const inWeek = timed.filter((t) => {
    const due = dueDate(t)!
    return due >= weekStart && due < weekEnd
  })

  const today = timed.filter((t) => sameDay(dueDate(t)!, now))
  const overdue = timed.filter((t) => !t.done && dueDate(t)! < startOfDay(now)).length
  const todayDone = today.filter((t) => t.done)
  const next = today
    .filter((t) => !t.done && dueDate(t)! >= now)
    .sort((a, b) => dueDate(a)!.getTime() - dueDate(b)!.getTime())[0]

  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart, i)
    const list = inWeek.filter((t) => sameDay(dueDate(t)!, date))
    return { date, total: list.length, done: list.filter((t) => t.done).length }
  })
  const weekDone = inWeek.filter((t) => t.done).length
  const rangeLabel = `${weekStart.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} to ${addDays(weekEnd, -1).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`

  return (
    <div className="progress-page">
      <section className="card neu today-card" aria-labelledby="today-h">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <h2 id="today-h" className="label">Today</h2>
            <span className="big-number">
              {todayDone.length}
              <small> / {today.length} done</small>
            </span>
          </div>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--accT)' }}>{pct(todayDone.length, today.length)}%</span>
        </div>
        <div
          className="today-track neu-in"
          role="progressbar"
          aria-label="Tasks done today"
          aria-valuemin={0}
          aria-valuemax={today.length}
          aria-valuenow={todayDone.length}
        >
          <Segments done={todayDone.length} total={today.length} />
        </div>
        <span className="list-sub">
          {today.length === 0
            ? 'Nothing scheduled today.'
            : next
              ? `Next: ${next.title} at ${formatTime(dueDate(next)!)}`
              : todayDone.length === today.length
                ? 'Everything done today.'
                : 'No more tasks coming up today.'}
        </span>
        {overdue > 0 && (
          <span className="list-sub" style={{ color: 'var(--dIcon)', fontWeight: 600 }}>
            {overdue} overdue from earlier days, see the top of Today.
          </span>
        )}
      </section>

      <section className="card glass" aria-labelledby="week-h">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <h2 id="week-h">This week</h2>
          <span className="list-sub">
            <strong style={{ color: 'var(--text)' }}>
              {weekDone} of {inWeek.length}
            </strong>{' '}
            done · {pct(weekDone, inWeek.length)}%
          </span>
        </div>
        <span className="list-sub" style={{ marginTop: -8 }}>
          {rangeLabel}
        </span>
        <div className="week">
          {days.map((d) => {
            const isToday = sameDay(d.date, startOfDay(now))
            const label = d.date.toLocaleDateString(undefined, { weekday: 'narrow' })
            return (
              <div
                key={d.date.toISOString()}
                className={`week-day${isToday ? ' today' : ''}`}
                aria-label={`${d.date.toLocaleDateString(undefined, { weekday: 'long' })}: ${d.done} of ${d.total} done`}
              >
                <span className="count" aria-hidden="true">
                  {d.done}/{d.total}
                </span>
                <div className="week-col" aria-hidden="true">
                  <span style={{ height: `${pct(d.done, d.total)}%` }} />
                </div>
                <span aria-hidden="true">{label}</span>
              </div>
            )
          })}
        </div>
      </section>

      <section className="card glass" aria-labelledby="cat-h">
        <h2 id="cat-h">By category this week</h2>
        {CATEGORIES.map((c) => {
          const list = inWeek.filter((t) => t.category === c.value)
          const done = list.filter((t) => t.done).length
          return (
            <div key={c.value} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 600 }}>
                <span>{c.label}</span>
                <span style={{ color: 'var(--sub)' }}>
                  {done} of {list.length}
                </span>
              </div>
              <div className="bar" role="progressbar" aria-label={`${c.label} tasks done`} aria-valuemin={0} aria-valuemax={list.length} aria-valuenow={done}>
                <span style={{ width: `${pct(done, list.length)}%`, background: `var(--${c.value})` }} />
              </div>
            </div>
          )
        })}
      </section>

      <section className="card glass" aria-labelledby="prio-h">
        <h2 id="prio-h">By priority this week</h2>
        {PRIORITIES.map((p) => {
          const list = inWeek.filter((t) => t.priority === p.value)
          const done = list.filter((t) => t.done).length
          return (
            <div key={p.value} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 600 }}>
                <span>{p.label}</span>
                <span style={{ color: 'var(--sub)' }}>
                  {done} of {list.length}
                </span>
              </div>
              <div className="bar" role="progressbar" aria-label={`${p.label} priority tasks done`} aria-valuemin={0} aria-valuemax={list.length} aria-valuenow={done}>
                <span style={{ width: `${pct(done, list.length)}%`, background: p.color }} />
              </div>
            </div>
          )
        })}
      </section>
    </div>
  )
}

const PRIORITIES = [
  { value: 'high', label: 'High', color: 'var(--danger)' },
  { value: 'medium', label: 'Medium', color: 'var(--acc)' },
  { value: 'low', label: 'Low', color: 'var(--sub)' },
] as const
