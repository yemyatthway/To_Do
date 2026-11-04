import { describe, expect, it } from 'vitest'
import { isKeyboardOpen, visibleTop } from './keyboard'

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

describe('keeping a screen in place', () => {
  it('follows the visible area while the keyboard is open', () => {
    expect(visibleTop(true, 1, 120.4)).toBe(120)
  })

  it('ignores an offset iPhone leaves behind after the keyboard closes', () => {
    expect(visibleTop(false, 1, 336)).toBe(0)
  })

  it('follows the visible area while pinch-zoomed', () => {
    expect(visibleTop(false, 2, 200)).toBe(200)
  })
})
