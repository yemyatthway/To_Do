import { Capacitor } from '@capacitor/core'
// Imported directly: a plugin can't be handed back from an async function (it looks like a promise and never settles).
import { Preferences } from '@capacitor/preferences'

/**
 * Running inside the iPhone app rather than a browser. The app shows the same pages, but it can't
 * keep the website's login cookie or use web push, so a few things work differently there.
 */
export const isNativeApp = Capacitor.isNativePlatform()

/** The app's pages come from inside it, so it reaches the server by its full address. */
export const NATIVE_API_URL: string = import.meta.env.VITE_NATIVE_API_URL ?? 'https://todoclock.app'

/** What the server recognises the app by (also where its pages are served from). */
export const NATIVE_ORIGIN = 'capacitor://localhost'

const REFRESH = 'session.refresh'
const DEVICE = 'session.device'

/** The app's login, kept on the phone: what a browser keeps in its cookies. */
export const nativeSession = { refresh: null as string | null, device: null as string | null }

/** Read once at startup, before the first request, so requests can send them straight away. */
export async function loadNativeSession() {
  if (!isNativeApp) return
  const store = Preferences
  nativeSession.refresh = (await store.get({ key: REFRESH })).value
  nativeSession.device = (await store.get({ key: DEVICE })).value
}

export async function saveNativeSession(next: { refresh?: string | null; device?: string | null }) {
  if (!isNativeApp) return
  const store = Preferences
  if (next.refresh !== undefined) {
    nativeSession.refresh = next.refresh
    await (next.refresh ? store.set({ key: REFRESH, value: next.refresh }) : store.remove({ key: REFRESH }))
  }
  if (next.device !== undefined) {
    nativeSession.device = next.device
    await (next.device ? store.set({ key: DEVICE, value: next.device }) : store.remove({ key: DEVICE }))
  }
}
