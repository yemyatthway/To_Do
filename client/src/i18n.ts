import { my } from './i18n.my'

export type Language = 'en' | 'my'

const KEY = 'todo:language'

function saved(): Language {
  try {
    return localStorage.getItem(KEY) === 'my' ? 'my' : 'en'
  } catch {
    return 'en'
  }
}

/** Set once when the app loads; changing it reloads the app, so nothing on screen is left in the old language. */
export const language: Language = saved()

const WEEKDAYS = ['တနင်္ဂနွေ', 'တနင်္လာ', 'အင်္ဂါ', 'ဗုဒ္ဓဟူး', 'ကြာသပတေး', 'သောကြာ', 'စနေ']
const WEEKDAY_LETTERS = ['နွေ', 'လာ', 'ဂါ', 'ဟူး', 'တေး', 'ကြာ', 'နေ']
const SHORT_MONTHS = ['ဇန်', 'ဖေ', 'မတ်', 'ဧပြီ', 'မေ', 'ဇွန်', 'ဇူ', 'ဩ', 'စက်', 'အောက်', 'နို', 'ဒီ']
const MONTHS = ['ဇန်နဝါရီ', 'ဖေဖော်ဝါရီ', 'မတ်', 'ဧပြီ', 'မေ', 'ဇွန်', 'ဇူလိုင်', 'ဩဂုတ်', 'စက်တင်ဘာ', 'အောက်တိုဘာ', 'နိုဝင်ဘာ', 'ဒီဇင်ဘာ']

/** Many browsers (Chrome among them) carry no Burmese names, so they're spelled out here. Digits and AM/PM match the clock. */
function burmeseDate(date: Date, options: Intl.DateTimeFormatOptions) {
  const parts: string[] = []
  if (options.weekday) parts.push(options.weekday === 'narrow' ? WEEKDAY_LETTERS[date.getDay()] : WEEKDAYS[date.getDay()] + (options.weekday === 'long' ? 'နေ့' : ''))
  const day = [options.year && String(date.getFullYear()), options.month && (options.month === 'short' ? SHORT_MONTHS : MONTHS)[date.getMonth()], options.day && String(date.getDate())].filter(Boolean).join(' ')
  if (day) parts.push(day)
  if (options.hour) {
    const hour = date.getHours() % 12 || 12
    const clock = options.minute ? `${hour}:${String(date.getMinutes()).padStart(2, '0')}` : String(hour)
    const zone = options.timeZoneName && new Intl.DateTimeFormat('en-US', { timeZoneName: options.timeZoneName }).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value
    parts.push([clock, date.getHours() < 12 ? 'AM' : 'PM', zone].filter(Boolean).join(' '))
  }
  return parts.join('၊ ')
}

export function formatDate(date: Date, options: Intl.DateTimeFormatOptions, englishLocale?: string) {
  return language === 'my' ? burmeseDate(date, options) : new Intl.DateTimeFormat(englishLocale, options).format(date)
}

/** The English text is the key: tr('Hello {name}', { name }). Anything not translated yet stays English. */
export function tr(text: string, values?: Record<string, string | number>) {
  const found = language === 'my' ? (my[text] ?? text) : text
  if (!values) return found
  return found.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole))
}

export function chooseLanguage(next: Language) {
  try {
    localStorage.setItem(KEY, next)
  } catch {
    // This device can't remember it.
  }
  window.location.reload()
}

/** English and မြန်မာ, each always written in its own language so anyone can find theirs. */
export const LANGUAGES: { value: Language; name: string }[] = [
  { value: 'en', name: 'English' },
  { value: 'my', name: 'မြန်မာ' },
]

export const hasChosenLanguage = () => {
  try {
    return localStorage.getItem(KEY) !== null
  } catch {
    return false
  }
}
