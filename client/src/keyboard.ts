/**
 * The on-screen keyboard. Native apps get told when it opens and resize themselves. A web page isn't:
 * on iPhone the page keeps its height and Safari slides the whole thing up to reveal the field, which
 * hides the header and leaves the bottom bar floating above the keys. So we measure the part of the
 * screen that's really visible and lay out to fit it:
 *
 *   --vvh, --vv-top       the visible height, and how far Safari slid the page
 *   .keyboard-open        the bottom bar steps aside, dialogs fit above the keys
 *   .keyboard-lock        typing in a panel, chat or dialog: the page stops moving at all
 */

/** Anything less than this is the address bar moving, not a keyboard. */
const KEYBOARD_MIN_HEIGHT = 120
const LOCK_INSIDE = '.panel, .thread, .scrim, .menu-layer'
const SETTLE_AFTER_MS = [50, 150, 300, 600, 1000]

export function isKeyboardOpen(fullHeight: number, visibleHeight: number, scale: number, typing: boolean) {
  // Pinch-zooming also shrinks the visible area, but that's not a keyboard.
  return typing && scale < 1.05 && fullHeight - visibleHeight > KEYBOARD_MIN_HEIGHT
}

/**
 * How far to shift things to stay on screen. Only a keyboard or a pinch-zoom can truly move the visible
 * area. iPhones can report a leftover offset after the keyboard closes, which would push a whole screen
 * down by the keyboard's height, so anything else counts as no shift at all.
 */
export const visibleTop = (open: boolean, scale: number, offsetTop: number) => (open || scale >= 1.05 ? Math.round(offsetTop) : 0)

const isTyping = (el: Element | null) => {
  if (!(el instanceof HTMLElement)) return false
  if (el instanceof HTMLTextAreaElement || el.isContentEditable) return true
  return el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'range', 'color', 'file'].includes(el.type)
}

export function watchKeyboard() {
  const view = window.visualViewport
  if (!view) return
  const root = document.documentElement
  let fullHeight = view.height
  let width = view.width
  let lockedFromScroll: number | null = null
  let settling: ReturnType<typeof setTimeout>[] = []
  // Where the page belongs after the keyboard, held until iPhone has finished moving it around.
  let restoreScroll: number | null = null

  const update = () => {
    if (view.width !== width) {
      // Turned sideways: start measuring again.
      width = view.width
      fullHeight = view.height
    }
    const active = document.activeElement
    const open = isKeyboardOpen(fullHeight, view.height, view.scale, isTyping(active))
    if (!open) fullHeight = Math.max(fullHeight, view.height)
    root.style.setProperty('--vvh', `${Math.round(view.height)}px`)
    root.style.setProperty('--vv-top', `${visibleTop(open, view.scale, view.offsetTop)}px`)
    root.classList.toggle('keyboard-open', open)

    const lock = open && Boolean(active?.closest(LOCK_INSIDE))
    if (lock && lockedFromScroll === null) {
      lockedFromScroll = window.scrollY
      root.classList.add('keyboard-lock')
    }
    if (lock && view.offsetTop > 0) window.scrollTo(0, 0)
    if (!lock && lockedFromScroll !== null) {
      root.classList.remove('keyboard-lock')
      restoreScroll = lockedFromScroll
      lockedFromScroll = null
    }
    if (open) restoreScroll = null
    if (restoreScroll !== null) window.scrollTo(0, restoreScroll)
  }

  /** The keyboard slides for a while and the last events can be missing, so look again until it's done. */
  const updateAndSettle = () => {
    update()
    settling.forEach(clearTimeout)
    settling = SETTLE_AFTER_MS.map((ms) => setTimeout(update, ms))
    settling.push(
      setTimeout(() => {
        update()
        restoreScroll = null
      }, SETTLE_AFTER_MS.at(-1)! + 100),
    )
  }

  view.addEventListener('resize', updateAndSettle)
  view.addEventListener('scroll', update)
  document.addEventListener('focusin', update)
  document.addEventListener('focusout', updateAndSettle)
  window.addEventListener('pageshow', updateAndSettle)
  document.addEventListener('visibilitychange', updateAndSettle)
  update()
}
