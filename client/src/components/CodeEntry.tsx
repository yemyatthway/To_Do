import { useEffect, useRef, useState } from 'react'

/**
 * The 6-digit email code box: one numeric field (so iOS/Android offer the code from Mail or
 * Messages), sends itself when the sixth digit is typed, and a "Send again" with a countdown.
 */
export function CodeEntry({
  submitLabel,
  initialWait,
  onSubmit,
  onResend,
}: {
  submitLabel: string
  /** Seconds before "Send again" works (a code was just sent). */
  initialWait: number
  onSubmit: (code: string) => Promise<void>
  /** Sends a new code and returns the new wait in seconds. */
  onResend: () => Promise<number>
}) {
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const [wait, setWait] = useState(initialWait)
  const inputRef = useRef<HTMLInputElement>(null)
  const submitted = useRef('')

  // Ticks once a second only while counting down; stops at 0 so it costs nothing afterwards.
  useEffect(() => {
    if (wait <= 0) return
    const id = window.setTimeout(() => setWait((w) => w - 1), 1000)
    return () => clearTimeout(id)
  }, [wait])

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

  async function resend() {
    setError('')
    setInfo('')
    try {
      setWait(await onResend())
      setCode('')
      setInfo('New code sent. Check your inbox (and spam folder).')
      inputRef.current?.focus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      const seconds = /wait (\d+) seconds/.exec(err instanceof Error ? err.message : '')
      if (seconds) setWait(Number(seconds[1]))
    }
  }

  return (
    <div className="code-entry">
      <label className="field-group">
        <span className="label">6-digit code</span>
        <input
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
        {error && (
          <span className="field-error" id="code-error" role="alert">
            {error}
          </span>
        )}
        {info && !error && <span className="list-sub">{info}</span>}
      </label>

      <button type="button" className="primary-btn" disabled={busy || code.length !== 6} style={{ height: 52 }} onClick={() => void submit()}>
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
