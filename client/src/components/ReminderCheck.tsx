import { useCallback, useEffect, useState } from 'react'
import { api, type ReminderStatus } from '../api'
import { Icon } from '../icons'
import { currentEndpoint, isPushSupported } from '../push'
import { formatTime } from '../time'
import { timeAgo } from '../user'

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
  if (!status) return <p className="list-sub">Checking reminders…</p>

  const now = checkedAt
  const device = status.devices.find((d) => d.this_device)
  const next = status.upcoming.find((t) => t.remind_at && !t.sent) ?? null
  const lastSent = status.upcoming.find((t) => t.sent)

  return (
    <section className="reminder-check" aria-labelledby="check-h">
      <div className="history-head">
        <h3 id="check-h" className="section-label">
          Check reminders
        </h3>
        <button type="button" className="text-btn" disabled={checking} onClick={() => void check()}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
      <ul className="check-list">
        <Check
          state={status.service.running ? 'ok' : 'bad'}
          title="Reminder service"
          detail={
            status.service.running
              ? `Running · last check ${timeAgo(status.service.last_run_at, now).toLowerCase()}`
              : status.service.last_run_at
                ? `Stopped · last check ${timeAgo(status.service.last_run_at, now).toLowerCase()}. The every-minute job isn't calling the server.`
                : "Never ran. The every-minute job (cron-job.org) isn't calling the server."
          }
        />
        <Check
          state={status.reminders_enabled ? 'ok' : 'bad'}
          title="Reminders on for your account"
          detail={status.reminders_enabled ? 'On' : 'Off. Tap the bell to turn them on.'}
        />
        <Check
          state={!isPushSupported() ? 'bad' : !device ? 'bad' : device.last_error ? 'bad' : 'ok'}
          title="This device can receive them"
          detail={
            !isPushSupported()
              ? "This browser can't receive notifications (on iPhone, open To-Do from the Home Screen)."
              : !device
                ? 'Not registered yet. Turn reminders off and on again here, then Allow.'
                : device.last_error
                  ? `Last push failed: ${device.last_error}`
                  : device.last_success_at
                    ? `Registered · last notification delivered ${timeAgo(device.last_success_at, now).toLowerCase()}`
                    : 'Registered · nothing sent yet. Try "Send a test notification".'
          }
        />
        <Check
          state={next ? 'ok' : 'warn'}
          title="Next reminder"
          detail={
            next
              ? `${next.title} at ${formatTime(new Date(next.due_at))} → reminder at ${formatTime(new Date(next.remind_at!))}`
              : lastSent
                ? `Already sent for "${lastSent.title}". No other reminder in the next 2 days.`
                : 'No upcoming task has a time and "Remind me" on.'
          }
        />
      </ul>
      {status.devices.length > 1 && <p className="hint">{status.devices.length} devices get your reminders.</p>}
    </section>
  )
}
