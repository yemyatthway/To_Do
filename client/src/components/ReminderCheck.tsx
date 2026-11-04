import { useCallback, useEffect, useState } from 'react'
import { api, type ReminderStatus } from '../api'
import { Icon } from '../icons'
import { currentEndpoint, isPushSupported } from '../push'
import { formatTime } from '../time'
import { timeAgo } from '../user'
import { tr } from '../i18n'

type State = 'ok' | 'bad' | 'warn'

function Check({ state, title, detail }: { state: State; title: string; detail: string }) {
  return (
    <li className={`check-row ${state}`}>
      <span className="check-icon" aria-hidden="true">
        <Icon name={state === 'ok' ? 'check' : state === 'bad' ? 'x' : 'help'} />
      </span>
      <span>
        <strong>{title}</strong>
        <span className="list-sub">{detail}</span>
      </span>
      <span className="sr-only">{state === 'ok' ? '(OK)' : state === 'bad' ? '(problem)' : '(check)'}</span>
    </li>
  )
}

/**
 * "Check reminders": the four things that must all be true for a reminder to arrive, each with a
 * tick or a cross and what to do about it.
 */
export function ReminderCheck() {
  const [status, setStatus] = useState<ReminderStatus | null>(null)
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState(() => new Date())

  const check = useCallback(async () => {
    setChecking(true)
    try {
      setStatus(await api.reminderStatus((await currentEndpoint()) ?? undefined))
      setCheckedAt(new Date())
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void check()
  }, [check])

  if (error) return <div className="error-banner">{error}</div>
  if (!status) return <p className="list-sub">{tr('Checking reminders…')}</p>

  const now = checkedAt
  const device = status.devices.find((d) => d.this_device)
  const next = status.upcoming.find((t) => t.remind_at && !t.sent) ?? null
  const lastSent = status.upcoming.find((t) => t.sent)

  return (
    <section className="reminder-check" aria-labelledby="check-h">
      <div className="history-head">
        <h3 id="check-h" className="section-label">
          {tr('Check reminders')}
        </h3>
        <button type="button" className="text-btn" disabled={checking} onClick={() => void check()}>
          {checking ? tr('Checking…') : tr('Check again')}
        </button>
      </div>
      <ul className="check-list">
        <Check
          state={status.service.running ? 'ok' : 'bad'}
          title={tr('Reminder service')}
          detail={
            status.service.running
              ? tr('Running · last check {value}', { value: timeAgo(status.service.last_run_at, now).toLowerCase() })
              : status.service.last_run_at
                ? tr('Stopped · last check {value}. The every-minute job isn\'t calling the server.', { value: timeAgo(status.service.last_run_at, now).toLowerCase() })
                : tr('Never ran. The every-minute job (cron-job.org) isn\'t calling the server.')
          }
        />
        <Check
          state={status.reminders_enabled ? 'ok' : 'bad'}
          title={tr('Reminders on for your account')}
          detail={status.reminders_enabled ? tr('On') : tr('Off. Tap the bell to turn them on.')}
        />
        <Check
          state={!isPushSupported() ? 'bad' : !device ? 'bad' : device.last_error ? 'bad' : 'ok'}
          title={tr('This device can receive them')}
          detail={
            !isPushSupported()
              ? tr('This browser can\'t receive notifications (on iPhone, open Todo Clock from the Home Screen).')
              : !device
                ? tr('Not registered yet. Turn reminders off and on again here, then Allow.')
                : device.last_error
                  ? tr('Last push failed: {last_error}', { last_error: device.last_error })
                  : device.last_success_at
                    ? tr('Registered · last notification delivered {value}', { value: timeAgo(device.last_success_at, now).toLowerCase() })
                    : tr('Registered · nothing sent yet. Try "Send a test notification".')
          }
        />
        <Check
          state={next ? 'ok' : 'warn'}
          title={tr('Next reminder')}
          detail={
            next
              ? tr('{title} at {value} → reminder at {value2}', { title: next.title, value: formatTime(new Date(next.due_at)), value2: formatTime(new Date(next.remind_at!)) })
              : lastSent
                ? tr('Already sent for "{title}". No other reminder in the next 2 days.', { title: lastSent.title })
                : tr('No upcoming task has a time and "Remind me" on.')
          }
        />
      </ul>
      {status.devices.length > 1 && <p className="hint">{tr('{length} devices get your reminders.', { length: status.devices.length })}</p>}
    </section>
  )
}
