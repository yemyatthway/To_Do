import { describe, expect, it } from 'vitest'
import type { Block } from './api'
import { applyShortcut, backspaceAtStart, pasteLines, setType, splitAt, insertBlock, insertFileBlock } from './pageBlocks'

const p = (id: string, text = ''): Block => ({ id, type: 'p', text })
const h = (id: string, text = ''): Block => ({ id, type: 'h', text })
const todo = (id: string, text = '', done = false): Block => ({ id, type: 'todo', text, done })
const texts = (blocks: Block[]) => blocks.map((b) => b.text)

describe('page editing', () => {
  it('turns shortcuts into headings and checklist items', () => {
    expect(applyShortcut(p('a'), '# Goal')).toEqual(h('a', 'Goal'))
    expect(applyShortcut(p('a'), '[] Buy')).toEqual(todo('a', 'Buy'))
    expect(applyShortcut(p('a'), '[ ] Buy')).toEqual(todo('a', 'Buy'))
    expect(applyShortcut(p('a'), '- [ ] Buy')).toEqual(todo('a', 'Buy'))
    expect(applyShortcut(p('a'), '#Goal')).toEqual(p('a', '#Goal'))
    // Only plain text converts, so a heading can start with "# " if you really want.
    expect(applyShortcut(h('a'), '# Goal')).toEqual(h('a', '# Goal'))
  })

  it('splits a line at the caret', () => {
    const { blocks, caret } = splitAt([p('a', 'hello world'), p('b', 'next')], 'a', 5)
    expect(texts(blocks)).toEqual(['hello', ' world', 'next'])
    expect(caret).toEqual({ id: blocks[1].id, at: 0 })
  })

  it('follows a heading with plain text and a checklist item with another', () => {
    expect(splitAt([h('a', 'Goal')], 'a', 4).blocks[1].type).toBe('p')
    const next = splitAt([todo('a', 'Buy', true)], 'a', 3).blocks[1]
    expect(next.type).toBe('todo')
    expect(next.done).toBe(false)
  })

  it('ends a list when Enter is pressed on an empty item', () => {
    const { blocks } = splitAt([todo('a', 'Buy'), todo('b', '')], 'b', 0)
    expect(blocks).toEqual([todo('a', 'Buy'), p('b', '')])
  })

  it('backspace turns a block plain, then joins it to the line above', () => {
    expect(backspaceAtStart([h('a', 'Goal')], 'a')?.blocks).toEqual([p('a', 'Goal')])
    expect(backspaceAtStart([todo('a', 'Buy', true)], 'a')?.blocks).toEqual([p('a', 'Buy')])
    const joined = backspaceAtStart([todo('a', 'one'), p('b', 'two'), p('c', 'three')], 'b')
    expect(joined?.blocks).toEqual([todo('a', 'onetwo'), p('c', 'three')])
    expect(joined?.caret).toEqual({ id: 'a', at: 3 })
  })

  it('backspace on the first plain line does nothing', () => {
    expect(backspaceAtStart([p('a', 'x'), p('b')], 'a')).toBeNull()
  })

  it('makes one block per pasted line, around the selection', () => {
    const { blocks, caret } = pasteLines([p('a', 'startXXend')], 'a', 5, 7, 'one\ntwo\r\nthree')!
    expect(texts(blocks)).toEqual(['startone', 'two', 'threeend'])
    expect(caret).toEqual({ id: blocks[2].id, at: 5 })
  })

  it('keeps a pasted list as a list, with new ids', () => {
    const { blocks } = pasteLines([todo('a', '', true)], 'a', 0, 0, 'one\ntwo')!
    expect(blocks.map((b) => b.type)).toEqual(['todo', 'todo'])
    expect(new Set(blocks.map((b) => b.id)).size).toBe(2)
    expect(blocks[1].done).toBe(false)
  })

  it('leaves a single pasted line to the browser', () => {
    expect(pasteLines([p('a')], 'a', 0, 0, 'just one')).toBeNull()
  })

  it('only checklist items carry a checkmark', () => {
    expect(setType(todo('a', 'x', true), 'p')).toEqual(p('a', 'x'))
    expect(setType(p('a', 'x'), 'todo')).toEqual(todo('a', 'x'))
  })
})

describe('adding from the Add menu', () => {
  const line = (id: string, text: string) => ({ id, type: 'p' as const, text })

  it('adds a new line below the current one', () => {
    const edit = insertBlock([line('a', 'one'), line('b', 'two')], 'a', 'h')
    expect(edit.blocks.map((b) => b.type)).toEqual(['p', 'h', 'p'])
    expect(edit.caret.id).toBe(edit.blocks[1].id)
  })

  it('turns an empty line into the new kind instead of leaving a gap', () => {
    const edit = insertBlock([line('a', '')], 'a', 'todo')
    expect(edit.blocks).toEqual([{ id: 'a', type: 'todo', text: '', done: false }])
    expect(edit.caret).toEqual({ id: 'a', at: 0 })
  })

  it('goes to the end when no line is active', () => {
    const edit = insertBlock([line('a', 'one')], null, 'h')
    expect(edit.blocks.map((b) => b.type)).toEqual(['p', 'h'])
  })
})

describe('putting a file on a page', () => {
  const line = (id: string, text: string) => ({ id, type: 'p' as const, text })

  it('goes below the line you were on', () => {
    const { blocks, anchor } = insertFileBlock([line('a', 'one'), line('b', 'two')], 'a', 7)
    expect(blocks.map((b) => b.type)).toEqual(['p', 'file', 'p'])
    expect(blocks[1]).toMatchObject({ id: anchor, file: 7, text: '' })
  })

  it('takes the place of an empty line and leaves one to keep writing', () => {
    const { blocks } = insertFileBlock([line('a', '')], 'a', 7)
    expect(blocks.map((b) => b.type)).toEqual(['file', 'p'])
  })

  it('several files stay in order', () => {
    const first = insertFileBlock([line('a', 'one')], 'a', 1)
    const second = insertFileBlock(first.blocks, first.anchor, 2)
    expect(second.blocks.map((b) => b.file ?? b.type)).toEqual(['p', 1, 2, 'p'])
  })

  it("backspace can't merge text into a file", () => {
    const { blocks } = insertFileBlock([line('a', 'one')], 'a', 1)
    expect(backspaceAtStart(blocks, blocks[2].id)).toBeNull()
  })
})
