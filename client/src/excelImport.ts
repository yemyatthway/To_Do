import { tr } from './i18n'

/**
 * Turning a spreadsheet into a new table. The file is read here on the person's own device, so a
 * huge one can't hurt the server, and it's never stored: only the cells are sent. The server checks
 * all of this again. Kept apart from the screen so it can be tested.
 */

export const MAX_IMPORT_COLUMNS = 30
export const MAX_IMPORT_ROWS = 2000
export const MAX_IMPORT_CELL = 5000
export const MAX_IMPORT_BYTES = 4_900_000 // the server takes 5 MB, with the title and such
export const MAX_FILE_MB = 10

export type SheetCell = string | number | boolean | Date | null | undefined
export type ImportColumnType = 'text' | 'number' | 'date' | 'checkbox'
export type ImportCell = string | number | boolean | null

export interface ImportPlan {
  columns: { name: string; type: ImportColumnType }[]
  rows: ImportCell[][]
  /** Why this can't be imported, if it can't. */
  problem: string
}

export interface ImportSheet {
  name: string
  data: SheetCell[][]
}

const plainNumber = /^-?(0|[1-9]\d*)(\.\d+)?$/ // not "0912": a phone number or code keeps its zero
const isoDate = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/
const yesNo = /^(true|false)$/i

const two = (n: number) => String(n).padStart(2, '0')

/** Excel keeps a time with no date as a day around the year 1900. */
const isTimeOnly = (date: Date) => date.getUTCFullYear() < 1902

function tidy(cell: SheetCell): SheetCell {
  if (typeof cell === 'string') return cell.trim() || null
  if (typeof cell === 'number' && !Number.isFinite(cell)) return null
  if (cell instanceof Date && Number.isNaN(cell.getTime())) return null
  return cell ?? null
}

function asText(cell: SheetCell): string {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE'
  if (cell instanceof Date) {
    const time = `${two(cell.getUTCHours())}:${two(cell.getUTCMinutes())}`
    if (isTimeOnly(cell)) return time
    const day = `${cell.getUTCFullYear()}-${two(cell.getUTCMonth() + 1)}-${two(cell.getUTCDate())}`
    return time === '00:00' ? day : `${day} ${time}`
  }
  return String(cell)
}

const isNumber = (cell: SheetCell) => (typeof cell === 'number' || (typeof cell === 'string' && plainNumber.test(cell))) && Math.abs(Number(cell)) <= 1e15
const isDate = (cell: SheetCell) => (cell instanceof Date && !isTimeOnly(cell)) || (typeof cell === 'string' && isoDate.test(cell) && !Number.isNaN(new Date(cell.replace(' ', 'T')).getTime()))
const isYesNo = (cell: SheetCell) => typeof cell === 'boolean' || (typeof cell === 'string' && yesNo.test(cell))

/** The kind of column: only when every value fits it. Anything mixed stays text, so nothing is lost. */
function columnType(cells: SheetCell[]): ImportColumnType {
  const filled = cells.filter((cell) => cell !== null)
  if (!filled.length) return 'text'
  if (filled.every(isYesNo)) return 'checkbox'
  if (filled.every(isNumber)) return 'number'
  if (filled.every(isDate)) return 'date'
  return 'text'
}

/** A spreadsheet's date has no time zone: it means the same day and hour wherever it's opened. */
function asDate(cell: SheetCell) {
  if (cell instanceof Date) {
    return new Date(cell.getUTCFullYear(), cell.getUTCMonth(), cell.getUTCDate(), cell.getUTCHours(), cell.getUTCMinutes(), cell.getUTCSeconds()).toISOString()
  }
  return new Date(String(cell).replace(' ', 'T')).toISOString()
}

function convert(cell: SheetCell, type: ImportColumnType): ImportCell {
  if (type === 'checkbox') return cell === true || (typeof cell === 'string' && cell.toLowerCase() === 'true')
  if (cell === null) return type === 'text' ? '' : null
  if (type === 'number') return Number(cell)
  if (type === 'date') return asDate(cell)
  return asText(cell)
}

function empty(problem: string): ImportPlan {
  return { columns: [], rows: [], problem }
}

/** The first row with anything in it names the columns. Rows that are completely blank are left out. */
export function planImport(sheet: SheetCell[][]): ImportPlan {
  const numbered = sheet
    .map((row, index) => ({ cells: row.map(tidy), number: index + 1 }))
    .filter((row) => row.cells.some((cell) => cell !== null))
  if (!numbered.length) return empty(tr('This sheet is empty.'))

  // Spreadsheets often have blank columns on the right that only look used.
  const width = Math.max(...numbered.map((row) => row.cells.reduce<number>((last, cell, i) => (cell !== null ? i + 1 : last), 0)))
  if (width > MAX_IMPORT_COLUMNS) return empty(tr('This file has {count} columns. A table can have up to {max}.', { count: width, max: MAX_IMPORT_COLUMNS }))
  const [head, ...body] = numbered
  if (body.length > MAX_IMPORT_ROWS) return empty(tr('This file has {count} rows. A table can have up to {max}.', { count: body.length.toLocaleString('en'), max: MAX_IMPORT_ROWS.toLocaleString('en') }))

  const columns = Array.from({ length: width }, (_, i) => {
    const cells = body.map((row) => row.cells[i] ?? null)
    const name = asText(head.cells[i]).replace(/\s+/g, ' ').trim().slice(0, 60)
    return { name: name || tr('Column {number}', { number: i + 1 }), type: columnType(cells) }
  })
  const rows = body.map((row) => columns.map((column, i) => convert(row.cells[i] ?? null, column.type)))

  for (const [r, row] of rows.entries()) {
    for (const [c, cell] of row.entries()) {
      if (typeof cell === 'string' && cell.length > MAX_IMPORT_CELL) {
        return empty(tr('Row {row}, {column} is longer than {max} characters.', { row: body[r].number, column: columns[c].name, max: MAX_IMPORT_CELL.toLocaleString('en') }))
      }
    }
  }
  if (new TextEncoder().encode(JSON.stringify({ columns, rows })).length > MAX_IMPORT_BYTES) return empty(tr('This file has too much data to import.'))
  return { columns, rows, problem: '' }
}

/** Excel saves commas or semicolons depending on the country. */
function delimiterOf(text: string) {
  let quoted = false
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 }
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '\n') break
    else if (!quoted && ch in counts) counts[ch]++
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
}

export function parseCsv(input: string): SheetCell[][] {
  const text = input.replace(/^﻿/, '')
  const delimiter = delimiterOf(text)
  const rows: SheetCell[][] = []
  let row: SheetCell[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch !== '"') cell += ch
      else if (text[i + 1] === '"') {
        cell += '"'
        i++
      } else quoted = false
    } else if (ch === '"' && !cell) quoted = true
    else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

export const titleFromFileName = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[_\s]+/g, ' ').trim().slice(0, 120)

function decode(bytes: ArrayBuffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes) // older Excel, saved as plain "CSV"
  }
}

/** Reads the file's sheets. Throws an Error with a message to show. */
export async function readSpreadsheet(file: File): Promise<ImportSheet[]> {
  const extension = file.name.split('.').pop()?.toLowerCase()
  if (extension === 'xls' || extension === 'xlsm' || extension === 'xlsb') throw new Error(tr('Save this file as .xlsx first, then try again.'))
  if (extension !== 'xlsx' && extension !== 'csv') throw new Error(tr('Choose an .xlsx or .csv file.'))
  if (file.size > MAX_FILE_MB * 1024 * 1024) throw new Error(tr('This file is over {max} MB.', { max: MAX_FILE_MB }))
  try {
    if (extension === 'csv') return [{ name: file.name, data: parseCsv(decode(await file.arrayBuffer())) }]
    const { default: readExcelFile } = await import('read-excel-file/browser')
    const sheets = await readExcelFile(file)
    return sheets.map((sheet) => ({ name: sheet.sheet, data: sheet.data as SheetCell[][] }))
  } catch (err) {
    throw new Error(tr('This file couldn\'t be read.'), { cause: err })
  }
}
