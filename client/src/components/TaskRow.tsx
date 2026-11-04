import { useRef, useState, type ReactNode } from 'react'
import type { Task } from '../api'
import type { ShownTask } from '../outbox'
import { Icon } from '../icons'
import { dueDate, formatShortDay, formatTime, relativeLabel, sameDay } from '../time'
import { tr } from '../i18n'

const REVEAL = 92
const CATEGORY_LABEL = { work: tr('Work'), personal: tr('Personal'), health: tr('Health') } as const

const SYNC_LABEL = { saving: tr('Saving…'), waiting: tr('Waiting for network'), failed: tr('Not saved · tap to fix') } as const

interface TaskRowProps {
  task: Task & Pick<ShownTask, 'sync'>
  now: Date
  fresh: boolean
  onToggle: () => void
  onOpen: () => void
  onDelete: () => void
  /** An extra button before the trash (e.g. "Move to today" in the Overdue section). */
  action?: ReactNode
}

export function TaskRow({ task, now, fresh, onToggle, onOpen, onDelete, action }: TaskRowProps) {
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)
  const drag = useRef<{ x: number; y: number; base: number; moved: boolean } | null>(null)

  const due = dueDate(task)
  // From another day (an overdue task), say which day too.
  const when = due ? (sameDay(due, now) ? formatTime(due) : `${formatShortDay(due)}, ${formatTime(due)}`) : tr('Anytime')
  // "Remind a friend": who put it in your list, or who you added yours for.
  const people = task.added_by_name
    ? tr('from {value}', { value: task.added_by_name.split(' ')[0] })
    : task.shared_with?.length
      ? tr('with {value}', { value: task.shared_with.join(', ') })
      : ''
  const meta = [when, CATEGORY_LABEL[task.category], people].filter(Boolean).join(' · ')
  const relative = relativeLabel(task, now)
  const revealed = offset <= -REVEAL / 2

  // Swipe left (touch/pen) to reveal the delete button.
  function onPointerDown(e: React.PointerEvent) {
    if (e.pointerType === 'mouse') return
    drag.current = { x: e.clientX, y: e.clientY, base: offset, moved: false }
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    if (!d.moved) {
      if (Math.abs(dx) < 8) return
      if (Math.abs(e.clientY - d.y) > Math.abs(dx)) {
        drag.current = null
        return
      }
      d.moved = true
      setDragging(true)
    }
    setOffset(Math.max(-REVEAL - 20, Math.min(0, d.base + dx)))
  }

  function onPointerUp() {
    const d = drag.current
    drag.current = null
    setDragging(false)
    if (d?.moved) setOffset((o) => (o < -REVEAL / 2 ? -REVEAL : 0))
  }

  function onClickCapture(e: React.MouseEvent) {
    // Taps on a swiped row close it instead of opening the task.
    if (offset !== 0 && !(e.target as HTMLElement).closest('.swipe-delete')) {
      e.stopPropagation()
      setOffset(0)
    }
  }

  const rowClasses = ['task-row', task.done && 'done', fresh && 'fresh', dragging && 'dragging'].filter(Boolean).join(' ')

  return (
    <li className={`task-wrap${offset < 0 ? ' revealed' : ''}`} style={{ listStyle: 'none' }} onClickCapture={onClickCapture}>
      {offset < 0 && (
        <button className="swipe-delete" onClick={onDelete} tabIndex={revealed ? 0 : -1}>
          <Icon name="trash" />
          {tr('Delete')}
        </button>
      )}
      <div
        className={rowClasses}
        style={{ transform: `translateX(${offset}px)`, ['--cat' as string]: `var(--${task.category})` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <button
          className={`check${task.done ? ' on' : ''}`}
          role="checkbox"
          aria-checked={task.done}
          aria-label={tr('Mark {title} {value}', { title: task.title, value: task.done ? tr('not done') : tr('done') })}
          onClick={onToggle}
        >
          {task.done && <Icon name="check" />}
        </button>
        <button className="task-main" onClick={onOpen} aria-label={tr('Edit {title}, {meta}', { title: task.title, meta })}>
          <span className="task-title">{task.title}</span>
          <span className="task-meta">
            {meta}
            {task.sync && <span className={`task-sync ${task.sync}`}> · {SYNC_LABEL[task.sync]}</span>}
          </span>
        </button>
        {fresh && <span className="badge badge-new">{tr('New')}</span>}
        {!fresh && relative && (
          <span className={`badge ${relative === tr('Overdue') ? 'badge-late' : 'badge-soon'}`}>{relative}</span>
        )}
        {!fresh && !relative && task.priority === 'high' && !task.done && <span className="badge badge-high">{tr('High')}</span>}
        {action}
        <button className="row-trash" aria-label={tr('Delete {title}', { title: task.title })} onClick={onDelete}>
          <Icon name="trash" />
        </button>
      </div>
    </li>
  )
}
