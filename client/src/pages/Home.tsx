import { useRef, useState } from 'react'
import type { Task } from '../api'
import { Clock } from '../components/Clock'
import { DayPicker } from '../components/DayPicker'
import { Segments } from '../components/Segments'
import { TaskRow } from '../components/TaskRow'
import { Icon } from '../icons'
import { enter, useGsap } from '../motion'
import { addDays, clockWindow, dueDate, formatHour, formatShortDay, formatTime, hourSlot, sameDay, startOfDay } from '../time'

const HOUR = 3600_000

interface HomeProps {
  tasks: Task[]
  now: Date
  day: Date
  freshId: number | null
  onDayChange: (day: Date) => void
  onToggle: (task: Task) => void
  /** Overdue tasks to today (one or all). */
  onMoveToToday: (tasks: Task[]) => void
  onOpen: (task: Task) => void
  onDelete: (task: Task) => void
  onCreateAt: (day: Date, time: string) => void
  onAddOnDay: (day: Date) => void
  onShowProgress: () => void
}

const time = (task: Task) => dueDate(task)!.getTime()
// Priority decides the order whenever time doesn't: same time slot, or Anytime tasks.
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 } as const
const byPriority = (a: Task, b: Task) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
const byDue = (a: Task, b: Task) => time(a) - time(b) || byPriority(a, b)

function dayLabel(date: Date, now: Date) {
  if (sameDay(date, now)) return 'today'
  if (sameDay(date, addDays(now, 1))) return 'tomorrow'
  return formatShortDay(date)
}

export function Home({ tasks, now, day, freshId, onDayChange, onToggle, onMoveToToday, onOpen, onDelete, onCreateAt, onAddOnDay, onShowProgress }: HomeProps) {
  const [selectedHour, setSelectedHour] = useState<number | null>(null)
  const listRef = useRef<HTMLElement>(null)

  // Rows cascade in when the list changes meaning (another day or hour). Not on first show:
  // the whole screen is already gliding in then, and doubling up looks jumpy.
  const shownKey = useRef(`${selectedHour}|${day.getTime()}`)
  useGsap(listRef, () => {
    const key = `${selectedHour}|${day.getTime()}`
    if (key === shownKey.current) return
    shownKey.current = key
    enter('.task-wrap, .list-head, .day-progress, .empty-state', { y: 12, duration: 0.45, stagger: 0.04 })
  }, [selectedHour, day])

  const isToday = sameDay(day, now)
  const timedAll = tasks.filter((t) => t.due_at).sort(byDue)
  const timed = timedAll.filter((t) => sameDay(dueDate(t)!, day))
  const anytime = tasks.filter((t) => !t.due_at).sort(byPriority)
  // Unfinished tasks from earlier days, oldest first; shown at the top of Today.
  const todayStart = startOfDay(now).getTime()
  const overdue = tasks.filter((t) => t.due_at && !t.done && time(t) < todayStart).sort(byDue)
  const doneCount = timed.filter((t) => t.done).length

  // Which 12 hours the face shows is worked out here, so there's no AM/PM switch.
  const firstHour = timed.length ? dueDate(timed[0])!.getHours() : null
  const face = clockWindow(day, now, firstHour)
  const onClock = timedAll.filter((t) => time(t) >= face.start.getTime() && time(t) < face.end.getTime())

  function changeDay(next: Date) {
    onDayChange(next)
    setSelectedHour(null)
  }

  function longPress(hour: number) {
    const slot = hourSlot(face.start, hour)
    onCreateAt(startOfDay(slot), `${String(slot.getHours()).padStart(2, '0')}:00`)
  }

  const row = (task: Task) => (
    <TaskRow
      key={task.id}
      task={task}
      now={now}
      fresh={task.id === freshId}
      onToggle={() => onToggle(task)}
      onOpen={() => onOpen(task)}
      onDelete={() => onDelete(task)}
    />
  )

  const endsTomorrow = !sameDay(face.start, new Date(face.end.getTime() - 1))
  const windowLabel = `${isToday ? 'Next 12 hours' : 'Showing'} · ${formatHour(face.start)} to ${formatHour(face.end)}${endsTomorrow ? ' tomorrow' : ''}`

  let list: React.ReactNode
  if (selectedHour !== null) {
    const slot = hourSlot(face.start, selectedHour)
    const slotEnd = slot.getTime() + HOUR
    const inHour = onClock.filter((t) => time(t) >= slot.getTime() && time(t) < slotEnd)
    const middle = slot.getTime() + HOUR / 2
    const best = Math.min(...onClock.map((t) => Math.abs(time(t) - middle)))
    const nearest = inHour.length ? [] : onClock.filter((t) => Math.abs(time(t) - middle) === best)
    const after = onClock.find((t) => time(t) >= slotEnd && !t.done)
    const range = `${formatTime(slot)} to ${formatTime(new Date(slotEnd - 60_000))}`
    const otherDay = !sameDay(slot, day) ? ` · ${dayLabel(slot, now)}` : ''
    list = (
      <>
        <div className="list-head">
          <div>
            <h2 className="list-title">{inHour.length ? `Around ${selectedHour} o'clock` : `Nothing at ${selectedHour}`}</h2>
            <span className="list-sub">
              {inHour.length
                ? `${inHour.length} ${inHour.length === 1 ? 'task' : 'tasks'} · ${range}${otherDay}`
                : nearest.length
                  ? `Closest tasks instead${otherDay}`
                  : 'Nothing on the clock right now'}
            </span>
          </div>
          <button className="text-btn" onClick={() => setSelectedHour(null)}>
            Show all
          </button>
        </div>
        <div className="list-scroll">
          <ul className="task-list">{(inHour.length ? inHour : nearest).map(row)}</ul>
          {inHour.length > 0 && after && (
            <p className="next-hint">
              <Icon name="arrow" />
              <span>
                Next after this hour: <strong>{after.title}, {formatTime(dueDate(after)!)}</strong>
              </span>
            </p>
          )}
        </div>
      </>
    )
  } else {
    const upcoming = timed.filter((t) => !t.done)
    const openAnytime = anytime.filter((t) => !t.done)
    const done = [...timed.filter((t) => t.done), ...anytime.filter((t) => t.done)]
    list = (
      <>
        <button
          className="day-progress"
          data-tour="day-progress"
          onClick={onShowProgress}
          aria-label={`${doneCount} of ${timed.length} tasks done. Open progress`}
        >
          <span className="day-progress-head">
            <span className="list-title">{isToday ? 'Today' : formatShortDay(day)}</span>
            <span className="list-sub">
              {timed.length ? (
                <>
                  <strong style={{ color: 'var(--text)' }}>
                    {doneCount} of {timed.length}
                  </strong>{' '}
                  done
                </>
              ) : (
                'No timed tasks'
              )}
            </span>
          </span>
          <Segments done={doneCount} total={timed.length} />
        </button>
        {/* The heading stays put; the tasks scroll inside the panel. */}
        <div className="list-scroll">
          {upcoming.length + openAnytime.length + done.length + (isToday ? overdue.length : 0) === 0 && (
            <div className="empty-state">
              <p className="empty-title">{isToday ? 'Nothing planned yet' : `Nothing planned for ${formatShortDay(day)}`}</p>
              <p className="empty">Press and hold an hour on the clock, or tap + to add your first task.</p>
            </div>
          )}
          {isToday && overdue.length > 0 && (
            <section className="overdue" aria-labelledby="overdue-h">
              <div className="overdue-head">
                <h3 id="overdue-h" className="section-label">
                  <Icon name="clock" />
                  Overdue · {overdue.length}
                </h3>
                {overdue.length > 1 && (
                  <button type="button" className="text-btn" onClick={() => onMoveToToday(overdue)}>
                    Move all to today
                  </button>
                )}
              </div>
              <ul className="task-list">
                {overdue.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    now={now}
                    fresh={false}
                    onToggle={() => onToggle(task)}
                    onOpen={() => onOpen(task)}
                    onDelete={() => onDelete(task)}
                    action={
                      <button type="button" className="move-today" onClick={() => onMoveToToday([task])} aria-label={`Move ${task.title} to today`}>
                        Today
                        <Icon name="arrow" />
                      </button>
                    }
                  />
                ))}
              </ul>
            </section>
          )}
          <ul className="task-list">{upcoming.map(row)}</ul>
          {openAnytime.length > 0 && <h3 className="section-label">Anytime</h3>}
          <ul className="task-list">{openAnytime.map(row)}</ul>
          {done.length > 0 && <h3 className="section-label">Done</h3>}
          <ul className="task-list">{done.map(row)}</ul>
        </div>
      </>
    )
  }

  return (
    <div className="home">
      <section className="clock-panel" aria-label="Clock">
        <DayPicker day={day} now={now} onChange={changeDay} onAddTask={onAddOnDay} />
        <Clock
          tasks={onClock}
          showHands={isToday}
          selectedHour={selectedHour}
          freshTaskId={freshId}
          onSelectHour={(h) => setSelectedHour(selectedHour === h ? null : h)}
          onLongPressHour={longPress}
        />
        <p className="clock-window">{windowLabel}</p>
        {!isToday && <p className="clock-ghost-note">Faded hands show the time now</p>}
        <div className="legend" aria-hidden="true">
          <span>
            <span className="dot dot-work" />
            Work
          </span>
          <span>
            <span className="dot dot-personal" />
            Personal
          </span>
          <span>
            <span className="dot dot-health" />
            Health
          </span>
        </div>
        <p className="clock-hint">Tap an hour to filter · press and hold to add a task there</p>
      </section>

      <section ref={listRef} className="list-panel glass" aria-label="Tasks" data-tour="task-list">
        {list}
      </section>
    </div>
  )
}
