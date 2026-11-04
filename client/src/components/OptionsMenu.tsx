import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon, type IconName } from '../icons'
import { gsap, useGsap } from '../motion'

export interface MenuOption {
  icon: IconName
  label: string
  danger?: boolean
  /** Shows as the current choice, like Table or Board. */
  current?: boolean
  run: () => void
}

interface OptionsMenuProps {
  /** What the button does, for screen readers. */
  label: string
  options: MenuOption[]
  /** A different button than the "..." key. */
  trigger?: ReactNode
  triggerClass?: string
}

/** Rare actions, behind one button. */
export function OptionsMenu({ label, options, trigger, triggerClass = 'icon-btn' }: OptionsMenuProps) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  useGsap(
    box,
    () => {
      if (open) gsap.fromTo('.table-menu', { opacity: 0, scale: 0.9, y: -6 }, { opacity: 1, scale: 1, y: 0, duration: 0.28, ease: 'back.out(2)', clearProps: 'transform,opacity' })
    },
    [open],
  )

  return (
    <div ref={box} className="table-more">
      <button type="button" className={triggerClass} aria-label={label} aria-expanded={open} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}>
        {trigger ?? <Icon name="more" />}
      </button>
      {open && (
        <div className="table-menu glass" role="menu">
          {options.map((option) => (
            <button
              key={option.label}
              type="button"
              role="menuitem"
              className={option.danger ? 'danger-row' : undefined}
              aria-current={option.current ? 'true' : undefined}
              // Keep the caret where it is, so what's added lands in the right place.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false)
                option.run()
              }}
            >
              <Icon name={option.icon} />
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
