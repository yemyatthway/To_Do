import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { BROWSER_LABEL, detectDevice, PLATFORM_LABEL, type Platform } from '../device'
import { Icon } from '../icons'
import { gsap, useGsap } from '../motion'
import { deviceCanReceive, isPushSupported, sendTestNotification } from '../push'

type Status = 'needs-install' | 'unsupported' | 'blocked' | 'ready' | 'on'

const STATUS_TEXT: Record<Status, string> = {
  'needs-install': 'Add To-Do to your Home Screen first (steps below).',
  unsupported: "This browser can't show notifications. Try Safari, Chrome or Edge.",
  blocked: 'Notifications are blocked for this site. See "Blocked?" below.',
  ready: 'Ready: turn reminders on below.',
  on: 'Reminders are on for this device.',
}

const STEPS: Record<Exclude<Platform, 'other'>, { title: string; steps: ReactNode[]; blocked: ReactNode; tip?: ReactNode }> = {
  ios: {
    title: 'iPhone and iPad',
    steps: [
      <>Needs iOS 16.4 or newer (Settings → General → About).</>,
      <>Open this site in <strong>Safari</strong>.</>,
      <>
        Tap the <strong>Share</strong> button (the square with an arrow).
      </>,
      <>
        Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
      </>,
      <>
        Open <strong>To-Do from the new Home Screen icon</strong>, not from Safari.
      </>,
      <>
        Tap the <strong>bell</strong> and choose <strong>Allow</strong>.
      </>,
    ],
    blocked: (
      <>
        Settings → Notifications → <strong>To-Do</strong> → turn on Allow Notifications.
      </>
    ),
    tip: <>Focus and Do Not Disturb can hide reminders; add To-Do to the allowed apps.</>,
  },
  android: {
    title: 'Android',
    steps: [
      <>
        Open this site in <strong>Chrome</strong> (Samsung Internet and Edge work too).
      </>,
      <>
        Tap the <strong>bell</strong> and choose <strong>Allow</strong>.
      </>,
      <>
        Optional: menu <strong>⋮</strong> → <strong>Add to Home screen</strong> (or Install app) to open it like an app.
      </>,
      <>
        For on-time reminders: Settings → Apps → Chrome → Battery → <strong>Unrestricted</strong>. Some phones put browsers to sleep.
      </>,
    ],
    blocked: (
      <>
        Tap the icon left of the address bar → Permissions → <strong>Notifications → Allow</strong>.
      </>
    ),
  },
  mac: {
    title: 'Mac',
    steps: [
      <>
        Click the <strong>bell</strong> and choose <strong>Allow</strong> (Safari, Chrome or Edge).
      </>,
      <>
        System Settings → Notifications → your browser (<strong>Safari</strong> or <strong>Google Chrome</strong>) → turn on Allow notifications.
      </>,
      <>
        Optional in Safari: File → <strong>Add to Dock</strong> to use it like an app (then allow notifications there once more).
      </>,
    ],
    blocked: (
      <>
        Safari: Settings → Websites → Notifications → this site → <strong>Allow</strong>. Chrome: the icon left of the address →{' '}
        <strong>Notifications → Allow</strong>.
      </>
    ),
    tip: <>Safari delivers reminders even when it's closed. Chrome needs to be running (it can be in the background).</>,
  },
  windows: {
    title: 'Windows',
    steps: [
      <>
        Click the <strong>bell</strong> and choose <strong>Allow</strong> (Chrome or Edge).
      </>,
      <>
        Windows Settings → System → Notifications → turn on <strong>Chrome</strong> or <strong>Edge</strong>.
      </>,
    ],
    blocked: (
      <>
        The icon left of the address bar → Site settings → <strong>Notifications → Allow</strong>.
      </>
    ),
    tip: <>The browser needs to be running (it can be in the background). Focus assist can hide reminders.</>,
  },
}

/**
 * "How to get reminders on this device". Push reminders work differently on each device
 * (iPhone needs the app on the Home Screen first), so this shows the steps for the one in use,
 * with tabs for the others, and a test button once it's set up.
 */
export function RemindersGuide({
  remindersOn,
  busy,
  onEnableHere,
  onClose,
  notify,
}: {
  remindersOn: boolean
  busy: boolean
  /** Ask for permission and register this device (also turns reminders on for the account). */
  onEnableHere: () => Promise<boolean>
  onClose: () => void
  notify: (title: string, detail?: string) => void
}) {
  const [device] = useState(detectDevice)
  const [tab, setTab] = useState<Exclude<Platform, 'other'>>(device.platform === 'other' ? 'windows' : device.platform)
  const [receiving, setReceiving] = useState(false)
  const [testing, setTesting] = useState(false)
  const cardRef = useRef<HTMLDivElement>(null)

  useGsap(cardRef, () => {
    gsap.fromTo(cardRef.current, { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.4, ease: 'power3.out' })
  }, [])

  useEffect(() => {
    deviceCanReceive().then(setReceiving)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, remindersOn])

  const status: Status =
    device.platform === 'ios' && !device.installed
      ? 'needs-install'
      : !isPushSupported()
        ? 'unsupported'
        : Notification.permission === 'denied'
          ? 'blocked'
          : remindersOn && receiving
            ? 'on'
            : 'ready'

  async function enable() {
    if (await onEnableHere()) setReceiving(await deviceCanReceive())
  }

  async function test() {
    setTesting(true)
    try {
      await sendTestNotification()
      notify('Test sent', 'It should pop up in a few seconds.')
    } catch (err) {
      notify("Couldn't send the test", err instanceof Error ? err.message : String(err))
    } finally {
      setTesting(false)
    }
  }

  const guide = STEPS[tab]
  const thisDevice = tab === device.platform

  return createPortal(
    <div className="scrim center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={cardRef} className="send-card glass guide-card" role="dialog" aria-modal="true" aria-labelledby="guide-h">
        <div className="sheet-head">
          <h2 id="guide-h">Get reminders on your devices</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>

        <div className={`guide-status guide-${status}`} role="status">
          <Icon name={status === 'on' ? 'check' : 'bell'} />
          <span>
            <strong>
              This device: {PLATFORM_LABEL[device.platform]} · {BROWSER_LABEL[device.browser]}
              {device.installed ? ' (app)' : ''}
            </strong>
            <br />
            {STATUS_TEXT[status]}
          </span>
        </div>

        <div className="segmented guide-tabs" role="tablist" aria-label="Device">
          {(Object.keys(STEPS) as (keyof typeof STEPS)[]).map((key) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} aria-pressed={tab === key} onClick={() => setTab(key)}>
              {key === 'ios' ? 'iPhone' : STEPS[key].title}
            </button>
          ))}
        </div>

        <ol className="guide-steps">
          {guide.steps.map((step, i) => (
            <li key={i}>
              <span className="guide-num" aria-hidden="true">
                {i + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>

        <div className="guide-note">
          <strong>Blocked?</strong> {guide.blocked}
        </div>
        {guide.tip && <p className="hint">{guide.tip}</p>}

        {thisDevice && status === 'ready' && (
          <button type="button" className="primary-btn" disabled={busy} onClick={() => void enable()}>
            {busy ? 'Turning on…' : 'Turn on reminders on this device'}
          </button>
        )}
        {thisDevice && status === 'on' && (
          <button type="button" className="task-action send-action" disabled={testing} onClick={() => void test()}>
            <Icon name="bell" />
            {testing ? 'Sending…' : 'Send a test notification'}
          </button>
        )}
        <p className="hint" style={{ textAlign: 'center', margin: 0 }}>
          Each device is set up on its own. Reminders come 10 minutes before timed tasks; high-priority ones stay on screen.
        </p>
      </div>
    </div>,
    document.body,
  )
}
