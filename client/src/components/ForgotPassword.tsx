import { useEffect, useState } from 'react'
import { ApiError, auth, type User } from '../api'
import { tr } from '../i18n'
import { Icon } from '../icons'
import { isValidEmail, PASSWORD_RULES } from '../user'
import { Banner } from './Banner'
import { CodeEntry, type CodeSent } from './CodeEntry'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

interface ForgotPasswordProps {
  /** Whatever was already typed on the log in form. */
  email: string
  onEmail: (email: string) => void
  onBack: () => void
  onDone: (user: User) => void
  /** The card is the log in form, so pressing Enter or the button goes through it. */
  onSubmitReady: (submit: () => void) => void
  /** The card should glide to its new height. */
  onStep: () => void
}

/** Forgot your password: your email, the code sent there, then a new password. */
export function ForgotPassword({ email, onEmail, onBack, onDone, onSubmitReady, onStep }: ForgotPasswordProps) {
  const [sent, setSent] = useState<CodeSent | null>(null)
  const [ticket, setTicket] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [fieldError, setFieldError] = useState('')
  const [busy, setBusy] = useState(false)

  async function sendCode() {
    if (!isValidEmail(email.trim())) {
      setFieldError(email.trim() ? tr('Enter a valid email, like name@example.com.') : tr('Enter your email.'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const answer = await auth.forgotPassword(email.trim())
      onStep()
      setSent(answer)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function savePassword() {
    if (!PASSWORD_RULES.every((rule) => rule.test(password))) {
      setFieldError(tr('Your new password needs everything in the list below.'))
      return
    }
    setBusy(true)
    setError('')
    setFieldError('')
    try {
      onDone(await auth.resetPassword(ticket, password))
    } catch (err) {
      if (err instanceof ApiError && err.fields.password) setFieldError(err.fields.password.join(' '))
      else setError(errorMessage(err))
      setBusy(false)
    }
  }

  useEffect(() => {
    onSubmitReady(() => {
      if (ticket) void savePassword()
      else if (!sent) void sendCode()
    })
  })

  const back = (
    <p className="list-sub" style={{ margin: 0, textAlign: 'center' }}>
      <button type="button" className="link-btn" onClick={onBack}>
        {tr('Back to log in')}
      </button>
    </p>
  )

  if (ticket) {
    return (
      <>
        <div>
          <h1 id="auth-title" className="auth-title">
            {tr('Choose a new password')}
          </h1>
          <p className="list-sub" style={{ margin: '4px 0 0' }}>
            {tr('Every other device will be logged out.')}
          </p>
        </div>
        <Banner tone="error" message={error} />
        <div className="field-group">
          <label className="label" htmlFor="reset-password">
            {tr('New password')}
          </label>
          <div className="password-field">
            <input
              id="reset-password"
              className="field"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              autoFocus
              value={password}
              aria-invalid={Boolean(fieldError)}
              onChange={(e) => {
                setPassword(e.target.value)
                setFieldError('')
              }}
            />
            <button type="button" className="text-btn" aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>
              {showPassword ? tr('Hide') : tr('Show')}
            </button>
          </div>
          {fieldError && <span className="field-error">{fieldError}</span>}
          <ul className="password-rules" aria-label={tr('Password requirements')}>
            {PASSWORD_RULES.map((rule) => {
              const ok = rule.test(password)
              return (
                <li key={rule.label} className={ok ? 'ok' : ''}>
                  <Icon name={ok ? 'check' : 'circle'} />
                  {rule.label}
                  <span className="sr-only">{ok ? tr(' (done)') : tr(' (needed)')}</span>
                </li>
              )
            })}
          </ul>
        </div>
        <button type="submit" className="primary-btn" disabled={busy} style={{ height: 52 }}>
          {busy ? tr('Saving…') : tr('Save and log in')}
        </button>
        {back}
      </>
    )
  }

  if (sent) {
    return (
      <>
        <div>
          <h1 id="auth-title" className="auth-title">
            {tr('Check your email')}
          </h1>
          <p className="list-sub" style={{ margin: '4px 0 0' }}>
            {tr('If {email} has an account, we sent a code there. It can take a minute; check your spam folder too.', { email: email.trim() })}
          </p>
        </div>
        <CodeEntry
          submitLabel={tr('Continue')}
          initialWait={sent.resend_in}
          expiresAt={sent.expires_at}
          onSubmit={async (code) => {
            const next = await auth.resetCode(email.trim(), code)
            onStep()
            setTicket(next)
          }}
          onResend={() => auth.forgotPassword(email.trim())}
        />
        {back}
      </>
    )
  }

  return (
    <>
      <div>
        <h1 id="auth-title" className="auth-title">
          {tr('Forgot your password?')}
        </h1>
        <p className="list-sub" style={{ margin: '4px 0 0' }}>
          {tr('Enter your email and we\'ll send you a code to choose a new one.')}
        </p>
      </div>
      <Banner tone="error" message={error} />
      <label className="field-group">
        <span className="label">{tr('Email')}</span>
        <input
          className="field"
          type="email"
          autoComplete="email"
          autoFocus
          placeholder="name@example.com"
          value={email}
          aria-invalid={Boolean(fieldError)}
          onChange={(e) => {
            onEmail(e.target.value)
            setFieldError('')
          }}
        />
        {fieldError && <span className="field-error">{fieldError}</span>}
      </label>
      <button type="submit" className="primary-btn" disabled={busy} style={{ height: 52 }}>
        {busy ? tr('Sending…') : tr('Send code')}
      </button>
      {back}
    </>
  )
}
