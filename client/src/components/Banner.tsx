import { useEffect, useRef, useState } from 'react'
import { gsap } from '../motion'

/**
 * A notice or error line inside a card. Set `message` to '' to dismiss it: it folds away
 * smoothly (and the card shrinks with it) instead of vanishing with a jump. With `autoHideMs`
 * it asks to be dismissed on its own after that long.
 */
export function Banner({
  message,
  tone,
  autoHideMs,
  onHide,
}: {
  message: string
  tone: 'notice' | 'error'
  autoHideMs?: number
  onHide?: () => void
}) {
  // The text on screen; it outlives `message` while the banner folds away.
  const [shown, setShown] = useState(message)
  if (message && message !== shown) setShown(message)
  const ref = useRef<HTMLDivElement>(null)
  const onHideRef = useRef(onHide)
  useEffect(() => {
    onHideRef.current = onHide
  }, [onHide])

  useEffect(() => {
    if (!message || !autoHideMs) return
    const id = window.setTimeout(() => onHideRef.current?.(), autoHideMs)
    return () => clearTimeout(id)
  }, [message, autoHideMs])

  // Appear.
  useEffect(() => {
    if (!shown || !ref.current) return
    gsap.fromTo(ref.current, { autoAlpha: 0, y: -6 }, { autoAlpha: 1, y: 0, duration: 0.35, ease: 'power2.out', clearProps: 'all' })
  }, [shown])

  // Fold away, taking the card's gap with it so nothing jumps at the end.
  useEffect(() => {
    const el = ref.current
    if (message || !shown || !el) return
    const gap = parseFloat(getComputedStyle(el.parentElement!).rowGap) || 0
    const tween = gsap.to(el, {
      autoAlpha: 0,
      height: 0,
      paddingTop: 0,
      paddingBottom: 0,
      marginBottom: -gap,
      duration: 0.4,
      ease: 'power2.inOut',
      onComplete: () => setShown(''),
    })
    return () => {
      tween.kill()
      gsap.set(el, { clearProps: 'all' })
    }
  }, [message, shown])

  if (!shown) return null
  return (
    <div ref={ref} className={tone === 'error' ? 'error-banner' : 'notice-banner'} role={tone === 'error' ? 'alert' : 'status'} style={{ overflow: 'hidden' }}>
      {shown}
    </div>
  )
}
