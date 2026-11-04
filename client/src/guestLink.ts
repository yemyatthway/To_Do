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
