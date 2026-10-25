import { useRef, useState } from 'react'
import { auth, type User } from '../api'
import { AuthScene } from '../components/AuthScene'
import { CodeEntry } from '../components/CodeEntry'
import { Icon } from '../icons'
import { gsap, useGsap } from '../motion'
import { isValidEmail } from '../user'

// A code lasts 10 minutes and "Send again" opens 60 s after it was sent; work that out from its
// expiry so a reload doesn't restart the wait.
const CODE_LIFETIME_S = 600
const RESEND_WAIT_S = 60
function resendWait(expiresAt: string | null) {
  if (!expiresAt) return 0
  const sentAt = new Date(expiresAt).getTime() - CODE_LIFETIME_S * 1000
  return Math.max(0, Math.ceil(RESEND_WAIT_S - (Date.now() - sentAt) / 1000))
}

/** Shown after sign-up (or an email change) until the emailed code is entered. */
export function VerifyEmail({ user, onVerified, onLogout }: { user: User; onVerified: (user: User) => void; onLogout: () => void }) {
  const [changing, setChanging] = useState(false)
  const [email, setEmail] = useState(user.email)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // Remounts the code box (fresh countdown) after the address changes.
  const [sentAt, setSentAt] = useState(0)

  const pageRef = useRef<HTMLDivElement>(null)
  useGsap(pageRef, () => {
    gsap.fromTo('.auth-card', { autoAlpha: 0, y: 26 }, { autoAlpha: 1, y: 0, duration: 0.8, ease: 'expo.out' })
  }, [])

  async function changeEmail(e: React.FormEvent) {
    e.preventDefault()
    if (!isValidEmail(email)) return setError('Enter a valid email, like name@example.com.')
    setBusy(true)
    setError('')
    try {
      onVerified(await auth.updateMe({ email: email.trim() }))
      setChanging(false)
      setSentAt(Date.now())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setBusy(false)
  }

  return (
    <div ref={pageRef} className="auth-page">
      <AuthScene />
      <div className="auth-brand">
        <span className="auth-logo" aria-hidden="true">
          <Icon name="clock" />
        </span>
        <span>To-Do</span>
      </div>

      <div className="auth-card glass" role="region" aria-labelledby="verify-title">
        <div>
          <h1 id="verify-title" className="auth-title">
            Verify your email
          </h1>
          <p className="list-sub" style={{ margin: '4px 0 0' }}>
            We sent a 6-digit code to <strong>{user.email}</strong>. It can take a minute; check your spam folder too.
          </p>
        </div>

        {changing ? (
          <form className="code-entry" onSubmit={changeEmail} noValidate>
            <label className="field-group">
              <span className="label">Email</span>
              <input
                className="field"
                type="email"
                autoComplete="email"
                inputMode="email"
                value={email}
                aria-invalid={Boolean(error)}
                onChange={(e) => {
                  setEmail(e.target.value)
                  setError('')
                }}
              />
              {error && (
                <span className="field-error" role="alert">
                  {error}
                </span>
              )}
            </label>
            <button type="submit" className="primary-btn" disabled={busy} style={{ height: 52 }}>
              {busy ? 'Saving…' : 'Send the code here'}
            </button>
            <button type="button" className="link-btn" onClick={() => setChanging(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <CodeEntry
            key={sentAt}
            submitLabel="Verify email"
            initialWait={resendWait(user.code_expires_at)}
            expiresAt={user.code_expires_at}
            onSubmit={async (code) => onVerified(await auth.verifyEmail(code))}
            onResend={() => auth.resendVerifyEmail()}
          />
        )}

        <p className="list-sub" style={{ margin: 0, textAlign: 'center' }}>
          {!changing && (
            <>
              <button type="button" className="link-btn" onClick={() => setChanging(true)}>
                Wrong email? Change it
              </button>
              {' · '}
            </>
          )}
          <button type="button" className="link-btn" onClick={onLogout}>
            Log out
          </button>
        </p>
      </div>
    </div>
  )
}
