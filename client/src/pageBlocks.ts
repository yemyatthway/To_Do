import type { Block, BlockType } from './api'

/** The editing moves on a page's blocks, kept apart from the screen so they can be tested. */

export const newBlockId = () => (typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)

export const makeBlock = (type: BlockType = 'p', text = ''): Block => (type === 'todo' ? { id: newBlockId(), type, text, done: false } : { id: newBlockId(), type, text })

export interface Caret {
  id: string
  at: number
}

export interface Edit {
  blocks: Block[]
  caret: Caret
}

export function setType(block: Block, type: BlockType): Block {
  return type === 'todo' ? { id: block.id, type, text: block.text, done: block.done ?? false } : { id: block.id, type, text: block.text }
}

/** Typing "# " or "[] " at the start of a line turns it into a heading or checklist item. */
export function applyShortcut(block: Block, text: string): Block {
  if (block.type === 'p') {
    if (text.startsWith('# ')) return setType({ ...block, text: text.slice(2) }, 'h')
    const todo = /^(\[\s?\]|-\s\[\s?\])\s/.exec(text)
    if (todo) return setType({ ...block, text: text.slice(todo[0].length) }, 'todo')
  }
  return { ...block, text }
}

/** Enter: the text after the caret moves to a new line below. An empty checklist item ends the list. */
export function splitAt(blocks: Block[], id: string, at: number): Edit {
  const index = blocks.findIndex((b) => b.id === id)
  const block = blocks[index]
  if (block.type === 'todo' && !block.text) {
    return { blocks: blocks.map((b) => (b.id === id ? setType(b, 'p') : b)), caret: { id, at: 0 } }
  }
  const next = makeBlock(block.type === 'todo' ? 'todo' : 'p', block.text.slice(at))
  const kept = { ...block, text: block.text.slice(0, at) }
  return { blocks: [...blocks.slice(0, index), kept, next, ...blocks.slice(index + 1)], caret: { id: next.id, at: 0 } }
}

/** Backspace at the start of a line: first back to plain text, then joined to the line above. */
export function backspaceAtStart(blocks: Block[], id: string): Edit | null {
  const index = blocks.findIndex((b) => b.id === id)
  const block = blocks[index]
  if (block.type !== 'p') return { blocks: blocks.map((b) => (b.id === id ? setType(b, 'p') : b)), caret: { id, at: 0 } }
  if (index === 0) return null
  const above = blocks[index - 1]
  if (above.type === 'file') return null
  const merged = { ...above, text: above.text + block.text }
  return { blocks: [...blocks.slice(0, index - 1), merged, ...blocks.slice(index + 1)], caret: { id: above.id, at: above.text.length } }
}

/** Pasting several lines makes several blocks, so a pasted list stays a list. */
export function pasteLines(blocks: Block[], id: string, start: number, end: number, pasted: string): Edit | null {
  const lines = pasted.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length < 2) return null
  const index = blocks.findIndex((b) => b.id === id)
  const block = blocks[index]
  const before = block.text.slice(0, start)
  const after = block.text.slice(end)
  const first = { ...block, text: before + lines[0] }
  const middle = lines.slice(1, -1).map((line) => makeBlock(block.type === 'todo' ? 'todo' : 'p', line))
  const lastLine = lines[lines.length - 1]
  const last = makeBlock(block.type === 'todo' ? 'todo' : 'p', lastLine + after)
  return { blocks: [...blocks.slice(0, index), first, ...middle, last, ...blocks.slice(index + 1)], caret: { id: last.id, at: lastLine.length } }
}

/** Add: an empty line becomes the new kind, otherwise a new line appears below. */
export function insertBlock(blocks: Block[], afterId: string | null, type: BlockType): Edit {
  const index = blocks.findIndex((b) => b.id === afterId)
  const current = index >= 0 ? blocks[index] : blocks[blocks.length - 1]
  if (current && !current.text) return { blocks: blocks.map((b) => (b.id === current.id ? setType(b, type) : b)), caret: { id: current.id, at: 0 } }
  const next = makeBlock(type)
  const at = index >= 0 ? index + 1 : blocks.length
  return { blocks: [...blocks.slice(0, at), next, ...blocks.slice(at)], caret: { id: next.id, at: 0 } }
}

/** A file goes below the current line, or takes its place if that's empty. There's always a line after it to keep writing on. */
export function insertFileBlock(blocks: Block[], afterId: string | null, file: number): { blocks: Block[]; anchor: string } {
  const found = blocks.findIndex((b) => b.id === afterId)
  const index = found >= 0 ? found : blocks.length - 1
  const current = blocks[index]
  const block: Block = { id: newBlockId(), type: 'file', text: '', file }
  const replaces = current && current.type === 'p' && !current.text
  const next = [...blocks.slice(0, replaces ? index : index + 1), block, ...blocks.slice(index + 1)]
  return { blocks: next[next.length - 1].type === 'file' ? [...next, makeBlock()] : next, anchor: block.id }
}
