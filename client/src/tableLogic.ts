import type { CellValue, Member, TableColumn, TableRowData } from './api'

/** Reading a table: what a cell says, and which rows a search or filter keeps. No screen here, so it can be tested. */

export type Members = Pick<Member, 'id' | 'full_name' | 'username'>[]

export interface SortChoice {
  column: string | 'no'
  descending: boolean
}

/** A filter value: a select's text, a person's id as text, "yes"/"no" for checkboxes, or "none" for empty. */
export type Filters = Record<string, string>

export const NONE = '__none__'

export const memberName = (member: Members[number]) => member.full_name || `@${member.username}`

export function personName(id: CellValue | undefined, members: Members) {
  if (id === null || id === undefined) return ''
  const member = members.find((m) => m.id === id)
  return member ? memberName(member) : 'Former member'
}

const pad = (n: number) => String(n).padStart(2, '0')

/** The stored time as `<input type="datetime-local">` wants it, in this device's time zone. */
export function toLocalInput(value: CellValue | undefined) {
  if (typeof value !== 'string' || !value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function formatDate(value: CellValue | undefined) {
  if (typeof value !== 'string' || !value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** What a cell reads as. */
export function displayValue(column: TableColumn, value: CellValue | undefined, members: Members) {
  switch (column.type) {
    case 'person':
      return personName(value, members)
    case 'date':
      return formatDate(value)
    case 'checkbox':
      return value ? 'Yes' : 'No'
    default:
      return value === null || value === undefined ? '' : String(value)
  }
}

export const firstOfType = (columns: TableColumn[], type: TableColumn['type']) => columns.find((c) => c.type === type)

/** A row's name: its first text with something in it. */
export function rowTitle(row: TableRowData, columns: TableColumn[]) {
  for (const column of columns) {
    const value = row.values[column.id]
    if (column.type === 'text' && typeof value === 'string' && value.trim()) return value.trim()
  }
  return `Row ${row.no}`
}

/** A select column's choices are simply what the team has typed into it so far. */
export function optionsFor(rows: TableRowData[], column: TableColumn) {
  const seen = new Set<string>()
  for (const row of rows) {
    const value = row.values[column.id]
    if (typeof value === 'string' && value) seen.add(value)
  }
  return [...seen].sort((a, b) => a.localeCompare(b))
}

export function matchesSearch(row: TableRowData, columns: TableColumn[], query: string, members: Members) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  if (String(row.no) === q) return true
  return columns.some((column) => column.type !== 'checkbox' && displayValue(column, row.values[column.id], members).toLowerCase().includes(q))
}

export function matchesFilters(row: TableRowData, columns: TableColumn[], filters: Filters) {
  return columns.every((column) => {
    const wanted = filters[column.id]
    if (!wanted) return true
    const value = row.values[column.id]
    if (column.type === 'checkbox') return (wanted === 'yes') === Boolean(value)
    if (wanted === NONE) return value === null || value === undefined || value === ''
    return String(value) === wanted
  })
}

export function sortRows(rows: TableRowData[], columns: TableColumn[], sort: SortChoice, members: Members) {
  const direction = sort.descending ? -1 : 1
  const column = columns.find((c) => c.id === sort.column)
  const byNumber = (a: TableRowData, b: TableRowData) => a.no - b.no
  if (!column) return [...rows].sort((a, b) => direction * byNumber(a, b))
  const keyOf = (row: TableRowData) => {
    const value = row.values[column.id]
    if (column.type === 'number') return typeof value === 'number' ? value : null
    if (column.type === 'checkbox') return value ? 1 : 0
    if (column.type === 'date') return typeof value === 'string' ? new Date(value).getTime() : null
    return displayValue(column, value, members).toLowerCase() || null
  }
  return [...rows].sort((a, b) => {
    const left = keyOf(a)
    const right = keyOf(b)
    // Empty cells stay at the bottom whichever way it's sorted.
    if (left === null || right === null) return left === right ? byNumber(a, b) : left === null ? 1 : -1
    if (left === right) return byNumber(a, b)
    return direction * (left < right ? -1 : 1)
  })
}

export interface BoardGroup {
  /** Filter-style key, turned back into a cell value by `groupValue`. */
  key: string
  label: string
  rows: TableRowData[]
}

export const groupableColumns = (columns: TableColumn[]) => columns.filter((c) => c.type === 'select' || c.type === 'person' || c.type === 'checkbox')

/** Board columns: every choice in the column, with its rows. */
export function boardGroups(rows: TableRowData[], column: TableColumn, members: Members): BoardGroup[] {
  const groups: BoardGroup[] =
    column.type === 'checkbox'
      ? [
          { key: 'no', label: `Not ${column.name.toLowerCase()}`, rows: [] },
          { key: 'yes', label: column.name, rows: [] },
        ]
      : column.type === 'person'
        ? [{ key: NONE, label: 'Nobody', rows: [] }, ...members.map((m) => ({ key: String(m.id), label: memberName(m), rows: [] }))]
        : [{ key: NONE, label: 'No value', rows: [] }, ...optionsFor(rows, column).map((option) => ({ key: option, label: option, rows: [] }))]
  for (const row of rows) {
    const value = row.values[column.id]
    const key = column.type === 'checkbox' ? (value ? 'yes' : 'no') : value === null || value === undefined || value === '' ? NONE : String(value)
    const group = groups.find((g) => g.key === key)
    if (group) group.rows.push(row)
    else groups.push({ key, label: column.type === 'person' ? 'Former member' : key, rows: [row] })
  }
  return groups
}

/** The cell value for a row dropped on a board column. */
export function groupValue(column: TableColumn, key: string): CellValue {
  if (column.type === 'checkbox') return key === 'yes'
  if (key === NONE) return null
  return column.type === 'person' ? Number(key) : key
}
