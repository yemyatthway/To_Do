import { api } from './api'
import { tr } from './i18n'
import { isNativeApp } from './native'
import { setAppAlarms } from './nativeAlarm'
// Imported directly: a plugin can't be handed back from an async function (it looks like a promise and never settles).
import { LocalNotifications } from '@capacitor/local-notifications'

/** Web push in a browser. The iPhone app has none: it schedules reminders on the phone instead. */
function webPushSupported() {
  return !isNativeApp && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export function isPushSupported() {
  return isNativeApp || webPushSupported()
}

// In the app, notification permission is asked through iOS; remembered here so screens can read it at once.
let appPermission: 'granted' | 'denied' | 'prompt' = 'prompt'


function toAppPermission(value: string) {
  return value === 'granted' ? 'granted' : value === 'denied' ? 'denied' : 'prompt'
}

/** Reads the app's notification permission (call at startup and when the app comes back). */
export async function loadAppPermission() {
  if (!isNativeApp) return
  appPermission = toAppPermission((await LocalNotifications.checkPermissions()).display)
}

/** Notifications refused for this site or app: asking again won't show a prompt. */
export function notificationsBlocked() {
  if (isNativeApp) return appPermission === 'denied'
  return webPushSupported() && Notification.permission === 'denied'
}

export function registerServiceWorker() {
  if (!webPushSupported()) return
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    console.error('Service worker registration failed:', err)
  })
}

// Browsers want the VAPID key as raw bytes, the server gives it as base64url.
function base64UrlToBytes(value: string) {
  const base64 = (value + '='.repeat((4 - (value.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array) {
  if (!a || a.byteLength !== b.byteLength) return false
  const view = new Uint8Array(a)
  return view.every((byte, i) => byte === b[i])
}

async function currentSubscription() {
  if (!webPushSupported()) return null
  const registration = await navigator.serviceWorker.getRegistration()
  return (await registration?.pushManager.getSubscription()) ?? null
}

/** What this device can do about reminders right now (when the account has them on). */
export type DeviceReminderState = 'ready' | 'needs-permission' | 'blocked' | 'unsupported'
export function deviceReminderState(): DeviceReminderState {
  if (isNativeApp) return appPermission === 'granted' ? 'ready' : appPermission === 'denied' ? 'blocked' : 'needs-permission'
  if (!isPushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  return Notification.permission === 'granted' ? 'ready' : 'needs-permission'
}

/**
 * Reminders on + permission given: (re)send this device's registration to the server. The server
 * can lose it (account deleted then restored, a ban, an expired push address) while the phone
 * still thinks it's set up, so this runs every time the app opens; the server just updates it.
 */
export async function syncThisDevice() {
  if (isNativeApp) {
    await loadAppPermission()
    return appPermission === 'granted'
  }
  if (deviceReminderState() !== 'ready') return false
  await subscribeThisDevice() // already allowed, so no prompt: it reuses or renews the subscription
  return true
}

/** False when asking would fail anyway: no push support (e.g. iPhone outside the Home Screen app) or blocked. */
export function canAskForNotifications() {
  if (isNativeApp) return appPermission !== 'denied'
  return isPushSupported() && Notification.permission !== 'denied'
}

/** Asks for permission (if needed), subscribes this browser and registers it with the server. */
export async function subscribeThisDevice() {
  if (isNativeApp) {
    appPermission = toAppPermission((await LocalNotifications.requestPermissions()).display)
    if (appPermission !== 'granted') throw new Error(tr('Notifications are off for Todo Clock. Turn them on in Settings → Todo Clock → Notifications.'))
    return
  }
  if (!isPushSupported()) {
    throw new Error(tr('This browser can\'t show push notifications. On iPhone, add the app to your Home Screen first.'))
  }

  // Must be the first await so it still counts as a response to the click.
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? tr('Notifications are blocked for this site. Allow them in your browser settings, then try again.')
        : tr('Notification permission was dismissed.'),
    )
  }

  const key = base64UrlToBytes((await api.vapidKey()).public_key)
  const registration = await navigator.serviceWorker.ready
  let subscription = await registration.pushManager.getSubscription()
  // A subscription made with an old server key can't receive pushes, so replace it.
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key as BufferSource })
  await api.subscribePush(subscription.toJSON())
}

/** Removes this browser's subscription here and on the server (reminders off, or logging out). */
export async function unsubscribeThisDevice() {
  if (isNativeApp) {
    await cancelAppReminders()
    return
  }
  const subscription = await currentSubscription()
  if (!subscription) return
  await api.unsubscribePush(subscription.endpoint).catch(() => undefined)
  await subscription.unsubscribe().catch(() => undefined)
}

/** Pushes "It works!" to this browser through the real server, to check the whole path. */
export async function sendTestNotification() {
  if (isNativeApp) {
    if (appPermission !== 'granted') throw new Error(tr('Reminders are not set up on this device yet.'))
    await LocalNotifications.schedule({ notifications: [{ id: TEST_ID, title: tr('It works!'), body: tr('Reminders will show up like this.'), schedule: { at: new Date(Date.now() + 2000) } }] })
    return
  }
  const subscription = await currentSubscription()
  if (!subscription) throw new Error(tr('Reminders are not set up on this device yet.'))
  await api.testPush(subscription.toJSON())
}

/** This browser's push address, if it has one (to recognise it in the server's device list). */
export async function currentEndpoint() {
  return (await currentSubscription())?.endpoint ?? null
}

/** True when this browser is set up to receive pushes right now. */
export async function deviceCanReceive() {
  if (isNativeApp) return appPermission === 'granted'
  return isPushSupported() && Notification.permission === 'granted' && Boolean(await currentSubscription())
}

// Task reminders use their task's id; this one is far above any of them.
const TEST_ID = 2_000_000_000

/** Takes back every reminder scheduled on this phone (reminders off, or logging out). */
export async function cancelAppReminders() {
  if (!isNativeApp) return
  await setAppAlarms([]).catch(() => undefined)
  const notifications = LocalNotifications
  const { notifications: pending } = await notifications.getPending()
  if (pending.length) await notifications.cancel({ notifications: pending.map((n) => ({ id: n.id })) })
}

/** Schedules these reminders on the phone in place of the ones scheduled before. */
export async function scheduleAppReminders(plan: { id: number; title: string; body: string; at: Date }[]) {
  if (!isNativeApp || appPermission !== 'granted') return
  await cancelAppReminders()
  if (!plan.length) return
  await LocalNotifications.schedule({
    notifications: plan.map((item) => ({ id: item.id, title: item.title, body: item.body, schedule: { at: item.at, allowWhileIdle: true } })),
  })
}
