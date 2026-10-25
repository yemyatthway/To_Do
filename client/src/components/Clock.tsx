import { useEffect, useRef, useState } from 'react'
import type { Task } from '../api'
import { gsap } from '../motion'
import { usePageVisible } from '../visibility'

const LONG_PRESS_MS = 550
const HOURS = Array.from({ length: 12 }, (_, i) => i + 1)

function point(deg: number, r: number) {
  const rad = (deg * Math.PI) / 180
  return [Math.sin(rad) * r, -Math.cos(rad) * r] as const
}

function wedgePath(hour: number) {
  const r = 136
  const [x0, y0] = point((hour - 0.5) * 30, r)
  const [x1, y1] = point((hour + 0.5) * 30, r)
  return `M0 0 L${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1} Z`
}

/** Re-renders every `ms` while the tab is visible. */
function useTicker(ms: number) {
  const [now, setNow] = useState(() => new Date())
  const visible = usePageVisible()
  useEffect(() => {
    if (!visible) return
    const tick = () => setNow(new Date())
    const catchUp = setTimeout(tick, 0) // right away after the tab was hidden
    const id = setInterval(tick, ms)
    return () => {
      clearTimeout(catchUp)
      clearInterval(id)
    }
  }, [ms, visible])
  return now
}

interface ClockProps {
  /** Timed tasks for the half of the day the clock shows. */
  tasks: Task[]
  showHands: boolean
  selectedHour: number | null
  freshTaskId: number | null
  onSelectHour: (hour: number) => void
  onLongPressHour: (hour: number) => void
}

export function Clock({ tasks, showHands, selectedHour, freshTaskId, onSelectHour, onLongPressHour }: ClockProps) {
  // Today: a ticking second hand. Other days: faded hands showing the time now, updated each half minute.
  const now = useTicker(showHands ? 1000 : 30_000)
  const timer = useRef<number | undefined>(undefined)
  const longPressed = useRef(false)
  const secondHand = useRef<SVGLineElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const ticked = useRef(false)

  // Second hand ticks like a real quartz clock: a quick step with a tiny overshoot.
  // Counting total seconds (not 0-59) keeps it from spinning backwards at the minute.
  const totalSeconds = Math.floor(now.getTime() / 1000)
  useEffect(() => {
    if (!secondHand.current) {
      ticked.current = false
      return
    }
    const rotation = (totalSeconds % 86400) * 6
    if (!ticked.current) {
      gsap.set(secondHand.current, { rotation, svgOrigin: '0 0' })
      ticked.current = true
    } else {
      gsap.to(secondHand.current, { rotation, svgOrigin: '0 0', duration: 0.3, ease: 'back.out(4)' })
    }
  }, [totalSeconds, showHands])

  // A newly added task's dot springs onto the face.
  useEffect(() => {
    if (freshTaskId === null) return
    const dot = svgRef.current?.querySelector(`[data-dot="${freshTaskId}"]`)
    if (dot) gsap.fromTo(dot, { scale: 0 }, { scale: 1, transformOrigin: '50% 50%', duration: 1, ease: 'elastic.out(1, 0.4)' })
  }, [freshTaskId])

  const countByHour = new Map<number, number>()
  for (const task of tasks) {
    const h = new Date(task.due_at!).getHours() % 12 || 12
    countByHour.set(h, (countByHour.get(h) ?? 0) + 1)
  }

  function startPress(hour: number) {
    longPressed.current = false
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      longPressed.current = true
      onLongPressHour(hour)
    }, LONG_PRESS_MS)
  }

  const cancelPress = () => window.clearTimeout(timer.current)

  function click(hour: number) {
    cancelPress()
    // The click that ends a long-press shouldn't also filter.
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    onSelectHour(hour)
  }

  const s = now.getSeconds()
  const m = now.getMinutes() + s / 60
  const h = (now.getHours() % 12) + m / 60

  return (
    <div className="clock" data-tour="clock">
      <div className="clock-face" />
      <svg ref={svgRef} viewBox="-150 -150 300 300" role="group" aria-label="Clock showing the next 12 hours. Tap an hour to see its tasks, press and hold to add one.">
        {selectedHour && <path d={wedgePath(selectedHour)} fill="var(--wedge)" />}

        {HOURS.map((hour) => {
          const [x, y] = point(hour * 30, 126)
          return <circle key={`t${hour}`} cx={x} cy={y} r="2" fill="var(--tick)" />
        })}

        {/* High priority drawn last, so it sits on top when dots share a time. */}
        {[...tasks].sort((a, b) => Number(a.priority === 'high') - Number(b.priority === 'high')).map((task) => {
          const due = new Date(task.due_at!)
          const [x, y] = point(((due.getHours() % 12) + due.getMinutes() / 60) * 30, 80)
          // High-priority tasks get a bigger dot with a ring, so they stand out on the face.
          const high = task.priority === 'high' && !task.done
          const classes = ['clock-dot', task.done && 'done', high && 'high'].filter(Boolean).join(' ')
          return (
            <circle
              key={task.id}
              className={classes}
              cx={x}
              cy={y}
              r={high ? 8 : 6}
              fill={`var(--${task.category})`}
              data-dot={task.id}
            />
          )
        })}

        <g aria-hidden="true" strokeLinecap="round" className={showHands ? 'clock-hands' : 'clock-hands ghost'}>
          <line x1="0" y1="0" x2="0" y2="-56" stroke="var(--hand)" strokeWidth="7" transform={`rotate(${h * 30})`} />
          <line x1="0" y1="0" x2="0" y2="-88" stroke="var(--hand)" strokeWidth="4.5" transform={`rotate(${m * 6})`} />
          {showHands && <line ref={secondHand} x1="0" y1="12" x2="0" y2="-96" stroke="var(--accSoft)" strokeWidth="2" />}
        </g>
        <circle r="7" fill="var(--acc)" stroke="var(--bg)" strokeWidth="2.5" aria-hidden="true" />

        {HOURS.map((hour) => {
          const [x, y] = point(hour * 30, 104)
          const count = countByHour.get(hour) ?? 0
          return (
            <g
              key={hour}
              className="clock-hour"
              data-tour={hour === 3 ? 'clock-hour' : undefined}
              role="button"
              tabIndex={0}
              aria-pressed={selectedHour === hour}
              aria-label={`${hour} o'clock, ${count} ${count === 1 ? 'task' : 'tasks'}`}
              onPointerDown={() => startPress(hour)}
              onPointerUp={cancelPress}
              onPointerLeave={cancelPress}
              onClick={() => click(hour)}
              onContextMenu={(e) => e.preventDefault()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onSelectHour(hour)
                }
              }}
            >
              <circle cx={x} cy={y} r="17" fill="transparent" />
              <text x={x} y={y} textAnchor="middle" dominantBaseline="central">
                {hour}
              </text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
