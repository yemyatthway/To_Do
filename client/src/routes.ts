import { useCallback, useEffect, useState } from 'react'
import { tr } from './i18n'

export type View = 'home' | 'tasks' | 'progress' | 'profile' | 'admin' | 'friends' | 'timer' | 'chats' | 'more' | 'workspaces' | 'workspace' | 'notifications'

export type WorkspaceSection = 'home' | 'members' | 'settings' | 'roles' | 'activity'
export type WorkspaceChild = WorkspaceSection | 'page' | 'table'

export const SETTINGS_SECTIONS = {
  personal: tr('Personal info'),
  preferences: tr('Preferences'),
  password: tr('Change password'),
  devices: tr('Trusted devices'),
  deleted: tr('Recently deleted'),
  help: tr('Help and account'),
  delete: tr('Delete account'),
} as const

export type SettingsSection = keyof typeof SETTINGS_SECTIONS

export type Route =
  | { view: Exclude<View, 'friends' | 'workspace' | 'profile'> }
  | { view: 'friends'; username?: string }
  | { view: 'workspace'; id: number; section: WorkspaceSection }
  | { view: 'workspace'; id: number; section: 'page'; pageId: number }
  | { view: 'workspace'; id: number; section: 'table'; tableId: number; rowId?: number }
  | { view: 'profile'; section?: SettingsSection }

const PLAIN: Partial<Record<string, Route>> = {
  chats: { view: 'chats' },
  tasks: { view: 'tasks' },
  more: { view: 'more' },
  progress: { view: 'progress' },
  timer: { view: 'timer' },
  admin: { view: 'admin' },
  notifications: { view: 'notifications' },
}

const safeDecode = (part: string) => {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

/** Which page an address means. Anything unknown is Today. */
export function parseRoute(pathname: string, search = ''): Route {
  // Tapping a notification opens /?view=friends or /?view=chats&chat=<id>.
  const asked = new URLSearchParams(search).get('view')
  if (asked === 'friends' || asked === 'chats' || asked === 'workspaces') return { view: asked }

  const parts = pathname.split('/').filter(Boolean).map(safeDecode)
  const [first, second, third, fourth, fifth, sixth] = parts
  if (first === 'friends') return parts.length <= 2 ? { view: 'friends', username: second } : { view: 'home' }
  if (first === 'workspaces') {
    if (!second) return { view: 'workspaces' }
    const id = Number(second)
    if (!Number.isInteger(id) || id <= 0) return { view: 'workspaces' }
    if (!third) return { view: 'workspace', id, section: 'home' }
    if (third === 'members' && !fourth) return { view: 'workspace', id, section: 'members' }
    if (third === 'activity' && !fourth) return { view: 'workspace', id, section: 'activity' }
    if (third === 'settings' && !fourth) return { view: 'workspace', id, section: 'settings' }
    if (third === 'settings' && fourth === 'roles') return { view: 'workspace', id, section: 'roles' }
    if (third === 'pages' && fourth && Number.isInteger(Number(fourth)) && Number(fourth) > 0) return { view: 'workspace', id, section: 'page', pageId: Number(fourth) }
    if (third === 'tables' && fourth && Number.isInteger(Number(fourth)) && Number(fourth) > 0) {
      const tableId = Number(fourth)
      if (fifth === 'rows' && sixth && Number.isInteger(Number(sixth)) && Number(sixth) > 0) return { view: 'workspace', id, section: 'table', tableId, rowId: Number(sixth) }
      return { view: 'workspace', id, section: 'table', tableId }
    }
    return { view: 'workspace', id, section: 'home' }
  }
  if (first === 'settings') {
    if (!second) return { view: 'profile' }
    return Object.hasOwn(SETTINGS_SECTIONS, second) ? { view: 'profile', section: second as SettingsSection } : { view: 'profile' }
  }
  return (parts.length === 1 && Object.hasOwn(PLAIN, first) && PLAIN[first]) || { view: 'home' }
}

/** The address of a page. */
export function pathFor(route: Route): string {
  switch (route.view) {
    case 'home':
      return '/'
    case 'friends':
      return route.username ? `/friends/${encodeURIComponent(route.username)}` : '/friends'
    case 'workspace': {
      const base = `/workspaces/${route.id}`
      if (route.section === 'home') return base
      if (route.section === 'page') return `${base}/pages/${route.pageId}`
      if (route.section === 'table') return `${base}/tables/${route.tableId}${route.rowId ? `/rows/${route.rowId}` : ''}`
      return route.section === 'roles' ? `${base}/settings/roles` : `${base}/${route.section}`
    }
    case 'profile':
      return route.section ? `/settings/${route.section}` : '/settings'
    default:
      return `/${route.view}`
  }
}

/** A page inside another page: it always has a back button. */
export function isChildPage(route: Route): boolean {
  return (route.view === 'friends' && Boolean(route.username)) || route.view === 'workspace' || (route.view === 'profile' && Boolean(route.section))
}

/** Where Back goes when there's no earlier page in this visit (e.g. a link opened directly). */
export function parentOf(route: Route): Route {
  switch (route.view) {
    case 'friends':
      return { view: 'friends' }
    case 'workspace':
      if (route.section === 'home') return { view: 'workspaces' }
      if (route.section === 'table' && route.rowId) return { view: 'workspace', id: route.id, section: 'table', tableId: route.tableId }
      return { view: 'workspace', id: route.id, section: route.section === 'roles' ? 'settings' : 'home' }
    case 'profile':
      return route.section ? { view: 'profile' } : { view: 'more' }
    case 'progress':
    case 'timer':
    case 'admin':
    case 'workspaces':
    case 'notifications':
      return { view: 'more' }
    default:
      return { view: 'home' }
  }
}

/** The current page, kept in the address bar so refresh, Back and shared links all work. */
export function useRoute() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname, window.location.search))

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Show the page's real address, including after /?view=... from a notification.
  useEffect(() => {
    const path = pathFor(parseRoute(window.location.pathname, window.location.search))
    if (path !== window.location.pathname || window.location.search) window.history.replaceState(window.history.state, '', path)
  }, [])

  const navigate = useCallback((next: Route, options?: { replace?: boolean }) => {
    const path = pathFor(next)
    if (options?.replace) window.history.replaceState(window.history.state, '', path)
    else if (path !== window.location.pathname) window.history.pushState({ inApp: true }, '', path)
    setRoute(next)
    window.scrollTo({ top: 0 })
  }, [])

  const goBack = useCallback(() => {
    // An earlier page in this visit: go back to it. Otherwise up one level.
    if (window.history.state?.inApp) {
      window.history.back()
      return
    }
    const parent = parentOf(parseRoute(window.location.pathname))
    window.history.replaceState(null, '', pathFor(parent))
    setRoute(parent)
  }, [])

  return { route, navigate, goBack }
}
