import { describe, expect, it } from 'vitest'
import { planCards, waitText } from './flashcards'

describe('planCards', () => {
  it('reads column A as the front and B as the back', () => {
    const plan = planCards([['Femur', 'Thigh bone'], ['Tibia', 'Shin bone', 'extra']])
    expect(plan.cards).toEqual([['Femur', 'Thigh bone'], ['Tibia', 'Shin bone']])
    expect(plan.problem).toBeUndefined()
  })

  it('leaves out a header row and blank rows', () => {
    const plan = planCards([[null, null], ['Question', 'Answer'], ['2 + 2', 4], [], ['', '  ']])
    expect(plan.skippedHeader).toBe(true)
    expect(plan.cards).toEqual([['2 + 2', '4']])
  })

  it('keeps a first row that is a real card', () => {
    expect(planCards([['Front page', 'Back page']]).cards).toHaveLength(1)
  })

  it('writes dates as days', () => {
    expect(planCards([['Pearl Harbor', new Date('1941-12-07T00:00:00Z')]]).cards[0][1]).toBe('1941-12-07')
  })

  it('names the row that is missing a side', () => {
    expect(planCards([['Femur', 'Thigh bone'], ['Tibia', '']]).problem).toBe('Row 2 needs a front and a back.')
  })

  it('refuses an empty file and a huge one', () => {
    expect(planCards([]).problem).toBe('The file has no cards in it.')
    expect(planCards(Array.from({ length: 2001 }, (_, i) => [`q${i}`, 'a'])).problem).toBe('Import up to 2,000 cards at a time.')
  })
})

describe('waitText', () => {
  it('reads like a person would say it', () => {
    expect(waitText(60)).toBe('1 min')
    expect(waitText(360)).toBe('6 min')
    expect(waitText(3600)).toBe('1 hour')
    expect(waitText(86400)).toBe('1 day')
    expect(waitText(3 * 86400)).toBe('3 days')
    expect(waitText(60 * 86400)).toBe('2 mo')
    expect(waitText(400 * 86400)).toBe('1.1 yr')
  })
})
