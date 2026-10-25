import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { gsap, useGsap } from '../motion'

export interface TourStep {
  /** Matches a data-tour="…" attribute. The first visible match is used (mobile and desktop differ). */
  target: string
  title: string
  body: string
  /** Animated hint drawn on the target. */
  gesture?: 'tap' | 'hold' | 'swipe'
}

const PAD = 8
const CARD_WIDTH = 340
const GAP = 14

function findTarget(name: string) {
  return [...document.querySelectorAll<Element>(`[data-tour="${name}"]`)].find((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

export function Tour({ steps, onClose }: { steps: TourStep[]; onClose: (finished: boolean) => void }) {
  const [index, setIndex] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const nextRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [cardHeight, setCardHeight] = useState(180)

  // The overlay fades in and the card pops up once; after that each step's text slides in.
  useGsap(rootRef, () => {
    gsap.fromTo(rootRef.current, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.35, ease: 'power1.out' })
    gsap.fromTo(cardRef.current, { scale: 0.92 }, { scale: 1, duration: 0.6, ease: 'back.out(1.5)' })
  }, [])

  useGsap(cardRef, () => {
    gsap.fromTo('.tour-step, h2, p', { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, stagger: 0.06, duration: 0.45, ease: 'power2.out' })
  }, [index])
  const step = steps[index]
  const last = index === steps.length - 1

  const measure = useCallback(() => {
    const el = findTarget(step.target)
    if (!el) {
      setRect(null)
      return
    }
    const r = el.getBoundingClientRect()
    // Keep the highlight on screen even for targets that touch the edges (the bottom nav).
    const left = Math.max(4, r.left - PAD)
    const top = Math.max(4, r.top - PAD)
    const right = Math.min(window.innerWidth - 4, r.right + PAD)
    const bottom = Math.min(window.innerHeight - 4, r.bottom + PAD)
    setRect({ top, left, width: right - left, height: bottom - top })
  }, [step.target])

  // Bring the target into view, then keep the spotlight on it while the page moves.
  useEffect(() => {
    const el = findTarget(step.target)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const first = requestAnimationFrame(measure)
    const settle = window.setTimeout(measure, 400)
    let frame = 0
    const onMove = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(measure)
    }
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    nextRef.current?.focus({ preventScroll: true })
    return () => {
      window.clearTimeout(settle)
      cancelAnimationFrame(first)
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
  }, [step.target, measure])

  useLayoutEffect(() => {
    if (cardRef.current) setCardHeight(cardRef.current.offsetHeight)
  }, [index, rect])

  const next = useCallback(() => (last ? onClose(true) : setIndex((i) => i + 1)), [last, onClose])
  const back = useCallback(() => setIndex((i) => Math.max(0, i - 1)), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose(false)
      else if (e.key === 'ArrowRight') next()
      else if (e.key === 'ArrowLeft') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, back, onClose])

  // Card below the target when it fits, otherwise above; centered when there's no target.
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(CARD_WIDTH, vw - 32)
  let cardStyle: React.CSSProperties
  if (rect) {
    const below = rect.top + rect.height + GAP
    const fitsBelow = below + cardHeight < vh - 16
    const top = fitsBelow ? below : Math.max(16, rect.top - GAP - cardHeight)
    const left = Math.min(Math.max(16, rect.left + rect.width / 2 - width / 2), vw - width - 16)
    cardStyle = { top, left, width }
  } else {
    cardStyle = { top: vh / 2 - cardHeight / 2, left: vw / 2 - width / 2, width }
  }

  return (
    <div ref={rootRef} className="tour" role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-body">
      {rect ? (
        <div className="tour-spotlight" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}>
          {step.gesture && (
            <span className={`tour-pointer tour-${step.gesture}`} aria-hidden="true">
              <span className="tour-finger" />
            </span>
          )}
        </div>
      ) : (
        <div className="tour-dim" />
      )}

      <div ref={cardRef} className="tour-card glass" style={cardStyle}>
        <span className="tour-step">
          Step {index + 1} of {steps.length}
        </span>
        <h2 id="tour-title">{step.title}</h2>
        <p id="tour-body">{step.body}</p>
        <div className="tour-dots" aria-hidden="true">
          {steps.map((_, i) => (
            <span key={i} className={i === index ? 'on' : ''} />
          ))}
        </div>
        <div className="tour-actions">
          <button type="button" className="link-btn" onClick={() => onClose(false)}>
            Skip tour
          </button>
          <span style={{ display: 'flex', gap: 8 }}>
            {index > 0 && (
              <button type="button" className="text-btn" onClick={back}>
                Back
              </button>
            )}
            <button ref={nextRef} type="button" className="primary-btn tour-next" onClick={next}>
              {last ? 'Finish' : 'Next'}
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

export function WelcomeDialog({ name, onAnswer }: { name: string; onAnswer: (firstTime: boolean) => void }) {
  const yesRef = useRef<HTMLButtonElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  useEffect(() => yesRef.current?.focus(), [])
  useGsap(cardRef, () => {
    gsap.fromTo(cardRef.current, { autoAlpha: 0, scale: 0.9, y: 20 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.7, ease: 'back.out(1.4)' })
  }, [])
  return (
    <div className="scrim center">
      <div ref={cardRef} className="welcome-card glass" role="dialog" aria-modal="true" aria-labelledby="welcome-title" aria-describedby="welcome-body">
        <span className="auth-logo" aria-hidden="true">
          <svg className="icon" viewBox="0 0 24 24">
            <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2" />
          </svg>
        </span>
        <h2 id="welcome-title">Welcome{name ? `, ${name.split(' ')[0]}` : ''}!</h2>
        <p id="welcome-body">Is this your first time using To-Do? We can show you around in about a minute.</p>
        <button ref={yesRef} type="button" className="primary-btn" onClick={() => onAnswer(true)}>
          Yes, show me around
        </button>
        <button type="button" className="text-btn" onClick={() => onAnswer(false)}>
          No, I've used it before
        </button>
      </div>
    </div>
  )
}
