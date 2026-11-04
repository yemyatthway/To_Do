import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { api, auth, chat, createOutbox, refreshSession, setSessionExpiredHandler, social, workspaces, type Task, type TaskInput, type User, type WorkspaceList } from './api'
import { SideNav } from './components/SideNav'
import { AppSkeleton, CardsSkeleton, HomeSkeleton, Loading, LoadingPage } from './components/Loading'
import { TaskSheet, type SheetDefaults } from './components/TaskSheet'
import { Toast, type ToastData } from './components/Toast'
import type { TourStep } from './components/Tour'
import { TimerPill } from './components/TimerPill'
import { Icon } from './icons'
import { clearSavedTimer, useTimer, type TimerState } from './timer/useTimer'
import { enter, useGsap } from './motion'
import { AuthScreen } from './pages/AuthScreen'
import { forgetJoinEmail, guestTokenFrom } from './guestLink'
import { isChildPage, parseRoute, SETTINGS_SECTIONS, useRoute, type Route, type View } from './routes'
import { useLiveRefresh } from './live'
import { clearPageDrafts, pageStorage, sendLeftoverDrafts } from './pageSaver'
import { clearLeftoverRows, sendLeftoverRows } from './rowSaver'
import type { WorkspaceItem } from './pages/Workspaces'
import { overlayTasks, type TaskPatch } from './outbox'
import { onLive, startAdminLive, startLive, stopLive } from './realtime'
import { usePageVisible } from './visibility'
import { loadShownReminders, reminderKey, remindersDue, saveShownReminders } from './taskReminders'
import { VerifyEmail } from './pages/VerifyEmail'
import { Home } from './pages/Home'
import { More } from './pages/More'
import { canAskForNotifications, deviceReminderState, subscribeThisDevice, syncThisDevice, unsubscribeThisDevice, type DeviceReminderState } from './push'
import { useTheme } from './theme'
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
import { chooseLanguage, hasChosenLanguage, language, tr } from './i18n'
import type { TaskList } from './taskGroups'
import { ConfirmAction } from './components/ConfirmAction'

// Phone: screens reached through More, which get a back button.
const MORE_VIEWS: readonly View[] = ['more', 'progress', 'timer', 'profile', 'admin', 'workspaces', 'workspace', 'notifications']

// Screens most visits never open load on demand, so the first paint stays small.
const GuestScreen = lazy(() => import('./pages/Guest').then((m) => ({ default: m.GuestScreen })))
const Profile = lazy(() => import('./pages/Profile').then((m) => ({ default: m.Profile })))
const Progress = lazy(() => import('./pages/Progress').then((m) => ({ default: m.Progress })))
const Admin = lazy(() => import('./pages/Admin').then((m) => ({ default: m.Admin })))
const Tasks = lazy(() => import('./pages/Tasks').then((m) => ({ default: m.Tasks })))
const Timer = lazy(() => import('./pages/Timer').then((m) => ({ default: m.Timer })))
const Friends = lazy(() => import('./pages/Friends').then((m) => ({ default: m.Friends })))
const Notifications = lazy(() => import('./pages/Notifications').then((m) => ({ default: m.Notifications })))
const Workspaces = lazy(() => import('./pages/Workspaces').then((m) => ({ default: m.Workspaces })))
const WorkspacePage = lazy(() => import('./pages/Workspaces').then((m) => ({ default: m.WorkspacePage })))
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
    import('./pages/Workspaces')
    import('./pages/Notifications')
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
    title: tr('Your day on a clock'),
    body: tr('Each dot is a task, colored by category. The clock always shows the next 12 hours, so AM and PM are picked for you.'),
  },
  {
    target: 'clock-hour',
    title: tr('Tap or hold an hour'),
    body: tr('Tap an hour to see what\'s due then. Press and hold an hour to add a task at that time.'),
    gesture: 'hold',
  },
  { target: 'day-strip', title: tr('Plan ahead'), body: tr('Switch between today and the next few days.'), gesture: 'tap' },
  { target: 'new-task', title: tr('Add a task'), body: tr('Add a task with a time, category, priority and reminder.'), gesture: 'tap' },
  {
    target: 'task-list',
    title: tr('Your list'),
    body: tr('Tick the circle when you\'re done and tap a task to edit it. Swipe left, or use the trash icon, to delete. You always get an Undo.'),
    gesture: 'swipe',
  },
  { target: 'day-progress', title: tr('Daily progress'), body: tr('One block per task. Filled blocks are done.') },
  { target: 'progress', title: tr('Your week'), body: tr('See how your day, week and categories are going.'), gesture: 'tap' },
  {
    target: 'friends',
    title: tr('Friends'),
    body: tr('Find people, add them as friends, and send them copies of your tasks. Tasks they send you wait here until you add them. Nobody can see your list.'),
    gesture: 'tap',
  },
  {
    target: 'chats',
    title: tr('Chats'),
    body: tr('Message your friends. You see when they\'re online, typing, and when they\'ve seen your message.'),
    gesture: 'tap',
  },
  {
    target: 'workspaces',
    title: tr('Workspaces'),
    body: tr('Make a shared space for a team and invite people with a role that decides what they can do. Your own tasks stay private.'),
    gesture: 'tap',
  },
  {
    target: 'reminders',
    title: tr('Reminders'),
    body: tr('Turn reminders on to get a notification before your tasks (10 minutes by default; pick another time on any task). Tap again to turn them off.'),
    gesture: 'tap',
  },
  {
    target: 'timer',
    title: tr('Timer'),
    body: tr('Start a countdown, like a 25-minute focus session, optionally for a task. It keeps running on every screen and chimes when time is up.'),
    gesture: 'tap',
  },
  {
    target: 'profile',
    title: tr('Your profile'),
    body: tr('Change your name, email, password or light/dark theme, and replay this tutorial whenever you like. That\'s it, enjoy!'),
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
  if (!due) return tr('Anytime')
  const today = startOfDay(new Date())
  const day = sameDay(due, today) ? tr('Today') : sameDay(due, addDays(today, 1)) ? tr('Tomorrow') : formatShortDay(due)
  return `${day} · ${formatTime(due)}`
}

function Backdrop() {
  return <div className="backdrop" aria-hidden="true" />
}

/** Signed-in gate, like afm_sys: restore the session from the refresh cookie, otherwise show login. */
export default function App() {
  const guestToken = guestTokenFrom(window.location.pathname)
  if (guestToken) {
    return (
      <>
        <Backdrop />
        <Suspense fallback={<LoadingPage skeleton={<CardsSkeleton />} />}>
          <GuestScreen token={guestToken} />
        </Suspense>
      </>
    )
  }
  return <AccountApp />
}

function AccountApp() {
  useTheme()
  const [booting, setBooting] = useState(true)
  const [user, setUser] = useState<User | null>(null)

  // A new device takes the account's language; after that, each choice is saved to the account.
  const accountLanguage = user?.language
  useEffect(() => {
    if (!accountLanguage || accountLanguage === language) return
    if (hasChosenLanguage()) void auth.updateMe({ language }).catch(() => undefined)
    else chooseLanguage(accountLanguage)
  }, [accountLanguage])
  const [notice, setNotice] = useState('')

  useEffect(() => {
    setSessionExpiredHandler(() => {
      setUser(null)
      setNotice(tr('Your session expired. Log in again.'))
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
        <LoadingPage skeleton={<AppSkeleton />} />
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
            forgetJoinEmail()
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

/** Only what the sheet actually changed, so an edit can't overwrite other fields. */
function changedFields(task: Task, input: TaskInput) {
  const patch: Record<string, unknown> = {}
  for (const field of Object.keys(input) as (keyof TaskInput)[]) {
    const same =
      field === 'due_at' ? (task.due_at ? new Date(task.due_at).getTime() : null) === (input.due_at ? new Date(input.due_at).getTime() : null) : task[field] === input[field]
    if (!same) patch[field] = input[field]
  }
  return patch as TaskPatch
}

function Workspace({ user, onUserChange, onLoggedOut }: { user: User; onUserChange: (u: User) => void; onLoggedOut: (message: string) => void }) {
  const theme = useTheme()
  const now = useNow(30_000)

  // The page comes from the address, so refresh, Back and shared links all work.
  const { route: asked, navigate, goBack } = useRoute()
  const route: Route = asked.view === 'admin' && !user.is_staff ? { view: 'home' } : asked
  const view = route.view
  const workspaceId = route.view === 'workspace' ? route.id : null
  const go = useCallback((next: Exclude<View, 'workspace'>) => navigate({ view: next } as Route), [navigate])
  const [friendName, setFriendName] = useState<string | null>(null)
  const [unreadNotices, setUnreadNotices] = useState(0)
  const [sideItems, setSideItems] = useState<{ workspaceId: number; items: WorkspaceItem[] } | null>(null)
  const showSideItems = useCallback((workspaceId: number, items: WorkspaceItem[]) => setSideItems({ workspaceId, items }), [])
  // Staff only: anyone else who opens /admin lands on Today, with the address to match.
  useEffect(() => {
    if (asked.view === 'admin' && !user.is_staff) navigate({ view: 'home' }, { replace: true })
  }, [asked.view, user.is_staff, navigate])
  const [chatStart, setChatStart] = useState<{ chatId?: number; friendId?: number; at: number } | undefined>(() => {
    const id = Number(new URLSearchParams(window.location.search).get('chat'))
    return id ? { chatId: id, at: Date.now() } : undefined
  })
  const [chatBadge, setChatBadge] = useState(0)
  const [workspaceList, setWorkspaceList] = useState<WorkspaceList | null>(null)
  const [workspaceError, setWorkspaceError] = useState('')
  const clearChatStart = useCallback(() => setChatStart(undefined), [])
  const [sendDialog, setSendDialog] = useState<{ friendId?: number; taskIds?: number[] } | null>(null)
  const [socialBadge, setSocialBadge] = useState(0)
  const [day, setDay] = useState(() => startOfDay(new Date()))
  // What the server last said; `tasks` adds everything still waiting to be saved on top.
  const [serverTasks, setTasks] = useState<Task[]>([])
  const [outbox] = useState(() => createOutbox(user.id))
  const sync = useSyncExternalStore(outbox.subscribe, outbox.getSnapshot)
  // Deleted, but the Undo window is still open.
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set())
  const [taskChanges, setTaskChanges] = useState(0)
  const [taskList, setTaskList] = useState<TaskList>('todo')
  // The warnings before anything hard to take back.
  const [deleting, setDeleting] = useState<Task | null>(null)
  const [loggingOut, setLoggingOut] = useState(false)
  const tasks = useMemo(() => overlayTasks(serverTasks, sync).filter((t) => !hidden.has(t.id)), [serverTasks, sync, hidden])
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

  // A reminder whose time comes while the app is on screen: the phone may not show a notification
  // over its own app, and this works even if a push never arrives.
  const pageVisible = usePageVisible()
  useEffect(() => {
    if (!user.reminders_enabled || !pageVisible) return
    const shown = loadShownReminders(now)
    const due = remindersDue(tasks, now, shown)
    if (!due.length) return
    for (const task of due) shown[reminderKey(task)] = now.getTime()
    saveShownReminders(shown)
    const first = due[0]
    const minutes = Math.max(1, Math.round((new Date(first.due_at!).getTime() - now.getTime()) / 60_000))
    const when = `${tr('in {minutes} min', { minutes })} · ${formatTime(new Date(first.due_at!))}`
    // oxlint-disable-next-line react-hooks/set-state-in-effect -- the clock moved on, nothing to derive it from
    showToast({
      title: first.title,
      detail: due.length > 1 ? `${when} · ${tr('{count} more coming up', { count: due.length - 1 })}` : when,
      durationMs: 12_000,
    })
  }, [now, tasks, user.reminders_enabled, pageVisible, showToast])

  // When a timer ends: a message with "Mark done" for its task, plus a system notification if the
  // page is in the background and notifications are allowed.
  const tasksRef = useRef<Task[]>([])
  const onTimerFinish = useCallback(
    (finished: TimerState) => {
      const task = finished.taskId ? tasksRef.current.find((t) => t.id === finished.taskId && !t.done) : undefined
      showToast({
        title: tr('Time\'s up'),
        detail: finished.label || tr('Your timer finished.'),
        action: task
          ? {
              label: tr('Mark done'),
              onClick: () => outbox.updateTask(task, { done: true }),
            }
          : undefined,
      })
      if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        navigator.serviceWorker?.ready
          .then((reg) => reg.showNotification("Time's up", { body: finished.label || tr('Your timer finished.'), icon: '/icon.svg', tag: 'timer' }))
          .catch(() => undefined)
      }
    },
    [showToast, outbox],
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
      setTasks(all)
      setLoadError('')
    } catch (err) {
      setLoadError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [day])

  useEffect(() => {
    // load only sets state after the requests finish (the linter can't see through the await).
    // oxlint-disable-next-line react/set-state-in-effect
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

  const unhide = (id: number) =>
    setHidden((set) => {
      const next = new Set(set)
      next.delete(id)
      return next
    })

  // Leaving the app: the delete is safe in the queue, and this tries to get it out right now too.
  const flushDeletes = useCallback(() => {
    for (const [id, timer] of pendingDeletes.current) {
      clearTimeout(timer)
      outbox.deleteTask(id)
      const real = outbox.resolve(id)
      if (real > 0) api.deleteTask(real, true).catch(() => undefined)
    }
    pendingDeletes.current.clear()
    setHidden(new Set())
  }, [outbox])

  // Answers from the save queue. Assigned every render, so they always see the latest state.
  useEffect(() => {
    outbox.events = {
      onTaskSaved: (previousId, task, op) => {
        setTasks((list) => (list.some((t) => t.id === previousId || t.id === task.id) ? list.map((t) => (t.id === previousId || t.id === task.id ? task : t)) : [...list, task]))
        setFreshId((id) => (id === previousId ? task.id : id))
        if (timer.state.taskId === previousId && previousId < 0) timer.setTask(task.id, timer.state.label)
        if (op.kind === 'task.update' && op.announce) notify(op.announce, task.title)
      },
      onTaskDeleted: (id) => setTasks((list) => list.filter((t) => t.id !== id)),
      onTaskGone: (id) => {
        setTasks((list) => list.filter((t) => t.id !== id))
        notify(tr('That task was deleted somewhere else'))
      },
      onConflict: (op, current) => {
        setTasks((list) => list.map((t) => (t.id === current.id ? current : t)))
        showToast({
          title: tr('Changed somewhere else'),
          detail: tr('"{title}" was updated on another device or by a friend, so your edit wasn\'t applied.', { title: current.title }),
          action: { label: tr('Keep mine'), onClick: () => outbox.updateTask(current, op.patch, { announce: tr('Changes saved') }) },
        })
      },
      onFailed: (op, message) => {
        if (op.kind === 'chat.send') return // the chat shows it on the message itself
        if (op.kind === 'task.delete') {
          notify(tr('Couldn\'t delete the task'), message)
          return
        }
        const title = op.kind === 'task.create' ? op.input.title : (tasksRef.current.find((t) => t.id === op.taskId)?.title ?? tr('your task'))
        showToast({ title: tr('Couldn\'t save "{title}"', { title }), detail: tr('{message} Tap the task to fix it.', { message }), action: { label: tr('Discard'), onClick: () => outbox.discard(op.key) } })
      },
      onDrained: () => {
        void load()
        setTaskChanges((n) => n + 1)
      },
      onExternalChange: () => {
        void load()
        setTaskChanges((n) => n + 1)
      },
    }
  })

  useEffect(() => {
    outbox.start()
    const onVisible = () => {
      if (!document.hidden) outbox.kick()
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === outbox.storageKey) outbox.reload()
    }
    window.addEventListener('online', outbox.kick)
    window.addEventListener('storage', onStorage)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      outbox.stop()
      window.removeEventListener('online', outbox.kick)
      window.removeEventListener('storage', onStorage)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [outbox])

  useEffect(() => {
    window.addEventListener('pagehide', flushDeletes)
    return () => window.removeEventListener('pagehide', flushDeletes)
  }, [flushDeletes])

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
      const patch = changedFields(editing, input)
      // Saving a refused change again without edits just tries again.
      if (Object.keys(patch).length) outbox.updateTask(editing, patch, { announce: tr('Changes saved') })
      else outbox.retryTask(editing.id)
      return
    }
    const created = { ...input, id: outbox.createTask(input) } as Task
    setFreshId(created.id)
    setTimeout(() => setFreshId((id) => (id === created.id || id === outbox.resolve(created.id) ? null : id)), 8000)
    showToast({
      title: tr('Task added'),
      detail: `${created.title} · ${describeDue(created)}`,
      action: {
        label: tr('Undo'),
        onClick: () => outbox.deleteTask(created.id),
      },
    })
  }

  function toggle(task: Task) {
    outbox.updateTask(task, { done: !task.done })
  }

  /** Overdue → today, at the same time if that's still ahead, otherwise at the next full hour. */
  function moveToToday(list: Task[]) {
    const now = new Date()
    const nextHour = new Date(now)
    nextHour.setHours(now.getHours() + 1, 0, 0, 0)
    for (const task of list) {
      const was = dueDate(task)!
      const sameTime = new Date(now)
      sameTime.setHours(was.getHours(), was.getMinutes(), 0, 0)
      outbox.updateTask(task, { due_at: (sameTime > now ? sameTime : nextHour).toISOString() })
    }
    showToast({ title: list.length === 1 ? tr('Moved to today') : tr('{length} tasks moved to today', { length: list.length }), detail: list.length === 1 ? list[0].title : undefined })
  }

  function remove(task: Task) {
    setSheet(null)
    setHidden((set) => new Set(set).add(task.id))
    const timer = window.setTimeout(() => {
      pendingDeletes.current.delete(task.id)
      outbox.deleteTask(task.id)
      unhide(task.id)
    }, UNDO_MS)
    pendingDeletes.current.set(task.id, timer)
    showToast({
      title: tr('Task deleted'),
      detail: tr('{title} · in Profile → Recently deleted for 7 days', { title: task.title }),
      action: {
        label: tr('Undo'),
        onClick: () => {
          clearTimeout(timer)
          pendingDeletes.current.delete(task.id)
          unhide(task.id)
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
      notify(tr('Reminders on'), tr('You get a notification before timed tasks (10 min by default, changeable per task).'))
      return true
    } catch (err) {
      notify(tr('Couldn\'t turn reminders on'), errorMessage(err))
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
      notify(tr('Reminders off'), tr('You won\'t get task notifications.'))
    } catch (err) {
      notify(tr('Couldn\'t turn reminders off'), errorMessage(err))
    } finally {
      setRemindersBusy(false)
    }
  }

  async function logout(anyway = false) {
    flushDeletes()
    // Don't drop work without saying so: give it one last try, then ask.
    const unsaved = await outbox.settle()
    if (unsaved && !anyway) {
      showToast({
        title: tr('{unsaved} {value} saved yet', { unsaved, value: unsaved === 1 ? "change hasn't" : "changes haven't" }),
        detail: tr('Stay logged in and they save by themselves when the connection is back.'),
        action: { label: tr('Log out anyway'), onClick: () => void logout(true) },
      })
      return
    }
    outbox.clear()
    // Stop this browser getting the previous person's reminders.
    await unsubscribeThisDevice()
    await auth.logout()
    clearSavedTimer()
    window.history.replaceState(null, '', '/')
    onLoggedOut(tr('You\'ve logged out.'))
  }

  async function deleteAccount(password: string) {
    flushDeletes()
    // Remove this browser's push subscription while we're still signed in to do it.
    await unsubscribeThisDevice()
    await auth.deleteAccount(password)
    outbox.clear()
    clearPageDrafts(user.id, pageStorage())
    clearLeftoverRows(user.id, pageStorage())
    clearSavedTimer()
    window.history.replaceState(null, '', '/')
    onLoggedOut(tr('Your account was deleted. Changed your mind? Log in within 30 days to restore it.'))
  }

  function startTour() {
    setSheet(null)
    go('home')
    setTouring(true)
  }

  function markTutorialSeen() {
    if (user.tutorial_seen) return
    onUserChange({ ...user, tutorial_seen: true })
    auth.updateMe({ tutorial_seen: true }).catch(() => undefined)
  }

  useEffect(preloadScreens, [])

  // Page text left on this device by a page that closed before it could save.
  useEffect(() => {
    void sendLeftoverDrafts(user.id, pageStorage(), workspaces.savePage)
    void sendLeftoverRows(user.id, pageStorage(), workspaces.saveRow)
  }, [user.id])

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

  const loadWorkspaces = useCallback(() => {
    workspaces.list().then(
      (list) => {
        setWorkspaceList(list)
        setWorkspaceError('')
      },
      (err) => setWorkspaceError(errorMessage(err)),
    )
  }, [])
  useEffect(loadWorkspaces, [loadWorkspaces])
  useLiveRefresh(loadWorkspaces, 30_000)
  const closeLinkedRow = useCallback(
    (tableId: number) => {
      if (workspaceId) navigate({ view: 'workspace', id: workspaceId, section: 'table', tableId }, { replace: true })
    },
    [navigate, workspaceId],
  )
  const openWorkspace = useCallback((id: number) => navigate({ view: 'workspace', id, section: 'home' }), [navigate])
  const leftWorkspace = useCallback(() => {
    navigate({ view: 'workspaces' }, { replace: true })
    loadWorkspaces()
  }, [navigate, loadWorkspaces])
  useEffect(() => onLive((e) => e.name === 'chat' && loadChatBadge()), [loadChatBadge])

  // A chat notification tapped while the app is already open.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'open') return
      const url = new URL(String(event.data.url), window.location.origin)
      const id = Number(url.searchParams.get('chat'))
      const target = parseRoute(url.pathname, url.search)
      if (target.view !== 'home') navigate(target)
      if (target.view === 'chats' && id) setChatStart({ chatId: id, at: Date.now() })
    }
    navigator.serviceWorker?.addEventListener('message', onMessage)
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
  }, [navigate])

  const loadNotices = useCallback(() => {
    workspaces
      .notifications()
      .then((n) => setUnreadNotices(n.unread))
      .catch(() => undefined)
  }, [])
  useEffect(loadNotices, [loadNotices])

  // Being in a workspace counts as seeing what's new there.
  const openWorkspaceUnread = workspaceList?.workspaces.find((w) => w.id === workspaceId)?.unread ?? 0
  useEffect(() => {
    if (!workspaceId || !openWorkspaceUnread) return
    workspaces
      .readWorkspaceNotifications(workspaceId)
      .then(() => {
        loadNotices()
        loadWorkspaces()
      })
      .catch(() => undefined)
  }, [workspaceId, openWorkspaceUnread, loadNotices, loadWorkspaces])

  // The count on the app's icon, where the phone or computer supports it.
  const iconCount = chatBadge + unreadNotices + (workspaceList?.invitations.length ?? 0)
  useEffect(() => {
    if (!('setAppBadge' in navigator)) return
    void (iconCount ? navigator.setAppBadge(iconCount) : navigator.clearAppBadge()).catch(() => undefined)
  }, [iconCount])
  useLiveRefresh(loadNotices, 30_000)
  const openUrl = useCallback(
    (url: string) => {
      const target = new URL(url, window.location.origin)
      navigate(parseRoute(target.pathname, target.search))
    },
    [navigate],
  )

  const remindersOn = user.reminders_enabled
  const inMore = MORE_VIEWS.includes(view)
  const inviteBadge = workspaceList?.invitations.length ?? 0
  const workspaceName = workspaceList?.workspaces.find((w) => w.id === workspaceId)?.name ?? tr('Workspace')
  const headings: Record<View, [string, string]> = {
    home: [formatLongDate(now), greeting(now)],
    progress: [tr('This week'), tr('Your progress')],
    profile: route.view === 'profile' && route.section ? [tr('Settings'), SETTINGS_SECTIONS[route.section]] : [tr('Account'), tr('Settings')],
    timer: [tr('Focus'), tr('Timer')],
    admin: [tr('Staff only'), tr('Admin dashboard')],
    friends: route.view === 'friends' && route.username ? [tr('Friends'), friendName ?? `@${route.username}`] : [tr('People'), tr('Friends')],
    chats: [tr('Messages'), tr('Chats')],
    tasks: [tr('Your list'), tr('Tasks')],
    more: [tr('Everything else'), tr('More')],
    workspaces: [tr('Teams'), tr('Workspaces')],
    notifications: [tr('For you'), tr('Notifications')],
    workspace:
      route.view !== 'workspace' || route.section === 'home' || route.section === 'page' || route.section === 'table'
        ? [tr('Workspaces'), workspaceName]
        : route.section === 'members'
          ? [workspaceName, tr('Members')]
          : route.section === 'activity'
            ? [workspaceName, tr('Activity')]
            : route.section === 'settings'
              ? [workspaceName, tr('Settings')]
              : [`${workspaceName} / Settings`, tr('What each role can do')],
  }

  const bell = (className: string) => (
    <button
      className={className}
      data-tour="reminders"
      role="switch"
      aria-checked={remindersOn}
      aria-label={tr('Task reminders')}
      disabled={remindersBusy}
      onClick={toggleReminders}
    >
      <Icon name={remindersOn ? 'bell' : 'bellOff'} />
    </button>
  )

  return (
    <>
      <Backdrop />

      <div className="shell">
      <SideNav
        view={route.view === 'workspace' ? (route.section === 'table' ? `table:${route.id}:${route.tableId}` : `workspace:${route.id}`) : view}
        // An open page has its own list of pages and tables beside it.
        openWorkspace={route.view === 'workspace' && route.section !== 'page' && sideItems?.workspaceId === route.id ? sideItems : null}
        isStaff={user.is_staff}
        chatBadge={chatBadge}
        socialBadge={socialBadge}
        workspaces={workspaceList?.workspaces ?? []}
        inviteBadge={inviteBadge}
        noticeBadge={unreadNotices}
        onGo={(next) => {
          if (next.startsWith('page:')) {
            const [, id, pageId] = next.split(':')
            navigate({ view: 'workspace', id: Number(id), section: 'page', pageId: Number(pageId) })
          } else if (next.startsWith('table:')) {
            const [, id, tableId] = next.split(':')
            navigate({ view: 'workspace', id: Number(id), section: 'table', tableId: Number(tableId) })
          } else if (next.startsWith('workspace:')) openWorkspace(Number(next.split(':')[1]))
          else go(next as Exclude<View, 'workspace'>)
        }}
      />
      <div className={`app${view === 'chats' ? ' is-chats' : ''}`}>
        {view !== 'chats' && (
        <header className="header">
          <div className="header-start">
            {(isChildPage(route) || (inMore && view !== 'more')) && (
              <button type="button" className={`round-btn${isChildPage(route) ? '' : ' mobile-only'}`} aria-label={tr('Back')} onClick={goBack}>
                <Icon name="back" />
              </button>
            )}
            <div className="header-title">
              <span className="eyebrow">{headings[view][0]}</span>
              <h1 className="greeting">{headings[view][1]}</h1>
            </div>
          </div>
          <div className={`header-actions${isChildPage(route) ? ' on-child' : ''}`}>
            <TimerPill timer={timer.state} active={view === 'timer'} onOpen={() => go('timer')} />
            <button className="round-btn" aria-label={inviteBadge + unreadNotices ? tr('Workspaces, {value} new', { value: inviteBadge + unreadNotices }) : tr('Workspaces')} aria-pressed={view === 'workspaces' || view === 'workspace'} onClick={() => go('workspaces')}>
              <Icon name="team" />
              {inviteBadge + unreadNotices > 0 && (
                <span className="nav-badge" aria-hidden="true">
                  {inviteBadge + unreadNotices}
                </span>
              )}
            </button>
            {bell(`round-btn${remindersOn ? ' on' : ''}`)}
            <button className="primary-btn desktop-only" data-tour="new-task" onClick={() => openCreate(day)}>
              <Icon name="plus" />
              {tr('New task')}
            </button>
          </div>
        </header>
        )}

        {user.reminders_enabled && deviceState !== 'ready' && !hideDeviceBanner && (
          <div className="device-banner" role="status">
            <Icon name="bellOff" />
            <span>
              <strong>{tr('Reminders are on, but not on this device.')}</strong>{' '}
              {deviceState === 'needs-permission'
                ? tr('Allow notifications here to get them.')
                : deviceState === 'blocked'
                  ? tr('Notifications are blocked for this site in your settings.')
                  : tr('This browser can\'t show them. On iPhone, open Todo Clock from your Home Screen.')}
            </span>
            {deviceState === 'needs-permission' ? (
              <button
                type="button"
                className="primary-btn small"
                onClick={async () => {
                  if (await enableReminders()) setDeviceState(deviceReminderState())
                }}
              >
                {tr('Turn on')}
              </button>
            ) : (
              <button type="button" className="text-btn" onClick={() => setRemindersGuide(true)}>
                {tr('How to fix')}
              </button>
            )}
            <button type="button" className="icon-btn" aria-label={tr('Hide for now')} onClick={() => setHideDeviceBanner(true)}>
              <Icon name="x" />
            </button>
          </div>
        )}

        {sync.blocked && sync.ops.length > 0 && (
          <div className="device-banner" role="status">
            <Icon name="clock" />
            <span>
              <strong>{tr('Can\'t reach the server.')}</strong> {sync.ops.length} {sync.ops.length === 1 ? tr('change is') : tr('changes are')} {tr('safe on this device and will save automatically.')}
            </span>
          </div>
        )}

        {loadError && (
          <div className="error-banner" role="alert">
            <span>{loadError}</span>
            <button className="text-btn" onClick={load}>
              {tr('Retry')}
            </button>
          </div>
        )}

        <main ref={mainRef}>
          <Suspense fallback={<LoadingPage skeleton={<CardsSkeleton />} />}>
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
          ) : view === 'more' ? (
            <Reveal key="more">
              <More user={user} inviteBadge={inviteBadge + unreadNotices} noticeBadge={unreadNotices} onGo={go} />
            </Reveal>
          ) : view === 'tasks' ? (
            <Reveal key="tasks">
              <Tasks
                now={now}
                hidden={hidden}
                changes={taskChanges}
                list={taskList}
                onList={setTaskList}
                onToggle={toggle}
                onMoveToToday={moveToToday}
                onOpen={(task) => setSheet({ task, defaults: { date: day, time: '' }, opened: Date.now() })}
                onDelete={setDeleting}
              />
            </Reveal>
          ) : view === 'notifications' ? (
            <Reveal key="notifications">
              <Notifications now={now} notify={notify} onOpen={openUrl} onUnread={setUnreadNotices} />
            </Reveal>
          ) : view === 'workspaces' ? (
            <Reveal key="workspaces">
              <Workspaces data={workspaceList} error={workspaceError} notify={notify} onOpen={openWorkspace} onChanged={loadWorkspaces} onRetry={loadWorkspaces} />
            </Reveal>
          ) : route.view === 'workspace' ? (
            <Reveal key={`workspace-${route.id}`}>
              <WorkspacePage
                key={route.id}
                id={route.id}
                myId={user.id}
                now={now}
                section={route.section}
                pageId={route.section === 'page' ? route.pageId : undefined}
                tableId={route.section === 'table' ? route.tableId : undefined}
                rowId={route.section === 'table' ? route.rowId : undefined}
                onRowClosed={closeLinkedRow}
                onOpenUrl={openUrl}
                notify={notify}
                showToast={showToast}
                onOpenSection={(section, options) => navigate({ view: 'workspace', id: route.id, section }, options)}
                onOpenPage={(pageId) => navigate({ view: 'workspace', id: route.id, section: 'page', pageId })}
                onOpenTable={(tableId) => navigate({ view: 'workspace', id: route.id, section: 'table', tableId })}
                onItems={showSideItems}
                onTasksChanged={load}
                onChanged={loadWorkspaces}
                onGone={leftWorkspace}
              />
            </Reveal>
          ) : route.view === 'friends' ? (
            <Reveal key="friends">
              <Friends
                now={now}
                username={route.username}
                notify={notify}
                onOpenFriend={(username) => navigate({ view: 'friends', username })}
                onCloseFriend={() => navigate({ view: 'friends' }, { replace: true })}
                onFriendName={setFriendName}
                onSendTasks={(friend) => setSendDialog({ friendId: friend?.id })}
                onMessage={(friend) => {
                  setChatStart({ friendId: friend.id, at: Date.now() })
                  go('chats')
                }}
                onChanged={() => {
                  load()
                  loadBadge()
                }}
              />
            </Reveal>
          ) : view === 'chats' ? (
            <Reveal key="chats">
              <Chats myId={user.id} now={now} notify={notify} start={chatStart} onUnread={setChatBadge} onStarted={clearChatStart} outbox={outbox} />
            </Reveal>
          ) : view === 'admin' && user.is_staff ? (
            <Reveal key="admin">
              <Admin me={user} now={now} notify={notify} />
            </Reveal>
          ) : route.view === 'profile' ? (
            <Reveal key="profile">
            <Profile
              user={user}
              now={now}
              section={route.section}
              onOpenSection={(section) => navigate({ view: 'profile', section })}
              remindersBusy={remindersBusy}
              themePreference={theme.preference}
              onUserChange={onUserChange}
              onToggleReminders={toggleReminders}
              onOpenRemindersGuide={() => setRemindersGuide(true)}
              onThemeChange={theme.choose}
              onReplayTutorial={startTour}
              onOpenAdmin={user.is_staff ? () => go('admin') : undefined}
              onLogout={() => setLoggingOut(true)}
              onDeleteAccount={deleteAccount}
              onTasksRestored={load}
              notify={notify}
            />
            </Reveal>
          ) : loading ? (
            <Loading skeleton={view === 'home' ? <HomeSkeleton /> : <CardsSkeleton />} onRetry={() => void load()} />
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
              onDelete={setDeleting}
              onCreateAt={(d, time) => openCreate(d, time)}
              onAddOnDay={(d) => openCreate(d)}
              onShowProgress={() => go('progress')}
              onSeeOverdue={() => {
                setTaskList('overdue')
                go('tasks')
              }}
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
      </div>

      <nav className="bottom-nav glass mobile-only" aria-label={tr('Main')}>
        <button className="nav-btn" aria-current={view === 'home' ? 'page' : undefined} onClick={() => go('home')}>
          <Icon name="clock" />
          <span className="nav-label">{tr('Today')}</span>
        </button>
        <button
          className="nav-btn"
          data-tour="chats"
          aria-label={chatBadge ? tr('Chats, {chatBadge} unread', { chatBadge }) : tr('Chats')}
          aria-current={view === 'chats' ? 'page' : undefined}
          onClick={() => go('chats')}
        >
          <Icon name="chat" />
          <span className="nav-label">{tr('Chats')}</span>
          {chatBadge > 0 && <span className="nav-badge" aria-hidden="true">{chatBadge}</span>}
        </button>
        <button className="fab" data-tour="new-task" aria-label={tr('New task')} onClick={() => openCreate(day)}>
          <Icon name="plus" />
        </button>
        <button
          className="nav-btn"
          data-tour="friends"
          aria-label={socialBadge ? tr('Friends, {socialBadge} new', { socialBadge }) : tr('Friends')}
          aria-current={view === 'friends' ? 'page' : undefined}
          onClick={() => go('friends')}
        >
          <Icon name="users" />
          <span className="nav-label">{tr('Friends')}</span>
          {socialBadge > 0 && <span className="nav-badge" aria-hidden="true">{socialBadge}</span>}
        </button>
        <button className="nav-btn" data-tour="progress profile workspaces timer" aria-label={inviteBadge + unreadNotices ? tr('More, {value} new', { value: inviteBadge + unreadNotices }) : tr('More')} aria-current={inMore ? 'page' : undefined} onClick={() => go('more')}>
          <Icon name="menu" />
          <span className="nav-label">{tr('More')}</span>
          {inviteBadge + unreadNotices > 0 && <span className="nav-badge" aria-hidden="true">{inviteBadge + unreadNotices}</span>}
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
          onDelete={setDeleting}
          onSend={(task) => {
            const id = outbox.resolve(task.id)
            if (id < 0) {
              notify(tr('Still saving this task'), tr('You can send it to a friend once it has saved.'))
              return
            }
            setSheet(null)
            setSendDialog({ taskIds: [id] })
          }}
        />
      )}

      {deleting && (
        <ConfirmAction
          danger
          icon="trash"
          title={tr('Delete {title}?', { title: deleting.title })}
          confirmLabel={tr('Delete')}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            remove(deleting)
            setDeleting(null)
          }}
        >
          <p>{tr('It stays in Recently deleted for 7 days, so you can bring it back.')}</p>
        </ConfirmAction>
      )}

      {loggingOut && (
        <ConfirmAction
          icon="logout"
          title={tr('Log out?')}
          confirmLabel={tr('Log out')}
          onCancel={() => setLoggingOut(false)}
          onConfirm={async () => {
            await logout()
            setLoggingOut(false)
          }}
        >
          <p>{tr('You\'ll need your email and password to log back in, and this device stops getting reminders until you do.')}</p>
        </ConfirmAction>
      )}

      {sendDialog && (
        <Suspense fallback={null}>
          <SendTasksDialog
            tasks={tasks.filter((t) => t.id > 0)}
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
