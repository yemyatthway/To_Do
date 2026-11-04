/** Reaching a workspace from an invitation's link, before having an account. */

const JOIN_EMAIL = 'todo:join-email'

/** The token in /guest/<token>, or null on any other address. */
export function guestTokenFrom(pathname: string) {
  const [first, token, extra] = pathname.split('/').filter(Boolean)
  return first === 'guest' && token && !extra ? decodeURIComponent(token) : null
}

/** Which page or table a guest has open: in the part of the address that never reaches the server. */
export function guestPlaceFrom(hash: string) {
  const match = /^#(page|table)-(\d+)$/.exec(hash)
  return match ? { kind: match[1] as 'page' | 'table', id: Number(match[2]) } : null
}

/** So the sign-up form can say which address the invitation was sent to (partly hidden). */
export function rememberJoinEmail(masked: string) {
  try {
    sessionStorage.setItem(JOIN_EMAIL, masked)
  } catch {
    // Without it they still see the address on the guest screen first.
  }
}

export function joinEmail() {
  try {
    return sessionStorage.getItem(JOIN_EMAIL) ?? ''
  } catch {
    return ''
  }
}

export function forgetJoinEmail() {
  try {
    sessionStorage.removeItem(JOIN_EMAIL)
  } catch {
    // Nothing to forget.
  }
}

/** The older way of copying, for in-app browsers that refuse the clipboard call. */
function copyBySelecting(text: string) {
  const box = document.createElement('textarea')
  box.value = text
  box.readOnly = true // so a phone doesn't open its keyboard
  box.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
  document.body.append(box)
  box.select()
  box.setSelectionRange(0, text.length)
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    box.remove()
  }
}

/** Puts text on the clipboard. Says whether it worked. */
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return copyBySelecting(text)
  }
}
