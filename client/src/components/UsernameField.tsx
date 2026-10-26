import { Rule } from './CheckRule'
import type { UsernameStatus } from './usernameCheck'

interface UsernameFieldProps {
  value: string
  status: UsernameStatus
  onChange: (value: string) => void
  /** From the server after saving, e.g. taken in the meantime. */
  error?: string
  autoFocus?: boolean
}

export function UsernameField({ value, status, onChange, error, autoFocus }: UsernameFieldProps) {
  const showRule = status.state !== 'empty' && status.state !== 'current'
  return (
    <label className="field-group">
      <span className="label">Username</span>
      <span className="username-input">
        <span aria-hidden="true">@</span>
        <input
          className="field"
          value={value}
          placeholder="your.name"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={21}
          autoFocus={autoFocus}
          aria-invalid={Boolean(error) || status.state === 'invalid' || status.state === 'taken'}
          onChange={(e) => onChange(e.target.value.replace(/\s/g, '').toLowerCase())}
        />
      </span>
      {error ? (
        <span className="field-error">{error}</span>
      ) : (
        showRule && (
          <ul className="password-rules" aria-label="Username check" aria-live="polite">
            <Rule
              state={status.state === 'ok' ? 'ok' : status.state === 'checking' ? 'checking' : 'bad'}
              label={status.state === 'ok' ? `@${status.value} is available` : status.state === 'checking' ? `@${status.value}` : status.message}
            />
          </ul>
        )
      )}
      {!error && status.suggestion && (
        <span className="field-hint">
          Try{' '}
          <button type="button" className="link-btn" onClick={() => onChange(status.suggestion!)}>
            @{status.suggestion}
          </button>
        </span>
      )}
      {!error && !showRule && <span className="field-hint">People can find you by it. Letters, numbers, dots and underscores.</span>}
    </label>
  )
}
