import type { PreparedUpload, UploadMeta, UploadTarget } from './uploads'
import { Outbox } from './outbox'
import { tr } from './i18n'

export type Category = 'work' | 'personal' | 'health'
export type Priority = 'low' | 'medium' | 'high'

export interface TaskPage {
  results: Task[]
  counts: { todo: number; overdue: number; done: number }
  page: number
  pages: number
}

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
  /** Chosen by the app when it was made, so a resend can't create a second copy. */
  client_id?: string | null
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
  /** Public and unique, lowercase, without the "@". */
  username: string
  /** False for accounts from before usernames, until they keep or change the one they were given. */
  username_confirmed: boolean
  timezone: string
  reminders_enabled: boolean
  tutorial_seen: boolean
  /** Friends may put tasks straight into your list. */
  friends_can_add_tasks: boolean
  workspace_emails: boolean
  language: 'en' | 'my'
  is_staff: boolean
  date_joined: string
}

export type AccountStatus = 'active' | 'banned' | 'inactive' | 'deleted'

export interface AdminUser {
  id: number
  email: string
  full_name: string
  username: string
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

export type ProfileInput = Partial<Pick<User, 'email' | 'full_name' | 'username' | 'timezone' | 'reminders_enabled' | 'tutorial_seen' | 'friends_can_add_tasks' | 'workspace_emails' | 'language'>>

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

export interface UsernameCheck {
  ok: boolean
  username: string
  message: string
  /** A free one to offer when the typed one is taken. */
  suggestion: string | null
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
  /** The whole reply, e.g. the newer task when an edit conflicts (409). */
  data?: unknown

  constructor(message: string, status: number, fields: Record<string, string[]> = {}, data?: unknown) {
    super(message)
    this.status = status
    this.fields = fields
    this.data = data
  }
}

/** A request that hasn't answered by then has failed, instead of "Saving…" forever. */
const REQUEST_TIMEOUT_MS = 25_000

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
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await fetch(API_BASE + path, { ...init, headers, credentials: 'include', signal: timeout.signal })
  } catch {
    throw new ApiError(tr('Couldn\'t reach the server. Check your connection and try again.'), 0)
  } finally {
    clearTimeout(timer)
  }
}

async function toError(response: Response) {
  let message = tr('Something went wrong ({status}).', { status: response.status })
  let fields: Record<string, string[]> = {}
  let data: unknown
  try {
    const body = await response.json()
    data = body
    if (typeof body.detail === 'string') {
      message = body.detail
    } else {
      fields = Object.fromEntries(Object.entries(body).map(([k, v]) => [k, Array.isArray(v) ? v.map((one) => tr(String(one))) : [tr(String(v))]]))
      message = Object.values(fields).flat().join(' ') || message
    }
  } catch {
    // Not JSON; keep the generic message.
  }
  // The dev proxy (or a host in front of Django) answers 502–504 when the server is down or waking up.
  if (response.status >= 502 && response.status <= 504) message = tr('Couldn\'t reach the server. Check your connection and try again.')
  // DRF's own throttle text is vague; our code limits explain themselves.
  if (response.status === 429 && (!message || message.startsWith('Request was throttled'))) message = tr('Too many attempts. Wait a minute and try again.')
  return new ApiError(tr(message), response.status, fields, data)
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
  register: (input: { full_name: string; username: string; email: string; password: string; timezone: string; language: 'en' | 'my' }) =>
    startSession('/api/auth/register/', input) as Promise<User>,
  forgotPassword: (email: string) => postPublic<{ resend_in: number; expires_at: string | null }>('/api/auth/password/forgot/', { email }),
  resetCode: (email: string, code: string) => postPublic<{ ticket: string }>('/api/auth/password/code/', { email, code }).then((answer) => answer.ticket),
  resetPassword: (ticket: string, password: string) => startSession('/api/auth/password/reset/', { ticket, password }) as Promise<User>,
  checkEmail: (email: string) => postPublic<EmailCheck>('/api/auth/check-email/', { email }),
  /** Signed in, your own current username counts as free. */
  checkUsername: (username: string, signedIn: boolean) =>
    signedIn
      ? request<UsernameCheck>('/api/auth/check-username/', json('POST', { username }))
      : postPublic<UsernameCheck>('/api/auth/check-username/', { username }),
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
  browseTasks(input: { list: string; page: number; now: Date; q: string; category: string; priority: string; from?: Date; to?: Date }) {
    const params = new URLSearchParams({ list: input.list, page: String(input.page), now: input.now.toISOString() })
    if (input.q) params.set('q', input.q)
    if (input.category) params.set('category', input.category)
    if (input.priority) params.set('priority', input.priority)
    if (input.from) params.set('from', input.from.toISOString())
    if (input.to) params.set('to', input.to.toISOString())
    return request<TaskPage>(`/api/tasks/browse/?${params}`)
  },
  overdueTasks: (before: Date) => request<Task[]>(`/api/tasks/?${new URLSearchParams({ overdue_before: before.toISOString() })}`),
  /** `clientId` makes sending it again safe: the server returns the task it already saved. */
  createTask: (input: TaskInput, clientId?: string) => request<Task>('/api/tasks/', json('POST', { ...input, client_id: clientId })),
  /** `base` is what these fields were when the edit began; if they've changed since, the server answers 409. */
  updateTask: (id: number, input: Partial<TaskInput>, base?: Record<string, unknown>) => request<Task>(`/api/tasks/${id}/`, json('PATCH', { ...input, base })),
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

export interface EmailResult {
  id: number
  kind: string
  recipient: string
  ok: boolean
  error: string
  created_at: string
}

export const admin = {
  stats: () => request<AdminStats>('/api/admin/stats/'),
  emails: () => request<{ items: EmailResult[]; sent_24h: number; failed_24h: number }>('/api/admin/emails/'),
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
  username: string
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

export interface ChatReply {
  id: number
  sender: number
  text: string
  deleted: boolean
}

export interface ChatReaction {
  user: number
  emoji: string
}

export interface ChatMessage {
  id: number
  client_id?: string | null
  conversation: number
  sender: number
  mine: boolean
  text: string
  deleted: boolean
  edited: boolean
  created_at: string
  /** The message this one answers. */
  reply?: ChatReply | null
  reactions?: ChatReaction[]
}

export interface Chat {
  id: number
  friend: Person
  last_message: ChatMessage | null
  last_message_at: string | null
  unread: number
  /** When the friend last read this chat, for "Seen". */
  friend_read_at: string | null
}

export interface ScheduledMessage {
  id: number
  text: string
  send_at: string
  status: 'pending' | 'sending' | 'failed'
  error: string
}

export const chat = {
  scheduled: (id: number) => request<ScheduledMessage[]>(`/api/chat/${id}/scheduled/`),
  schedule: (id: number, text: string, sendAt: string) => request<ScheduledMessage>(`/api/chat/${id}/scheduled/`, json('POST', { text, send_at: sendAt })),
  updateScheduled: (id: number, itemId: number, text: string, sendAt: string) => request<ScheduledMessage>(`/api/chat/${id}/scheduled/${itemId}/`, json('PATCH', { text, send_at: sendAt })),
  sendScheduledNow: (id: number, itemId: number) => request<ChatMessage>(`/api/chat/${id}/scheduled/${itemId}/`, json('POST', {})),
  deleteScheduled: (id: number, itemId: number) => request<void>(`/api/chat/${id}/scheduled/${itemId}/`, { method: 'DELETE' }),
  list: () => request<{ chats: Chat[]; unread: number }>('/api/chat/'),
  open: (userId: number) => request<Chat>(`/api/chat/with/${userId}/`, json('POST', {})),
  messages: (id: number, before?: number) =>
    request<{ chat: Chat; messages: ChatMessage[] }>(`/api/chat/${id}/messages/${before ? `?before=${before}` : ''}`),
  send: (id: number, text: string, clientId?: string, replyTo?: number) => request<ChatMessage>(`/api/chat/${id}/messages/`, json('POST', { text, client_id: clientId, reply_to: replyTo })),
  react: (id: number, messageId: number, emoji: string | null) =>
    emoji
      ? request<{ reactions: ChatReaction[] }>(`/api/chat/${id}/messages/${messageId}/react/`, json('POST', { emoji }))
      : request<{ reactions: ChatReaction[] }>(`/api/chat/${id}/messages/${messageId}/react/`, { method: 'DELETE' }),
  read: (id: number) => request<{ read_at: string }>(`/api/chat/${id}/read/`, json('POST', {})),
  edit: (id: number, messageId: number, text: string) => request<ChatMessage>(`/api/chat/${id}/messages/${messageId}/`, json('PATCH', { text })),
  /** For everyone (your own messages), or just for you (any message). */
  remove: (id: number, messageId: number, forMe = false) =>
    request<void>(`/api/chat/${id}/messages/${messageId}/${forMe ? '?for=me' : ''}`, { method: 'DELETE' }),
  /** Empty the chat on your side only. */
  clear: (id: number) => request<void>(`/api/chat/${id}/clear/`, json('POST', {})),
}

export type LivePass = { enabled: false } | { enabled: true; client_id: string; token_request: import('ably').TokenRequest }

export const live = {
  token: () => request<LivePass>('/api/live/token/'),
}

export type Role = 'owner' | 'admin' | 'editor' | 'commenter' | 'viewer'

export interface WorkspaceSummary {
  id: number
  name: string
  role: Role
  member_count: number
  /** Notifications from here you haven't seen. */
  unread: number
  created_at: string
}

export interface Member {
  id: number
  full_name: string
  username: string
  /** Partly hidden. */
  email: string
  role: Role
  joined_at: string
}

export interface WorkspaceDetail extends WorkspaceSummary {
  /** What your role allows; the server enforces it either way. */
  can: Record<'read' | 'comment' | 'edit' | 'manage_members' | 'rename' | 'delete_workspace' | 'transfer', boolean>
  assignable_roles: Role[]
  members: Member[]
  /** Only for people who can manage members. */
  invitations: { id: number; label: string; role: Role; created_at: string; expires_at: string }[]
}

export type BlockType = 'p' | 'h' | 'todo' | 'file'

export interface Block {
  id: string
  type: BlockType
  text: string
  /** Checklist items only. */
  done?: boolean
  /** File blocks only: which file. */
  file?: number
}

export interface TeamPageSummary {
  id: number
  title: string
  version: number
  updated_at: string
  updated_by: string | null
}

export interface TeamPage extends TeamPageSummary {
  blocks: Block[]
}

export type ColumnType = 'text' | 'number' | 'select' | 'person' | 'date' | 'checkbox' | 'file'
export type CellValue = string | number | boolean | number[] | null

export interface TableColumn {
  id: string
  name: string
  type: ColumnType
}

export interface TableRowData {
  id: number
  no: number
  values: Record<string, CellValue>
  highlighted: boolean
  /** Whether it's already on your own task list. */
  on_my_tasks: boolean
  comment_count: number
}

export interface TeamTableSummary {
  id: number
  title: string
  version: number
  updated_at: string
  updated_by: string | null
}

export interface TeamTable extends TeamTableSummary {
  description: string
  columns: TableColumn[]
  rows: TableRowData[]
}

export interface Comment {
  id: number
  body: string
  created_at: string
  /** Null once their account is erased. */
  author: { id: number; name: string; username: string } | null
  can_delete: boolean
  /** Files attached to it. */
  files: number[]
}

export interface TeamFile {
  id: number
  name: string
  size: number
  status: 'pending' | 'ready'
  is_image: boolean
  width: number | null
  height: number | null
  uploaded_by: number | null
  url: string | null
  thumb_url: string | null
  download_url: string | null
  expires_at: string
}

export interface ActivityItem {
  id: number
  created_at: string
  actor: string
  /** The rest of the sentence: "commented on the page ...". */
  text: string
  /** Where it happened, if that still exists. */
  url: string | null
}

export interface WorkspaceNotification {
  id: number
  kind: 'mention' | 'assigned' | 'comment' | 'new_work' | 'done'
  title: string
  body: string
  url: string
  read: boolean
  created_at: string
  actor: string
}

export interface WorkspaceList {
  workspaces: WorkspaceSummary[]
  invitations: { id: number; workspace: string; role: Role; invited_by: string; expires_at: string }[]
}

export const workspaces = {
  list: () => request<WorkspaceList>('/api/workspaces/'),
  create: (name: string) => request<WorkspaceDetail>('/api/workspaces/', json('POST', { name })),
  get: (id: number) => request<WorkspaceDetail>(`/api/workspaces/${id}/`),
  rename: (id: number, name: string) => request<WorkspaceDetail>(`/api/workspaces/${id}/`, json('PATCH', { name })),
  remove: (id: number, confirmName: string) => request<void>(`/api/workspaces/${id}/`, json('DELETE', { confirm_name: confirmName })),
  invite: (id: number, invitee: string, role: Role) => request<WorkspaceDetail>(`/api/workspaces/${id}/invitations/`, json('POST', { invitee, role })),
  cancelInvitation: (id: number, invitationId: number) => request<void>(`/api/workspaces/${id}/invitations/${invitationId}/`, { method: 'DELETE' }),
  accept: (invitationId: number) => request<WorkspaceDetail>(`/api/workspaces/invitations/${invitationId}/accept/`, json('POST', {})),
  decline: (invitationId: number) => request<void>(`/api/workspaces/invitations/${invitationId}/decline/`, json('POST', {})),
  setRole: (id: number, userId: number, role: Role) => request<WorkspaceDetail>(`/api/workspaces/${id}/members/${userId}/`, json('PATCH', { role })),
  removeMember: (id: number, userId: number) => request<void>(`/api/workspaces/${id}/members/${userId}/`, { method: 'DELETE' }),
  transfer: (id: number, userId: number) => request<WorkspaceDetail>(`/api/workspaces/${id}/transfer/`, json('POST', { user_id: userId })),
  pages: (id: number) => request<TeamPageSummary[]>(`/api/workspaces/${id}/pages/`),
  createPage: (id: number, title: string) => request<TeamPage>(`/api/workspaces/${id}/pages/`, json('POST', { title })),
  getPage: (id: number, pageId: number) => request<TeamPage>(`/api/workspaces/${id}/pages/${pageId}/`),
  savePage: (id: number, pageId: number, base: number, doc: { title: string; blocks: Block[] }) =>
    request<TeamPage>(`/api/workspaces/${id}/pages/${pageId}/`, json('PATCH', { base_version: base, title: doc.title, blocks: doc.blocks })),
  deletePage: (id: number, pageId: number) => request<void>(`/api/workspaces/${id}/pages/${pageId}/`, { method: 'DELETE' }),
  restorePage: (id: number, pageId: number) => request<TeamPage>(`/api/workspaces/${id}/pages/${pageId}/restore/`, json('POST', {})),
  pageComments: (id: number, pageId: number) => request<Comment[]>(`/api/workspaces/${id}/pages/${pageId}/comments/`),
  addPageComment: (id: number, pageId: number, body: string, files: number[] = []) => request<Comment>(`/api/workspaces/${id}/pages/${pageId}/comments/`, json('POST', { body, files })),
  rowComments: (id: number, tableId: number, rowId: number) => request<Comment[]>(`/api/workspaces/${id}/tables/${tableId}/rows/${rowId}/comments/`),
  addRowComment: (id: number, tableId: number, rowId: number, body: string, files: number[] = []) => request<Comment>(`/api/workspaces/${id}/tables/${tableId}/rows/${rowId}/comments/`, json('POST', { body, files })),
  files: (id: number, ids: number[]) => request<TeamFile[]>(`/api/workspaces/${id}/files/?ids=${ids.join(',')}`),
  prepareFile: (id: number, meta: UploadMeta) => request<PreparedUpload<TeamFile>>(`/api/workspaces/${id}/files/`, json('POST', meta)),
  restartFile: (id: number, fileId: number) => request<PreparedUpload<TeamFile>>(`/api/workspaces/${id}/files/${fileId}/`, json('POST', {})),
  finishFile: (id: number, fileId: number) => request<TeamFile>(`/api/workspaces/${id}/files/${fileId}/done/`, json('POST', {})),
  cancelFile: (id: number, fileId: number) => request<void>(`/api/workspaces/${id}/files/${fileId}/`, { method: 'DELETE' }),
  deleteComment: (id: number, commentId: number) => request<void>(`/api/workspaces/${id}/comments/${commentId}/`, { method: 'DELETE' }),
  activity: (id: number, options: { before?: number; page?: number; row?: number } = {}) => {
    const query = new URLSearchParams(Object.entries(options).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])))
    return request<{ items: ActivityItem[]; more: boolean }>(`/api/workspaces/${id}/activity/?${query}`)
  },
  activityPage: (id: number, options: { number: number; q?: string; actor?: string; kind?: string; since?: Date }) => {
    const query = new URLSearchParams({ number: String(options.number) })
    if (options.q) query.set('q', options.q)
    if (options.actor) query.set('actor', options.actor)
    if (options.kind) query.set('kind', options.kind)
    if (options.since) query.set('since', options.since.toISOString())
    return request<{ items: ActivityItem[]; number: number; pages: number }>(`/api/workspaces/${id}/activity/?${query}`)
  },
  notifications: (before?: number) => request<{ items: WorkspaceNotification[]; unread: number; more: boolean }>(`/api/workspaces/notifications/${before ? `?before=${before}` : ''}`),
  readNotifications: (ids?: number[]) => request<void>('/api/workspaces/notifications/read/', json('POST', ids ? { ids } : {})),
  readWorkspaceNotifications: (id: number) => request<void>('/api/workspaces/notifications/read/', json('POST', { workspace: id })),
  tables: (id: number) => request<TeamTableSummary[]>(`/api/workspaces/${id}/tables/`),
  createTable: (id: number, title: string) => request<TeamTable>(`/api/workspaces/${id}/tables/`, json('POST', { title })),
  /** With `known`, answers "unchanged" if nothing moved since that version. */
  getTable: (id: number, tableId: number, known?: number) => request<TeamTable | { unchanged: true }>(`/api/workspaces/${id}/tables/${tableId}/${known === undefined ? '' : `?known=${known}`}`),
  updateTable: (id: number, tableId: number, change: { title?: string; description?: string }) => request<TeamTable>(`/api/workspaces/${id}/tables/${tableId}/`, json('PATCH', change)),
  deleteTable: (id: number, tableId: number) => request<void>(`/api/workspaces/${id}/tables/${tableId}/`, { method: 'DELETE' }),
  restoreTable: (id: number, tableId: number) => request<TeamTable>(`/api/workspaces/${id}/tables/${tableId}/restore/`, json('POST', {})),
  addColumn: (id: number, tableId: number, name: string, type: ColumnType) => request<TeamTable>(`/api/workspaces/${id}/tables/${tableId}/columns/`, json('POST', { name, type })),
  updateColumn: (id: number, tableId: number, columnId: string, change: { name?: string; position?: number }) => request<TeamTable>(`/api/workspaces/${id}/tables/${tableId}/columns/${columnId}/`, json('PATCH', change)),
  deleteColumn: (id: number, tableId: number, columnId: string) => request<TeamTable>(`/api/workspaces/${id}/tables/${tableId}/columns/${columnId}/`, { method: 'DELETE' }),
  createRow: (id: number, tableId: number) => request<TableRowData>(`/api/workspaces/${id}/tables/${tableId}/rows/`, json('POST', { values: {} })),
  saveRow: (id: number, tableId: number, rowId: number, change: { values: Record<string, CellValue>; base: Record<string, CellValue>; highlighted?: boolean }) =>
    request<TableRowData>(`/api/workspaces/${id}/tables/${tableId}/rows/${rowId}/`, json('PATCH', change)),
  deleteRow: (id: number, tableId: number, rowId: number) => request<void>(`/api/workspaces/${id}/tables/${tableId}/rows/${rowId}/`, { method: 'DELETE' }),
  restoreRow: (id: number, tableId: number, rowId: number) => request<TableRowData>(`/api/workspaces/${id}/tables/${tableId}/rows/${rowId}/restore/`, json('POST', {})),
  addRowToTasks: (id: number, tableId: number, rowId: number) => request<{ row: TableRowData; task_title: string; due_at: string | null }>(`/api/workspaces/${id}/tables/${tableId}/rows/${rowId}/add-to-tasks/`, json('POST', {})),
}

/** This person's save queue on this device (see outbox.ts). */
export function createOutbox(userId: number) {
  let store: Storage | null = null
  try {
    store = window.localStorage
  } catch {
    // Blocked: changes wait in memory until the app closes.
  }
  return new Outbox(
    `todo:outbox:${userId}`,
    {
      createTask: (input, clientId) => api.createTask(input, clientId),
      updateTask: (id, patch, base) => api.updateTask(id, patch, base),
      deleteTask: (id) => api.deleteTask(id),
      sendMessage: (conversation, text, clientId, replyTo) => chat.send(conversation, text, clientId, replyTo),
    },
    store,
    navigator.locks ?? null,
  )
}

/** Sends a file straight to storage. Not through `request`: this needs real progress, and the link is its own pass. */
export function putFile(target: UploadTarget, blob: Blob, onProgress: (loaded: number) => void, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', target.url)
    Object.entries(target.headers).forEach(([name, value]) => xhr.setRequestHeader(name, value))
    xhr.upload.onprogress = (e) => onProgress(e.loaded)
    // 409: it already arrived on an earlier try.
    xhr.onload = () => (xhr.status < 300 || xhr.status === 409 ? resolve() : reject(new Error(xhr.status === 413 ? tr('That file is too big.') : tr('The upload didn\'t finish. Try again.'))))
    xhr.onerror = () => reject(new Error(tr('Can\'t reach the file storage. Check your connection and try again.')))
    xhr.onabort = () => reject(new Error(tr('Cancelled')))
    signal.addEventListener('abort', () => xhr.abort())
    xhr.send(blob)
  })
}
