import { api } from './api'

export function isPushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export function registerServiceWorker() {
  if (!isPushSupported()) return
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
  if (!isPushSupported()) return null
  const registration = await navigator.serviceWorker.getRegistration()
  return (await registration?.pushManager.getSubscription()) ?? null
}

/** What this device can do about reminders right now (when the account has them on). */
export type DeviceReminderState = 'ready' | 'needs-permission' | 'blocked' | 'unsupported'
export function deviceReminderState(): DeviceReminderState {
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
  if (deviceReminderState() !== 'ready') return false
  await subscribeThisDevice() // already allowed, so no prompt: it reuses or renews the subscription
  return true
}

/** False when asking would fail anyway: no push support (e.g. iPhone outside the Home Screen app) or blocked. */
export function canAskForNotifications() {
  return isPushSupported() && Notification.permission !== 'denied'
}

/** Asks for permission (if needed), subscribes this browser and registers it with the server. */
export async function subscribeThisDevice() {
  if (!isPushSupported()) {
    throw new Error("This browser can't show push notifications. On iPhone, add the app to your Home Screen first.")
  }

  // Must be the first await so it still counts as a response to the click.
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications are blocked for this site. Allow them in your browser settings, then try again.'
        : 'Notification permission was dismissed.',
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
  const subscription = await currentSubscription()
  if (!subscription) return
  await api.unsubscribePush(subscription.endpoint).catch(() => undefined)
  await subscription.unsubscribe().catch(() => undefined)
}

/** Pushes "It works!" to this browser through the real server, to check the whole path. */
export async function sendTestNotification() {
  const subscription = await currentSubscription()
  if (!subscription) throw new Error('Reminders are not set up on this device yet.')
  await api.testPush(subscription.toJSON())
}

/** This browser's push address, if it has one (to recognise it in the server's device list). */
export async function currentEndpoint() {
  return (await currentSubscription())?.endpoint ?? null
}

/** True when this browser is set up to receive pushes right now. */
export async function deviceCanReceive() {
  return isPushSupported() && Notification.permission === 'granted' && Boolean(await currentSubscription())
}
