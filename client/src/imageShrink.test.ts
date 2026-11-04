import { describe, expect, it } from 'vitest'
import { fitWithin, shrunkName } from './imageShrink'

describe('making images smaller', () => {
  it('fits the longest side and never enlarges', () => {
    expect(fitWithin(4800, 2400, 2400)).toEqual({ width: 2400, height: 1200 })
    expect(fitWithin(1000, 3000, 1500)).toEqual({ width: 500, height: 1500 })
    expect(fitWithin(800, 600, 2400)).toEqual({ width: 800, height: 600 })
    expect(fitWithin(5000, 1, 100)).toEqual({ width: 100, height: 1 })
  })

  it('keeps a real name and names pasted screenshots', () => {
    const now = new Date(2026, 10, 4, 9, 5)
    expect(shrunkName('Bug on login.PNG', 'webp', now)).toBe('Bug on login.webp')
    expect(shrunkName('image.png', 'webp', now)).toBe('Screenshot 2026-11-04 09.05.webp')
    expect(shrunkName('', 'jpg', now)).toBe('Screenshot 2026-11-04 09.05.jpg')
  })
})
