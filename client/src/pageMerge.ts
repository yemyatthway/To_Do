import type { Block } from './api'

/**
 * Putting two people's edits of a page together. Each side changed the same starting point (`base`),
 * so whatever only one of them changed is simply kept, and words are never thrown away: if both
 * changed the same spot, both versions of that spot stay. Kept apart from the screen so it can be tested.
 */

export interface PageContent {
  title: string
  blocks: Block[]
}

interface TextEdit {
  from: number
  /** Where the replaced part ended in the old text. */
  to: number
  inserted: string
}

/** Never cut between the two halves of an emoji. */
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff
const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff

/** The one stretch of text that differs. */
function editBetween(before: string, after: string): TextEdit {
  const limit = Math.min(before.length, after.length)
  let from = 0
  while (from < limit && before[from] === after[from]) from++
  if (from > 0 && isHighSurrogate(before.charCodeAt(from - 1))) from--
  let tail = 0
  while (tail < limit - from && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
  if (tail > 0 && isLowSurrogate(before.charCodeAt(before.length - tail))) tail--
  return { from, to: before.length - tail, inserted: after.slice(from, after.length - tail) }
}

export function mergeText(base: string, mine: string, theirs: string) {
  if (mine === theirs || theirs === base) return mine
  if (mine === base) return theirs
  const a = editBetween(base, theirs)
  const b = editBetween(base, mine)
  // Apart from each other: both land where they were made, the later one first so places don't move.
  if (a.to < b.from || (a.to === b.from && a.from < a.to)) {
    return base.slice(0, a.from) + a.inserted + base.slice(a.to, b.from) + b.inserted + base.slice(b.to)
  }
  if (b.to < a.from || (b.to === a.from && b.from < b.to)) {
    return base.slice(0, b.from) + b.inserted + base.slice(b.to, a.from) + a.inserted + base.slice(a.to)
  }
  // The same spot: both people's words stay, theirs first.
  return base.slice(0, Math.min(a.from, b.from)) + a.inserted + b.inserted + base.slice(Math.max(a.to, b.to))
}

/** Where a place in `before` ends up in `after`, so the cursor stays with the words around it. */
export function mapOffset(before: string, after: string, offset: number) {
  if (before === after) return offset
  const edit = editBetween(before, after)
  if (offset <= edit.from) return offset
  if (offset >= edit.to) return offset + edit.inserted.length - (edit.to - edit.from)
  return edit.from + edit.inserted.length
}

const sameBlock = (a: Block, b: Block) => a.type === b.type && a.text === b.text && Boolean(a.done) === Boolean(b.done) && (a.file ?? null) === (b.file ?? null)

export const sameContent = (a: PageContent, b: PageContent) => a.title === b.title && a.blocks.length === b.blocks.length && a.blocks.every((block, i) => block.id === b.blocks[i].id && sameBlock(block, b.blocks[i]))

function mergeBlock(base: Block, mine: Block, theirs: Block): Block {
  const merged: Block = { ...theirs, text: mergeText(base.text, mine.text, theirs.text) }
  if (mine.type !== base.type) merged.type = mine.type
  if (mine.done !== base.done) merged.done = mine.done
  if (merged.type !== 'todo') delete merged.done
  else merged.done = Boolean(merged.done)
  return merged
}

function mergeBlocks(base: Block[], mine: Block[], theirs: Block[]) {
  const baseById = new Map(base.map((block) => [block.id, block]))
  const mineById = new Map(mine.map((block) => [block.id, block]))
  const theirsById = new Map(theirs.map((block) => [block.id, block]))

  // Their order, without what I deleted (unless they've changed it since, then it stays).
  const merged: Block[] = []
  for (const block of theirs) {
    const before = baseById.get(block.id)
    const my = mineById.get(block.id)
    if (my) merged.push(before ? mergeBlock(before, my, block) : block)
    else if (before && !sameBlock(before, block)) merged.push(block)
    else if (!before) merged.push(block)
  }

  // What I added, or changed after they deleted it, goes after the block it followed for me.
  mine.forEach((block, index) => {
    if (theirsById.has(block.id)) return
    const before = baseById.get(block.id)
    if (before && sameBlock(before, block)) return // they deleted it and I hadn't touched it
    const previous = mine.slice(0, index).reverse().find((other) => merged.some((m) => m.id === other.id))
    merged.splice(previous ? merged.findIndex((m) => m.id === previous.id) + 1 : 0, 0, block)
  })
  return merged
}

export function mergeContent(base: PageContent, mine: PageContent, theirs: PageContent): PageContent {
  return { title: mergeText(base.title, mine.title, theirs.title), blocks: mergeBlocks(base.blocks, mine.blocks, theirs.blocks) }
}
