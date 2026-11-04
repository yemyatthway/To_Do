import { describe, expect, it } from 'vitest'
import type { Block } from './api'
import { mapOffset, mergeContent, mergeText, sameContent } from './pageMerge'

const p = (id: string, text: string): Block => ({ id, type: 'p', text })
const doc = (...blocks: Block[]) => ({ title: 'Plan', blocks })

describe('merging text', () => {
  it('keeps whatever only one side changed', () => {
    expect(mergeText('hello', 'hello world', 'hello')).toBe('hello world')
    expect(mergeText('hello', 'hello', 'hello there')).toBe('hello there')
    expect(mergeText('hello', 'same', 'same')).toBe('same')
  })

  it('keeps both edits made in different places', () => {
    expect(mergeText('the quick fox', 'the quick brown fox', 'the quick fox jumps')).toBe('the quick brown fox jumps')
    expect(mergeText('the quick fox', 'very the quick fox', 'the quick fox!')).toBe('very the quick fox!')
    expect(mergeText('one two three', 'one three', 'one two three four')).toBe('one three four')
  })

  it('never loses words when both typed at the same spot', () => {
    const merged = mergeText('hi ', 'hi mine', 'hi theirs')
    expect(merged).toContain('mine')
    expect(merged).toContain('theirs')
    expect(merged.startsWith('hi ')).toBe(true)
  })

  it('does not break an emoji or Burmese text in two', () => {
    const merged = mergeText('a😀', 'a😀b', 'a😃')
    expect([...merged].every((ch) => ch.length === 2 || ch.charCodeAt(0) < 0xd800 || ch.charCodeAt(0) > 0xdfff)).toBe(true)
    expect(mergeText('မင်္ဂလာ', 'မင်္ဂလာပါ', 'ယနေ့ မင်္ဂလာ')).toBe('ယနေ့ မင်္ဂလာပါ')
  })

  it('lets one side delete what the other left alone', () => {
    expect(mergeText('abc def', 'abc', 'abc def')).toBe('abc')
  })
})

describe('keeping the cursor with the words', () => {
  it('stays put when the change is after it', () => {
    expect(mapOffset('hello world', 'hello world!', 5)).toBe(5)
  })

  it('moves along when text is added before it', () => {
    expect(mapOffset('hello', 'oh hello', 5)).toBe(8)
    expect(mapOffset('oh hello', 'hello', 8)).toBe(5)
  })

  it('lands after the change when it was inside it', () => {
    expect(mapOffset('abcdef', 'aXf', 3)).toBe(2)
  })
})

describe('merging a page', () => {
  it('keeps edits to different blocks', () => {
    const base = doc(p('a', 'one'), p('b', 'two'))
    const merged = mergeContent(base, doc(p('a', 'one!'), p('b', 'two')), doc(p('a', 'one'), p('b', 'two?')))
    expect(merged.blocks.map((b) => b.text)).toEqual(['one!', 'two?'])
  })

  it('keeps blocks both people added, each where it was added', () => {
    const base = doc(p('a', 'one'), p('b', 'two'))
    const merged = mergeContent(base, doc(p('a', 'one'), p('mine', 'new'), p('b', 'two')), doc(p('a', 'one'), p('b', 'two'), p('theirs', 'end')))
    expect(merged.blocks.map((b) => b.id)).toEqual(['a', 'mine', 'b', 'theirs'])
  })

  it('removes what they deleted when I had not touched it', () => {
    const base = doc(p('a', 'one'), p('b', 'two'))
    const merged = mergeContent(base, doc(p('a', 'one!'), p('b', 'two')), doc(p('a', 'one')))
    expect(merged.blocks.map((b) => b.id)).toEqual(['a'])
    expect(merged.blocks[0].text).toBe('one!')
  })

  it('keeps a block I changed even though they deleted it', () => {
    const base = doc(p('a', 'one'), p('b', 'two'))
    const merged = mergeContent(base, doc(p('a', 'one'), p('b', 'two more')), doc(p('a', 'one')))
    expect(merged.blocks.map((b) => b.text)).toEqual(['one', 'two more'])
  })

  it('removes what I deleted, unless they changed it since', () => {
    const base = doc(p('a', 'one'), p('b', 'two'))
    expect(mergeContent(base, doc(p('a', 'one')), doc(p('a', 'one!'), p('b', 'two'))).blocks.map((b) => b.id)).toEqual(['a'])
    expect(mergeContent(base, doc(p('a', 'one')), doc(p('a', 'one'), p('b', 'two more'))).blocks.map((b) => b.text)).toEqual(['one', 'two more'])
  })

  it('keeps ticks and type changes from either side', () => {
    const todo = (done: boolean): Block => ({ id: 't', type: 'todo', text: 'x', done })
    expect(mergeContent(doc(todo(false)), doc(todo(true)), doc(todo(false))).blocks[0].done).toBe(true)
    expect(mergeContent(doc(todo(false)), doc(todo(false)), doc(todo(true))).blocks[0].done).toBe(true)
    const head: Block = { id: 't', type: 'h', text: 'x' }
    expect(mergeContent(doc(p('t', 'x')), doc(head), doc(p('t', 'x y'))).blocks[0]).toEqual({ id: 't', type: 'h', text: 'x y' })
  })

  it('merges the title too', () => {
    const merged = mergeContent({ title: 'Plan', blocks: [] }, { title: 'Plan A', blocks: [] }, { title: 'New Plan', blocks: [] })
    expect(merged.title).toBe('New Plan A')
  })

  it('comparing ignores how a block happens to be written down', () => {
    expect(sameContent(doc({ id: 'a', text: 'x', type: 'p' }), doc({ id: 'a', type: 'p', text: 'x' }))).toBe(true)
    expect(sameContent(doc(p('a', 'x')), doc(p('a', 'y')))).toBe(false)
  })
})
