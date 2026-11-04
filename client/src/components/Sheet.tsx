import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../icons'
import { tr } from '../i18n'

/** A sheet with a title, its contents and buttons at the foot. */
export function Sheet({ title, onBack, onClose, foot, children }: { title: string; onBack?: () => void; onClose: () => void; foot: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (onBack) onBack()
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack, onClose])
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-top">
          <div className="grabber" aria-hidden="true" />
          <div className="sheet-head">
            <div className="sheet-title">
              {onBack && (
                <button type="button" className="icon-btn" aria-label={tr('Back')} onClick={onBack}>
                  <Icon name="back" />
                </button>
              )}
              <h2>{title}</h2>
            </div>
            <button type="button" className="icon-btn" aria-label={tr('Close')} onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>
        </div>
        <div className="sheet-body">{children}</div>
        <div className="sheet-foot table-sheet-foot">{foot}</div>
      </div>
    </div>,
    document.body,
  )
}
