import { describe, expect, it } from 'vitest'
import { firstEmoji, groupReactions, onlyEmoji, withMyReaction } from './emojiText'

describe('emoji in text', () => {
  it('knows a message that is only emoji', () => {
    expect(onlyEmoji('❤️')).toEqual(['❤️'])
    expect(onlyEmoji(' 🔥 😮 ')).toEqual(['🔥', '😮'])
    expect(onlyEmoji('👨‍👩‍👧‍👦👍🏽🇲🇲')).toEqual(['👨‍👩‍👧‍👦', '👍🏽', '🇲🇲'])
    expect(onlyEmoji('❤️ hi')).toBeNull()
    expect(onlyEmoji('😀😀😀😀')).toBeNull()
    expect(onlyEmoji('')).toBeNull()
    expect(onlyEmoji('123')).toBeNull()
  })

  it('finds the first emoji in what was typed', () => {
    expect(firstEmoji('😂')).toBe('😂')
    expect(firstEmoji('ab🤦🏽‍♂️c😂')).toBe('🤦🏽‍♂️')
    expect(firstEmoji('1️⃣')).toBe('1️⃣')
    expect(firstEmoji('hello')).toBeNull()
    expect(firstEmoji('12')).toBeNull()
  })
})

describe('reactions', () => {
  it('groups them and marks mine', () => {
    expect(groupReactions([{ user: 1, emoji: '❤️' }, { user: 2, emoji: '❤️' }, { user: 3, emoji: '🔥' }], 2)).toEqual([
      { emoji: '❤️', count: 2, mine: true },
      { emoji: '🔥', count: 1, mine: false },
    ])
  })

  it('swaps or takes back mine, leaving others alone', () => {
    const start = [{ user: 1, emoji: '❤️' }, { user: 2, emoji: '🔥' }]
    expect(withMyReaction(start, 1, '😮')).toEqual([{ user: 2, emoji: '🔥' }, { user: 1, emoji: '😮' }])
    expect(withMyReaction(start, 1, null)).toEqual([{ user: 2, emoji: '🔥' }])
    expect(withMyReaction([], 1, '😮')).toEqual([{ user: 1, emoji: '😮' }])
  })
})
