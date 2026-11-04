import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { QUICK_REACTIONS, firstEmoji } from '../emojiText'
import { Icon, type IconName } from '../icons'
import { gsap, useGsap } from '../motion'
import { EmojiGrid } from './emoji'
import { tr } from '../i18n'

export interface MessageAction {
  icon: IconName
  label: string
  danger?: boolean
  run: () => void
}

interface MessageMenuProps {
  /** Where the message is on screen. */
  anchor: DOMRect
  mine: boolean
  /** Null when this message can't take reactions (deleted, still sending). */
  reaction: { current: string | null; onPick: (emoji: string | null) => void } | null
  actions: MessageAction[]
  onClose: () => void
}

const GAP = 8
const EDGE = 10

/** Everything you can do with a message, floating next to it: react on top, then a short list. */
export function MessageMenu({ anchor, mine, reaction, actions, onClose }: MessageMenuProps) {
  const [view, setView] = useState<'main' | 'emoji'>('main')
  const panel = useRef<HTMLDivElement>(null)
  const closing = useRef(false)

  const close = useCallback(
    (then?: () => void) => {
      if (closing.current) return
      closing.current = true
      gsap.to(panel.current, {
        opacity: 0,
        scale: 0.94,
        duration: 0.14,
        ease: 'power2.in',
        onComplete: () => {
          onClose()
          then?.()
        },
      })
    },
    [onClose],
  )

  // Beside the message, kept on screen and above the keyboard, even when the keyboard opens later.
  useLayoutEffect(() => {
    const place = () => {
      const el = panel.current
      if (!el) return
      const visible = window.visualViewport
      const top = visible?.offsetTop ?? 0
      const bottom = top + (visible?.height ?? window.innerHeight)
      const width = document.documentElement.clientWidth
      const below = anchor.bottom + GAP
      const above = anchor.top - GAP - el.offsetHeight
      const y = below + el.offsetHeight <= bottom - EDGE ? below : above >= top + EDGE ? above : Math.max(top + EDGE, bottom - EDGE - el.offsetHeight)
      const x = mine ? anchor.right - el.offsetWidth : anchor.left
      el.style.top = `${y}px`
      el.style.left = `${Math.max(EDGE, Math.min(x, width - EDGE - el.offsetWidth))}px`
      el.style.transformOrigin = `${mine ? '100%' : '0%'} ${y >= anchor.bottom ? '0%' : '100%'}`
    }
    place()
    window.visualViewport?.addEventListener('resize', place)
    return () => window.visualViewport?.removeEventListener('resize', place)
  }, [anchor, mine, view])

  useGsap(
    panel,
    () => {
      gsap.fromTo(panel.current, { opacity: 0, scale: 0.86, y: 6 }, { opacity: 1, scale: 1, y: 0, duration: 0.32, ease: 'back.out(1.8)' })
      gsap.fromTo('.reaction-key', { scale: 0.4, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.34, stagger: 0.03, delay: 0.04, ease: 'back.out(2.4)', clearProps: 'transform,opacity' })
      // Keyboard users land in the menu. Someone typing keeps their place.
      if (!(document.activeElement instanceof HTMLTextAreaElement)) panel.current?.querySelector('button')?.focus({ preventScroll: true })
    },
    [],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const pick = (emoji: string) => {
    if (!reaction) return
    reaction.onPick(reaction.current === emoji ? null : emoji)
    close()
  }

  return createPortal(
    <div className="menu-layer" onMouseDown={(e) => e.target === e.currentTarget && close()} onTouchEnd={(e) => e.target === e.currentTarget && (e.preventDefault(), close())}>
      <div ref={panel} className="message-menu" role="menu" aria-label={tr('Message options')}>
        {view === 'emoji' ? (
          <>
            <input
              className="field emoji-input"
              value=""
              placeholder={tr('Any emoji from your keyboard')}
              aria-label={tr('Any emoji from your keyboard')}
              autoComplete="off"
              onChange={(e) => {
                const emoji = firstEmoji(e.target.value)
                if (emoji) pick(emoji)
              }}
            />
            <EmojiGrid selected={reaction?.current} onPick={pick} />
          </>
        ) : (
          <>
            {reaction && (
              <div className="reaction-bar" role="group" aria-label={tr('React')}>
                {QUICK_REACTIONS.map((emoji) => (
                  <button key={emoji} type="button" className="reaction-key" aria-pressed={reaction.current === emoji} onClick={() => pick(emoji)}>
                    {emoji}
                  </button>
                ))}
                <button type="button" className="reaction-key reaction-more" aria-label={tr('More emoji')} onClick={() => setView('emoji')}>
                  <Icon name="reactPlus" />
                </button>
              </div>
            )}
            <div className="menu-list">
              {actions.map((action) => (
                <button key={action.label} type="button" role="menuitem" className={`menu-item${action.danger ? ' danger' : ''}`} onClick={() => close(action.run)}>
                  <Icon name={action.icon} />
                  {action.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
