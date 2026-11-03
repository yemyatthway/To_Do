import { describe, expect, it } from 'vitest'
import { stageAfter } from './loadingStage'

describe('how long a wait has been', () => {
  it.each([
    [0, 'hidden'],
    [999, 'hidden'],
    [1000, 'skeleton'],
    [9999, 'skeleton'],
    [10_000, 'slow'],
    [60_000, 'slow'],
  ])('at %i ms shows %s', (ms, stage) => {
    expect(stageAfter(ms)).toBe(stage)
  })
})
