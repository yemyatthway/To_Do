import { describe, expect, it } from 'vitest'
import { parseCsv, planImport, readSpreadsheet, titleFromFileName } from './excelImport'

const utc = (y: number, m: number, d: number, h = 0, min = 0) => new Date(Date.UTC(y, m - 1, d, h, min))

describe('planning a table from a sheet', () => {
  it('takes the exact columns and rows', () => {
    const plan = planImport([
      ['Task', 'Hours', 'Done'],
      ['Login', 2.5, true],
      ['Chat', 4, false],
    ])
    expect(plan.problem).toBe('')
    expect(plan.columns).toEqual([
      { name: 'Task', type: 'text' },
      { name: 'Hours', type: 'number' },
      { name: 'Done', type: 'checkbox' },
    ])
    expect(plan.rows).toEqual([
      ['Login', 2.5, true],
      ['Chat', 4, false],
    ])
  })

  it('leaves out blank rows and blank columns on the right', () => {
    const plan = planImport([[null, null, null], ['A', 'B', null, ''], [null], ['1', '  ', null], [null, null, null]])
    expect(plan.columns.map((c) => c.name)).toEqual(['A', 'B'])
    expect(plan.rows).toEqual([[1, '']])
  })

  it('keeps a blank column in the middle and names it', () => {
    const plan = planImport([['A', null, 'C'], ['x', null, 'y']])
    expect(plan.columns.map((c) => c.name)).toEqual(['A', 'Column 2', 'C'])
  })

  it('keeps two columns with the same name', () => {
    expect(planImport([['A', 'A'], ['1', '2']]).columns.map((c) => c.name)).toEqual(['A', 'A'])
  })

  it('makes a column text when its values are mixed, so nothing is lost', () => {
    const plan = planImport([['Mixed'], [1], ['two'], [true]])
    expect(plan.columns[0].type).toBe('text')
    expect(plan.rows).toEqual([['1'], ['two'], ['TRUE']])
  })

  it('keeps phone numbers and long codes as text', () => {
    expect(planImport([['Phone'], ['0912345678'], ['0987654321']]).columns[0].type).toBe('text')
    expect(planImport([['Id'], ['12345678901234567890']]).columns[0].type).toBe('text')
    expect(planImport([['Money'], ['1,000']]).columns[0].type).toBe('text')
  })

  it('understands numbers, yes/no and dates saved as text in a CSV', () => {
    const plan = planImport([['N', 'B', 'D'], ['1.5', 'TRUE', '2026-11-04'], ['-2', 'false', '2026-11-05 09:30']])
    expect(plan.columns.map((c) => c.type)).toEqual(['number', 'checkbox', 'date'])
    expect(plan.rows[0][0]).toBe(1.5)
    expect(plan.rows[1][1]).toBe(false)
  })

  it('does not guess at dates that could mean two things', () => {
    expect(planImport([['D'], ['03/04/2026']]).columns[0].type).toBe('text')
  })

  it('keeps the same day and hour wherever the file is opened', () => {
    const plan = planImport([['Due'], [utc(2026, 11, 4, 9, 30)]])
    expect(plan.columns[0].type).toBe('date')
    const local = new Date(plan.rows[0][0] as string)
    expect([local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes()]).toEqual([2026, 10, 4, 9, 30])
  })

  it('corrects the tiny rounding errors Excel stores in times', () => {
    const nearly = new Date(utc(2026, 11, 12, 16, 45).getTime() - 1)
    const local = new Date(planImport([['At'], [nearly]]).rows[0][0] as string)
    expect([local.getHours(), local.getMinutes(), local.getSeconds()]).toEqual([16, 45, 0])
    expect(planImport([['At'], [new Date(utc(1899, 12, 30, 16, 45).getTime() - 1)]]).rows[0][0]).toBe('16:45')
  })

  it('keeps a time with no date as text', () => {
    const plan = planImport([['At'], [utc(1899, 12, 30, 9, 30)]])
    expect(plan.columns[0].type).toBe('text')
    expect(plan.rows[0][0]).toBe('09:30')
  })

  it('an empty number or date stays empty, and an empty tick is no', () => {
    const plan = planImport([['N', 'D', 'B'], [1, utc(2026, 1, 1), true], [null, null, null], ['end', null, null]])
    expect(plan.columns.map((c) => c.type)).toEqual(['text', 'date', 'checkbox'])
    expect(plan.rows[1]).toEqual(['end', null, false])
  })

  it('a file with only a header makes an empty table', () => {
    const plan = planImport([['A', 'B']])
    expect(plan.problem).toBe('')
    expect(plan.rows).toEqual([])
  })

  it('says the real counts when a file is too big, instead of cutting it', () => {
    expect(planImport([]).problem).toContain('empty')
    expect(planImport([Array.from({ length: 31 }, (_, i) => `C${i}`)]).problem).toContain('31 columns')
    const rows = Array.from({ length: 2002 }, (_, i) => [`r${i}`])
    expect(planImport(rows).problem).toContain('2,001 rows')
    expect(planImport(rows.slice(0, 2001)).problem).toBe('')
  })

  it('refuses a cell that is too long and says where', () => {
    const problem = planImport([['Notes'], ['ok'], ['x'.repeat(5001)]]).problem
    expect(problem).toContain('Row 3')
    expect(problem).toContain('Notes')
  })

  it('refuses a file with too much data overall', () => {
    const big = 'x'.repeat(5000)
    const rows = Array.from({ length: 1100 }, () => [big])
    expect(planImport([['A'], ...rows]).problem).toContain('too much data')
  })

  it('a formula from a file is only text', () => {
    expect(planImport([['F'], ['=1+1']]).rows[0][0]).toBe('=1+1')
  })

  it('keeps Burmese as it is', () => {
    expect(planImport([['အမည်'], ['မင်္ဂလာပါ']]).rows[0][0]).toBe('မင်္ဂလာပါ')
  })
})

describe('reading a CSV', () => {
  it('handles quotes, commas and line breaks inside cells', () => {
    expect(parseCsv('a,b\n"x, y","line1\nline2"\n"say ""hi""",z')).toEqual([
      ['a', 'b'],
      ['x, y', 'line1\nline2'],
      ['say "hi"', 'z'],
    ])
  })

  it('finds semicolons and tabs, and ignores the mark Excel adds at the start', () => {
    expect(parseCsv('﻿a;b\r\n1;2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('choosing a file', () => {
  const file = (name: string, size = 3) => new File(['x'.repeat(size)], name)

  it('names the table after the file', () => {
    expect(titleFromFileName('Bug_list 2026.xlsx')).toBe('Bug list 2026')
  })

  it('refuses old and macro files with a clear reason', async () => {
    await expect(readSpreadsheet(file('old.xls'))).rejects.toThrow('.xlsx first')
    await expect(readSpreadsheet(file('macro.XLSM'))).rejects.toThrow('.xlsx first')
    await expect(readSpreadsheet(file('photo.png'))).rejects.toThrow('Choose an .xlsx')
  })

  it('refuses a huge file before reading it', async () => {
    await expect(readSpreadsheet(file('big.csv', 11 * 1024 * 1024))).rejects.toThrow('over 10 MB')
  })

  it('reads a CSV', async () => {
    const csv = new File(['a,b\n1,2'], 'a.csv')
    expect((await readSpreadsheet(csv))[0].data).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})
