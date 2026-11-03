/** Reading and typing @mentions. No screen here, so it can be tested. */

export type CommentPart = { text: string; mention?: boolean }

const MENTION = /(^|[^\w.@])@([A-Za-z0-9._]{1,20})/g

/** Splits a comment so real mentions can stand out. Anyone who isn't a member stays plain text. */
export function splitMentions(body: string, usernames: string[]): CommentPart[] {
  const known = new Set(usernames.map((name) => name.toLowerCase()))
  const parts: CommentPart[] = []
  let last = 0
  for (const match of body.matchAll(MENTION)) {
    const name = match[2].toLowerCase()
    if (!known.has(name)) continue
    const start = match.index + match[1].length
    if (start > last) parts.push({ text: body.slice(last, start) })
    parts.push({ text: `@${match[2]}`, mention: true })
    last = start + match[2].length + 1
  }
  if (last < body.length) parts.push({ text: body.slice(last) })
  return parts
}

export interface MentionQuery {
  /** Where the @ is. */
  start: number
  query: string
}

/** The @name being typed at the caret, if any. */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret)
  const match = /(^|[^\w.@])@([A-Za-z0-9._]{0,20})$/.exec(before)
  if (!match) return null
  return { start: match.index + match[1].length, query: match[2].toLowerCase() }
}

/** Swaps the half-typed @name for the chosen one. */
export function insertMention(text: string, at: MentionQuery, caret: number, username: string) {
  const inserted = `@${username} `
  return { text: text.slice(0, at.start) + inserted + text.slice(caret), caret: at.start + inserted.length }
}
