import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../icons'
import { gsap, useGsap } from '../motion'

interface ConfirmActionProps {
  title: string
  children: ReactNode
  confirmLabel: string
  danger?: boolean
  /** Null for small forms, which don't need a big icon on top. */
  icon?: IconName | null
  /** For the most serious actions: this exact text has to be typed first. */
  typeToConfirm?: string
  /** For dialogs with a form in them: hold the button until it's filled in. */
  confirmDisabled?: boolean
  cancelLabel?: string
  onCancel: () => void
  /** Throws to show the problem in the dialog. */
  onConfirm: () => Promise<void>
}

/** "Are you sure?" before anything hard to undo. */
export function ConfirmAction({ title, children, confirmLabel, danger, icon = 'help', typeToConfirm, confirmDisabled, cancelLabel = 'Cancel', onCancel, onConfirm }: ConfirmActionProps) {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const cardRef = useRef<HTMLFormElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const typedRef = useRef<HTMLInputElement>(null)

  useGsap(cardRef, () => {
    // Opacity, not autoAlpha: a hidden field can't take the cursor when the dialog opens.
    gsap.fromTo(cardRef.current, { opacity: 0, scale: 0.94, y: 14 }, { opacity: 1, scale: 1, y: 0, duration: 0.45, ease: 'back.out(1.5)' })
  }, [])

  // Once, on opening: refocusing later would pull you out of whatever you're filling in.
  useEffect(() => {
    ;(typedRef.current ?? cardRef.current?.querySelector<HTMLElement>('[data-autofocus]') ?? cancelRef.current)?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const ready = !confirmDisabled && (!typeToConfirm || typed === typeToConfirm)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError('')
    try {
      await onConfirm()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return createPortal(
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form ref={cardRef} className="welcome-card glass confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-action-h" onSubmit={submit}>
        {icon && (
          <span className={`confirm-icon${danger ? ' danger' : ''}`} aria-hidden="true">
            <Icon name={icon} />
          </span>
        )}
        <h2 id="confirm-action-h">{title}</h2>
        <div className="confirm-body">{children}</div>
        {typeToConfirm && (
          <label className="field-group" style={{ width: '100%', textAlign: 'left' }}>
            <span className="label">Type "{typeToConfirm}" to confirm</span>
            <input ref={typedRef} className="field" value={typed} autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
          </label>
        )}
        {error && (
          <span className="field-error" role="alert">
            {error}
          </span>
        )}
        <div className="confirm-actions">
          <button ref={cancelRef} type="button" className="text-btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button type="submit" className={danger ? 'danger-btn' : 'primary-btn'} disabled={!ready || busy}>
            {busy ? 'One moment…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
