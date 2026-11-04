import { useEffect, useState } from 'react'
import { planImport, readSpreadsheet, titleFromFileName, type ImportPlan, type ImportSheet } from '../excelImport'
import { pickFiles } from '../filesClient'
import { Icon } from '../icons'
import { tr } from '../i18n'

const ACCEPT = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,.xlsx,.csv'

/** Choosing a spreadsheet for a new table: its name, then how many columns and rows it will make. */
export function ImportFile({ onPlan, onTitle }: { onPlan: (plan: ImportPlan | null) => void; onTitle: (title: string) => void }) {
  const [fileName, setFileName] = useState('')
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [sheets, setSheets] = useState<ImportSheet[]>([])
  const [sheet, setSheet] = useState(0)
  const [plan, setPlan] = useState<ImportPlan | null>(null)

  // Switching away forgets the file, so Create can't send one that's no longer shown.
  useEffect(() => () => onPlan(null), [onPlan])

  function choose(next: ImportPlan | null) {
    setPlan(next)
    onPlan(next)
  }

  async function read(file: File) {
    setFileName(file.name)
    setError('')
    setSheets([])
    setSheet(0)
    choose(null)
    setReading(true)
    try {
      const found = await readSpreadsheet(file)
      setSheets(found)
      choose(planImport(found[0]?.data ?? []))
      onTitle(titleFromFileName(file.name))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setReading(false)
    }
  }

  const problem = error || plan?.problem
  return (
    <div className="import-file">
      <button type="button" className={`field import-pick${fileName ? ' has-file' : ''}`} disabled={reading} onClick={() => pickFiles(([file]) => file && void read(file), { accept: ACCEPT })}>
        <Icon name="file" />
        <span>{reading ? tr('Reading…') : fileName || tr('Choose a file')}</span>
      </button>
      {sheets.length > 1 && (
        <label className="field-group">
          <span className="label">{tr('Sheet')}</span>
          <select
            className="field"
            value={sheet}
            onChange={(e) => {
              const index = Number(e.target.value)
              setSheet(index)
              choose(planImport(sheets[index].data))
            }}
          >
            {sheets.map((one, index) => (
              <option key={one.name} value={index}>
                {one.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {problem ? (
        <span className="field-error" role="alert">
          {problem}
        </span>
      ) : (
        plan && (
          <div className="import-preview" role="status">
            <span className="person-name">{plan.columns.length === 1 ? tr('1 column') : tr('{count} columns', { count: plan.columns.length })}, {plan.rows.length === 1 ? tr('1 row') : tr('{count} rows', { count: plan.rows.length.toLocaleString('en') })}</span>
            <span className="row-sub">{plan.columns.map((column) => column.name).join(' · ')}</span>
            <span className="row-sub">{tr('Pictures and colours aren\'t imported.')}</span>
          </div>
        )
      )}
    </div>
  )
}
