import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { BROWSER_LABEL, detectDevice, PLATFORM_LABEL, type Platform } from '../device'
import { Icon } from '../icons'
import { ReminderCheck } from './ReminderCheck'
import { gsap, useGsap } from '../motion'
import { deviceCanReceive, isPushSupported, sendTestNotification } from '../push'
import { tr } from '../i18n'

type Status = 'needs-install' | 'unsupported' | 'blocked' | 'ready' | 'on'

const STATUS_TEXT: Record<Status, string> = {
  'needs-install': tr('Add Todo Clock to your Home Screen first (steps below).'),
  unsupported: tr('This browser can\'t show notifications. Try Safari, Chrome or Edge.'),
  blocked: tr('Notifications are blocked for this site. See "Blocked?" below.'),
  ready: tr('Ready: turn reminders on below.'),
  on: tr('Reminders are on for this device.'),
}

const STEPS: Record<Exclude<Platform, 'other'>, { title: string; steps: ReactNode[]; blocked: ReactNode; tip?: ReactNode }> = {
  ios: {
    title: tr('iPhone and iPad'),
    steps: [
      <>{tr('Needs iOS 16.4 or newer (Settings → General → About).')}</>,
      <>{tr('Open this site in')}{' '}<strong>{tr('Safari')}</strong>.</>,
      <>
        {tr('Tap the')}{' '}<strong>{tr('Share')}</strong> {tr('button (the square with an arrow).')}
      </>,
      <>
        {tr('Choose')}{' '}<strong>{tr('Add to Home Screen')}</strong>{tr(', then')}{' '}<strong>{tr('Add')}</strong>.
      </>,
      <>
        {tr('Open')}{' '}<strong>{tr('Todo Clock from the new Home Screen icon')}</strong>{tr(', not from Safari.')}
      </>,
      <>
        {tr('Tap the')}{' '}<strong>{tr('bell')}</strong> {tr('and choose')}{' '}<strong>{tr('Allow')}</strong>.
      </>,
    ],
    blocked: (
      <>
        {tr('Settings → Notifications →')}{' '}<strong>{tr('Todo Clock')}</strong> {tr('→ turn on Allow Notifications.')}
      </>
    ),
    tip: <>{tr('Focus and Do Not Disturb can hide reminders; add Todo Clock to the allowed apps.')}</>,
  },
  android: {
    title: tr('Android'),
    steps: [
      <>
        {tr('Open this site in')}{' '}<strong>{tr('Chrome')}</strong> {tr('(Samsung Internet and Edge work too).')}
      </>,
      <>
        {tr('Tap the')}{' '}<strong>{tr('bell')}</strong> {tr('and choose')}{' '}<strong>{tr('Allow')}</strong>.
      </>,
      <>
        {tr('Optional: menu')}{' '}<strong>⋮</strong> → <strong>{tr('Add to Home screen')}</strong> {tr('(or Install app) to open it like an app.')}
      </>,
      <>
        {tr('For on-time reminders: Settings → Apps → Chrome → Battery →')}{' '}<strong>{tr('Unrestricted')}</strong>{tr('. Some phones put browsers to sleep.')}
      </>,
    ],
    blocked: (
      <>
        {tr('Tap the icon left of the address bar → Permissions →')}{' '}<strong>{tr('Notifications → Allow')}</strong>.
      </>
    ),
  },
  mac: {
    title: tr('Mac'),
    steps: [
      <>
        {tr('Click the')}{' '}<strong>{tr('bell')}</strong> {tr('and choose')}{' '}<strong>{tr('Allow')}</strong> {tr('(Safari, Chrome or Edge).')}
      </>,
      <>
        {tr('System Settings → Notifications → your browser (')}<strong>{tr('Safari')}</strong> {tr('or')}{' '}<strong>{tr('Google Chrome')}</strong>{tr(') → turn on Allow notifications.')}
      </>,
      <>
        {tr('Optional in Safari: File →')}{' '}<strong>{tr('Add to Dock')}</strong> {tr('to use it like an app (then allow notifications there once more).')}
      </>,
    ],
    blocked: (
      <>
        {tr('Safari: Settings → Websites → Notifications → this site →')}{' '}<strong>{tr('Allow')}</strong>{tr('. Chrome: the icon left of the address →')}{' '}<strong>{tr('Notifications → Allow')}</strong>.
      </>
    ),
    tip: <>{tr('Safari delivers reminders even when it\'s closed. Chrome needs to be running (it can be in the background).')}</>,
  },
  windows: {
    title: tr('Windows'),
    steps: [
      <>
        {tr('Click the')}{' '}<strong>{tr('bell')}</strong> {tr('and choose')}{' '}<strong>{tr('Allow')}</strong> {tr('(Chrome or Edge).')}
      </>,
      <>
        {tr('Windows Settings → System → Notifications → turn on')}{' '}<strong>{tr('Chrome')}</strong> {tr('or')}{' '}<strong>{tr('Edge')}</strong>.
      </>,
    ],
    blocked: (
      <>
        {tr('The icon left of the address bar → Site settings →')}{' '}<strong>{tr('Notifications → Allow')}</strong>.
      </>
    ),
    tip: <>{tr('The browser needs to be running (it can be in the background). Focus assist can hide reminders.')}</>,
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
      notify(tr('Test sent'), tr('It should pop up in a few seconds.'))
    } catch (err) {
      notify(tr('Couldn\'t send the test'), err instanceof Error ? err.message : String(err))
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
          <h2 id="guide-h">{tr('Get reminders on your devices')}</h2>
          <button type="button" className="icon-btn" aria-label={tr('Close')} onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>

        <div className={`guide-status guide-${status}`} role="status">
          <Icon name={status === 'on' ? 'check' : 'bell'} />
          <span>
            <strong>
              {tr('This device: {value} · {value2}', { value: PLATFORM_LABEL[device.platform], value2: BROWSER_LABEL[device.browser] })}{device.installed ? tr(' (app)') : ''}
            </strong>
            <br />
            {STATUS_TEXT[status]}
          </span>
        </div>

        <ReminderCheck />

        <div className="segmented guide-tabs" role="tablist" aria-label={tr('Device')}>
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
          <strong>{tr('Blocked?')}</strong> {guide.blocked}
        </div>
        {guide.tip && <p className="hint">{guide.tip}</p>}

        {thisDevice && status === 'ready' && (
          <button type="button" className="primary-btn" disabled={busy} onClick={() => void enable()}>
            {busy ? tr('Turning on…') : tr('Turn on reminders on this device')}
          </button>
        )}
        {thisDevice && status === 'on' && (
          <button type="button" className="task-action send-action" disabled={testing} onClick={() => void test()}>
            <Icon name="bell" />
            {testing ? tr('Sending…') : tr('Send a test notification')}
          </button>
        )}
        <p className="hint" style={{ textAlign: 'center', margin: 0 }}>
          {tr('Each device is set up on its own. Reminders come before timed tasks (you choose how long on each task); high-priority ones stay on screen.')}
        </p>
      </div>
    </div>,
    document.body,
  )
}
