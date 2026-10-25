import { useEffect, useRef, useState } from 'react'
import { Icon } from '../icons'

export interface CodeSent {
  /** Seconds until "Send again" works. */
  resend_in: number
  /** When this code stops working (ISO time from the server), for the countdown. */
  expires_at: string | null
}

const mmss = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

/**
 * The 6-digit email code box: one numeric field (so iOS/Android offer the code from Mail or
 * Messages), sends itself when the sixth digit is typed, a live "Code expires in 9:41"
 * countdown, and "Send again" once the resend wait is over.
 */
export function CodeEntry({
  submitLabel,
  initialWait,
  expiresAt: initialExpiry,
  onSubmit,
  onResend,
}: {
  submitLabel: string
  /** Seconds before "Send again" works (a code was just sent). */
  initialWait: number
  /** When the current code expires; null if unknown (then no countdown is shown). */
  expiresAt: string | null
  onSubmit: (code: string) => Promise<void>
  /** Sends a new code. */
  onResend: () => Promise<CodeSent>
}) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  // Both countdowns are end times, so they stay right even if the tab sleeps for a while.
  const [now, setNow] = useState(() => Date.now())
  const [resendAt, setResendAt] = useState(() => Date.now() + initialWait * 1000)
  const [expiresAt, setExpiresAt] = useState(() => (initialExpiry ? new Date(initialExpiry).getTime() : null))
  const inputRef = useRef<HTMLInputElement>(null)
  const submitted = useRef('')

  const wait = Math.max(0, Math.ceil((resendAt - now) / 1000))
  const left = expiresAt === null ? null : Math.max(0, Math.ceil((expiresAt - now) / 1000))
  const expired = left === 0

  // One tick a second while either countdown is running; stops when both are done.
  const ticking = wait > 0 || (left !== null && left > 0)
  useEffect(() => {
    if (!ticking) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [ticking])

  useEffect(() => inputRef.current?.focus(), [])

  async function submit(value = code) {
    if (value.length !== 6 || busy) return
    submitted.current = value
    setBusy(true)
    setError('')
    try {
      await onSubmit(value)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
      inputRef.current?.select()
    }
  }

  // "Paste" button: reads the clipboard (the browser may ask once) and sends the code if it finds one.
  const canPaste = typeof navigator !== 'undefined' && Boolean(navigator.clipboard?.readText)
  async function paste() {
    try {
      const digits = (await navigator.clipboard.readText()).match(/\d{6}/)?.[0]
      if (!digits) {
        setError("The copied text doesn't contain a 6-digit code.")
        return
      }
      setCode(digits)
      setError('')
      if (digits !== submitted.current) void submit(digits)
    } catch {
      setError('Paste was blocked. Long-press the box and choose Paste instead.')
      inputRef.current?.focus()
    }
  }

  async function resend() {
    setError('')
    setInfo('')
    try {
      const sent = await onResend()
      setNow(Date.now())
      setResendAt(Date.now() + sent.resend_in * 1000)
      setExpiresAt(sent.expires_at ? new Date(sent.expires_at).getTime() : null)
      submitted.current = ''
      setCode('')
      setInfo('New code sent. Check your inbox (and spam folder).')
      inputRef.current?.focus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      const seconds = /wait (\d+) seconds/.exec(err instanceof Error ? err.message : '')
      if (seconds) setResendAt(Date.now() + Number(seconds[1]) * 1000)
    }
  }

  return (
    <div className="code-entry">
      <div className="field-group">
        <div className="code-label-row">
          <label className="label" htmlFor="code-input">
            6-digit code
          </label>
          {canPaste && (
            <button type="button" className="text-btn paste-btn" onClick={() => void paste()}>
              <Icon name="inbox" />
              Paste
            </button>
          )}
        </div>
        <input
          id="code-input"
          ref={inputRef}
          className="field code-field"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          value={code}
          placeholder="••••••"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? 'code-error' : undefined}
          onChange={(e) => {
            const next = e.target.value.replace(/\D/g, '').slice(0, 6)
            setCode(next)
            setError('')
            // Pasting or autofilling the whole code sends it straight away (once per code).
            if (next.length === 6 && next !== submitted.current) void submit(next)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            }
          }}
        />
        {left !== null && (
          <span className={`code-expiry${expired ? ' expired' : left <= 60 ? ' soon' : ''}`} aria-live={left <= 60 ? 'polite' : 'off'}>
            <Icon name="timer" />
            {expired ? 'This code has expired. Send a new one below.' : <>Code expires in <strong>{mmss(left)}</strong></>}
          </span>
        )}
        {error && (
          <span className="field-error" id="code-error" role="alert">
            {error}
          </span>
        )}
        {info && !error && <span className="list-sub">{info}</span>}
      </div>

      <button type="button" className="primary-btn" disabled={busy || code.length !== 6 || expired} style={{ height: 52 }} onClick={() => void submit()}>
        {busy ? 'Checking…' : submitLabel}
      </button>

      <p className="list-sub" style={{ margin: 0, textAlign: 'center' }}>
        Didn't get it?{' '}
        <button type="button" className="link-btn" disabled={wait > 0} onClick={() => void resend()}>
          {wait > 0 ? `Send again in ${wait}s` : 'Send again'}
        </button>
      </p>
    </div>
  )
}
