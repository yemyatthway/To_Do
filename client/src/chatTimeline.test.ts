import { describe, expect, it } from 'vitest'
import type { Chat } from './api'
import { chatSections, dayLabel, isSeen, matchesChat, messageTime, momentLabel } from './chatTimeline'

const now = new Date(2026, 10, 4, 15, 0)
const chat = (id: number, at: Date | null, more: Partial<Chat> = {}) =>
  ({ id, friend: { id, full_name: 'Aung Kyaw', username: 'aung_dev' }, last_message: null, last_message_at: at?.toISOString() ?? null, unread: 0, friend_read_at: null, ...more }) as Chat

describe('the chat timeline', () => {
  it('says when in a few letters', () => {
    expect(momentLabel(new Date(2026, 10, 4, 14, 59, 30), now)).toBe('Now')
    expect(momentLabel(new Date(2026, 10, 4, 14, 58), now)).toBe('2m')
    expect(momentLabel(new Date(2026, 10, 4, 12, 30), now)).toBe('2h')
    expect(momentLabel(new Date(2026, 10, 3, 23, 0), now)).toBe('Yest.')
    expect(momentLabel(new Date(2026, 10, 1, 9, 0), now)).toBe('Sun')
    expect(momentLabel(new Date(2026, 9, 20, 9, 0), now)).toBe('Oct 20')
  })

  it('splits today from earlier and hides empty sections', () => {
    const sections = chatSections([chat(1, new Date(2026, 10, 4, 9, 0)), chat(2, new Date(2026, 10, 2, 9, 0)), chat(3, null)], now)
    expect(sections.map((s) => [s.label, s.chats.map((c) => c.id)])).toEqual([
      ['Today', [1]],
      ['Earlier', [2, 3]],
    ])
    expect(chatSections([chat(2, new Date(2026, 10, 2))], now).map((s) => s.label)).toEqual(['Earlier'])
    expect(chatSections([], now)).toEqual([])
  })

  it('only counts as seen when they read your latest message', () => {
    const last = { mine: true, deleted: false, created_at: '2026-11-04T10:00:00Z' } as Chat['last_message']
    expect(isSeen(chat(1, null, { last_message: last, friend_read_at: '2026-11-04T10:01:00Z' }))).toBe(true)
    expect(isSeen(chat(1, null, { last_message: last, friend_read_at: '2026-11-04T09:00:00Z' }))).toBe(false)
    expect(isSeen(chat(1, null, { last_message: last }))).toBe(false)
    expect(isSeen(chat(1, null, { last_message: { ...last!, mine: false }, friend_read_at: '2026-11-04T11:00:00Z' }))).toBe(false)
    expect(isSeen(chat(1, null, { last_message: { ...last!, deleted: true }, friend_read_at: '2026-11-04T11:00:00Z' }))).toBe(false)
  })

  it('finds a chat by name or handle', () => {
    expect(matchesChat(chat(1, null), 'aung')).toBe(true)
    expect(matchesChat(chat(1, null), '@AUNG_d')).toBe(true)
    expect(matchesChat(chat(1, null), 'sara')).toBe(false)
    expect(matchesChat(chat(1, null), '  ')).toBe(true)
  })

  it('labels days the way people say them', () => {
    expect(dayLabel(new Date(2026, 10, 4, 1, 0), now)).toBe('Today')
    expect(dayLabel(new Date(2026, 10, 3, 23, 0), now)).toBe('Yesterday')
    expect(dayLabel(new Date(2026, 10, 2, 9, 0), now)).toBe('Monday')
    expect(dayLabel(new Date(2026, 9, 28, 9, 0), now)).toBe('Oct 28')
    expect(dayLabel(new Date(2025, 9, 28, 9, 0), now)).toBe('Oct 28, 2025')
  })

  it('always gives message times with AM or PM', () => {
    expect(messageTime(new Date(2026, 10, 4, 9, 41))).toMatch(/^9:41\sAM$/)
    expect(messageTime(new Date(2026, 10, 4, 15, 5))).toMatch(/^3:05\sPM$/)
    expect(messageTime(new Date(2026, 10, 4, 0, 30))).toMatch(/^12:30\sAM$/)
  })
})
