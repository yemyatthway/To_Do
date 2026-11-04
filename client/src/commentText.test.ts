import { describe, expect, it } from 'vitest'
import { insertMention, mentionAt, splitMentions, writingLine } from './commentText'

describe('splitMentions', () => {
  const members = ['aung_dev', 'mia']

  it('marks members and leaves the rest as text', () => {
    expect(splitMentions('Hi @aung_dev and @mia!', members)).toEqual([{ text: 'Hi ' }, { text: '@aung_dev', mention: true }, { text: ' and ' }, { text: '@mia', mention: true }, { text: '!' }])
  })

  it('ignores names that are not members, whatever the case', () => {
    expect(splitMentions('@nobody here', members)).toEqual([{ text: '@nobody here' }])
    expect(splitMentions('@MIA here', members)).toEqual([{ text: '@MIA', mention: true }, { text: ' here' }])
  })

  it('does not treat an email address as a mention', () => {
    expect(splitMentions('me@mia.com', members)).toEqual([{ text: 'me@mia.com' }])
  })

  it('handles text that is only a mention, or has none', () => {
    expect(splitMentions('@mia', members)).toEqual([{ text: '@mia', mention: true }])
    expect(splitMentions('plain', members)).toEqual([{ text: 'plain' }])
    expect(splitMentions('', members)).toEqual([])
  })
})

describe('typing a mention', () => {
  it('finds the name being typed at the caret', () => {
    expect(mentionAt('hello @mi', 9)).toEqual({ start: 6, query: 'mi' })
    expect(mentionAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionAt('(@MI', 4)).toEqual({ start: 1, query: 'mi' })
  })

  it('stays quiet when no name is being typed', () => {
    expect(mentionAt('hello', 5)).toBeNull()
    expect(mentionAt('me@mi', 5)).toBeNull()
    expect(mentionAt('@mia done', 9)).toBeNull()
    expect(mentionAt('@mia done', 2)).toEqual({ start: 0, query: 'm' })
  })

  it('puts the chosen name in, ready to keep typing', () => {
    const text = 'hi @mi there'
    const at = mentionAt(text, 6)!
    expect(insertMention(text, at, 6, 'mia')).toEqual({ text: 'hi @mia  there', caret: 8 })
  })
})

describe('who is writing', () => {
  const members = [{ id: 1, full_name: 'Aung Kyaw', username: 'aung' }, { id: 2, full_name: '', username: 'mia' }]
  it('names one person by first name, and counts more', () => {
    expect(writingLine([], members)).toBe('')
    expect(writingLine([1], members)).toBe('Aung is writing…')
    expect(writingLine([2], members)).toBe('@mia is writing…')
    expect(writingLine([1, 2], members)).toBe('2 people are writing…')
  })
  it('ignores someone no longer in the workspace', () => {
    expect(writingLine([9], members)).toBe('')
  })
})
