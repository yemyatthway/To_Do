import type { ChatReaction } from './api'

/** The first choices when reacting. Any other emoji works too: these are real ones, from the phone's own set. */
export const QUICK_REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🔥']

const ONE_EMOJI = /^(?:\p{RI}\p{RI}|[0-9#*]️?⃣|\p{Extended_Pictographic}(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|️|‍|[\u{E0020}-\u{E007F}])*)$/u

/** The characters as you'd count them: a family or a flag is one, however it's stored. */
function characters(text: string) {
  if (!Intl.Segmenter) return Array.from(text)
  return Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), (part) => part.segment)
}

/** The first emoji in what was typed, or null. */
export const firstEmoji = (text: string) => characters(text).find((character) => ONE_EMOJI.test(character)) ?? null

/** A message that's nothing but one to three emoji shows big, on its own. */
export function onlyEmoji(text: string): string[] | null {
  const parts = characters(text.replace(/\s/g, ''))
  return parts.length >= 1 && parts.length <= 3 && parts.every((part) => ONE_EMOJI.test(part)) ? parts : null
}

export interface ReactionGroup {
  emoji: string
  count: number
  mine: boolean
}

export function groupReactions(reactions: ChatReaction[], myId: number): ReactionGroup[] {
  const groups = new Map<string, ReactionGroup>()
  for (const reaction of reactions) {
    const group = groups.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, mine: false }
    group.count += 1
    group.mine ||= reaction.user === myId
    groups.set(reaction.emoji, group)
  }
  return [...groups.values()]
}

/** Reactions with mine set to this emoji, or taken back with null. */
export function withMyReaction(reactions: ChatReaction[], myId: number, emoji: string | null): ChatReaction[] {
  const others = reactions.filter((reaction) => reaction.user !== myId)
  return emoji ? [...others, { user: myId, emoji }] : others
}
