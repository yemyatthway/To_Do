import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiError, api, auth, type Task, type TrustedDevice, type User } from '../api'
import { Loading, SkeletonRows } from '../components/Loading'
import { UsernameField } from '../components/UsernameField'
import { usernameBlocks, useUsernameCheck } from '../components/usernameCheck'
import { Icon, type IconName } from '../icons'
import { gsap, useEnterOnChange, useGsap } from '../motion'
import { SETTINGS_SECTIONS, type SettingsSection } from '../routes'
import type { ThemePreference } from '../theme'
import { initials, isValidEmail, normalizeUsername, PASSWORD_RULES, timeAgo } from '../user'
import { chooseLanguage, formatDate, language, LANGUAGES, tr } from '../i18n'

const SECTION_ICONS: Record<SettingsSection, IconName> = {
  personal: 'user',
  preferences: 'bell',
  password: 'lock',
  devices: 'shield',
  deleted: 'trash',
  help: 'help',
  delete: 'x',
}

interface ProfileProps {
  user: User
  now: Date
  /** Which child page is open; none means the list of settings. */
  section?: SettingsSection
  onOpenSection: (section: SettingsSection) => void
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
  const { user, now, section, onOpenSection, remindersBusy, themePreference, onUserChange, onToggleReminders, onOpenRemindersGuide, onThemeChange, onReplayTutorial, onOpenAdmin, onLogout, onDeleteAccount, notify, onTasksRestored } = props
  const [deleting, setDeleting] = useState(false)
  const pageRef = useRef<HTMLDivElement>(null)
  useEnterOnChange(pageRef, section ?? '')

  const [fullName, setFullName] = useState(user.full_name)
  const [username, setUsername] = useState(user.username)
  const usernameStatus = useUsernameCheck(username, { current: user.username, signedIn: true })
  const [email, setEmail] = useState(user.email)
  const [infoErrors, setInfoErrors] = useState<Record<string, string>>({})
  const [savingInfo, setSavingInfo] = useState(false)

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [pwErrors, setPwErrors] = useState<Record<string, string>>({})
  const [savingPw, setSavingPw] = useState(false)

  const usernameChanged = normalizeUsername(username) !== user.username
  const infoChanged = fullName.trim() !== user.full_name || usernameChanged || email.trim().toLowerCase() !== user.email

  async function saveInfo(e: React.FormEvent) {
    e.preventDefault()
    const next: Record<string, string> = {}
    if (!fullName.trim()) next.full_name = tr('Enter your name.')
    if (usernameChanged && usernameBlocks(usernameStatus)) next.username = usernameStatus.message
    if (!isValidEmail(email)) next.email = tr('Enter a valid email, like name@example.com.')
    setInfoErrors(next)
    if (Object.keys(next).length) return
    setSavingInfo(true)
    try {
      onUserChange(
        await auth.updateMe({ full_name: fullName.trim(), email: email.trim(), ...(usernameChanged ? { username: normalizeUsername(username) } : {}) }),
      )
      notify(tr('Profile saved'))
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) {
        setInfoErrors(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k, v.join(' ')])))
      } else {
        notify(tr('Couldn\'t save your profile'), err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSavingInfo(false)
    }
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault()
    const next: Record<string, string> = {}
    if (!oldPassword) next.old_password = tr('Enter your current password.')
    if (!PASSWORD_RULES.every((r) => r.test(newPassword))) next.new_password = tr('Your new password needs everything in the list below.')
    setPwErrors(next)
    if (Object.keys(next).length) return
    setSavingPw(true)
    try {
      await auth.changePassword(oldPassword, newPassword)
      setOldPassword('')
      setNewPassword('')
      notify(tr('Password changed'))
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) {
        setPwErrors(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k, v.join(' ')])))
      } else {
        notify(tr('Couldn\'t change your password'), err instanceof Error ? err.message : String(err))
      }
    } finally {
      setSavingPw(false)
    }
  }

  const joined = formatDate(new Date(user.date_joined), { month: 'long', year: 'numeric' })
  const localTime = formatDate(now, { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })

  return (
    <div ref={pageRef} className="profile-page">
      {!section && (
        <section className="card neu profile-hero">
        <span className="avatar avatar-lg" aria-hidden="true">
          {initials(user)}
        </span>
        <div style={{ minWidth: 0 }}>
          <h2 className="profile-name">{user.full_name || tr('Your profile')}</h2>
          <span className="list-sub profile-handle">@{user.username}</span>
          <span className="list-sub profile-email">{user.email}</span>
          <span className="list-sub">{tr('Member since {joined}', { joined })}</span>
        </div>
        </section>
      )}

      {!section && (
        <section className="card glass" aria-label={tr('Settings')}>
          <div className="panel-rows">
            {(Object.keys(SETTINGS_SECTIONS) as SettingsSection[]).map((key) => (
              <button key={key} className={`more-row${key === 'delete' ? ' danger-row' : ''}`} onClick={() => onOpenSection(key)}>
                <Icon name={SECTION_ICONS[key]} />
                <span className="person-name">{SETTINGS_SECTIONS[key]}</span>
                <Icon name="chevron" className="more-go" />
              </button>
            ))}
          </div>
        </section>
      )}

      {section === 'personal' && (
      <form className="card glass" onSubmit={saveInfo} noValidate aria-labelledby="info-h">
        <h2 id="info-h" className="sr-only">{tr('Personal info')}</h2>
        <label className="field-group">
          <span className="label">{tr('Name')}</span>
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
        <UsernameField
          value={username}
          status={usernameStatus}
          error={infoErrors.username}
          onChange={(value) => {
            setUsername(value)
            setInfoErrors((p) => ({ ...p, username: '' }))
          }}
        />
        <label className="field-group">
          <span className="label">
            {tr('Email')}
            {user.email_verified && <span className="verify-badge">{tr('Verified')}</span>}
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
            <span className="field-hint">{tr('We\'ll email a code to the new address to confirm it.')}</span>
          )}
        </label>
        <button type="submit" className="primary-btn" disabled={savingInfo || !infoChanged}>
          {savingInfo ? tr('Saving…') : tr('Save changes')}
        </button>
      </form>
      )}

      {section === 'preferences' && (
      <section className="card glass" aria-labelledby="prefs-h">
        <h2 id="prefs-h" className="sr-only">{tr('Preferences')}</h2>
        <div className="toggle-row">
          <span style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon name="bell" />
              {tr('Task reminders')}
            </span>
            <span className="hint">
              {tr('A notification before each timed task (10 min by default; change it on any task).')}{' '}<button type="button" className="link-btn" onClick={onOpenRemindersGuide}>
                {tr('Set up on your devices')}
              </button>
            </span>
          </span>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={user.reminders_enabled}
            aria-label={tr('Task reminders')}
            disabled={remindersBusy}
            onClick={onToggleReminders}
          />
        </div>

        <div className="toggle-row">
          <span style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon name="users" />
              {tr('Friends can add tasks to my list')}
            </span>
            <span className="hint">{tr('With a reminder, like "Go out at 7 PM". Off: they land in your Friends inbox for you to add.')}</span>
          </span>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={user.friends_can_add_tasks}
            aria-label={tr('Friends can add tasks to my list')}
            onClick={async () => {
              try {
                onUserChange(await auth.updateMe({ friends_can_add_tasks: !user.friends_can_add_tasks }))
              } catch (err) {
                notify(tr('Couldn\'t save that'), err instanceof Error ? err.message : String(err))
              }
            }}
          />
        </div>

        <div className="toggle-row">
          <span style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Icon name="team" />
              {tr('Workspace emails')}
            </span>
            <span className="hint">{tr('An email when someone adds work or finishes it. You\'ll always see it in the app.')}</span>
          </span>
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={user.workspace_emails}
            aria-label={tr('Workspace emails')}
            onClick={async () => {
              try {
                onUserChange(await auth.updateMe({ workspace_emails: !user.workspace_emails }))
              } catch (err) {
                notify(tr('Couldn\'t save that'), err instanceof Error ? err.message : String(err))
              }
            }}
          />
        </div>

        <div className="pref-row">
          <span className="label">{tr('Appearance')}</span>
          <div className="segmented" role="group" aria-label={tr('Appearance')}>
            {(['light', 'dark', 'auto'] as const).map((p) => (
              <button key={p} type="button" aria-pressed={themePreference === p} onClick={() => onThemeChange(p)}>
                {p === 'light' ? tr('Light') : p === 'dark' ? tr('Dark') : tr('Auto')}
              </button>
            ))}
          </div>
        </div>

        <div className="pref-row">
          <span className="label">{tr('Language')}</span>
          <div className="segmented" role="group" aria-label={tr('Language')}>
            {LANGUAGES.map((option) => (
              <button
                key={option.value}
                type="button"
                lang={option.value}
                aria-pressed={language === option.value}
                onClick={() => {
                  if (option.value === language) return
                  void auth
                    .updateMe({ language: option.value })
                    .catch(() => undefined)
                    .finally(() => chooseLanguage(option.value))
                }}
              >
                {option.name}
              </button>
            ))}
          </div>
        </div>

        <div className="pref-row">
          <span className="label">{tr('Time zone')}</span>
          <span style={{ textAlign: 'right' }}>
            <strong style={{ fontSize: 14 }}>{user.timezone || tr('Not set')}</strong>
            <br />
            <span className="hint">{tr('Follows this device · {localTime}', { localTime })}</span>
          </span>
        </div>
      </section>
      )}

      {section === 'password' && (
      <form className="card glass" onSubmit={savePassword} noValidate aria-labelledby="pw-h">
        <h2 id="pw-h" className="sr-only">{tr('Change password')}</h2>
        <input type="email" autoComplete="username" value={user.email} readOnly hidden />
        <label className="field-group">
          <span className="label">{tr('Current password')}</span>
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
          <span className="label">{tr('New password')}</span>
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
        <ul className="password-rules" aria-label={tr('Password requirements')}>
          {PASSWORD_RULES.map((rule) => {
            const ok = rule.test(newPassword)
            return (
              <li key={rule.label} className={ok ? 'ok' : ''}>
                <Icon name={ok ? 'check' : 'circle'} />
                {rule.label}
                <span className="sr-only">{ok ? tr(' (done)') : tr(' (needed)')}</span>
              </li>
            )
          })}
        </ul>
        <button type="submit" className="primary-btn" disabled={savingPw}>
          {savingPw ? tr('Changing…') : tr('Change password')}
        </button>
      </form>
      )}

      {section === 'deleted' && <RecentlyDeleted now={now} notify={notify} onRestored={onTasksRestored} />}

      {section === 'devices' && <Devices now={now} notify={notify} />}

      {section === 'help' && (
      <section className="card glass" aria-labelledby="help-h">
        <h2 id="help-h" className="sr-only">{tr('Help and account')}</h2>
        <button type="button" className="row-btn" onClick={onReplayTutorial}>
          <Icon name="help" />
          {tr('Replay the tutorial')}
          <Icon name="chevron" className="end" />
        </button>
        {onOpenAdmin && (
          <button type="button" className="row-btn" onClick={onOpenAdmin}>
            <Icon name="shield" />
            {tr('Admin dashboard')}
            <Icon name="chevron" className="end" />
          </button>
        )}
        <button type="button" className="row-btn danger" onClick={onLogout}>
          <Icon name="logout" />
          {tr('Log out')}
        </button>
      </section>
      )}

      {section === 'delete' && (
      <section className="card glass danger-zone" aria-labelledby="danger-h">
        <h2 id="danger-h" className="sr-only">{tr('Delete account')}</h2>
        <p className="list-sub" style={{ margin: 0 }}>
          {tr('Deletes your account and logs you out everywhere. You have 30 days to change your mind: just log in again to restore it. After that, your account and tasks are erased for good.')}
        </p>
        <button type="button" className="danger-btn" onClick={() => setDeleting(true)}>
          <Icon name="trash" />
          {tr('Delete my account')}
        </button>
      </section>
      )}

      {deleting && <DeleteAccountDialog email={user.email} onCancel={() => setDeleting(false)} onConfirm={onDeleteAccount} />}
    </div>
  )
}

/** Deleted tasks wait here for 7 days before they're erased. */
function RecentlyDeleted({ now, notify, onRestored }: { now: Date; notify: ProfileProps['notify']; onRestored: () => void }) {
  const [tasks, setTasks] = useState<Task[] | null>(null)
  const [error, setError] = useState('')
  const [confirmEmpty, setConfirmEmpty] = useState(false)

  const load = useCallback(() => {
    api.trash().then(setTasks, (err: Error) => setError(err.message))
  }, [])
  useEffect(load, [load])

  const drop = (id: number) => setTasks((list) => list?.filter((t) => t.id !== id) ?? null)

  async function restore(task: Task) {
    try {
      await api.restoreTask(task.id)
      drop(task.id)
      onRestored()
      notify(tr('Task restored'), task.title)
    } catch (err) {
      notify(tr('Couldn\'t restore it'), err instanceof Error ? err.message : String(err))
    }
  }

  async function purge(task: Task) {
    try {
      await api.purgeTask(task.id)
      drop(task.id)
    } catch (err) {
      notify(tr('Couldn\'t delete it'), err instanceof Error ? err.message : String(err))
    }
  }

  async function empty() {
    try {
      await api.emptyTrash()
      setTasks([])
      setConfirmEmpty(false)
    } catch (err) {
      notify(tr('Couldn\'t empty it'), err instanceof Error ? err.message : String(err))
    }
  }

  const daysLeft = (task: Task) => {
    const left = Math.ceil((new Date(task.deleted_at!).getTime() + 7 * 86_400_000 - now.getTime()) / 86_400_000)
    return left <= 1 ? tr('Erased tomorrow') : tr('Erased in {left} days', { left })
  }

  return (
    <section className="card glass" aria-labelledby="trash-h">
      <div className="history-head">
        <h2 id="trash-h" className="sr-only">{tr('Recently deleted')}</h2>
        {Boolean(tasks?.length) &&
          (confirmEmpty ? (
            <span className="confirm-inline">
              <button type="button" className="text-btn" onClick={() => setConfirmEmpty(false)}>
                {tr('Cancel')}
              </button>
              <button type="button" className="text-btn danger-text" onClick={() => void empty()}>
                {tr('Erase all')}
              </button>
            </span>
          ) : (
            <button type="button" className="text-btn" onClick={() => setConfirmEmpty(true)}>
              {tr('Empty')}
            </button>
          ))}
      </div>
      <p className="list-sub" style={{ margin: 0 }}>
        {tr('Deleted tasks stay here for 7 days, then they\'re erased for good.')}
      </p>
      {error && <div className="error-banner">{error}</div>}
      {tasks === null && <Loading active={!error} skeleton={<SkeletonRows count={2} />} onRetry={load} />}
      {tasks?.length === 0 && <p className="list-sub">{tr('Nothing here.')}</p>}
      <div>
        {tasks?.map((task) => (
          <div key={task.id} className="device-row">
            <Icon name="trash" />
            <div className="grow">
              <div className="name">{task.title}</div>
              <div className="list-sub">
                {tr('Deleted')}{' '}{timeAgo(task.deleted_at!, now).toLowerCase()} · {daysLeft(task)}
              </div>
            </div>
            <button type="button" className="text-btn" onClick={() => void restore(task)}>
              {tr('Restore')}
            </button>
            <button type="button" className="icon-btn" aria-label={tr('Erase {title} now', { title: task.title })} onClick={() => void purge(task)}>
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

  const load = useCallback(() => {
    auth.devices().then(setDevices, (err: Error) => setError(err.message))
  }, [])
  useEffect(load, [load])

  async function remove(device: TrustedDevice) {
    try {
      await auth.removeDevice(device.id)
      setDevices((list) => list?.filter((d) => d.id !== device.id) ?? null)
      notify(tr('Device removed'), device.current ? tr('This browser will need an email code at the next log in.') : tr('It will need an email code to log in again.'))
    } catch (err) {
      notify(tr('Couldn\'t remove it'), err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <section className="card glass" aria-labelledby="devices-h">
      <h2 id="devices-h" className="sr-only">{tr('Trusted devices')}</h2>
      <p className="list-sub" style={{ margin: 0 }}>
        {tr('Logging in from any other browser needs a code we email to you.')}
      </p>
      {error && <div className="error-banner">{error}</div>}
      {devices === null && <Loading active={!error} skeleton={<SkeletonRows count={2} />} onRetry={load} />}
      {devices?.length === 0 && <p className="list-sub">{tr('No trusted devices yet.')}</p>}
      <div>
        {devices?.map((device) => (
          <div key={device.id} className="device-row">
            <Icon name="shield" />
            <div className="grow">
              <div className="name">
                {device.name || tr('Browser')}
                {device.current && <span className="verify-badge">{tr('This device')}</span>}
              </div>
              <div className="list-sub">
                {tr('Last used')}{' '}{timeAgo(device.last_used_at, now)}
                {device.ip_address ? ` · ${device.ip_address}` : ''}
              </div>
            </div>
            <button type="button" className="text-btn" onClick={() => void remove(device)}>
              {tr('Remove')}
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
      setError(tr('Enter your password to confirm.'))
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
        <h2 id="delete-h">{tr('Delete your account?')}</h2>
        <p id="delete-body">
          <strong>{email}</strong> {tr('will be logged out on every device and hidden from your friends. Log in within 30 days to restore it with all its tasks; after that it\'s erased for good.')}
        </p>
        <input type="email" autoComplete="username" value={email} readOnly hidden />
        <label className="field-group" style={{ width: '100%', textAlign: 'left' }}>
          <span className="label">{tr('Password')}</span>
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
            {tr('Cancel')}
          </button>
          <button type="submit" className="danger-btn" disabled={busy}>
            {busy ? tr('Deleting…') : tr('Delete account')}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  )
}
