import { describe, expect, it } from 'vitest'
import type { TableColumn, TableRowData } from './api'
import { boardGroups, displayValue, formatDate, fromLocalInput, groupValue, matchesFilters, matchesSearch, NONE, optionsFor, personName, rowTitle, sortRows, toLocalInput } from './tableLogic'

const members = [
  { id: 1, full_name: 'Aung Kyaw', username: 'aung' },
  { id: 2, full_name: '', username: 'mia' },
]
const text: TableColumn = { id: 't', name: 'Description', type: 'text' }
const screen: TableColumn = { id: 's', name: 'Page', type: 'select' }
const who: TableColumn = { id: 'w', name: 'Assigned', type: 'person' }
const done: TableColumn = { id: 'd', name: 'Done', type: 'checkbox' }
const count: TableColumn = { id: 'n', name: 'Count', type: 'number' }
const when: TableColumn = { id: 'x', name: 'Due', type: 'date' }
const columns = [text, screen, who, done, count, when]
const row = (no: number, values: TableRowData['values'] = {}): TableRowData => ({ id: no, no, values, highlighted: false, on_my_tasks: false, comment_count: 0 })

describe('reading cells', () => {
  it('shows each type in words', () => {
    expect(displayValue(who, 1, members)).toBe('Aung Kyaw')
    expect(displayValue(who, 2, members)).toBe('@mia')
    expect(displayValue(who, 99, members)).toBe('Former member')
    expect(displayValue(who, null, members)).toBe('')
    expect(displayValue(done, true, members)).toBe('Yes')
    expect(displayValue(done, undefined, members)).toBe('No')
    expect(displayValue(count, 0, members)).toBe('0')
    expect(displayValue(text, undefined, members)).toBe('')
    expect(personName(undefined, members)).toBe('')
  })

  it('names a row by its first text', () => {
    expect(rowTitle(row(3, { t: '  Fix it ' }), columns)).toBe('Fix it')
    expect(rowTitle(row(3, { t: '   ' }), columns)).toBe('Row 3')
    expect(rowTitle(row(3), [done])).toBe('Row 3')
  })

  it('keeps a date through the local input and back', () => {
    const stored = '2030-06-15T04:30:00.000Z'
    expect(fromLocalInput(toLocalInput(stored))).toBe(stored)
    expect(toLocalInput(null)).toBe('')
    expect(toLocalInput('not a date')).toBe('')
    expect(fromLocalInput('')).toBeNull()
    expect(formatDate('not a date')).toBe('')
    expect(formatDate(stored)).not.toBe('')
  })

  it('offers what the team has typed as a select’s choices', () => {
    expect(optionsFor([row(1, { s: 'Login' }), row(2, { s: 'Sidebar' }), row(3, { s: 'Login' }), row(4), row(5, { s: null })], screen)).toEqual(['Login', 'Sidebar'])
  })
})

describe('search and filters', () => {
  it('searches text, people, choices and row numbers', () => {
    const r = row(12, { t: 'Fix the login', s: 'Sidebar', w: 1 })
    for (const q of ['login', 'SIDEBAR', 'aung', '12', '  fix ']) expect(matchesSearch(r, columns, q, members)).toBe(true)
    expect(matchesSearch(r, columns, 'nothing', members)).toBe(false)
    expect(matchesSearch(r, columns, 'yes', members)).toBe(false)
    expect(matchesSearch(r, columns, '', members)).toBe(true)
  })

  it('filters by choice, person and checkbox', () => {
    const r = row(1, { s: 'Login', w: 2, d: true })
    expect(matchesFilters(r, columns, {})).toBe(true)
    expect(matchesFilters(r, columns, { s: 'Login', w: '2', d: 'yes' })).toBe(true)
    expect(matchesFilters(r, columns, { s: 'Sidebar' })).toBe(false)
    expect(matchesFilters(r, columns, { w: '1' })).toBe(false)
    expect(matchesFilters(r, columns, { d: 'no' })).toBe(false)
    expect(matchesFilters(row(2), columns, { d: 'no' })).toBe(true)
  })

  it('can ask for empty cells', () => {
    expect(matchesFilters(row(1), columns, { s: NONE, w: NONE })).toBe(true)
    expect(matchesFilters(row(1, { s: 'Login' }), columns, { s: NONE })).toBe(false)
  })

  it('ignores filters for columns that were removed', () => {
    expect(matchesFilters(row(1), columns, { gone: 'x' })).toBe(true)
  })
})

describe('sorting', () => {
  const nos = (rows: TableRowData[]) => rows.map((r) => r.no)
  const rows = [row(1, { t: 'b', n: 2 }), row(2, { t: 'A', n: 10 }), row(3, {})]

  it('defaults to row number, either way', () => {
    expect(nos(sortRows(rows, columns, { column: 'no', descending: false }, members))).toEqual([1, 2, 3])
    expect(nos(sortRows(rows, columns, { column: 'no', descending: true }, members))).toEqual([3, 2, 1])
  })

  it('sorts text without caring about capitals, numbers as numbers, empties last', () => {
    expect(nos(sortRows(rows, columns, { column: 't', descending: false }, members))).toEqual([2, 1, 3])
    expect(nos(sortRows(rows, columns, { column: 't', descending: true }, members))).toEqual([1, 2, 3])
    expect(nos(sortRows(rows, columns, { column: 'n', descending: false }, members))).toEqual([1, 2, 3])
    expect(nos(sortRows(rows, columns, { column: 'n', descending: true }, members))).toEqual([2, 1, 3])
  })

  it('sorts dates, checkboxes and people', () => {
    const dated = [row(1, { x: '2030-02-01T00:00:00Z', d: true, w: 2 }), row(2, { x: '2030-01-01T00:00:00Z', d: false, w: 1 })]
    expect(nos(sortRows(dated, columns, { column: 'x', descending: false }, members))).toEqual([2, 1])
    expect(nos(sortRows(dated, columns, { column: 'd', descending: false }, members))).toEqual([2, 1])
    expect(nos(sortRows(dated, columns, { column: 'w', descending: false }, members))).toEqual([1, 2])
  })

  it('falls back to row number for a removed column, and leaves the original alone', () => {
    const original = [row(2), row(1)]
    expect(nos(sortRows(original, columns, { column: 'gone', descending: false }, members))).toEqual([1, 2])
    expect(nos(original)).toEqual([2, 1])
  })
})

describe('the board', () => {
  it('groups by checkbox', () => {
    const groups = boardGroups([row(1, { d: true }), row(2)], done, members)
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([['Not done', 1], ['Done', 1]])
    expect(groupValue(done, 'yes')).toBe(true)
    expect(groupValue(done, 'no')).toBe(false)
  })

  it('groups by choice, with a place for empty rows', () => {
    const groups = boardGroups([row(1, { s: 'Login' }), row(2)], screen, members)
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([['No value', 1], ['Login', 1]])
    expect(groupValue(screen, 'Login')).toBe('Login')
    expect(groupValue(screen, NONE)).toBeNull()
  })

  it('groups by person, keeping rows of someone who left', () => {
    const groups = boardGroups([row(1, { w: 1 }), row(2, { w: 99 }), row(3)], who, members)
    expect(groups.map((g) => [g.label, g.rows.length])).toEqual([['Nobody', 1], ['Aung Kyaw', 1], ['@mia', 0], ['Former member', 1]])
    expect(groupValue(who, '2')).toBe(2)
  })
})
