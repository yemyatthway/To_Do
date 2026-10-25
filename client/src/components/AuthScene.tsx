import { useEffect, useRef } from 'react'

/** Sample cards that drift behind the login form to show what the app is for. Decorative only. */
const FLOATERS = [
  { title: 'Morning run', time: '7:00 AM', cat: 'health', done: true, x: '6%', y: '14%' },
  { title: 'Team standup', time: '2:00 PM', cat: 'work', done: false, x: '74%', y: '10%' },
  { title: 'Call mom', time: '6:00 PM', cat: 'personal', done: false, x: '80%', y: '62%' },
  { title: 'Design review', time: '2:30 PM', cat: 'work', done: true, x: '4%', y: '70%' },
  { title: 'Pay the bills', time: '4:15 PM', cat: 'personal', done: false, x: '68%', y: '86%', wide: true },
  { title: 'Read 20 pages', time: '9:00 PM', cat: 'health', done: false, x: '12%', y: '44%', wide: true },
]

/**
 * The moving backdrop for login and sign-up: slow color orbs, a large clock whose hands really
 * move, and floating task cards. Everything moves with CSS transform animations, which the
 * browser runs off the main thread, and it all stops for people who prefer reduced motion.
 */
export function AuthScene() {
  const hourRef = useRef<SVGLineElement>(null)
  const minuteRef = useRef<SVGLineElement>(null)

  // Start the clock's hands at the real time; CSS keeps them turning from there.
  useEffect(() => {
    const now = new Date()
    const minutes = now.getMinutes() + now.getSeconds() / 60
    const hours = (now.getHours() % 12) + minutes / 60
    hourRef.current?.style.setProperty('--start', `${hours * 30}deg`)
    minuteRef.current?.style.setProperty('--start', `${minutes * 6}deg`)
  }, [])

  return (
    <div className="auth-scene" aria-hidden="true">
      <span className="orb orb-1" />
      <span className="orb orb-2" />
      <span className="orb orb-3" />

      <svg className="scene-clock" viewBox="-100 -100 200 200">
        <circle r="92" className="scene-clock-rim" />
        {Array.from({ length: 12 }, (_, i) => {
          const a = (i * Math.PI) / 6
          return <line key={i} x1={Math.sin(a) * 78} y1={-Math.cos(a) * 78} x2={Math.sin(a) * 86} y2={-Math.cos(a) * 86} className="scene-clock-tick" />
        })}
        <line ref={hourRef} x1="0" y1="0" x2="0" y2="-44" className="scene-hand scene-hour" />
        <line ref={minuteRef} x1="0" y1="0" x2="0" y2="-66" className="scene-hand scene-minute" />
        <line x1="0" y1="10" x2="0" y2="-74" className="scene-hand scene-second" />
        <circle r="4" className="scene-clock-pin" />
      </svg>

      {FLOATERS.map((f, i) => (
        <div
          key={f.title}
          className={`floater${f.wide ? ' floater-wide' : ''}`}
          style={{ left: f.x, top: f.y, animationDelay: `${-i * 1.7}s`, animationDuration: `${9 + (i % 3) * 2}s` }}
        >
          <span className={`floater-check${f.done ? ' on' : ''}`} style={{ ['--cat' as string]: `var(--${f.cat})` }}>
            {f.done && (
              <svg viewBox="0 0 24 24">
                <path d="M5 12l5 5L20 7" />
              </svg>
            )}
          </span>
          <span className="floater-text">
            <strong className={f.done ? 'done' : ''}>{f.title}</strong>
            <span>{f.time}</span>
          </span>
        </div>
      ))}
    </div>
  )
}
