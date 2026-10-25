import { useCallback, useEffect, useRef } from 'react'
import { Icon } from '../icons'
import { gsap, useGsap } from '../motion'

export interface ToastData {
  id: number
  title: string
  detail?: string
  action?: { label: string; onClick: () => void }
}

const DURATION_MS = 5000

export function Toast({ toast, onDismiss }: { toast: ToastData; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const gone = useRef(false)

  useGsap(ref, () => {
    gsap.fromTo(ref.current, { autoAlpha: 0, y: 30, scale: 0.96 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.6, ease: 'back.out(1.4)' })
  }, [])

  const leave = useCallback(() => {
    if (gone.current) return
    gone.current = true
    gsap.to(ref.current, { autoAlpha: 0, y: 18, duration: 0.3, ease: 'power2.in', onComplete: onDismiss })
  }, [onDismiss])

  useEffect(() => {
    const id = setTimeout(leave, DURATION_MS)
    return () => clearTimeout(id)
  }, [toast.id, leave])

  return (
    <div ref={ref} className="toast" role="status">
      <div className="toast-text">
        <strong>{toast.title}</strong>
        {toast.detail && <span>{toast.detail}</span>}
      </div>
      {toast.action && (
        <button
          onClick={() => {
            toast.action!.onClick()
            leave()
          }}
        >
          {toast.action.label === 'Undo' && <Icon name="undo" />}
          {toast.action.label}
        </button>
      )}
    </div>
  )
}
