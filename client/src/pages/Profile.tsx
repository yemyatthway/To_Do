import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiError, api, auth, type Task, type TrustedDevice, type User } from '../api'
import { Icon } from '../icons'
import { gsap, useGsap } from '../motion'
import type { ThemePreference } from '../theme'
import { initials, isValidEmail, PASSWORD_RULES, timeAgo } from '../user'

interface ProfileProps {
  user: User
  now: Date
  remindersBusy: boolean
  themePreference: ThemePreference
  onUserChange: (user: User) => void
  onToggleReminders: () => void
  /** How to set up reminders on iPhone, Android, Mac and Windows. */
  onOpenRemindersGuide: () => void
  onThemeChange: (pref: ThemePreference) => void
  onReplayTutorial: () => void
  /** Only passed for staff accounts. */
  onOpenAdmin?: () => void
  onLogout: () => void
  /** Throws (e.g. wrong password) so the dialog can show the error. */
  onDeleteAccount: (password: string) => Promise<void>
  notify: (title: string, detail?: string) => void
  /** A task came back from Recently deleted: refresh the clock and lists. */
  onTasksRestored: () => void
}

export function Profile(props: ProfileProps) {
  const { user, now, remindersBusy, themePreference, onUserChange, onToggleReminders, onOpenRemindersGuide, onThemeChange, onReplayTutorial, onOpenAdmin, onLogout, onDeleteAccount, notify, onTasksRestored } = props
  const [deleting, setDeleting] = useState(false)

  const [fullName, setFullName] = useState(user.full_name)
  const [email, setEmail] = useState(user.email)
  const [infoErrors, setInfoErrors] = useState<Record<string, string>>({})
  const [savingInfo, setSavingInfo] = useState(false)

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [pwErrors, setPwErrors] = useState<Record<string, string>>({})
  const [savingPw, setSavingPw] = useState(false)

  const infoChanged = fullName.trim() !== user.full_name || email.trim().toLowerCase() !== user.email

  async function saveInfo(e: React.FormEvent) {
    e.preventDefault()
    const next: Record<string, string> = {}
    if (!fullName.trim()) next.full_name = 'Enter your name.'
    if (!isValidEmail(email)) next.email = 'Enter a valid email, like name@example.com.'
    setInfoErrors(next)
    if (Object.keys(next).length) return
    setSavingInfo(true)
    try {
      onUserChange(await auth.updateMe({ full_name: fullName.trim(), email: email.trim() }))
      notify('Profile saved')
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) {
        setInfoErrors(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k, v.join(' ')])))
      } else {
        notify("Couldn't save your profile", err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSavingInfo(false)
    }
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault()
    const next: Record<string, string> = {}
    if (!oldPassword) next.old_password = 'Enter your current password.'
    if (!PASSWORD_RULES.every((r) => r.test(newPassword))) next.new_password = 'Your new password needs everything in the list below.'
    setPwErrors(next)
    if (Object.keys(next).length) return
    setSavingPw(true)
    try {
      await auth.changePassword(oldPassword, newPassword)
      setOldPassword('')
      setNewPassword('')
      notify('Password changed')
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) {
        setPwErrors(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k, v.join(' ')])))
      } else {
        notify("Couldn't change your password", err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSavingPw(false)
    }
  }

  const joined = new Date(user.date_joined).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const localTime = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })

  return (
    <div className="profile-page">
      <section className="card neu profile-hero">
        <span className="avatar avatar-lg" aria-hidden="true">
          {initials(user)}
        </span>
        <div style={{ minWidth: 0 }}>
          <h2 className="profile-name">{user.full_name || 'Your profile'}</h2>
          <span className="list-sub profile-email">{user.email}</span>
          <span className="list-sub">Member since {joined}</span>
        </div>
      </section>

      <form className="card glass" onSubmit={saveInfo} noValidate aria-labelledby="info-h">
        <h2 id="info-h">Personal info</h2>
        <label className="field-group">
          <span className="label">Name</span>
          <input
            className="field"
            autoComplete="name"
            value={fullName}
            aria-invalid={Boolean(infoErrors.full_name)}
            onChange={(e) => {
              setFullName(e.target.value)
              setInfoErrors((p) => ({ ...p, full_name: '' }))
            }}
          />
          {infoErrors.full_name && <span className="field-error">{infoErrors.full_name}</span>}
        </label>
        <label className="field-group">
          <span className="label">
            Email
            {user.email_verified && <span className="verify-badge">Verified</span>}
          </span>
          <input
            className="field"
            type="email"
            autoComplete="email"
            value={email}
            aria-invalid={Boolean(infoErrors.email)}
            onChange={(e) => {
              setEmail(e.target.value)
              setInfoErrors((p) => ({ ...p, email: '' }))
            }}
          />
          {infoErrors.email && <span className="field-error">{infoErrors.email}</span>}
          {email.trim().toLowerCase() !== user.email && !infoErrors.email && (
            <span className="field-hint">We'll email a code to the new address to confirm it.</span>
          )}
        </label>
        <button type="submit" className="primary-btn" disabled={savingInfo || !infoChanged}>
          {savingInfo ? 'Saving…' : 'Save changes'}
        </button>
      </form>

      <section className="card glass" aria-labelledby="prefs-h">
        <h2 id="prefs-h">Preferences</h2>
        <div className="toggle-row">
          <span style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon name="bell" />
              Task reminders
            </span>
            <span className="hint">
              A notification 10 minutes before each timed task.{' '}
              <button type="button" className="link-btn" onClick={onOpenRemindersGuide}>
                Set up on your devices
              </button>
            </span>
          </span>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={user.reminders_enabled}
            aria-label="Task reminders"
            disabled={remindersBusy}
            onClick={onToggleReminders}
          />
        </div>

        <div className="pref-row">
          <span className="label">Appearance</span>
          <div className="segmented" role="group" aria-label="Appearance">
            {(['light', 'dark', 'auto'] as const).map((p) => (
              <button key={p} type="button" aria-pressed={themePreference === p} onClick={() => onThemeChange(p)}>
                {p === 'light' ? 'Light' : p === 'dark' ? 'Dark' : 'Auto'}
              </button>
            ))}
          </div>
        </div>

        <div className="pref-row">
          <span className="label">Time zone</span>
          <span style={{ textAlign: 'right' }}>
            <strong style={{ fontSize: 14 }}>{user.timezone || 'Not set'}</strong>
            <br />
            <span className="hint">Follows this device · {localTime}</span>
          </span>
        </div>
      </section>

      <form className="card glass" onSubmit={savePassword} noValidate aria-labelledby="pw-h">
        <h2 id="pw-h">Change password</h2>
        <input type="email" autoComplete="username" value={user.email} readOnly hidden />
        <label className="field-group">
          <span className="label">Current password</span>
          <input
            className="field"
            type="password"
            autoComplete="current-password"
            value={oldPassword}
            aria-invalid={Boolean(pwErrors.old_password)}
            onChange={(e) => {
              setOldPassword(e.target.value)
              setPwErrors((p) => ({ ...p, old_password: '' }))
            }}
          />
          {pwErrors.old_password && <span className="field-error">{pwErrors.old_password}</span>}
        </label>
        <label className="field-group">
          <span className="label">New password</span>
          <input
            className="field"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            aria-invalid={Boolean(pwErrors.new_password)}
            onChange={(e) => {
              setNewPassword(e.target.value)
              setPwErrors((p) => ({ ...p, new_password: '' }))
            }}
          />
          {pwErrors.new_password && <span className="field-error">{pwErrors.new_password}</span>}
        </label>
        <ul className="password-rules" aria-label="Password requirements">
          {PASSWORD_RULES.map((rule) => {
            const ok = rule.test(newPassword)
            return (
              <li key={rule.label} className={ok ? 'ok' : ''}>
                <Icon name={ok ? 'check' : 'circle'} />
                {rule.label}
                <span className="sr-only">{ok ? ' (done)' : ' (needed)'}</span>
              </li>
            )
          })}
        </ul>
        <button type="submit" className="primary-btn" disabled={savingPw}>
          {savingPw ? 'Changing…' : 'Change password'}
        </button>
      </form>

      <RecentlyDeleted now={now} notify={notify} onRestored={onTasksRestored} />

      <Devices now={now} notify={notify} />

      <section className="card glass" aria-labelledby="help-h">
        <h2 id="help-h">Help and account</h2>
        <button type="button" className="row-btn" onClick={onReplayTutorial}>
          <Icon name="help" />
          Replay the tutorial
          <Icon name="chevron" className="end" />
        </button>
        {onOpenAdmin && (
          <button type="button" className="row-btn" onClick={onOpenAdmin}>
            <Icon name="shield" />
            Admin dashboard
            <Icon name="chevron" className="end" />
          </button>
        )}
        <button type="button" className="row-btn danger" onClick={onLogout}>
          <Icon name="logout" />
          Log out
        </button>
      </section>

      <section className="card glass danger-zone" aria-labelledby="danger-h">
        <h2 id="danger-h">Delete account</h2>
        <p className="list-sub" style={{ margin: 0 }}>
          Deletes your account and logs you out everywhere. You have 30 days to change your mind: just log in again to restore it. After that, your account and tasks are erased for good.
        </p>
        <button type="button" className="danger-btn" onClick={() => setDeleting(true)}>
          <Icon name="trash" />
          Delete my account
        </button>
      </section>

      {deleting && <DeleteAccountDialog email={user.email} onCancel={() => setDeleting(false)} onConfirm={onDeleteAccount} />}
    </div>
  )
}

/** Deleted tasks wait here for 7 days before they're erased. */
function RecentlyDeleted({ now, notify, onRestored }: { now: Date; notify: ProfileProps['notify']; onRestored: () => void }) {
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [error, setError] = useState('')
  const [confirmEmpty, setConfirmEmpty] = useState(false)

  useEffect(() => {
    api.trash().then(setTasks, (err: Error) => setError(err.message))
  }, [])

  const drop = (id: number) => setTasks((list) => list?.filter((t) => t.id !== id) ?? null)

  async function restore(task: Task) {
    try {
      await api.restoreTask(task.id)
      drop(task.id)
      onRestored()
      notify('Task restored', task.title)
    } catch (err) {
      notify("Couldn't restore it", err instanceof Error ? err.message : String(err))
    }
  }

  async function purge(task: Task) {
    try {
      await api.purgeTask(task.id)
      drop(task.id)
    } catch (err) {
      notify("Couldn't delete it", err instanceof Error ? err.message : String(err))
    }
  }

  async function empty() {
    try {
      await api.emptyTrash()
      setTasks([])
      setConfirmEmpty(false)
    } catch (err) {
      notify("Couldn't empty it", err instanceof Error ? err.message : String(err))
    }
  }

  const daysLeft = (task: Task) => {
    const left = Math.ceil((new Date(task.deleted_at!).getTime() + 7 * 86_400_000 - now.getTime()) / 86_400_000)
    return left <= 1 ? 'Erased tomorrow' : `Erased in ${left} days`
  }

  return (
    <section className="card glass" aria-labelledby="trash-h">
      <div className="history-head">
        <h2 id="trash-h">Recently deleted</h2>
        {Boolean(tasks?.length) &&
          (confirmEmpty ? (
            <span className="confirm-inline">
              <button type="button" className="text-btn" onClick={() => setConfirmEmpty(false)}>
                Cancel
              </button>
              <button type="button" className="text-btn danger-text" onClick={() => void empty()}>
                Erase all
              </button>
            </span>
          ) : (
            <button type="button" className="text-btn" onClick={() => setConfirmEmpty(true)}>
              Empty
            </button>
          ))}
      </div>
      <p className="list-sub" style={{ margin: 0 }}>
        Deleted tasks stay here for 7 days, then they're erased for good.
      </p>
      {error && <div className="error-banner">{error}</div>}
      {tasks === null && !error && <p className="list-sub">Loading…</p>}
      {tasks?.length === 0 && <p className="list-sub">Nothing here.</p>}
      <div>
        {tasks?.map((task) => (
          <div key={task.id} className="device-row">
            <Icon name="trash" />
            <div className="grow">
              <div className="name">{task.title}</div>
              <div className="list-sub">
                Deleted {timeAgo(task.deleted_at!, now).toLowerCase()} · {daysLeft(task)}
              </div>
            </div>
            <button type="button" className="text-btn" onClick={() => void restore(task)}>
              Restore
            </button>
            <button type="button" className="icon-btn" aria-label={`Erase ${task.title} now`} onClick={() => void purge(task)}>
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

/** Browsers that can log in without an email code. Removing one means it needs a code next time. */
function Devices({ now, notify }: { now: Date; notify: ProfileProps['notify'] }) {
  const [devices, setDevices] = useState<TrustedDevice[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    auth.devices().then(setDevices, (err: Error) => setError(err.message))
  }, [])

  async function remove(device: TrustedDevice) {
    try {
      await auth.removeDevice(device.id)
      setDevices((list) => list?.filter((d) => d.id !== device.id) ?? null)
      notify('Device removed', device.current ? 'This browser will need an email code at the next log in.' : 'It will need an email code to log in again.')
    } catch (err) {
      notify("Couldn't remove it", err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="card glass" aria-labelledby="devices-h">
      <h2 id="devices-h">Trusted devices</h2>
      <p className="list-sub" style={{ margin: 0 }}>
        Logging in from any other browser needs a code we email to you.
      </p>
      {error && <div className="error-banner">{error}</div>}
      {devices === null && !error && <p className="list-sub">Loading…</p>}
      {devices?.length === 0 && <p className="list-sub">No trusted devices yet.</p>}
      <div>
        {devices?.map((device) => (
          <div key={device.id} className="device-row">
            <Icon name="shield" />
            <div className="grow">
              <div className="name">
                {device.name || 'Browser'}
                {device.current && <span className="verify-badge">This device</span>}
              </div>
              <div className="list-sub">
                Last used {timeAgo(device.last_used_at, now)}
                {device.ip_address ? ` · ${device.ip_address}` : ''}
              </div>
            </div>
            <button type="button" className="text-btn" onClick={() => void remove(device)}>
              Remove
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

function DeleteAccountDialog({
  email,
  onCancel,
  onConfirm,
}: {
  email: string
  onCancel: () => void
  onConfirm: (password: string) => Promise<void>
}) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const cardRef = useRef<HTMLFormElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useGsap(cardRef, () => {
    gsap.fromTo(cardRef.current, { autoAlpha: 0, scale: 0.94, y: 14 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.45, ease: 'back.out(1.5)' })
  }, [])

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel, busy])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!password) {
      setError('Enter your password to confirm.')
      inputRef.current?.focus()
      return
    }
    setBusy(true)
    try {
      await onConfirm(password)
    } catch (err) {
      setError(err instanceof ApiError && err.fields.password ? err.fields.password.join(' ') : err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return createPortal(
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && !busy && onCancel()}>
      <form
        ref={cardRef}
        className="welcome-card glass confirm-card"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-h"
        aria-describedby="delete-body"
        onSubmit={submit}
        noValidate
      >
        <span className="confirm-icon danger" aria-hidden="true">
          <Icon name="trash" />
        </span>
        <h2 id="delete-h">Delete your account?</h2>
        <p id="delete-body">
          <strong>{email}</strong> will be logged out on every device and hidden from your friends. Log in within 30 days to restore it with all its tasks; after that it's erased for good.
        </p>
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <label className="field-group" style={{ width: '100%', textAlign: 'left' }}>
          <span className="label">Password</span>
          <input
            ref={inputRef}
            className="field"
            type="password"
            autoComplete="current-password"
            value={password}
            aria-invalid={Boolean(error)}
            aria-describedby={error ? 'delete-error' : undefined}
            onChange={(e) => {
              setPassword(e.target.value)
              setError('')
            }}
          />
          {error && (
            <span className="field-error" id="delete-error" role="alert">
              {error}
            </span>
          )}
        </label>
        <div className="confirm-actions">
          <button type="button" className="text-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="danger-btn" disabled={busy}>
            {busy ? 'Deleting…' : 'Delete account'}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
