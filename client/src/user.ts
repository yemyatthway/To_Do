import type { User } from './api'

/** Mirrors the server's validators (same rule as afm_sys) so people see what's missing as they type. */
export const PASSWORD_RULES = [
  { label: '12+ characters', test: (p: string) => p.length >= 12 },
  { label: 'Uppercase letter', test: (p: string) => /[A-Z]/.test(p) },
  { label: 'Lowercase letter', test: (p: string) => /[a-z]/.test(p) },
  { label: 'Number', test: (p: string) => /\d/.test(p) },
  { label: 'Symbol', test: (p: string) => /[^A-Za-z0-9]/.test(p) },
]

/** name@domain.tld: one @, no spaces, a dot in the domain and a 2+ letter ending. */
export const isValidEmail = (email: string) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)*\.[a-z]{2,}$/i.test(email.trim())

export function initials(user: Pick<User, 'full_name' | 'email'>) {
  const source = user.full_name.trim() || user.email
  const parts = source.split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?'
}

/** "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
export function timeAgo(iso: string | null, now = new Date()) {
  if (!iso) return 'Never'
  const then = new Date(iso)
  const minutes = Math.round((now.getTime() - then.getTime()) / 60000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })

/** Mirrors the server's username rules (usernames.py); the server also checks it's free. */
export const normalizeUsername = (value: string) => value.trim().replace(/^@+/, '').toLowerCase()

export function usernameProblem(value: string) {
  if (value.length < 3) return 'Use at least 3 characters.'
  if (value.length > 20) return 'Use at most 20 characters.'
  if (!/^[a-z0-9](?:[a-z0-9._]*[a-z0-9])?$/.test(value)) return 'Use lowercase letters, numbers, dots and underscores, starting and ending with a letter or number.'
  if (value.includes('..')) return 'No two dots in a row.'
  return null
}

/** "Ryen Kai" -> "ryenkai": a first suggestion while someone types their name. */
export const usernameFromName = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // accents: é -> e
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20)

/** "Mia Thompson" with "@mia.t" under it, wherever people are listed. */
export const handle = (p: { username?: string }) => (p.username ? `@${p.username}` : '')
