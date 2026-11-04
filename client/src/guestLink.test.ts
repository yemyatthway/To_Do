import { describe, expect, it } from 'vitest'
import { guestPlaceFrom, guestTokenFrom } from './guestLink'

describe('guest link addresses', () => {
  it('finds the token', () => {
    expect(guestTokenFrom('/guest/12.abc-_d')).toBe('12.abc-_d')
    expect(guestTokenFrom('/guest/12.abc/')).toBe('12.abc')
  })

  it('leaves other addresses alone', () => {
    for (const path of ['/', '/guest', '/guest/a/b', '/workspaces/1', '/guests/a']) expect(guestTokenFrom(path)).toBeNull()
  })

  it('knows which page or table is open', () => {
    expect(guestPlaceFrom('#page-12')).toEqual({ kind: 'page', id: 12 })
    expect(guestPlaceFrom('#table-3')).toEqual({ kind: 'table', id: 3 })
    for (const hash of ['', '#', '#page-', '#row-1', '#table-1x']) expect(guestPlaceFrom(hash)).toBeNull()
  })
})
