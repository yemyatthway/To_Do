import type { Chat } from './api'
import { addDays, sameDay } from './time'
import { formatDate, tr } from './i18n'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The short time on the chat timeline: 2m, 1h, Yest., Mon, Oct 28. */
export function momentLabel(at: Date, now: Date) {
  const ago = now.getTime() - at.getTime()
  if (sameDay(at, now)) {
    if (ago < MINUTE) return tr('Now')
    return ago < HOUR ? tr('{n}m', { n: Math.floor(ago / MINUTE) }) : tr('{n}h', { n: Math.floor(ago / HOUR) })
  }
  if (sameDay(at, addDays(now, -1))) return tr('Yest.')
  if (ago < 7 * 24 * HOUR) return formatDate(at, { weekday: 'short' }, 'en-US')
  return formatDate(at, { month: 'short', day: 'numeric' }, 'en-US')
}

export interface ChatSection {
  label: string
  chats: Chat[]
}

/** Today's chats, then the rest. Empty sections are left out. */
export function chatSections(chats: Chat[], now: Date): ChatSection[] {
  const today = chats.filter((c) => c.last_message_at && sameDay(new Date(c.last_message_at), now))
  const earlier = chats.filter((c) => !today.includes(c))
  return [
    { label: tr('Today'), chats: today },
    { label: tr('Earlier'), chats: earlier },
  ].filter((section) => section.chats.length)
}

/** Did they read your latest message? */
export function isSeen(chat: Chat) {
  const last = chat.last_message
  return Boolean(last?.mine && !last.deleted && chat.friend_read_at && new Date(chat.friend_read_at) >= new Date(last.created_at))
}

export const matchesChat = (chat: Chat, query: string) => {
  const q = query.trim().replace(/^@/, '').toLowerCase()
  return !q || `${chat.friend.full_name} ${chat.friend.username}`.toLowerCase().includes(q)
}

/** The label between days: Today, Yesterday, Monday, then Oct 28, with the year once it's not this year. */
export function dayLabel(at: Date, now: Date) {
  if (sameDay(at, now)) return tr('Today')
  if (sameDay(at, addDays(now, -1))) return tr('Yesterday')
  if (now.getTime() - at.getTime() < 7 * 24 * HOUR) return formatDate(at, { weekday: 'long' }, 'en-US')
  return formatDate(at, at.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' }, 'en-US')
}

/** A message's exact time, always with AM or PM. */
export const messageTime = (at: Date) => formatDate(at, { hour: 'numeric', minute: '2-digit', hour12: true }, 'en-US')
