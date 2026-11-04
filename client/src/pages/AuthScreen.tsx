import { useEffect, useRef, useState } from 'react'
import { ApiError, auth, isChallenge, isDeletedAccount, type DeletedAccount, type EmailCheck, type LoginChallenge, type User } from '../api'
import { AuthScene } from '../components/AuthScene'
import { Banner } from '../components/Banner'
import { CodeEntry } from '../components/CodeEntry'
import { ForgotPassword } from '../components/ForgotPassword'
import { Rule, type RuleState } from '../components/CheckRule'
import { UsernameField } from '../components/UsernameField'
import { usernameBlocks, useUsernameCheck } from '../components/usernameCheck'
import { Icon } from '../icons'
import { enter, gsap, useGsap } from '../motion'
import { deviceTimezone } from '../time'
import { isValidEmail, normalizeUsername, PASSWORD_RULES, usernameFromName } from '../user'
import { chooseLanguage, formatDate, language, LANGUAGES, tr } from '../i18n'

type Mode = 'login' | 'register'

export function AuthScreen({ onAuthenticated, notice }: { onAuthenticated: (user: User) => void; notice?: string }) {
  const [mode, setMode] = useState<Mode>('login')
  const [fullName, setFullName] = useState('')
  const [username, setUsername] = useState('')
  // Until they type one, the username follows the name ("Ryen Kai" -> ryenkai).
  const [usernameEdited, setUsernameEdited] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState('')
  // Messages from outside ("session expired", "account deleted") fade after a few seconds.
  const [noticeText, setNoticeText] = useState(notice ?? '')
  const [busy, setBusy] = useState(false)
  // Set when this browser needs the emailed sign-in code.
  const [challenge, setChallenge] = useState<LoginChallenge | null>(null)
  // Set when the password was right for an account its owner deleted recently.
  const [deleted, setDeleted] = useState<DeletedAccount | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [forgot, setForgot] = useState(false)
  const [stepTick, setStepTick] = useState(0)
  const forgotSubmit = useRef<() => void>(() => {})
  // Server checks for the address as typed (kept with the value they're for).
  const [emailHint, setEmailHint] = useState<(EmailCheck & { for: string }) | null>(null)
  const [emailTouched, setEmailTouched] = useState(false)

  const registering = mode === 'register'
  const usernameStatus = useUsernameCheck(registering ? username : '')
  const cardRef = useRef<HTMLFormElement>(null)

  const pageRef = useRef<HTMLDivElement>(null)
  // Opacity and position only: scaling a frosted card makes the browser redo its blur every frame.
  useGsap(pageRef, () => {
    gsap.fromTo(cardRef.current, { autoAlpha: 0, y: 26 }, { autoAlpha: 1, y: 0, duration: 0.8, ease: 'expo.out' })
  }, [])

  // Switching between log in and sign up: the card smoothly grows or shrinks to its new height
  // (instead of jumping), while the fields settle in just behind it.
  const shownMode = useRef<string>(mode)
  const heightBefore = useRef(0)
  const step = forgot ? `forgot-${stepTick}` : challenge ? 'code' : deleted ? 'restore' : mode
  useGsap(cardRef, () => {
    if (shownMode.current === step) return
    shownMode.current = step
    const card = cardRef.current!
    gsap.fromTo(
      card,
      { height: heightBefore.current, overflow: 'hidden' },
      {
        height: card.offsetHeight,
        duration: 0.5,
        ease: 'power3.inOut',
        clearProps: 'height,overflow',
      },
    )
    enter(card.querySelectorAll(':scope > :not(.auth-tabs)'), {
      y: 8,
      duration: 0.45,
      stagger: 0.035,
      delay: 0.05,
    })
  }, [step])

  function switchMode(next: Mode) {
    if (next === mode) return
    heightBefore.current = cardRef.current?.offsetHeight ?? 0
    setMode(next)
    setErrors({})
    setFormError('')
    setEmailHint(null)
  }

  // Live email checks while typing (like the password rules): the format right away, then once
  // typing pauses the server checks for throwaway inboxes and a domain that can receive mail.
  const typedEmail = email.trim().toLowerCase()
  const formatOk = isValidEmail(typedEmail)
  const hint = emailHint?.for === typedEmail ? emailHint : null
  useEffect(() => {
    if (!registering || !formatOk) return
    let live = true
    const id = setTimeout(() => {
      auth.checkEmail(typedEmail).then(
        (result) => live && setEmailHint({ ...result, for: typedEmail }),
        () => undefined, // offline or throttled: the server checks again on submit
      )
    }, 500)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [typedEmail, formatOk, registering])

  const serverRule = (value: boolean | null | undefined): RuleState => (!formatOk || value === null ? 'wait' : !hint ? 'checking' : value ? 'ok' : 'bad')

  function validate() {
    const next: Record<string, string> = {}
    if (registering && !fullName.trim()) next.full_name = tr('Enter your name.')
    if (registering && usernameBlocks(usernameStatus)) next.username = usernameStatus.message
    if (!email.trim()) next.email = tr('Enter your email.')
    else if (!isValidEmail(email)) next.email = tr('Enter a valid email, like name@example.com.')
    if (!password) next.password = tr('Enter your password.')
    else if (registering && !PASSWORD_RULES.every((r) => r.test(password))) next.password = tr('Your password needs everything in the list below.')
    setErrors(next)
    return Object.keys(next).length === 0
  }

  // Typing means the person has moved on: old messages fold away.
  function editing() {
    setFormError('')
    setNoticeText('')
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (forgot) {
      forgotSubmit.current()
      return
    }
    setFormError('')
    setNoticeText('')
    if (!validate()) return
    setBusy(true)
    try {
      const result = registering
        ? await auth.register({
            full_name: fullName.trim(),
            username: normalizeUsername(username),
            email: email.trim(),
            password,
            timezone: deviceTimezone(),
            language,
          })
        : await auth.login(email.trim(), password)
      if (isDeletedAccount(result)) {
        heightBefore.current = cardRef.current?.offsetHeight ?? 0
        setDeleted(result)
        setBusy(false)
        return
      }
      if (isChallenge(result)) {
        heightBefore.current = cardRef.current?.offsetHeight ?? 0
        setChallenge(result)
        setBusy(false)
        return
      }
      onAuthenticated(result)
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) {
        const { non_field_errors, ...fields } = err.fields
        setErrors(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.join(' ')])))
        if (non_field_errors)
          setErrors((prev) => ({
            ...prev,
            password: non_field_errors.join(' '),
          }))
      } else {
        setFormError(err instanceof Error ? err.message : String(err))
      }
      setBusy(false)
    }
  }

  async function restore() {
    setBusy(true)
    setFormError('')
    try {
      const result = await auth.login(email.trim(), password, true)
      heightBefore.current = cardRef.current?.offsetHeight ?? 0
      if (isChallenge(result)) {
        setRestoring(true)
        setDeleted(null)
        setChallenge(result)
        setBusy(false)
      } else if (!isDeletedAccount(result)) {
        onAuthenticated(result)
      }
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  const glide = () => {
    heightBefore.current = cardRef.current?.offsetHeight ?? 0
    setStepTick((n) => n + 1)
  }

  function backToLogin() {
    heightBefore.current = cardRef.current?.offsetHeight ?? 0
    setChallenge(null)
    setDeleted(null)
    setRestoring(false)
    setPassword('')
  }

  const fieldError = (name: string) =>
    errors[name] && (
      <span className="field-error" id={`${name}-error`}>
        {errors[name]}
      </span>
    )

  return (
    <div ref={pageRef} className="auth-page">
      <AuthScene />
      <div className="segmented auth-language" role="group" aria-label={tr('Language')}>
        {LANGUAGES.map((option) => (
          <button key={option.value} type="button" lang={option.value} aria-pressed={language === option.value} onClick={() => option.value !== language && chooseLanguage(option.value)}>
            {option.name}
          </button>
        ))}
      </div>
      <div className="auth-brand">
        <span className="auth-logo" aria-hidden="true">
          <Icon name="clock" />
        </span>
        <span>{tr('Todo Clock')}</span>
      </div>

      <form ref={cardRef} className="auth-card glass" onSubmit={submit} noValidate aria-labelledby="auth-title">
        {forgot ? (
          <ForgotPassword
            email={email}
            onEmail={setEmail}
            onBack={() => {
              glide()
              setForgot(false)
            }}
            onDone={onAuthenticated}
            onSubmitReady={(run) => (forgotSubmit.current = run)}
            onStep={glide}
          />
        ) : deleted ? (
          <>
            <div>
              <h1 id="auth-title" className="auth-title">
                {tr('Restore your account?')}
              </h1>
              <p className="list-sub" style={{ margin: '4px 0 0' }}>
                {tr('This account was deleted. You can bring it back, with all its tasks, until')}{' '}<strong>{formatDate(new Date(deleted.restore_until), { day: 'numeric', month: 'long', year: 'numeric' })}</strong>{tr('. After that it\'s erased for good.')}
              </p>
            </div>
            <Banner tone="error" message={formError} />
            <button type="button" className="primary-btn" disabled={busy} style={{ height: 52 }} onClick={() => void restore()}>
              {busy ? tr('Restoring…') : tr('Restore my account')}
            </button>
            <p className="list-sub" style={{ margin: 0, textAlign: 'center' }}>
              <button type="button" className="link-btn" onClick={backToLogin}>
                {tr('Not now')}
              </button>
            </p>
          </>
        ) : challenge ? (
          <>
            <div>
              <h1 id="auth-title" className="auth-title">
                {tr('Check your email')}
              </h1>
              <p className="list-sub" style={{ margin: '4px 0 0' }}>
                {restoring ? tr('To restore your account, enter') : tr('This browser is new to your account. Enter')} {tr('the code we sent to')}{' '}<strong>{challenge.email}</strong>.
              </p>
            </div>
            <CodeEntry
              submitLabel={tr('Verify and log in')}
              initialWait={challenge.resend_in}
              expiresAt={challenge.expires_at}
              onSubmit={async (code) => onAuthenticated(await auth.verifyLogin(challenge.challenge, code))}
              onResend={() => auth.resendLogin(challenge.challenge)}
            />
            <p className="list-sub" style={{ margin: 0, textAlign: 'center' }}>
              <button type="button" className="link-btn" onClick={backToLogin}>
                {tr('Back to log in')}
              </button>
            </p>
          </>
        ) : (
          <>
            <div className={`segmented auth-tabs${registering ? ' right' : ''}`} role="group" aria-label={tr('Log in or sign up')}>
              <span className="seg-knob" aria-hidden="true" />
              <button type="button" aria-pressed={!registering} onClick={() => switchMode('login')}>
                {tr('Log in')}
              </button>
              <button type="button" aria-pressed={registering} onClick={() => switchMode('register')}>
                {tr('Sign up')}
              </button>
            </div>

            <div>
              <h1 id="auth-title" className="auth-title">
                {registering ? tr('Create your account') : tr('Welcome back')}
              </h1>
              <p className="list-sub" style={{ margin: '4px 0 0' }}>
                {registering ? tr('Your tasks and reminders, on a clock.') : tr('Log in to see your tasks.')}
              </p>
            </div>

            <Banner tone="notice" message={noticeText} autoHideMs={6000} onHide={() => setNoticeText('')} />
            <Banner tone="error" message={formError} />

            {registering && (
              <label className="field-group">
                <span className="label">{tr('Name')}</span>
                <input
                  className="field"
                  autoComplete="name"
                  value={fullName}
                  placeholder={tr('Mia Thompson')}
                  aria-invalid={Boolean(errors.full_name)}
                  aria-describedby={errors.full_name ? 'full_name-error' : undefined}
                  onChange={(e) => {
                    editing()
                    setFullName(e.target.value)
                    if (!usernameEdited) setUsername(usernameFromName(e.target.value))
                    setErrors((p) => ({ ...p, full_name: '' }))
                  }}
                />
                {fieldError('full_name')}
              </label>
            )}

            {registering && (
              <UsernameField
                value={username}
                status={usernameStatus}
                error={errors.username}
                onChange={(value) => {
                  editing()
                  setUsername(value)
                  setUsernameEdited(true)
                  setErrors((p) => ({ ...p, username: '' }))
                }}
              />
            )}

            <label className="field-group">
              <span className="label">{tr('Email')}</span>
              <input
                className="field"
                type="email"
                autoComplete="email"
                inputMode="email"
                value={email}
                placeholder="name@example.com"
                aria-invalid={Boolean(errors.email)}
                aria-describedby={errors.email ? 'email-error' : undefined}
                onChange={(e) => {
                  editing()
                  setEmail(e.target.value)
                  setErrors((p) => ({ ...p, email: '' }))
                }}
                onBlur={() => setEmailTouched(true)}
              />
              {fieldError('email')}
              {typedEmail && (
                <ul className="password-rules" aria-label={tr('Email checks')} aria-live="polite">
                  <Rule state={formatOk ? 'ok' : emailTouched ? 'bad' : 'wait'} label={formatOk || !emailTouched ? tr('Valid email format') : tr('Not a valid email address')} />
                  {registering && (
                    <>
                      <Rule state={serverRule(hint?.checks.real_inbox)} label={hint?.checks.real_inbox === false ? tr('Temporary inbox') : tr('Real inbox')} />
                      <Rule
                        state={serverRule(hint?.checks.receives_mail)}
                        label={hint?.checks.receives_mail === false ? tr('Domain can\'t receive email') : tr('Domain receives email')}
                      />
                    </>
                  )}
                </ul>
              )}
              {hint?.suggestion && (
                <span className="field-hint">
                  {tr('Did you mean')}{' '}<button
                    type="button"
                    className="link-btn"
                    onClick={() => {
                      setEmail(hint.suggestion!)
                      setErrors((p) => ({ ...p, email: '' }))
                    }}
                  >
                    {hint.suggestion}
                  </button>
                  ?
                </span>
              )}
            </label>

            <div className="field-group">
              <label className="label" htmlFor="auth-password">
                {tr('Password')}
              </label>
              <div className="password-field">
                <input
                  id="auth-password"
                  className="field"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={registering ? 'new-password' : 'current-password'}
                  value={password}
                  aria-invalid={Boolean(errors.password)}
                  aria-describedby={errors.password ? 'password-error' : undefined}
                  onChange={(e) => {
                    editing()
                    setPassword(e.target.value)
                    setErrors((p) => ({ ...p, password: '' }))
                  }}
                />
                <button type="button" className="text-btn" aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>
                  {showPassword ? tr('Hide') : tr('Show')}
                </button>
              </div>
              {fieldError('password')}
              {!registering && (
                <button
                  type="button"
                  className="link-btn auth-forgot"
                  onClick={() => {
                    glide()
                    setFormError('')
                    setForgot(true)
                  }}
                >
                  {tr('Forgot password?')}
                </button>
              )}
              {registering && (
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
              )}
            </div>

            <button type="submit" className="primary-btn" disabled={busy} style={{ height: 52 }}>
              {busy ? (registering ? tr('Creating account…') : tr('Logging in…')) : registering ? tr('Create account') : tr('Log in')}
            </button>

            <p className="list-sub" style={{ margin: 0, textAlign: 'center' }}>
              {registering ? tr('Already have an account? ') : tr('New here? ')}
              <button type="button" className="link-btn" onClick={() => switchMode(registering ? 'login' : 'register')}>
                {registering ? tr('Log in') : tr('Create an account')}
              </button>
            </p>
          </>
        )}
      </form>
    </div>
  )
}
