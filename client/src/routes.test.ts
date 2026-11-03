import { describe, expect, it } from 'vitest'
import { isChildPage, parentOf, parseRoute, pathFor, type Route } from './routes'

const pages: [string, Route][] = [
  ['/', { view: 'home' }],
  ['/chats', { view: 'chats' }],
  ['/friends', { view: 'friends' }],
  ['/friends/aung_dev', { view: 'friends', username: 'aung_dev' }],
  ['/workspaces', { view: 'workspaces' }],
  ['/workspaces/5', { view: 'workspace', id: 5, section: 'home' }],
  ['/workspaces/5/members', { view: 'workspace', id: 5, section: 'members' }],
  ['/workspaces/5/settings', { view: 'workspace', id: 5, section: 'settings' }],
  ['/workspaces/5/settings/roles', { view: 'workspace', id: 5, section: 'roles' }],
  ['/workspaces/5/pages/9', { view: 'workspace', id: 5, section: 'page', pageId: 9 }],
  ['/workspaces/5/tables/9', { view: 'workspace', id: 5, section: 'table', tableId: 9 }],
  ['/settings', { view: 'profile' }],
  ['/settings/password', { view: 'profile', section: 'password' }],
  ['/more', { view: 'more' }],
  ['/progress', { view: 'progress' }],
  ['/timer', { view: 'timer' }],
  ['/admin', { view: 'admin' }],
]

describe('page addresses', () => {
  it.each(pages)('%s reads and writes the same page', (path, route) => {
    expect(parseRoute(path)).toEqual(route)
    expect(pathFor(route)).toBe(path)
  })

  it('opens the page a notification asks for', () => {
    expect(parseRoute('/', '?view=friends')).toEqual({ view: 'friends' })
    expect(parseRoute('/', '?view=chats&chat=4')).toEqual({ view: 'chats' })
    expect(parseRoute('/', '?view=workspaces')).toEqual({ view: 'workspaces' })
    expect(parseRoute('/', '?view=admin')).toEqual({ view: 'home' })
  })

  it('treats addresses it does not know safely', () => {
    expect(parseRoute('/nope')).toEqual({ view: 'home' })
    expect(parseRoute('/chats/a/b')).toEqual({ view: 'home' })
    expect(parseRoute('/friends/a/b')).toEqual({ view: 'home' })
    expect(parseRoute('/workspaces/abc')).toEqual({ view: 'workspaces' })
    expect(parseRoute('/workspaces/-1')).toEqual({ view: 'workspaces' })
    expect(parseRoute('/workspaces/5/nope')).toEqual({ view: 'workspace', id: 5, section: 'home' })
    expect(parseRoute('/workspaces/5/pages/abc')).toEqual({ view: 'workspace', id: 5, section: 'home' })
    expect(parseRoute('/workspaces/5/pages')).toEqual({ view: 'workspace', id: 5, section: 'home' })
    expect(parseRoute('/workspaces/5/tables/abc')).toEqual({ view: 'workspace', id: 5, section: 'home' })
    expect(parseRoute('/settings/nope')).toEqual({ view: 'profile' })
    expect(parseRoute('/settings/constructor')).toEqual({ view: 'profile' })
    expect(parseRoute('/constructor')).toEqual({ view: 'home' })
    expect(parseRoute('/friends/%E0%A4%A')).toEqual({ view: 'friends', username: '%E0%A4%A' })
  })

  it('keeps odd characters in a username inside the address', () => {
    const route: Route = { view: 'friends', username: 'a/b' }
    expect(parseRoute(pathFor(route))).toEqual(route)
  })
})

describe('child pages', () => {
  it('knows which pages sit inside another', () => {
    expect(isChildPage({ view: 'friends' })).toBe(false)
    expect(isChildPage({ view: 'friends', username: 'a' })).toBe(true)
    expect(isChildPage({ view: 'workspace', id: 1, section: 'home' })).toBe(true)
    expect(isChildPage({ view: 'profile' })).toBe(false)
    expect(isChildPage({ view: 'profile', section: 'help' })).toBe(true)
  })

  it('goes up one level', () => {
    expect(parentOf({ view: 'friends', username: 'a' })).toEqual({ view: 'friends' })
    expect(parentOf({ view: 'workspace', id: 1, section: 'roles' })).toEqual({ view: 'workspace', id: 1, section: 'settings' })
    expect(parentOf({ view: 'workspace', id: 1, section: 'members' })).toEqual({ view: 'workspace', id: 1, section: 'home' })
    expect(parentOf({ view: 'workspace', id: 1, section: 'home' })).toEqual({ view: 'workspaces' })
    expect(parentOf({ view: 'workspace', id: 1, section: 'page', pageId: 2 })).toEqual({ view: 'workspace', id: 1, section: 'home' })
    expect(parentOf({ view: 'workspace', id: 1, section: 'table', tableId: 2 })).toEqual({ view: 'workspace', id: 1, section: 'home' })
    expect(parentOf({ view: 'profile', section: 'help' })).toEqual({ view: 'profile' })
    expect(parentOf({ view: 'profile' })).toEqual({ view: 'more' })
  })
})
