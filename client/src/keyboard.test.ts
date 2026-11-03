import { describe, expect, it } from 'vitest'
import { isKeyboardOpen } from './keyboard'

describe('the on-screen keyboard', () => {
  it('is open when the visible area shrinks a lot while typing', () => {
    expect(isKeyboardOpen(844, 500, 1, true)).toBe(true)
  })

  it('is not the address bar sliding away', () => {
    expect(isKeyboardOpen(844, 780, 1, true)).toBe(false)
  })

  it('is not open when nothing is being typed in', () => {
    expect(isKeyboardOpen(844, 500, 1, false)).toBe(false)
  })

  it('is not pinch-zooming', () => {
    expect(isKeyboardOpen(844, 400, 2, true)).toBe(false)
  })
})
