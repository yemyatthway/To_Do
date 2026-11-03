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

export function isKeyboardOpen(fullHeight: number, visibleHeight: number, scale: number, typing: boolean) {
  // Pinch-zooming also shrinks the visible area, but that's not a keyboard.
  return typing && scale < 1.05 && fullHeight - visibleHeight > KEYBOARD_MIN_HEIGHT
}

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
    root.style.setProperty('--vv-top', `${Math.round(view.offsetTop)}px`)
    root.classList.toggle('keyboard-open', open)

    const lock = open && Boolean(active?.closest(LOCK_INSIDE))
    if (lock && lockedFromScroll === null) {
      lockedFromScroll = window.scrollY
      root.classList.add('keyboard-lock')
    }
    if (lock && view.offsetTop > 0) window.scrollTo(0, 0)
    if (!lock && lockedFromScroll !== null) {
      root.classList.remove('keyboard-lock')
      window.scrollTo(0, lockedFromScroll)
      lockedFromScroll = null
    }
  }

  view.addEventListener('resize', update)
  view.addEventListener('scroll', update)
  document.addEventListener('focusin', update)
  document.addEventListener('focusout', () => setTimeout(update, 50))
  update()
}
