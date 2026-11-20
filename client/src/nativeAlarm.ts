import { registerPlugin } from '@capacitor/core'
import { isNativeApp } from './native'

/**
 * Task reminders that ring like the Clock app (full screen, even on silent), through our own small
 * iPhone plugin (client/native/todo-alarm). Needs iOS 26 or later; everywhere else a task's alarm
 * setting is kept but its reminder stays a normal notification.
 */

export type AlarmPermission = 'authorized' | 'denied' | 'notDetermined'

interface TodoAlarmPlugin {
  status(): Promise<{ available: boolean; permission: AlarmPermission }>
  requestPermission(): Promise<{ permission: AlarmPermission }>
  sync(options: { alarms: { title: string; at: number }[] }): Promise<{ scheduled: number }>
  openSettings(): Promise<void>
}

// Created once here: a plugin can't be handed back from an async function (it looks like a promise).
const TodoAlarm = registerPlugin<TodoAlarmPlugin>('TodoAlarm')

let state: { available: boolean; permission: AlarmPermission } = { available: false, permission: 'notDetermined' }

export const alarmsAvailable = () => isNativeApp && state.available
export const alarmsAllowed = () => alarmsAvailable() && state.permission === 'authorized'

/** Read at startup and whenever the app comes back (the permission can change in Settings). */
export async function loadAlarmStatus() {
  if (!isNativeApp) return
  try {
    state = await TodoAlarm.status()
  } catch {
    state = { available: false, permission: 'denied' }
  }
}

/** Asks iOS the first time. True when alarms may be set. */
export async function askForAlarms() {
  if (!alarmsAvailable()) return false
  if (state.permission === 'authorized') return true
  const { permission } = await TodoAlarm.requestPermission()
  state = { ...state, permission }
  return permission === 'authorized'
}

/** Sets exactly these alarms, in place of the ones set before. */
export async function setAppAlarms(alarms: { title: string; at: Date }[]) {
  if (!alarmsAllowed()) return
  await TodoAlarm.sync({ alarms: alarms.map((alarm) => ({ title: alarm.title, at: alarm.at.getTime() })) })
}

/** iOS only asks once; after a no, alarms are allowed in Settings → Todo Clock. */
export function openAlarmSettings() {
  if (alarmsAvailable()) void TodoAlarm.openSettings().catch(() => undefined)
}
