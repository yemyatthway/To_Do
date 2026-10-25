export type Platform = 'ios' | 'android' | 'mac' | 'windows' | 'other'
export type Browser = 'safari' | 'chrome' | 'edge' | 'firefox' | 'samsung' | 'other'

export interface Device {
  platform: Platform
  browser: Browser
  /** Opened from the Home Screen / Dock / installed app rather than a browser tab. */
  installed: boolean
}

/** Good-enough guess for showing the right setup steps (not for anything security-related). */
export function detectDevice(): Device {
  const ua = navigator.userAgent
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  const platform: Platform = ios ? 'ios' : /Android/.test(ua) ? 'android' : /Macintosh/.test(ua) ? 'mac' : /Windows/.test(ua) ? 'windows' : 'other'
  const browser: Browser = /SamsungBrowser/.test(ua)
    ? 'samsung'
    : /Edg\//.test(ua)
      ? 'edge'
      : /Firefox|FxiOS/.test(ua)
        ? 'firefox'
        : /Chrome|CriOS/.test(ua)
          ? 'chrome'
          : /Safari/.test(ua)
            ? 'safari'
            : 'other'
  const installed =
    window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
  return { platform, browser, installed }
}

export const PLATFORM_LABEL: Record<Platform, string> = {
  ios: 'iPhone / iPad',
  android: 'Android',
  mac: 'Mac',
  windows: 'Windows',
  other: 'Other',
}

export const BROWSER_LABEL: Record<Browser, string> = {
  safari: 'Safari',
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  samsung: 'Samsung Internet',
  other: 'browser',
}
