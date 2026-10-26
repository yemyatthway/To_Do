import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { api, auth, chat, refreshSession, setSessionExpiredHandler, social, type Task, type TaskInput, type User } from './api'
import { TaskSheet, type SheetDefaults } from './components/TaskSheet'
import { Toast, type ToastData } from './components/Toast'
import type { TourStep } from './components/Tour'
import { TimerPill } from './components/TimerPill'
import { Icon } from './icons'
import { clearSavedTimer, useTimer, type TimerState } from './timer/useTimer'
import { enter, useGsap } from './motion'
import { AuthScreen } from './pages/AuthScreen'
import { useLiveRefresh } from './live'
import { onLive, startAdminLive, startLive, stopLive } from './realtime'
import { usePageVisible } from './visibility'
import { VerifyEmail } from './pages/VerifyEmail'
import { Home } from './pages/Home'
import { canAskForNotifications, deviceReminderState, subscribeThisDevice, syncThisDevice, unsubscribeThisDevice, type DeviceReminderState } from './push'
import { useTheme } from './theme'
import { initials } from './user'
import {
  addDays,
  deviceTimezone,
  dueDate,
  formatLongDate,
  formatShortDay,
  formatTime,
  greeting,
  sameDay,
  startOfDay,
  startOfWeek,
} from './time'

type View = 'home' | 'progress' | 'profile' | 'admin' | 'friends' | 'timer' | 'chats'

// Screens most visits never open load on demand, so the first paint stays small.
const Profile = lazy(() => import('./pages/Profile').then((m) => ({ default: m.Profile })))
const Progress = lazy(() => import('./pages/Progress').then((m) => ({ default: m.Progress })))
const Admin = lazy(() => import('./pages/Admin').then((m) => ({ default: m.Admin })))
const Timer = lazy(() => import('./pages/Timer').then((m) => ({ default: m.Timer })))
const Friends = lazy(() => import('./pages/Friends').then((m) => ({ default: m.Friends })))
const Chats = lazy(() => import('./pages/Chats').then((m) => ({ default: m.Chats })))
const RemindersGuide = lazy(() => import('./components/RemindersGuide').then((m) => ({ default: m.RemindersGuide })))
const SendTasksDialog = lazy(() => import('./components/SendTasksDialog').then((m) => ({ default: m.SendTasksDialog })))
const Tour = lazy(() => import('./components/Tour').then((m) => ({ default: m.Tour })))
const ChooseUsername = lazy(() => import('./components/ChooseUsername').then((m) => ({ default: m.ChooseUsername })))
const WelcomeDialog = lazy(() => import('./components/Tour').then((m) => ({ default: m.WelcomeDialog })))

// Fetch those screens in idle time after sign-in, so opening one later is instant.
function preloadScreens() {
  const load = () => {
    import('./pages/Profile')
    import('./pages/Progress')
    import('./pages/Friends')
    import('./pages/Chats')
    import('./pages/Timer')
    import('./components/Tour')
  }
  if ('requestIdleCallback' in window) window.requestIdleCallback(load, { timeout: 3000 })
  else setTimeout(load, 1500)
}

/**
 * Plays a screen's entrance once its real content has mounted (inside Suspense, so it never
 * animates a loading placeholder that's about to be swapped out).
 */
function Reveal({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useGsap(ref, () => {
    // Cascade the screen's own sections (cards, panels) rather than the screen as one block.
    enter(ref.current!.firstElementChild?.children ?? ref.current!.children)
  }, [])
  return (
    <div ref={ref} className="reveal">
      {children}
    </div>
  )
}

const UNDO_MS = 5000
const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

const TOUR_STEPS: TourStep[] = [
  {
    target: 'clock',
    title: 'Your day on a clock',
    body: 'Each dot is a task, colored by category. The clock always shows the next 12 hours, so AM and PM are picked for you.',
  },
  {
    target: 'clock-hour',
    title: 'Tap or hold an hour',
    body: "Tap an hour to see what's due then. Press and hold an hour to add a task at that time.",
    gesture: 'hold',
  },
  { target: 'day-strip', title: 'Plan ahead', body: 'Switch between today and the next few days.', gesture: 'tap' },
  { target: 'new-task', title: 'Add a task', body: 'Add a task with a time, category, priority and reminder.', gesture: 'tap' },
  {
    target: 'task-list',
    title: 'Your list',
    body: "Tick the circle when you're done and tap a task to edit it. Swipe left, or use the trash icon, to delete. You always get an Undo.",
    gesture: 'swipe',
  },
  { target: 'day-progress', title: 'Daily progress', body: 'One block per task. Filled blocks are done.' },
  { target: 'progress', title: 'Your week', body: 'See how your day, week and categories are going.', gesture: 'tap' },
  {
    target: 'friends',
    title: 'Friends',
    body: 'Find people, add them as friends, and send them copies of your tasks. Tasks they send you wait here until you add them. Nobody can see your list.',
    gesture: 'tap',
  },
  {
    target: 'chats',
    title: 'Chats',
    body: "Message your friends. You see when they're online, typing, and when they've seen your message.",
    gesture: 'tap',
  },
  {
    target: 'reminders',
    title: 'Reminders',
    body: 'Turn reminders on to get a notification before your tasks (10 minutes by default; pick another time on any task). Tap again to turn them off.',
    gesture: 'tap',
  },
  {
    target: 'timer',
    title: 'Timer',
    body: 'Start a countdown, like a 25-minute focus session, optionally for a task. It keeps running on every screen and chimes when time is up.',
    gesture: 'tap',
  },
  {
    target: 'profile',
    title: 'Your profile',
    body: "Change your name, email, password or light/dark theme, and replay this tutorial whenever you like. That's it, enjoy!",
    gesture: 'tap',
  },
]

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => new Date())
  const visible = usePageVisible()
  useEffect(() => {
    if (!visible) return
    const tick = () => setNow(new Date())
    const catchUp = setTimeout(tick, 0) // right away after the tab was hidden
    const id = setInterval(tick, intervalMs)
    return () => {
      clearTimeout(catchUp)
      clearInterval(id)
    }
  }, [intervalMs, visible])
  return now
}

function describeDue(task: Task) {
  const due = dueDate(task)
  if (!due) return 'Anytime'
  const today = startOfDay(new Date())
  const day = sameDay(due, today) ? 'Today' : sameDay(due, addDays(today, 1)) ? 'Tomorrow' : formatShortDay(due)
  return `${day} · ${formatTime(due)}`
}

function Backdrop() {
  return <div className="backdrop" aria-hidden="true" />
}

/** Signed-in gate, like afm_sys: restore the session from the refresh cookie, otherwise show login. */
export default function App() {
  useTheme()
  const [booting, setBooting] = useState(true)
  const [user, setUser] = useState<User | null>(null)
  const [notice, setNotice] = useState('')

  useEffect(() => {
    setSessionExpiredHandler(() => {
      setUser(null)
      setNotice('Your session expired. Log in again.')
    })
    ;(async () => {
      if (await refreshSession()) {
        try {
          setUser(await auth.me())
        } catch {
          // Treated as logged out.
        }
      }
      setBooting(false)
    })()
  }, [])

  if (booting) {
    return (
      <>
        <Backdrop />
        <p className="empty" style={{ position: 'relative', paddingTop: '40vh' }}>
          Loading…
        </p>
      </>
    )
  }

  if (!user) {
    return (
      <>
        <Backdrop />
        <AuthScreen
          notice={notice}
          onAuthenticated={(u) => {
            setNotice('')
            setUser(u)
          }}
        />
      </>
    )
  }

  if (!user.email_verified) {
    return (
      <>
        <Backdrop />
        <VerifyEmail
          user={user}
          onVerified={setUser}
          onLogout={async () => {
            await auth.logout()
            setNotice('')
            setUser(null)
          }}
        />
      </>
    )
  }

  return (
    <Workspace
      key={user.id}
      user={user}
      onUserChange={setUser}
      onLoggedOut={(message) => {
        setNotice(message)
        setUser(null)
      }}
    />
  )
}

function Workspace({ user, onUserChange, onLoggedOut }: { user: User; onUserChange: (u: User) => void; onLoggedOut: (message: string) => void }) {
  const theme = useTheme()
  const now = useNow(30_000)

  // Tapping a notification opens /?view=friends or /?view=chats&chat=<id>.
  const [view, setView] = useState<View>(() => {
    const asked = new URLSearchParams(window.location.search).get('view')
    return asked === 'friends' || asked === 'chats' ? asked : 'home'
  })
  const [chatStart, setChatStart] = useState<{ chatId?: number; friendId?: number; at: number } | undefined>(() => {
    const id = Number(new URLSearchParams(window.location.search).get('chat'))
    return id ? { chatId: id, at: Date.now() } : undefined
  })
  const [chatBadge, setChatBadge] = useState(0)
  const clearChatStart = useCallback(() => setChatStart(undefined), [])
  const [sendDialog, setSendDialog] = useState<{ friendId?: number; taskIds?: number[] } | null>(null)
  const [socialBadge, setSocialBadge] = useState(0)
  const [day, setDay] = useState(() => startOfDay(new Date()))
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  // `opened` makes every opening a fresh sheet, even if the last one is still sliding away.
  const [sheet, setSheet] = useState<{ task: Task | null; defaults: SheetDefaults; opened: number } | null>(null)
  const [toast, setToast] = useState<ToastData | null>(null)
  const [freshId, setFreshId] = useState<number | null>(null)
  const [remindersBusy, setRemindersBusy] = useState(false)
  const [remindersGuide, setRemindersGuide] = useState(false)
  const [touring, setTouring] = useState(false)
  // Deletes wait out the undo window before reaching the server.
  const pendingDeletes = useRef(new Map<number, number>())

  const showToast = useCallback((data: Omit<ToastData, 'id'>) => setToast({ ...data, id: Date.now() }), [])
  const notify = useCallback((title: string, detail?: string) => showToast({ title, detail }), [showToast])
  const dismissToast = useCallback(() => setToast(null), [])

  // When a timer ends: a message with "Mark done" for its task, plus a system notification if the
  // page is in the background and notifications are allowed.
  const tasksRef = useRef<Task[]>([])
  const onTimerFinish = useCallback(
    (finished: TimerState) => {
      const task = finished.taskId ? tasksRef.current.find((t) => t.id === finished.taskId && !t.done) : undefined
      showToast({
        title: "Time's up",
        detail: finished.label || 'Your timer finished.',
        action: task
          ? {
              label: 'Mark done',
              onClick: () => {
                setTasks((list) => list.map((t) => (t.id === task.id ? { ...t, done: true } : t)))
                api.updateTask(task.id, { done: true }).catch(() => undefined)
              },
            }
          : undefined,
      })
      if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        navigator.serviceWorker?.ready
          .then((reg) => reg.showNotification("Time's up", { body: finished.label || 'Your timer finished.', icon: '/icon.svg', tag: 'timer' }))
          .catch(() => undefined)
      }
    },
    [showToast],
  )
  const timer = useTimer(onTimerFinish)
  useEffect(() => {
    tasksRef.current = tasks
  }, [tasks])
  const closeSheet = useCallback(() => setSheet(null), [])
  const closeRemindersGuide = useCallback(() => setRemindersGuide(false), [])

  // This week (for progress) through the next few days, stretched to include whatever day is open,
  // plus anything unfinished from before today (the Overdue section), merged into one list.
  const load = useCallback(async () => {
    const today = startOfDay(new Date())
    const start = startOfWeek(today)
    const end = new Date(Math.max(addDays(start, 7).getTime(), addDays(today, 4).getTime(), addDays(day, 2).getTime()))
    try {
      const [list, overdue] = await Promise.all([api.listTasks(start, end), api.overdueTasks(today)])
      const seen = new Set(list.map((t) => t.id))
      const all = [...list, ...overdue.filter((t) => !seen.has(t.id))]
      setTasks(all.filter((t) => !pendingDeletes.current.has(t.id)))
      setLoadError('')
    } catch (err) {
      setLoadError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [day])

  useEffect(() => {
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [load])
  // Tasks friends add or change for you show up without a reload.
  useLiveRefresh(load, 30_000)

  // Time zone follows the device, so reminders read right after travelling.
  useEffect(() => {
    const zone = deviceTimezone()
    if (zone && zone !== user.timezone) auth.updateMe({ timezone: zone }).then(onUserChange).catch(() => undefined)
  }, [user.timezone, onUserChange])

  // Reminders on: make sure the server knows this device, every time the app opens. Fixes the
  // phone and server disagreeing (account restored, ban lifted, cleared data, expired address).
  const [deviceState, setDeviceState] = useState<DeviceReminderState>(() => deviceReminderState())
  useEffect(() => {
    if (!user.reminders_enabled) return
    syncThisDevice()
      .catch(() => undefined)
      .finally(() => setDeviceState(deviceReminderState()))
  }, [user.reminders_enabled])
  const [hideDeviceBanner, setHideDeviceBanner] = useState(false)

  const flushDeletes = useCallback(() => {
    for (const [id, timer] of pendingDeletes.current) {
      clearTimeout(timer)
      api.deleteTask(id, true).catch(() => undefined)
    }
    pendingDeletes.current.clear()
  }, [])

  useEffect(() => {
    window.addEventListener('pagehide', flushDeletes)
    return () => window.removeEventListener('pagehide', flushDeletes)
  }, [flushDeletes])

  const replace = (task: Task) => setTasks((list) => list.map((t) => (t.id === task.id ? task : t)))

  function openCreate(date: Date, time?: string) {
    const isToday = sameDay(date, new Date())
    const nextHour = Math.min(new Date().getHours() + 1, 23)
    setSheet({
      opened: Date.now(),
      task: null,
      defaults: { date, time: time ?? `${String(isToday ? nextHour : 9).padStart(2, '0')}:00`, fromClock: time !== undefined },
    })
  }

  async function save(input: TaskInput) {
    const editing = sheet?.task
    if (editing) {
      const updated = await api.updateTask(editing.id, input)
      replace(updated)
      notify('Changes saved', updated.title)
      return
    }
    const created = await api.createTask(input)
    setTasks((list) => [...list, created])
    setFreshId(created.id)
    setTimeout(() => setFreshId((id) => (id === created.id ? null : id)), 8000)
    showToast({
      title: 'Task added',
      detail: `${created.title} · ${describeDue(created)}`,
      action: {
        label: 'Undo',
        onClick: () => {
          setTasks((list) => list.filter((t) => t.id !== created.id))
          api.deleteTask(created.id).catch((err) => notify("Couldn't undo", errorMessage(err)))
        },
      },
    })
  }

  async function toggle(task: Task) {
    replace({ ...task, done: !task.done })
    try {
      replace(await api.updateTask(task.id, { done: !task.done }))
    } catch (err) {
      replace(task)
      notify("Couldn't update the task", errorMessage(err))
    }
  }

  /** Overdue → today, at the same time if that's still ahead, otherwise at the next full hour. */
  async function moveToToday(list: Task[]) {
    const now = new Date()
    const nextHour = new Date(now)
    nextHour.setHours(now.getHours() + 1, 0, 0, 0)
    const moved = list.map((task) => {
      const was = dueDate(task)!
      const sameTime = new Date(now)
      sameTime.setHours(was.getHours(), was.getMinutes(), 0, 0)
      return { ...task, due_at: (sameTime > now ? sameTime : nextHour).toISOString() }
    })
    moved.forEach(replace)
    const results = await Promise.allSettled(moved.map((t) => api.updateTask(t.id, { due_at: t.due_at })))
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') replace(result.value)
      else replace(list[i])
    })
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed) notify("Couldn't move some tasks", `${failed} of ${list.length} stayed where they were.`)
    else showToast({ title: list.length === 1 ? 'Moved to today' : `${list.length} tasks moved to today`, detail: list.length === 1 ? list[0].title : undefined })
  }

  function remove(task: Task) {
    setSheet(null)
    setTasks((list) => list.filter((t) => t.id !== task.id))
    const timer = window.setTimeout(() => {
      pendingDeletes.current.delete(task.id)
      api.deleteTask(task.id).catch((err) => {
        setTasks((list) => [...list, task])
        notify("Couldn't delete the task", errorMessage(err))
      })
    }, UNDO_MS)
    pendingDeletes.current.set(task.id, timer)
    showToast({
      title: 'Task deleted',
      detail: `${task.title} · in Profile → Recently deleted for 7 days`,
      action: {
        label: 'Undo',
        onClick: () => {
          clearTimeout(timer)
          pendingDeletes.current.delete(task.id)
          setTasks((list) => [...list, task])
        },
      },
    })
  }

  /** Permission + subscribe this device, then reminders on for the account. True if it worked. */
  async function enableReminders() {
    // iPhone in a Safari tab, an old browser, or blocked: show how to set this device up instead.
    if (!canAskForNotifications()) {
      setRemindersGuide(true)
      return false
    }
    setRemindersBusy(true)
    try {
      await subscribeThisDevice()
      onUserChange(await auth.updateMe({ reminders_enabled: true }))
      setDeviceState(deviceReminderState())
      notify('Reminders on', 'You get a notification before timed tasks (10 min by default, changeable per task).')
      return true
    } catch (err) {
      notify("Couldn't turn reminders on", errorMessage(err))
      setRemindersGuide(true)
      return false
    } finally {
      setRemindersBusy(false)
    }
  }

  async function toggleReminders() {
    if (remindersBusy) return
    if (!user.reminders_enabled) {
      await enableReminders()
      return
    }
    setRemindersBusy(true)
    try {
      onUserChange(await auth.updateMe({ reminders_enabled: false }))
      await unsubscribeThisDevice()
      notify('Reminders off', "You won't get task notifications.")
    } catch (err) {
      notify("Couldn't turn reminders off", errorMessage(err))
    } finally {
      setRemindersBusy(false)
    }
  }

  async function logout() {
    flushDeletes()
    // Stop this browser getting the previous person's reminders.
    await unsubscribeThisDevice()
    await auth.logout()
    clearSavedTimer()
    onLoggedOut("You've logged out.")
  }

  async function deleteAccount(password: string) {
    flushDeletes()
    // Remove this browser's push subscription while we're still signed in to do it.
    await unsubscribeThisDevice()
    await auth.deleteAccount(password)
    clearSavedTimer()
    onLoggedOut('Your account was deleted. Changed your mind? Log in within 30 days to restore it.')
  }

  function startTour() {
    setSheet(null)
    setView('home')
    window.scrollTo({ top: 0 })
    setTouring(true)
  }

  function markTutorialSeen() {
    if (user.tutorial_seen) return
    onUserChange({ ...user, tutorial_seen: true })
    auth.updateMe({ tutorial_seen: true }).catch(() => undefined)
  }

  useEffect(preloadScreens, [])

  // Panels that scroll on their own (task list, chats) size themselves to the screen below the
  // header, which changes height with banners and window width.
  const mainRef = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const main = mainRef.current
    if (!main?.parentElement) return
    const update = () => document.documentElement.style.setProperty('--main-top', `${Math.round(main.getBoundingClientRect().top + window.scrollY)}px`)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(main.parentElement)
    window.addEventListener('resize', update)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, '', window.location.pathname)
  }, [])

  // Friend requests + new shares, for the badge. Cheap: one tiny request on focus and once a minute.
  const loadBadge = useCallback(() => {
    social
      .summary()
      .then((s) => setSocialBadge(s.incoming_requests + s.new_shares))
      .catch(() => undefined)
  }, [])

  // No polling while the tab is hidden; it refreshes as soon as you come back.
  useEffect(() => {
    loadBadge()
  }, [loadBadge])
  useLiveRefresh(loadBadge, 20_000)

  // The live connection (chat, online status, instant updates). Off if the server has no key.
  useEffect(() => {
    void startLive(user.id)
    if (user.is_staff) void startAdminLive()
    return stopLive
  }, [user.id, user.is_staff])

  const loadChatBadge = useCallback(() => {
    chat
      .list()
      .then((c) => setChatBadge(c.unread))
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    loadChatBadge()
  }, [loadChatBadge])
  useLiveRefresh(loadChatBadge, 30_000)
  useEffect(() => onLive((e) => e.name === 'chat' && loadChatBadge()), [loadChatBadge])

  // A chat notification tapped while the app is already open.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'open') return
      const url = new URL(String(event.data.url), window.location.origin)
      const id = Number(url.searchParams.get('chat'))
      if (url.searchParams.get('view') === 'chats') {
        setView('chats')
        if (id) setChatStart({ chatId: id, at: Date.now() })
      }
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [])

  const remindersOn = user.reminders_enabled
  const headings: Record<View, [string, string]> = {
    home: [formatLongDate(now), greeting(now)],
    progress: ['This week', 'Your progress'],
    profile: ['Account', 'Your profile'],
    timer: ['Focus', 'Timer'],
    admin: ['Staff only', 'Admin dashboard'],
    friends: ['People', 'Friends'],
    chats: ['Messages', 'Chats'],
  }

  const bell = (className: string) => (
    <button
      className={className}
      data-tour="reminders"
      role="switch"
      aria-checked={remindersOn}
      aria-label="Task reminders"
      disabled={remindersBusy}
      onClick={toggleReminders}
    >
      <Icon name={remindersOn ? 'bell' : 'bellOff'} />
    </button>
  )

  return (
    <>
      <Backdrop />

      <div className="app">
        <header className="header">
          <div className="header-title">
            <span className="eyebrow">{headings[view][0]}</span>
            <h1 className="greeting">{headings[view][1]}</h1>
          </div>
          <nav className="segmented header-tabs desktop-only" aria-label="View">
            <button aria-pressed={view === 'home'} onClick={() => setView('home')}>
              Clock
            </button>
            <button aria-pressed={view === 'progress'} data-tour="progress" onClick={() => setView('progress')}>
              Progress
            </button>
            <button aria-pressed={view === 'friends'} data-tour="friends" onClick={() => setView('friends')}>
              Friends
              {socialBadge > 0 && <span className="nav-badge" aria-label={`${socialBadge} new`}>{socialBadge}</span>}
            </button>
            <button aria-pressed={view === 'timer'} onClick={() => setView('timer')}>
              Timer
            </button>
            {user.is_staff && (
              <button aria-pressed={view === 'admin'} onClick={() => setView('admin')}>
                Admin
              </button>
            )}
          </nav>
          <div className="header-actions">
            <TimerPill timer={timer.state} active={view === 'timer'} onOpen={() => setView('timer')} />
            <button
              className="round-btn desktop-only"
              data-tour="chats"
              aria-label={chatBadge ? `Chats, ${chatBadge} unread` : 'Chats'}
              aria-pressed={view === 'chats'}
              onClick={() => setView('chats')}
            >
              <Icon name="chat" />
              {chatBadge > 0 && <span className="nav-badge" aria-hidden="true">{chatBadge}</span>}
            </button>
            {bell(`round-btn${remindersOn ? ' on' : ''}`)}
            <button
              className="avatar-btn desktop-only"
              data-tour="profile"
              aria-label="Your profile"
              aria-current={view === 'profile' ? 'page' : undefined}
              onClick={() => setView('profile')}
            >
              <span className="avatar">{initials(user)}</span>
            </button>
            <button className="primary-btn desktop-only" data-tour="new-task" onClick={() => openCreate(day)}>
              <Icon name="plus" />
              New task
            </button>
          </div>
        </header>

        {user.reminders_enabled && deviceState !== 'ready' && !hideDeviceBanner && (
          <div className="device-banner" role="status">
            <Icon name="bellOff" />
            <span>
              <strong>Reminders are on, but not on this device.</strong>{' '}
              {deviceState === 'needs-permission'
                ? 'Allow notifications here to get them.'
                : deviceState === 'blocked'
                  ? 'Notifications are blocked for this site in your settings.'
                  : 'This browser can\'t show them. On iPhone, open To-Do from your Home Screen.'}
            </span>
            {deviceState === 'needs-permission' ? (
              <button
                type="button"
                className="primary-btn small"
                onClick={async () => {
                  if (await enableReminders()) setDeviceState(deviceReminderState())
                }}
              >
                Turn on
              </button>
            ) : (
              <button type="button" className="text-btn" onClick={() => setRemindersGuide(true)}>
                How to fix
              </button>
            )}
            <button type="button" className="icon-btn" aria-label="Hide for now" onClick={() => setHideDeviceBanner(true)}>
              <Icon name="x" />
            </button>
          </div>
        )}

        {loadError && (
          <div className="error-banner" role="alert">
            <span>{loadError}</span>
            <button className="text-btn" onClick={load}>
              Retry
            </button>
          </div>
        )}

        <main ref={mainRef}>
          <Suspense fallback={<p className="empty">Loading…</p>}>
          {view === 'timer' ? (
            <Reveal key="timer">
              <Timer
                timer={timer.state}
                tasks={tasks}
                onDuration={timer.setDuration}
                onTask={timer.setTask}
                onStart={timer.start}
                onPause={timer.pause}
                onReset={timer.reset}
                onAddMinute={timer.addMinute}
              />
            </Reveal>
          ) : view === 'friends' ? (
            <Reveal key="friends">
              <Friends
                now={now}
                notify={notify}
                onSendTasks={(friend) => setSendDialog({ friendId: friend?.id })}
                onMessage={(friend) => {
                  setChatStart({ friendId: friend.id, at: Date.now() })
                  setView('chats')
                }}
                onChanged={() => {
                  load()
                  loadBadge()
                }}
              />
            </Reveal>
          ) : view === 'chats' ? (
            <Reveal key="chats">
              <Chats myId={user.id} now={now} notify={notify} start={chatStart} onUnread={setChatBadge} onStarted={clearChatStart} />
            </Reveal>
          ) : view === 'admin' && user.is_staff ? (
            <Reveal key="admin">
              <Admin me={user} now={now} notify={notify} />
            </Reveal>
          ) : view === 'profile' ? (
            <Reveal key="profile">
            <Profile
              user={user}
              now={now}
              remindersBusy={remindersBusy}
              themePreference={theme.preference}
              onUserChange={onUserChange}
              onToggleReminders={toggleReminders}
              onOpenRemindersGuide={() => setRemindersGuide(true)}
              onThemeChange={theme.choose}
              onReplayTutorial={startTour}
              onOpenAdmin={user.is_staff ? () => setView('admin') : undefined}
              onLogout={logout}
              onDeleteAccount={deleteAccount}
              onTasksRestored={load}
              notify={notify}
            />
            </Reveal>
          ) : loading ? (
            <p className="empty">Loading your tasks…</p>
          ) : view === 'home' ? (
            <Reveal key="home">
            <Home
              tasks={tasks}
              now={now}
              day={day}
              freshId={freshId}
              onDayChange={setDay}
              onToggle={toggle}
              onMoveToToday={moveToToday}
              onOpen={(task) => setSheet({ task, defaults: { date: day, time: '' }, opened: Date.now() })}
              onDelete={remove}
              onCreateAt={(d, time) => openCreate(d, time)}
              onAddOnDay={(d) => openCreate(d)}
              onShowProgress={() => setView('progress')}
            />
            </Reveal>
          ) : (
            <Reveal key="progress">
              <Progress tasks={tasks} now={now} />
            </Reveal>
          )}
          </Suspense>
        </main>
      </div>

      <nav className="bottom-nav glass mobile-only" aria-label="Main">
        <button className="nav-btn" aria-label="Clock" aria-current={view === 'home' ? 'page' : undefined} onClick={() => setView('home')}>
          <Icon name="clock" />
        </button>
        <button
          className="nav-btn"
          data-tour="chats"
          aria-label={chatBadge ? `Chats, ${chatBadge} unread` : 'Chats'}
          aria-current={view === 'chats' ? 'page' : undefined}
          onClick={() => setView('chats')}
        >
          <Icon name="chat" />
          {chatBadge > 0 && <span className="nav-badge" aria-hidden="true">{chatBadge}</span>}
        </button>
        <button className="fab" data-tour="new-task" aria-label="New task" onClick={() => openCreate(day)}>
          <Icon name="plus" />
        </button>
        <button
          className="nav-btn"
          data-tour="friends"
          aria-label={socialBadge ? `Friends, ${socialBadge} new` : 'Friends'}
          aria-current={view === 'friends' ? 'page' : undefined}
          onClick={() => setView('friends')}
        >
          <Icon name="users" />
          {socialBadge > 0 && <span className="nav-badge" aria-hidden="true">{socialBadge}</span>}
        </button>
        <button
          className="nav-btn"
          data-tour="profile"
          aria-label="Your profile"
          aria-current={view === 'profile' ? 'page' : undefined}
          onClick={() => setView('profile')}
        >
          <span className="avatar">{initials(user)}</span>
        </button>
      </nav>

      {sheet && (
        <TaskSheet
          key={sheet.opened}
          task={sheet.task}
          defaults={sheet.defaults}
          remindersOn={remindersOn}
          onClose={closeSheet}
          onSave={save}
          onDelete={remove}
          onSend={(task) => {
            setSheet(null)
            setSendDialog({ taskIds: [task.id] })
          }}
        />
      )}

      {sendDialog && (
        <Suspense fallback={null}>
          <SendTasksDialog
            tasks={tasks}
            initialFriendId={sendDialog.friendId}
            initialTaskIds={sendDialog.taskIds}
            onClose={() => setSendDialog(null)}
            onSent={(title, detail) => {
              setSendDialog(null)
              notify(title, detail)
              load() // your tasks now show who they were added for
            }}
          />
        </Suspense>
      )}

      {toast && <Toast key={toast.id} toast={toast} onDismiss={dismissToast} />}

      <Suspense fallback={null}>
      {remindersGuide && (
        <RemindersGuide
          remindersOn={user.reminders_enabled}
          busy={remindersBusy}
          onEnableHere={enableReminders}
          onClose={closeRemindersGuide}
          notify={notify}
        />
      )}
      {/* Accounts from before usernames choose theirs once (before anything else). */}
      {!user.username_confirmed && <ChooseUsername user={user} onDone={onUserChange} />}
      {user.username_confirmed && !user.tutorial_seen && !touring && (
        <WelcomeDialog
          name={user.full_name}
          onAnswer={(firstTime) => {
            if (firstTime) startTour()
            else markTutorialSeen()
          }}
        />
      )}

      {touring && (
        <Tour
          steps={TOUR_STEPS}
          onClose={() => {
            setTouring(false)
            markTutorialSeen()
          }}
        />
      )}
      </Suspense>
    </>
  )
}
