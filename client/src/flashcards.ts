import type { SheetCell } from './excelImport'
import { tr } from './i18n'

export const MAX_CARD_IMPORT = 2000
export const MAX_FRONT = 1000
export const MAX_BACK = 2000

export interface CardPlan {
  cards: [string, string][]
  /** Set when the file can't be used as it is. */
  problem?: string
  /** A header row like "Front | Back" was found and left out. */
  skippedHeader: boolean
}

const HEADER_WORDS = new Set(['front', 'back', 'question', 'answer', 'term', 'definition', 'word', 'meaning', 'q', 'a'])

function text(cell: SheetCell): string {
  if (cell === null || cell === undefined) return ''
  if (cell instanceof Date) return cell.toISOString().slice(0, 10)
  return String(cell).trim()
}

/** Cards from a sheet: column A is the front, column B the back. */
export function planCards(sheet: SheetCell[][]): CardPlan {
  const rows = sheet.map((row) => [text(row[0]), text(row[1])])
  let start = 0
  const first = rows.find((row) => row[0] || row[1])
  const skippedHeader = Boolean(first && HEADER_WORDS.has(first[0].toLowerCase()) && HEADER_WORDS.has(first[1].toLowerCase()))
  if (skippedHeader) start = rows.indexOf(first!) + 1

  const cards: [string, string][] = []
  for (let i = start; i < rows.length; i++) {
    const [front, back] = rows[i]
    if (!front && !back) continue
    if (!front || !back) return { cards: [], skippedHeader, problem: tr('Row {row} needs a front and a back.', { row: i + 1 }) }
    if (front.length > MAX_FRONT || back.length > MAX_BACK) return { cards: [], skippedHeader, problem: tr('Row {row} is too long.', { row: i + 1 }) }
    cards.push([front, back])
  }
  if (!cards.length) return { cards, skippedHeader, problem: tr('The file has no cards in it.') }
  if (cards.length > MAX_CARD_IMPORT) return { cards: [], skippedHeader, problem: tr('Import up to {max} cards at a time.', { max: MAX_CARD_IMPORT.toLocaleString('en') }) }
  return { cards, skippedHeader }
}

/** "1 min", "3 days", "2 mo": how long until a card comes back. */
export function waitText(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return tr('{count} min', { count: Math.max(1, minutes) })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? tr('1 hour') : tr('{count} hours', { count: hours })
  const days = Math.round(hours / 24)
  if (days < 31) return days === 1 ? tr('1 day') : tr('{count} days', { count: days })
  const months = Math.round(days / 30)
  if (months < 12) return tr('{count} mo', { count: months })
  const years = Math.round((days / 365) * 10) / 10
  return tr('{count} yr', { count: years })
}

/** Cards answered "again" come back within the same sitting. */
export const COMES_BACK_IN_SESSION = 20 * 60
