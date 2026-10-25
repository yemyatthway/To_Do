export type Category = 'work' | 'personal' | 'health'
export type Priority = 'low' | 'medium' | 'high'

export interface Task {
  id: number
  title: string
  notes: string
  due_at: string | null
  category: Category
  priority: Priority
  remind_before_minutes: number | null
  done: boolean
  completed_at: string | null
  created_at: string
  updated_at: string
  /** Set while it's in "Recently deleted". */
  deleted_at?: string | null
  /** Put in your list by this friend ("Remind a friend"). */
  added_by_name?: string | null
  /** Still follows the friend's changes to the original. */
  linked?: boolean
  /** Your task: first names of friends you added it for. */
  shared_with?: string[]
}

export type TaskInput = Pick<Task, 'title' | 'notes' | 'due_at' | 'category' | 'priority' | 'remind_before_minutes' | 'done'>

export interface User {
  id: number
  email: string
  /** False until the emailed code is entered; the app shows the verify screen until then. */
  email_verified: boolean
  /** Until the email is confirmed: when the emailed code expires. */
  code_expires_at: string | null
  full_name: string
  timezone: string
  reminders_enabled: boolean
  tutorial_seen: boolean
  /** Friends may put tasks straight into your list. */
  friends_can_add_tasks: boolean
  is_staff: boolean
  date_joined: string
}

export type AccountStatus = 'active' | 'banned' | 'inactive' | 'deleted'

export interface AdminUser {
  id: number
  email: string
  full_name: string
  status: AccountStatus
  email_verified: boolean
  is_active: boolean
  is_staff: boolean
  timezone: string
  reminders_enabled: boolean
  task_count: number
  date_joined: string
  last_login_at: string | null
  last_login_ip: string | null
  banned_at: string | null
  ban_reason: string
  deleted_at: string | null
  /** Deleted accounts: when the daily clean-up erases it. */
  erase_after: string | null
}

export interface AuthEvent {
  id: number
  user: number | null
  email: string
  kind: 'signup' | 'login' | 'logout' | 'deleted' | 'restored'
  ip_address: string | null
  created_at: string
}

export interface AdminUserDetail extends AdminUser {
  recent_events: AuthEvent[]
}

export interface AdminStats {
  total_users: number
  active_users: number
  banned_users: number
  deleted_users: number
  new_users_7d: number
  logins_24h: number
  /** When the reminder check last ran (cron-job.org, every minute). */
  reminders_last_run: string | null
}

export interface Page<T> {
  count: number
  next: string | null
  previous: string | null
  results: T[]
}

export type ProfileInput = Partial<Pick<User, 'email' | 'full_name' | 'timezone' | 'reminders_enabled' | 'tutorial_seen' | 'friends_can_add_tasks'>>

interface Session {
  access: string
  user: User
}

/** Right password on a browser the account hasn't used: a code was emailed to finish signing in. */
export interface LoginChallenge {
  challenge: string
  /** Partly hidden, e.g. mi•••@gmail.com. */
  email: string
  /** Seconds until "Send again" works. */
  resend_in: number
  /** When the emailed code stops working. */
  expires_at: string | null
}

/** Right password for an account its owner deleted recently: it can still be restored. */
export interface DeletedAccount {
  account_deleted: true
  /** After this the account is erased for good. */
  restore_until: string
}

export interface EmailCheck {
  ok: boolean
  message: string
  /** A likely fix for a typo, e.g. mia@gmail.com for mia@gmial.com. */
  suggestion: string | null
  /** Each rule on its own (null: not checked because an earlier one failed). */
  checks: { format: boolean; real_inbox: boolean | null; receives_mail: boolean | null }
}

export interface TrustedDevice {
  id: number
  name: string
  ip_address: string | null
  created_at: string
  last_used_at: string
  current: boolean
}

/** Field-level errors from DRF, e.g. { email: ["An account with this email already exists."] }. */
export class ApiError extends Error {
  status: number
  fields: Record<string, string[]>

  constructor(message: string, status: number, fields: Record<string, string[]> = {}) {
    super(message)
    this.status = status
    this.fields = fields
  }
}

// Empty in development (Vite proxies /api to Django); the backend URL in production.
export const API_BASE = import.meta.env.VITE_API_URL ?? ''

// Like afm_sys: the access token lives only in memory; the refresh token is an httpOnly cookie.
let accessToken: string | null = null
let onSessionExpired: () => void = () => {}

export function setSessionExpiredHandler(handler: () => void) {
  onSessionExpired = handler
}

async function rawFetch(path: string, init: RequestInit = {}, withAuth = true) {
  const headers = new Headers(init.headers)
  if (init.body !== undefined) headers.set('Content-Type', 'application/json')
  if (withAuth && accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  try {
    return await fetch(API_BASE + path, { ...init, headers, credentials: 'include' })
  } catch {
    throw new ApiError("Couldn't reach the server. Check your connection and try again.", 0)
  }
}

async function toError(response: Response) {
  let message = `Something went wrong (${response.status}).`
  let fields: Record<string, string[]> = {}
  try {
    const body = await response.json()
    if (typeof body.detail === 'string') {
      message = body.detail
    } else {
      fields = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : [String(v)]]))
      message = Object.values(fields).flat().join(' ') || message
    }
  } catch {
    // Not JSON; keep the generic message.
  }
  // The dev proxy (or a host in front of Django) answers 502–504 when the server is down or waking up.
  if (response.status >= 502 && response.status <= 504) message = "Couldn't reach the server. Check your connection and try again."
  // DRF's own throttle text is vague; our code limits explain themselves.
  if (response.status === 429 && (!message || message.startsWith('Request was throttled'))) message = 'Too many attempts. Wait a minute and try again.'
  return new ApiError(message, response.status, fields)
}

let refreshing: Promise<boolean> | null = null

/** Swap the refresh cookie for a new access token. One request at a time, like afm_sys. */
export function refreshSession(): Promise<boolean> {
  refreshing ??= rawFetch('/api/auth/refresh/', { method: 'POST' }, false)
    .then(async (response) => {
      // 204: no session cookie at all; 401: it expired or was revoked.
      if (!response.ok || response.status === 204) {
        accessToken = null
        return false
      }
      accessToken = (await response.json()).access
      return true
    })
    .catch(() => false)
    .finally(() => {
      refreshing = null
    })
  return refreshing
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response = await rawFetch(path, init)
  if (response.status === 401) {
    if (await refreshSession()) {
      response = await rawFetch(path, init)
    } else {
      onSessionExpired()
    }
  }
  if (!response.ok) throw await toError(response)
  return (response.status === 204 || response.status === 205 ? undefined : await response.json()) as T
}

async function startSession(path: string, body: object) {
  const response = await rawFetch(path, { method: 'POST', body: JSON.stringify(body) }, false)
  if (!response.ok) throw await toError(response)
  const data: Session | DeletedAccount | (LoginChallenge & { two_factor_required: true }) = await response.json()
  if ('two_factor_required' in data) return { challenge: data.challenge, email: data.email, resend_in: data.resend_in, expires_at: data.expires_at }
  if ('account_deleted' in data) return data
  accessToken = data.access
  return data.user
}

async function postPublic<T>(path: string, body: object): Promise<T> {
  const response = await rawFetch(path, { method: 'POST', body: JSON.stringify(body) }, false)
  if (!response.ok) throw await toError(response)
  return response.json()
}

export const isChallenge = (result: User | LoginChallenge | DeletedAccount): result is LoginChallenge => 'challenge' in result
export const isDeletedAccount = (result: User | LoginChallenge | DeletedAccount): result is DeletedAccount => 'account_deleted' in result

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) })

export const auth = {
  /** A User, or a LoginChallenge when this browser needs the emailed sign-in code first. */
  /** Also a DeletedAccount for a recently deleted account; call again with restore to bring it back. */
  login: (email: string, password: string, restore = false) => startSession('/api/auth/login/', { email, password, restore }),
  verifyLogin: (challenge: string, code: string) => startSession('/api/auth/login/verify/', { challenge, code }) as Promise<User>,
  resendLogin: (challenge: string) => postPublic<{ resend_in: number; expires_at: string | null }>('/api/auth/login/resend/', { challenge }),
  register: (input: { full_name: string; email: string; password: string; timezone: string }) =>
    startSession('/api/auth/register/', input) as Promise<User>,
  checkEmail: (email: string) => postPublic<EmailCheck>('/api/auth/check-email/', { email }),
  verifyEmail: (code: string) => request<User>('/api/auth/verify-email/', json('POST', { code })),
  resendVerifyEmail: () => request<{ resend_in: number; expires_at: string | null }>('/api/auth/verify-email/resend/', json('POST', {})),
  devices: () => request<TrustedDevice[]>('/api/auth/devices/'),
  removeDevice: (id: number) => request<void>(`/api/auth/devices/${id}/`, { method: 'DELETE' }),
  async logout() {
    await rawFetch('/api/auth/logout/', { method: 'POST' }, false).catch(() => undefined)
    accessToken = null
  },
  me: () => request<User>('/api/auth/me/'),
  updateMe: (input: ProfileInput) => request<User>('/api/auth/me/', json('PATCH', input)),
  async deleteAccount(password: string) {
    await request<void>('/api/auth/me/', json('DELETE', { password }))
    accessToken = null
  },
  changePassword: (old_password: string, new_password: string) =>
    request<void>('/api/auth/change-password/', json('POST', { old_password, new_password })),
}

export const api = {
  listTasks(start: Date, end: Date) {
    const params = new URLSearchParams({ start: start.toISOString(), end: end.toISOString(), anytime: '1' })
    return request<Task[]>(`/api/tasks/?${params}`)
  },
  /** Unfinished tasks due before `before` (start of today), newest first. */
  overdueTasks: (before: Date) => request<Task[]>(`/api/tasks/?${new URLSearchParams({ overdue_before: before.toISOString() })}`),
  createTask: (input: TaskInput) => request<Task>('/api/tasks/', json('POST', input)),
  updateTask: (id: number, input: Partial<TaskInput>) => request<Task>(`/api/tasks/${id}/`, json('PATCH', input)),
  /** Moves it to "Recently deleted"; restorable for 7 days. */
  deleteTask: (id: number, keepalive = false) => request<void>(`/api/tasks/${id}/`, { method: 'DELETE', keepalive }),
  trash: () => request<Task[]>('/api/tasks/trash/'),
  restoreTask: (id: number) => request<Task>(`/api/tasks/${id}/restore/`, json('POST', {})),
  purgeTask: (id: number) => request<void>(`/api/tasks/${id}/purge/`, { method: 'DELETE' }),
  emptyTrash: () => request<void>('/api/tasks/trash/', { method: 'DELETE' }),
  vapidKey: () => request<{ public_key: string }>('/api/push/vapid-public-key/'),
  subscribePush: (subscription: PushSubscriptionJSON) => request<void>('/api/push/subscribe/', json('POST', subscription)),
  unsubscribePush: (endpoint: string) => request<void>('/api/push/subscribe/', json('DELETE', { endpoint })),
  reminderStatus: (endpoint?: string) => request<ReminderStatus>(`/api/push/status/?${new URLSearchParams(endpoint ? { endpoint } : {})}`),
  testPush: (subscription: PushSubscriptionJSON) => request<{ detail: string }>('/api/push/test/', json('POST', subscription)),
}

/** Query for an admin table: search, filters, `ordering` ("joined" / "-joined"), page, page_size. Empty values are left out. */
export type TableQuery = Record<string, string | number | undefined>

const tableQuery = (params: TableQuery) =>
  new URLSearchParams(Object.entries(params).flatMap(([key, value]) => (value === undefined || value === '' ? [] : [[key, String(value)]])))

export const admin = {
  stats: () => request<AdminStats>('/api/admin/stats/'),
  users: (params: TableQuery) => request<Page<AdminUser>>(`/api/admin/users/?${tableQuery(params)}`),
  events: (params: TableQuery) => request<Page<AuthEvent>>(`/api/admin/auth-events/?${tableQuery(params)}`),
  user: (id: number) => request<AdminUserDetail>(`/api/admin/users/${id}/`),
  ban: (id: number, reason: string) => request<AdminUser>(`/api/admin/users/${id}/ban/`, json('POST', { reason })),
  unban: (id: number) => request<AdminUser>(`/api/admin/users/${id}/unban/`, json('POST', {})),
}

export type Relationship = 'none' | 'friends' | 'outgoing' | 'incoming'

/** GET /api/push/status/: everything that must be true for reminders to arrive. */
export interface ReminderStatus {
  reminders_enabled: boolean
  service: { last_run_at: string | null; running: boolean }
  devices: { id: number; this_device: boolean; added_at: string; last_success_at: string | null; last_error: string }[]
  upcoming: { title: string; due_at: string; remind_at: string | null; sent: boolean }[]
}

export interface RemindResult {
  /** "inbox" when the friend only takes tasks through their inbox (it was sent there instead). */
  mode: 'added' | 'inbox'
  added: number
  /** They already had these from you. */
  already: number
  /** Already over, so not added. */
  past: number
}

export interface Person {
  id: number
  full_name: string
  /** Partly hidden, e.g. m•••@gmail.com. */
  email: string
  relationship?: Relationship
  friendship_id?: number | null
}

export interface SharedTask {
  id: number
  title: string
  notes: string
  due_at: string | null
  category: Category
  priority: Priority
  added: boolean
}

export interface Share {
  id: number
  sender: Person
  recipient: Person
  message: string
  status: 'new' | 'added' | 'dismissed'
  created_at: string
  tasks: SharedTask[]
}

export interface AddSharedResult {
  share: Share
  added: number
  task_ids: number[]
  moved_to_anytime: string[]
  clashes: { new: string; existing: string; due_at: string }[]
}

export const social = {
  search: (q: string) => request<Person[]>(`/api/social/users/?${new URLSearchParams({ q })}`),
  friends: () => request<{ friends: Person[]; incoming: Person[]; outgoing: Person[] }>('/api/social/friends/'),
  requestFriend: (user_id: number) => request<Person>('/api/social/friends/requests/', json('POST', { user_id })),
  accept: (friendshipId: number) => request<Person>(`/api/social/friends/${friendshipId}/accept/`, json('POST', {})),
  remove: (friendshipId: number) => request<void>(`/api/social/friends/${friendshipId}/`, { method: 'DELETE' }),
  inbox: () => request<Share[]>('/api/social/shares/'),
  /** "Remind a friend": straight into their list with reminders, kept in sync with yours. */
  remind: (recipient_id: number, task_ids: number[]) => request<RemindResult>('/api/social/remind/', json('POST', { recipient_id, task_ids })),
  send: (recipient_id: number, task_ids: number[], message: string) =>
    request<Share>('/api/social/shares/', json('POST', { recipient_id, task_ids, message })),
  add: (shareId: number, item_ids?: number[]) => request<AddSharedResult>(`/api/social/shares/${shareId}/add/`, json('POST', item_ids ? { item_ids } : {})),
  dismiss: (shareId: number) => request<void>(`/api/social/shares/${shareId}/dismiss/`, json('POST', {})),
  summary: () => request<{ incoming_requests: number; new_shares: number }>('/api/social/summary/'),
}
