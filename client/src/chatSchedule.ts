import type { ScheduledMessage } from './api'
import { dayLabel, messageTime } from './chatTimeline'
import { tr } from './i18n'

export const sendAtText = (when: Date, now: Date) => `${dayLabel(when, now)}, ${messageTime(when)}`

/** The line above the message box. */
export function scheduledSummary(items: ScheduledMessage[], now: Date) {
  if (!items.length) return null
  const failed = items.filter((item) => item.status === 'failed').length
  if (failed) return tr('{failed} scheduled {value} couldn\'t send', { failed, value: failed === 1 ? 'message' : 'messages' })
  const count = `${items.length} scheduled`
  return tr('{count} · next {value}', { count, value: sendAtText(new Date(items[0].send_at), now) })
}
