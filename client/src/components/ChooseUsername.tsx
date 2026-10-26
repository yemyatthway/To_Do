import { useRef, useState } from 'react'
import { ApiError, auth, type User } from '../api'
import { gsap, useGsap } from '../motion'
import { normalizeUsername } from '../user'
import { UsernameField } from './UsernameField'
import { usernameBlocks, useUsernameCheck } from './usernameCheck'

/**
 * Once, for accounts from before usernames: they were given one from their name, and choose to
 * keep it (one tap) or pick another. Also asks for a name if the account has none.
 */
export function ChooseUsername({ user, onDone }: { user: User; onDone: (user: User) => void }) {
  const [username, setUsername] = useState(user.username)
  const [fullName, setFullName] = useState(user.full_name)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const needsName = !user.full_name.trim()
  // The given one is theirs already, so it's always fine to keep.
  const status = useUsernameCheck(username, { current: user.username, signedIn: true })
  const cardRef = useRef<HTMLFormElement>(null)
  useGsap(cardRef, () => {
    gsap.fromTo(cardRef.current, { autoAlpha: 0, scale: 0.9, y: 20 }, { autoAlpha: 1, scale: 1, y: 0, duration: 0.7, ease: 'back.out(1.4)' })
  }, [])

  const keeping = normalizeUsername(username) === user.username

  async function save(e: React.FormEvent) {
    e.preventDefault()
    const next: Record<string, string> = {}
    if (needsName && !fullName.trim()) next.full_name = 'Enter your name.'
    if (usernameBlocks(status)) next.username = status.message
    setErrors(next)
    if (Object.keys(next).length) return
    setBusy(true)
    try {
      onDone(await auth.updateMe({ username: normalizeUsername(username), ...(needsName ? { full_name: fullName.trim() } : {}) }))
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fields).length) {
        setErrors(Object.fromEntries(Object.entries(err.fields).map(([k, v]) => [k, v.join(' ')])))
      } else {
        setErrors({ username: err instanceof Error ? err.message : String(err) })
      }
      setBusy(false)
    }
  }

  return (
    <div className="scrim center">
      <form
        ref={cardRef}
        className="welcome-card choose-username glass"
        role="dialog"
        aria-modal="true"
        aria-labelledby="choose-username-title"
        onSubmit={save}
        noValidate
      >
        <h2 id="choose-username-title">Choose your username</h2>
        <p>Friends find you by it, and it tells you apart from anyone with the same name. You can change it later in your profile.</p>
        {needsName && (
          <label className="field-group">
            <span className="label">Name</span>
            <input
              className="field"
              autoComplete="name"
              value={fullName}
              placeholder="Mia Thompson"
              onChange={(e) => {
                setFullName(e.target.value)
                setErrors((p) => ({ ...p, full_name: '' }))
              }}
            />
            {errors.full_name && <span className="field-error">{errors.full_name}</span>}
          </label>
        )}
        <UsernameField
          value={username}
          status={status}
          error={errors.username}
          onChange={(value) => {
            setUsername(value)
            setErrors((p) => ({ ...p, username: '' }))
          }}
        />
        <button type="submit" className="primary-btn" disabled={busy}>
          {busy ? 'Saving…' : keeping ? `Keep @${user.username}` : 'Save username'}
        </button>
      </form>
    </div>
  )
}
