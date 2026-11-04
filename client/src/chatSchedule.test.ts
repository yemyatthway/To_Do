import { describe, expect, it } from 'vitest'
import type { ScheduledMessage } from './api'
import { scheduledSummary, sendAtText } from './chatSchedule'

const now = new Date(2026, 10, 4, 15, 0)
const item = (status: ScheduledMessage['status'], send_at: Date) => ({ id: 1, text: 'x', status, error: '', send_at: send_at.toISOString() }) as ScheduledMessage

describe('sending later', () => {
  it('says when in plain words', () => {
    expect(sendAtText(new Date(2026, 10, 4, 20, 0), now)).toMatch(/^Today, 8:00\sPM$/)
    expect(sendAtText(new Date(2026, 10, 3, 9, 0), now)).toMatch(/^Yesterday, 9:00\sAM$/)
  })

  it('sums up what is waiting, and failures first', () => {
    expect(scheduledSummary([], now)).toBeNull()
    expect(scheduledSummary([item('pending', new Date(2026, 10, 4, 20, 0))], now)).toMatch(/^1 scheduled · next Today, 8:00\sPM$/)
    expect(scheduledSummary([item('pending', now), item('failed', now)], now)).toBe("1 scheduled message couldn't send")
  })
})
