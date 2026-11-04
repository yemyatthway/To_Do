import type { Chat } from './api'
import { addDays, sameDay } from './time'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** The short time on the chat timeline: 2m, 1h, Yest., Mon, Oct 28. */
export function momentLabel(at: Date, now: Date) {
  const ago = now.getTime() - at.getTime()
  if (sameDay(at, now)) {
    if (ago < MINUTE) return 'Now'
    return ago < HOUR ? `${Math.floor(ago / MINUTE)}m` : `${Math.floor(ago / HOUR)}h`
  }
  if (sameDay(at, addDays(now, -1))) return 'Yest.'
  if (ago < 7 * 24 * HOUR) return at.toLocaleDateString('en-US', { weekday: 'short' })
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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
    { label: 'Today', chats: today },
    { label: 'Earlier', chats: earlier },
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
  if (sameDay(at, now)) return 'Today'
  if (sameDay(at, addDays(now, -1))) return 'Yesterday'
  if (now.getTime() - at.getTime() < 7 * 24 * HOUR) return at.toLocaleDateString('en-US', { weekday: 'long' })
  return at.toLocaleDateString('en-US', at.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

/** A message's exact time, always with AM or PM. */
export const messageTime = (at: Date) => at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
