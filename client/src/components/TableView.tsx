import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiError, workspaces as api, type CellValue, type ColumnType, type Member, type TableColumn, type TableRowData, type TeamTable } from '../api'
import { Icon } from '../icons'
import { useLiveRefresh } from '../live'
import { pageStorage } from '../pageSaver'
import { RowSaver, type RowSaveState } from '../rowSaver'
import {
  boardGroups,
  displayValue,
  firstOfType,
  fromLocalInput,
  groupableColumns,
  groupValue,
  matchesFilters,
  matchesSearch,
  memberName,
  NONE,
  optionsFor,
  rowTitle,
  sortRows,
  toLocalInput,
  type Filters,
  type SortChoice,
} from '../tableLogic'
import { pickFiles, uploads } from '../filesClient'
import { Comments, HistoryFold } from './Comments'
import { ConfirmAction } from './ConfirmAction'
import { FileThumbs, FileView } from './Files'
import { Loading, SkeletonRows } from './Loading'
import { OptionsMenu } from './OptionsMenu'
import { SearchField } from './SearchField'
import type { ToastData } from './Toast'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
const MAX_CELL_FILES = 10
const COLUMN_TYPES: { type: ColumnType; label: string; hint: string }[] = [
  { type: 'text', label: 'Text', hint: 'Words and sentences' },
  { type: 'select', label: 'Choice', hint: 'Pick from a list, like Login or Sidebar' },
  { type: 'person', label: 'Person', hint: 'Someone in this workspace' },
  { type: 'date', label: 'Date and time', hint: 'A row can land on your clock' },
  { type: 'checkbox', label: 'Checkbox', hint: 'Yes or no, like Done' },
  { type: 'number', label: 'Number', hint: 'Amounts and counts' },
  { type: 'file', label: 'Images and files', hint: 'Screenshots, PDFs and more' },
]
const typeLabel = (type: ColumnType) => COLUMN_TYPES.find((t) => t.type === type)?.label ?? type
const COLUMN_ICONS: Record<ColumnType, string> = {
  text: 'M4 6h16M4 12h16M4 18h10',
  select: 'M6 9l6 6 6-6',
  person: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
  date: 'M7 3v3M17 3v3M4 9h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z',
  checkbox: 'M5 12l5 5L20 7',
  number: 'M5 9h14M5 15h14M10 4L8 20M16 4l-2 16',
  file: 'M21 11l-9 9a5 5 0 0 1-7-7l9-9a3.500 3.500 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8',
}

function usePhoneLayout() {
  const [phone, setPhone] = useState(() => window.matchMedia('(max-width: 759px)').matches)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 759px)')
    const onChange = () => setPhone(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return phone
}

interface TableViewProps {
  workspaceId: number
  tableId: number
  userId: number
  canEdit: boolean
  canComment: boolean
  now: Date
  /** A row to open straight away, from a notification or shared link. */
  rowId?: number
  onRowClosed: () => void
  members: Member[]
  notify: (title: string, detail?: string) => void
  showToast: (toast: Omit<ToastData, 'id'>) => void
  /** A newer name or edit time, for the list of pages and tables. */
  onSaved: (table: TeamTable) => void
  onDeleted: (table: TeamTable) => void
  onGone: () => void
  /** A row was put on your own task list. */
  onTasksChanged: () => void
}

/** Loads a table, then hands it to the screen. */
export function TableView(props: TableViewProps) {
  const { workspaceId, tableId, onGone } = props
  const [table, setTable] = useState<TeamTable | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setTable((await api.getTable(workspaceId, tableId)) as TeamTable)
      setError('')
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) onGone()
      else setError(errorMessage(err))
    }
  }, [workspaceId, tableId, onGone])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  if (!table) {
    return (
      <section className="card glass panel" aria-label="Table">
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="text-btn" onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}
        <Loading active={!error} skeleton={<SkeletonRows count={5} />} onRetry={() => void load()} />
      </section>
    )
  }
  return <TableScreen {...props} table={table} setTable={setTable} />
}

function saveText(state: RowSaveState, canEdit: boolean) {
  if (!canEdit) return "You can read this table. Your role doesn't allow editing."
  if (state === 'saving') return 'Saving…'
  if (state === 'waiting') return "Can't reach the server. It's safe on this device and will save automatically."
  return 'Saved'
}

function TableScreen({
  workspaceId,
  tableId,
  userId,
  canEdit,
  canComment,
  now,
  rowId,
  onRowClosed,
  members,
  notify,
  showToast,
  onSaved,
  onDeleted,
  onGone,
  onTasksChanged,
  table,
  setTable,
}: TableViewProps & { table: TeamTable; setTable: React.Dispatch<React.SetStateAction<TeamTable | null>> }) {
  const phone = usePhoneLayout()
  const [saver] = useState(() => new RowSaver(workspaceId, tableId, userId, (rowId, change) => api.saveRow(workspaceId, tableId, rowId, change), canEdit ? pageStorage() : null))
  const [saveState, setSaveState] = useState<RowSaveState>(saver.state)
  const [title, setTitle] = useState(table.title)
  const [description, setDescription] = useState(table.description)
  const [query, setQuery] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [filters, setFilters] = useState<Filters>({})
  const [sort, setSort] = useState<SortChoice>({ column: 'no', descending: false })
  const [view, setView] = useState<'table' | 'board'>('table')
  const [groupBy, setGroupBy] = useState<string | null>(null)
  const [openRow, setOpenRow] = useState<number | null>(rowId ?? null)
  const [editing, setEditing] = useState<{ row: number; column: string } | null>(null)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [deletingTable, setDeletingTable] = useState(false)
  const [adding, setAdding] = useState(false)
  // Bumped when an edit lands in the saver, so the screen redraws with it.
  const [editTick, redraw] = useState(0)
  const versionRef = useRef(table.version)
  useEffect(() => {
    versionRef.current = table.version
  }, [table.version])

  const replaceRow = useCallback((row: TableRowData) => setTable((t) => t && { ...t, rows: t.rows.map((r) => (r.id === row.id ? row : r)) }), [setTable])

  useEffect(() => {
    saver.start({
      onState: setSaveState,
      onSaved: replaceRow,
      onConflict: (row, mine) => {
        replaceRow(row)
        // Their version stays, but your words aren't lost without you seeing them.
        const typed = Object.values(mine.values).find((value) => typeof value === 'string' && value)
        notify('Someone else changed that cell', typed ? `Their version is showing. You had typed: ${typed}` : 'Their version is showing now.')
      },
      onRefused: (_rowId, message) => {
        notify("Couldn't save that change", message)
        redraw((n) => n + 1)
      },
    })
    return () => saver.dispose()
  }, [saver, replaceRow, notify])

  // Other people's changes appear on their own. The check is tiny unless something really changed.
  const poll = useCallback(async () => {
    try {
      const fresh = await api.getTable(workspaceId, tableId, versionRef.current)
      if ('unchanged' in fresh) return
      setTable(fresh)
      onSaved(fresh)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) onGone()
    }
  }, [workspaceId, tableId, setTable, onSaved, onGone])
  useLiveRefresh(poll, 10_000)

  // A notification tapped while this table is already open.
  const linkedRow = useRef(rowId)
  useEffect(() => {
    if (rowId === linkedRow.current) return
    linkedRow.current = rowId
    // oxlint-disable-next-line react/set-state-in-effect
    if (rowId) setOpenRow(rowId)
  }, [rowId])

  const columns = table.columns
  const rows = useMemo(() => saver.overlay(table.rows), [saver, table.rows, saveState, editTick]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(
    () => sortRows(rows.filter((r) => matchesSearch(r, columns, query, members) && matchesFilters(r, columns, filters)), columns, sort, members),
    [rows, columns, query, filters, sort, members],
  )
  const checkbox = firstOfType(columns, 'checkbox')
  const doneCount = checkbox ? rows.filter((r) => r.values[checkbox.id]).length : 0
  const filterable = groupableColumns(columns)
  const activeFilters = columns.filter((c) => filters[c.id])
  const board = columns.find((c) => c.id === groupBy) ?? checkbox ?? filterable[0]
  const opened = rows.find((r) => r.id === openRow) ?? null

  // The linked row no longer exists: say so rather than showing nothing.
  useEffect(() => {
    if (rowId && !table.rows.some((r) => r.id === rowId)) {
      notify('That row was deleted')
      onRowClosed()
    }
  }, [rowId, table.rows, notify, onRowClosed])

  const closeRow = () => {
    setOpenRow(null)
    if (rowId) onRowClosed()
  }

  function setCells(row: TableRowData, values: Record<string, CellValue>) {
    saver.edit(row.id, values, row.values)
    redraw((n) => n + 1)
  }

  async function saveDetails(next: { title?: string; description?: string }) {
    try {
      const saved = await api.updateTable(workspaceId, tableId, next)
      setTable(saved)
      onSaved(saved)
    } catch (err) {
      notify("Couldn't save that", errorMessage(err))
    }
  }

  async function addRow() {
    if (adding) return
    setAdding(true)
    try {
      const row = await api.createRow(workspaceId, tableId)
      setTable((t) => t && { ...t, rows: [...t.rows, row] })
      // Show the new row even if a search or filter would hide it.
      setQuery('')
      setFilters({})
      const first = firstOfType(columns, 'text')
      if (phone || view === 'board' || !first) setOpenRow(row.id)
      else setEditing({ row: row.id, column: first.id })
    } catch (err) {
      notify("Couldn't add a row", errorMessage(err))
    } finally {
      setAdding(false)
    }
  }

  async function deleteRow(row: TableRowData) {
    await api.deleteRow(workspaceId, tableId, row.id)
    saver.forget(row.id)
    setOpenRow(null)
    setTable((t) => t && { ...t, rows: t.rows.filter((r) => r.id !== row.id) })
    showToast({
      title: 'Row deleted',
      detail: rowTitle(row, columns),
      action: {
        label: 'Undo',
        onClick: () => {
          api.restoreRow(workspaceId, tableId, row.id).then(
            (restored) => setTable((t) => t && { ...t, rows: [...t.rows, restored] }),
            (err: unknown) => notify("Couldn't bring it back", errorMessage(err)),
          )
        },
      },
    })
  }

  async function addToTasks(row: TableRowData) {
    try {
      const result = await api.addRowToTasks(workspaceId, tableId, row.id)
      replaceRow(result.row)
      onTasksChanged()
      notify('Added to your tasks', result.due_at ? 'It shows on your clock too.' : result.task_title)
    } catch (err) {
      notify("Couldn't add it to your tasks", errorMessage(err))
    }
  }

  const filesColumn = columns.find((c) => c.type === 'file')
  const firstFile = (row: TableRowData) => (filesColumn ? fileIds(row.values[filesColumn.id])[0] : undefined)

  const sortBy = (column: string) =>
    setSort((s) => (s.column !== column ? { column, descending: false } : s.descending ? { column: 'no', descending: false } : { column, descending: true }))

  return (
    <section className="card glass panel table-screen" aria-label={title || 'Untitled'}>
      <div className="table-title-row">
        {canEdit ? (
          <input
            className="page-title"
            aria-label="Table name"
            placeholder="Untitled"
            maxLength={120}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => title !== table.title && void saveDetails({ title })}
          />
        ) : (
          <h2 className="page-title">{table.title}</h2>
        )}
        <OptionsMenu
          label="Table options"
          options={[
            { icon: 'table', label: 'Show as table', current: view === 'table', run: () => setView('table') },
            { icon: 'columns', label: 'Show as board', current: view === 'board', run: () => setView('board') },
            ...(canEdit
              ? [
                  { icon: 'menu' as const, label: 'Edit columns', run: () => setColumnsOpen(true) },
                  { icon: 'trash' as const, label: 'Delete table', danger: true, run: () => setDeletingTable(true) },
                ]
              : []),
          ]}
        />
      </div>

      {canEdit ? (
        <input
          className="table-desc-text"
          aria-label="Table description"
          placeholder="Add a description"
          maxLength={500}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== table.description && void saveDetails({ description })}
        />
      ) : (
        table.description && <p className="task-meta table-desc-read">{table.description}</p>
      )}

      <div className="table-tools">
        <SearchField label="Search rows" placeholder="Search" value={query} onChange={setQuery} />
        <button type="button" className={`text-btn icon-only table-filter-btn${activeFilters.length ? ' is-on' : ''}`} aria-label={activeFilters.length ? `Filter rows, ${activeFilters.length} on` : 'Filter rows'} onClick={() => setFilterOpen(true)}>
          <Icon name="filter" />
          {activeFilters.length > 0 && <span className="count-pill">{activeFilters.length}</span>}
        </button>
        {canEdit && (
          <button type="button" className="primary-btn icon-only table-new" aria-label="New row" disabled={adding} onClick={() => void addRow()}>
            <Icon name="plus" />
          </button>
        )}
      </div>

      {activeFilters.length > 0 && (
        <div className="table-active" role="group" aria-label="Filters on">
          {activeFilters.map((column) => (
            <button
              key={column.id}
              type="button"
              className="filter-chip"
              aria-label={`Remove filter: ${filterText(column, filters[column.id], members, userId)}`}
              onClick={() => setFilters((f) => ({ ...f, [column.id]: '' }))}
            >
              {filterText(column, filters[column.id], members, userId)}
              <Icon name="x" />
            </button>
          ))}
        </div>
      )}

      <div className="table-bar">
        {checkbox && rows.length > 0 && (
          <>
            <span className="table-progress" role="img" aria-label={`${doneCount} of ${rows.length} ${checkbox.name.toLowerCase()}`}>
              <span style={{ width: `${(doneCount / rows.length) * 100}%` }} />
            </span>
            <span className="task-meta">
              {doneCount} of {rows.length} {checkbox.name.toLowerCase()}
            </span>
          </>
        )}
        <span className={`page-status${saveState === 'waiting' ? ' wide' : ''}`} role="status">
          {saveText(saveState, canEdit)}
        </span>
      </div>

      {view === 'board' ? (
        board ? (
          <Board rows={shown} columns={columns} column={board} members={members} canEdit={canEdit} onOpen={(row) => setOpenRow(row.id)} onMove={(row, value) => setCells(row, { [board.id]: value })} />
        ) : (
          <p className="empty">A board groups rows by a Choice, Person or Checkbox column. Add one under Columns.</p>
        )
      ) : phone ? (
        <ul className="panel-scroll table-list">
          {shown.map((row) => {
            const done = Boolean(checkbox && row.values[checkbox.id])
            return (
              <li key={row.id}>
                <button type="button" className="flat-row" onClick={() => setOpenRow(row.id)}>
                  {firstFile(row) !== undefined && <FileThumbs workspaceId={workspaceId} ids={[firstFile(row)!]} limit={1} still />}
                  <span className="row-main">
                    <span className={`person-name${row.highlighted ? ' row-red' : ''}${done ? ' is-done' : ''}`}>{rowTitle(row, columns)}</span>
                    <span className="row-sub">
                      {[`No. ${row.no}`, ...columns.filter((c) => c.type !== 'checkbox' && displayValue(c, row.values[c.id], members) !== rowTitle(row, columns)).map((c) => displayValue(c, row.values[c.id], members))]
                        .filter((part) => part !== '')
                        .join(' · ')}
                      {row.comment_count > 0 && ` · ${row.comment_count} ${row.comment_count === 1 ? 'comment' : 'comments'}`}
                    </span>
                  </span>
                  {done && <span className="row-status done">Done</span>}
                  <Icon name="chevron" className="more-go" />
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="panel-scroll grid-box" role="table" aria-label={title || 'Table'}>
          <div className="grid-row grid-head" role="row">
            <button type="button" className="grid-cell grid-no" role="columnheader" onClick={() => sortBy('no')}>
              No{sort.column === 'no' && sort.descending ? ' ↓' : ''}
            </button>
            {columns.map((column) => (
              <button
                key={column.id}
                type="button"
                className={`grid-cell grid-${column.type}`}
                role="columnheader"
                aria-sort={sort.column === column.id ? (sort.descending ? 'descending' : 'ascending') : undefined}
                onClick={() => sortBy(column.id)}
              >
                <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
                  <path d={COLUMN_ICONS[column.type]} />
                </svg>
                <span className="grid-name">{column.name}</span>
                {sort.column === column.id && (sort.descending ? ' ↓' : ' ↑')}
              </button>
            ))}
          </div>
          {shown.map((row) => (
            <div key={row.id} className={`grid-row${row.highlighted ? ' row-red' : ''}`} role="row">
              <button type="button" className="grid-cell grid-no grid-open" role="cell" aria-label={`Open row ${row.no}`} onClick={() => setOpenRow(row.id)}>
                <Icon name="page" />
                {row.no}
                {row.comment_count > 0 && (
                  <span className="row-comments" aria-label={`${row.comment_count} comments`}>
                    <Icon name="chat" />
                    {row.comment_count}
                  </span>
                )}
              </button>
              {columns.map((column) => (
                <div key={column.id} className={`grid-cell grid-${column.type}`} role="cell">
                  <GridCell
                    row={row}
                    column={column}
                    rows={rows}
                    members={members}
                    canEdit={canEdit}
                    workspaceId={workspaceId}
                    editing={editing?.row === row.id && editing.column === column.id}
                    onEdit={() => setEditing({ row: row.id, column: column.id })}
                    onDone={() => setEditing(null)}
                    onChange={(value) => setCells(row, { [column.id]: value })}
                  />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {view === 'table' && table.rows.length === 0 && <p className="empty">{canEdit ? 'No rows yet. Press New row to add the first one.' : 'No rows yet.'}</p>}
      {view === 'table' && table.rows.length > 0 && shown.length === 0 && <p className="empty">No rows match.</p>}

      {opened && (
        <RowSheet
          row={opened}
          columns={columns}
          rows={rows}
          members={members}
          canEdit={canEdit}
          canComment={canComment}
          now={now}
          workspaceId={workspaceId}
          tableId={tableId}
          onCommentsChanged={() => void poll()}
          onClose={closeRow}
          onCells={(values) => setCells(opened, values)}
          onHighlight={(on) => {
            saver.edit(opened.id, {}, {}, on)
            redraw((n) => n + 1)
          }}
          onAddToTasks={() => void addToTasks(opened)}
          onDelete={() => deleteRow(opened)}
        />
      )}

      {filterOpen && (
        <FilterSheet
          columns={columns}
          filterable={filterable}
          rows={rows}
          members={members}
          userId={userId}
          filters={filters}
          sort={sort}
          boardColumn={view === 'board' ? board : undefined}
          onFilters={setFilters}
          onSort={setSort}
          onGroupBy={setGroupBy}
          onClose={() => setFilterOpen(false)}
        />
      )}

      {columnsOpen && (
        <ColumnsSheet
          workspaceId={workspaceId}
          tableId={tableId}
          columns={columns}
          onClose={() => setColumnsOpen(false)}
          onChanged={(saved) => {
            setTable(saved)
            onSaved(saved)
          }}
        />
      )}

      {deletingTable && (
        <ConfirmAction
          danger
          icon="trash"
          title={`Delete ${table.title}?`}
          confirmLabel="Delete table"
          onCancel={() => setDeletingTable(false)}
          onConfirm={async () => {
            await api.deleteTable(workspaceId, tableId)
            setDeletingTable(false)
            onDeleted(table)
          }}
        >
          <p>Everyone in the workspace loses it, with its {table.rows.length} rows. You can undo this right after.</p>
        </ConfirmAction>
      )}
    </section>
  )
}

function RowCheck({ row, column, canEdit, onChange }: { row: TableRowData; column: TableColumn; canEdit: boolean; onChange: (value: boolean) => void }) {
  const on = Boolean(row.values[column.id])
  const name = `${column.name}, row ${row.no}`
  if (!canEdit) {
    return (
      <span className={`check${on ? ' on' : ''}`} role="img" aria-label={`${name}: ${on ? 'yes' : 'no'}`}>
        {on && <Icon name="check" />}
      </span>
    )
  }
  return (
    <button type="button" className={`check${on ? ' on' : ''}`} role="checkbox" aria-checked={on} aria-label={name} onClick={() => onChange(!on)}>
      {on && <Icon name="check" />}
    </button>
  )
}

interface GridCellProps {
  row: TableRowData
  column: TableColumn
  rows: TableRowData[]
  members: Member[]
  canEdit: boolean
  workspaceId: number
  editing: boolean
  onEdit: () => void
  onDone: () => void
  onChange: (value: CellValue) => void
}

/** Cells read as plain text until clicked, so a long table stays quick. */
const fileIds = (value: CellValue | undefined) => (Array.isArray(value) ? value : [])

/** The files in a cell: small squares in the grid, full cards in the row sheet. */
function CellFiles({ workspaceId, value, canEdit, columnName, expanded, onChange }: { workspaceId: number; value: CellValue | undefined; canEdit: boolean; columnName: string; expanded?: boolean; onChange: (value: CellValue) => void }) {
  const ids = fileIds(value)
  const [error, setError] = useState('')
  const latest = useRef(ids)
  useEffect(() => {
    latest.current = fileIds(value)
  }, [value])

  async function add(files: File[]) {
    setError('')
    for (const file of files) {
      if (latest.current.length >= MAX_CELL_FILES) {
        setError(`A cell can hold up to ${MAX_CELL_FILES} files.`)
        return
      }
      try {
        const record = await uploads.start(workspaceId, file)
        latest.current = [...latest.current, record.id]
        onChange(latest.current)
      } catch (err) {
        setError(`${file.name}: ${errorMessage(err)}`)
      }
    }
  }

  const errorLine = error && (
    <span className="field-error" role="alert">
      {error}
    </span>
  )
  if (!expanded) {
    return (
      <span className="cell-files">
        <FileThumbs workspaceId={workspaceId} ids={ids} />
        {canEdit && (
          <button type="button" className="cell-add" aria-label={`Add to ${columnName}`} title={error || undefined} onClick={() => pickFiles((files) => void add(files))}>
            <Icon name="plus" />
          </button>
        )}
        {errorLine}
      </span>
    )
  }
  return (
    <div
      className="sheet-files"
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files)
        if (canEdit && files.length) {
          e.preventDefault()
          void add(files)
        }
      }}
    >
      {ids.map((id) => (
        <FileView key={id} workspaceId={workspaceId} id={id} compact onRemove={canEdit ? () => onChange((latest.current = latest.current.filter((other) => other !== id))) : undefined} />
      ))}
      {ids.length === 0 && !canEdit && <p className="sheet-read">—</p>}
      {canEdit && (
        <button type="button" className="text-btn" onClick={() => pickFiles((files) => void add(files))}>
          <Icon name="attach" />
          Add screenshot or file
        </button>
      )}
      {errorLine}
    </div>
  )
}

function GridCell({ row, column, rows, members, canEdit, workspaceId, editing, onEdit, onDone, onChange }: GridCellProps) {
  const value = row.values[column.id]
  if (column.type === 'file') return <CellFiles workspaceId={workspaceId} value={value} canEdit={canEdit} columnName={column.name} onChange={onChange} />
  if (column.type === 'checkbox') return <RowCheck row={row} column={column} canEdit={canEdit} onChange={onChange} />
  const text = displayValue(column, value, members)
  if (!canEdit) return <span className="grid-text">{text}</span>
  if (!editing) {
    return (
      <button type="button" className={`grid-text grid-edit${text ? '' : ' empty-cell'}`} aria-label={`${column.name}, row ${row.no}: ${text || 'empty'}. Edit`} onClick={onEdit}>
        {text}
      </button>
    )
  }
  return <CellEditor column={column} value={value} rows={rows} members={members} autoFocus onChange={onChange} onDone={onDone} />
}

interface CellEditorProps {
  column: TableColumn
  value: CellValue | undefined
  rows: TableRowData[]
  members: Member[]
  autoFocus?: boolean
  label?: string
  /** Inside the row sheet, every keystroke counts; in the grid, Escape can still take it back. */
  live?: boolean
  onChange: (value: CellValue) => void
  onDone?: () => void
}

function CellEditor({ column, value, rows, members, autoFocus, label, live, onChange, onDone }: CellEditorProps) {
  const [draft, setDraft] = useState<string>(() => (column.type === 'date' ? toLocalInput(value) : value === null || value === undefined ? '' : String(value)))
  const cancelled = useRef(false)
  const listId = `options-${column.id}`
  const common = { className: 'field cell-input', 'aria-label': label ?? column.name, autoFocus }

  const parse = (text: string): CellValue => {
    if (column.type === 'number') {
      const number = Number(text)
      return text.trim() === '' || !Number.isFinite(number) ? null : number
    }
    if (column.type === 'date') return fromLocalInput(text)
    if (column.type === 'select') return text.trim() || null
    return text
  }
  const commit = (text: string) => {
    if (cancelled.current) return
    const next = parse(text)
    if ((next ?? '') !== (value ?? '')) onChange(next)
  }
  const type = (text: string) => {
    setDraft(text)
    if (live) commit(text)
  }
  const finish = () => {
    if (!live) commit(draft)
    onDone?.()
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      cancelled.current = true
      onDone?.()
    } else if (e.key === 'Enter' && !e.shiftKey && !live) {
      e.preventDefault()
      ;(e.currentTarget as HTMLElement).blur()
    }
  }

  if (column.type === 'person') {
    return (
      <select
        {...common}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value)
          onChange(e.target.value ? Number(e.target.value) : null)
          onDone?.()
        }}
        onBlur={() => onDone?.()}
        onKeyDown={onKey}
      >
        <option value="">Nobody</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {memberName(m)}
          </option>
        ))}
      </select>
    )
  }
  if (column.type === 'text') {
    return <textarea {...common} rows={live ? 3 : 2} maxLength={5000} value={draft} onChange={(e) => type(e.target.value)} onBlur={finish} onKeyDown={onKey} />
  }
  if (column.type === 'select') {
    return (
      <>
        <input {...common} list={listId} maxLength={60} placeholder="Choose or type" value={draft} onChange={(e) => type(e.target.value)} onBlur={finish} onKeyDown={onKey} />
        <datalist id={listId}>
          {optionsFor(rows, column).map((option) => (
            <option key={option} value={option} />
          ))}
        </datalist>
      </>
    )
  }
  return <input {...common} type={column.type === 'number' ? 'number' : 'datetime-local'} value={draft} onChange={(e) => type(e.target.value)} onBlur={finish} onKeyDown={onKey} />
}

function Board({
  rows,
  columns,
  column,
  members,
  canEdit,
  onOpen,
  onMove,
}: {
  rows: TableRowData[]
  columns: TableColumn[]
  column: TableColumn
  members: Member[]
  canEdit: boolean
  onOpen: (row: TableRowData) => void
  onMove: (row: TableRowData, value: CellValue) => void
}) {
  const [dragged, setDragged] = useState<number | null>(null)
  const groups = boardGroups(rows, column, members)
  return (
    <div className="panel-scroll table-board">
      {groups.map((group) => (
        <section
          key={group.key}
          className="board-col"
          aria-label={group.label}
          onDragOver={(e) => canEdit && dragged !== null && e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            const row = rows.find((r) => r.id === dragged)
            if (row) onMove(row, groupValue(column, group.key))
            setDragged(null)
          }}
        >
          <h3 className="section-label board-head">
            {group.label} <span className="count-pill">{group.rows.length}</span>
          </h3>
          {group.rows.map((row) => (
            <button key={row.id} type="button" className={`board-card${row.highlighted ? ' row-red' : ''}`} draggable={canEdit} onDragStart={() => setDragged(row.id)} onDragEnd={() => setDragged(null)} onClick={() => onOpen(row)}>
              <span className="task-title">{rowTitle(row, columns)}</span>
              <span className="task-meta">
                No. {row.no}
                {row.comment_count > 0 && ` · ${row.comment_count} ${row.comment_count === 1 ? 'comment' : 'comments'}`}
              </span>
            </button>
          ))}
        </section>
      ))}
    </div>
  )
}

function RowSheet({
  row,
  columns,
  rows,
  members,
  canEdit,
  canComment,
  now,
  workspaceId,
  tableId,
  onCommentsChanged,
  onClose,
  onCells,
  onHighlight,
  onAddToTasks,
  onDelete,
}: {
  row: TableRowData
  columns: TableColumn[]
  rows: TableRowData[]
  members: Member[]
  canEdit: boolean
  canComment: boolean
  now: Date
  workspaceId: number
  tableId: number
  onCommentsChanged: () => void
  onClose: () => void
  onCells: (values: Record<string, CellValue>) => void
  onHighlight: (on: boolean) => void
  onAddToTasks: () => void
  onDelete: () => Promise<void>
}) {
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={`Row ${row.no}`}>
        <div className="sheet-top">
          <div className="grabber" aria-hidden="true" />
          <div className="sheet-head">
            <h2>No. {row.no}</h2>
            <div style={{ display: 'flex', gap: 10 }}>
              {canEdit && (
                <button type="button" className="icon-btn" aria-label="Delete this row" onClick={() => setDeleting(true)}>
                  <Icon name="trash" />
                </button>
              )}
              <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
                <Icon name="x" />
              </button>
            </div>
          </div>
        </div>
        <div className="sheet-body">
          {columns.map((column) => (
            <div key={column.id} className="field-group">
              <span className="label">{column.name}</span>
              {column.type === 'file' ? (
                <CellFiles workspaceId={workspaceId} value={row.values[column.id]} canEdit={canEdit} columnName={column.name} expanded onChange={(value) => onCells({ [column.id]: value })} />
              ) : column.type === 'checkbox' ? (
                <div className="sheet-check" style={{ ['--cat' as string]: 'var(--work)' }}>
                  <RowCheck row={row} column={column} canEdit={canEdit} onChange={(value) => onCells({ [column.id]: value })} />
                </div>
              ) : canEdit ? (
                <CellEditor key={column.id} column={column} value={row.values[column.id]} rows={rows} members={members} label={column.name} live onChange={(value) => onCells({ [column.id]: value })} />
              ) : (
                <p className="sheet-read">{displayValue(column, row.values[column.id], members) || '—'}</p>
              )}
            </div>
          ))}
          {canEdit && (
            <div className="toggle-row">
              <span>Highlight in red</span>
              <button type="button" className="switch" role="switch" aria-checked={row.highlighted} aria-label="Highlight in red" onClick={() => onHighlight(!row.highlighted)} />
            </div>
          )}
          <Comments target={{ workspaceId, tableId, rowId: row.id }} now={now} members={members} canComment={canComment} onChanged={onCommentsChanged} />
          <HistoryFold workspaceId={workspaceId} now={now} rowId={row.id} />
        </div>
        <div className="sheet-foot table-sheet-foot">
          <button type="button" className="text-btn" disabled={row.on_my_tasks} onClick={onAddToTasks}>
            <Icon name={row.on_my_tasks ? 'check' : 'plus'} />
            {row.on_my_tasks ? 'On your tasks' : 'Add to my tasks'}
          </button>
          <button type="button" className="primary-btn" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
      {deleting && (
        <ConfirmAction danger icon="trash" title={`Delete row ${row.no}?`} confirmLabel="Delete row" onCancel={() => setDeleting(false)} onConfirm={onDelete}>
          <p>Everyone in the workspace loses it. You can undo this right after.</p>
        </ConfirmAction>
      )}
    </div>,
    document.body,
  )
}

/** What an active filter reads as, in its chip. */
function filterText(column: TableColumn, value: string, members: Member[], userId: number) {
  if (column.type === 'checkbox') return value === 'yes' ? column.name : `Not ${column.name.toLowerCase()}`
  if (column.type === 'person') {
    if (value === NONE) return `${column.name}: Nobody`
    if (Number(value) === userId) return `${column.name}: Me`
    const member = members.find((m) => m.id === Number(value))
    return `${column.name}: ${member ? memberName(member) : 'Former member'}`
  }
  return `${column.name}: ${value === NONE ? 'Empty' : value}`
}

/** A dialog on desktop and a bottom sheet on phones, like the task and row sheets. */
function Sheet({ title, onBack, onClose, foot, children }: { title: string; onBack?: () => void; onClose: () => void; foot: React.ReactNode; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (onBack) onBack()
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onBack, onClose])
  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-top">
          <div className="grabber" aria-hidden="true" />
          <div className="sheet-head">
            <div className="sheet-title">
              {onBack && (
                <button type="button" className="icon-btn" aria-label="Back" onClick={onBack}>
                  <Icon name="back" />
                </button>
              )}
              <h2>{title}</h2>
            </div>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              <Icon name="x" />
            </button>
          </div>
        </div>
        <div className="sheet-body">{children}</div>
        <div className="sheet-foot table-sheet-foot">{foot}</div>
      </div>
    </div>,
    document.body,
  )
}

function FilterSheet({
  columns,
  filterable,
  rows,
  members,
  userId,
  filters,
  sort,
  boardColumn,
  onFilters,
  onSort,
  onGroupBy,
  onClose,
}: {
  columns: TableColumn[]
  filterable: TableColumn[]
  rows: TableRowData[]
  members: Member[]
  userId: number
  filters: Filters
  sort: SortChoice
  boardColumn?: TableColumn
  onFilters: React.Dispatch<React.SetStateAction<Filters>>
  onSort: (sort: SortChoice) => void
  onGroupBy: (column: string) => void
  onClose: () => void
}) {
  return (
    <Sheet
      title="Filter and sort"
      onClose={onClose}
      foot={
        <>
          <button
            type="button"
            className="text-btn"
            onClick={() => {
              onFilters({})
              onSort({ column: 'no', descending: false })
            }}
          >
            Clear all
          </button>
          <button type="button" className="primary-btn" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      {filterable.length === 0 && <p className="task-meta">Add a Choice, Person or Checkbox column to filter by it.</p>}
      {filterable.map((column) => (
        <label key={column.id} className="field-group">
          <span className="label">{column.name}</span>
          <select className="field" value={filters[column.id] ?? ''} onChange={(e) => onFilters((f) => ({ ...f, [column.id]: e.target.value }))}>
            <option value="">{column.type === 'person' ? 'Anyone' : 'All'}</option>
            {column.type === 'checkbox' && (
              <>
                <option value="yes">{column.name}</option>
                <option value="no">Not {column.name.toLowerCase()}</option>
              </>
            )}
            {column.type === 'select' && (
              <>
                {optionsFor(rows, column).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
                <option value={NONE}>Empty</option>
              </>
            )}
            {column.type === 'person' && (
              <>
                <option value={String(userId)}>Me</option>
                {members
                  .filter((m) => m.id !== userId)
                  .map((m) => (
                    <option key={m.id} value={String(m.id)}>
                      {memberName(m)}
                    </option>
                  ))}
                <option value={NONE}>Nobody</option>
              </>
            )}
          </select>
        </label>
      ))}
      <label className="field-group">
        <span className="label">Sort by</span>
        <select
          className="field"
          value={`${sort.column}|${sort.descending ? 'd' : 'a'}`}
          onChange={(e) => {
            const [column, direction] = e.target.value.split('|')
            onSort({ column, descending: direction === 'd' })
          }}
        >
          <option value="no|a">Oldest first</option>
          <option value="no|d">Newest first</option>
          {columns.flatMap((c) => [
            <option key={`${c.id}a`} value={`${c.id}|a`}>
              {c.name}, A to Z
            </option>,
            <option key={`${c.id}d`} value={`${c.id}|d`}>
              {c.name}, Z to A
            </option>,
          ])}
        </select>
      </label>
      {boardColumn && (
        <label className="field-group">
          <span className="label">Group the board by</span>
          <select className="field" value={boardColumn.id} onChange={(e) => onGroupBy(e.target.value)}>
            {filterable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </Sheet>
  )
}

function ColumnIcon({ type }: { type: ColumnType }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d={COLUMN_ICONS[type]} />
    </svg>
  )
}

/** The list of columns; tapping one, or Add, opens a small page of its own inside the sheet. */
function ColumnsSheet({
  workspaceId,
  tableId,
  columns,
  onClose,
  onChanged,
}: {
  workspaceId: number
  tableId: number
  columns: TableColumn[]
  onClose: () => void
  onChanged: (table: TeamTable) => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [type, setType] = useState<ColumnType>('text')
  const [removing, setRemoving] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const editing = columns.find((c) => c.id === editingId)
  const index = editing ? columns.indexOf(editing) : -1

  const backToList = () => {
    setEditingId(null)
    setAdding(false)
    setError('')
  }
  const run = async (fn: () => Promise<TeamTable>, then?: () => void) => {
    setBusy(true)
    setError('')
    try {
      onChanged(await fn())
      then?.()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }
  const errorLine = error && (
    <span className="field-error" role="alert">
      {error}
    </span>
  )

  if (adding) {
    return (
      <Sheet
        title="Add a column"
        onBack={backToList}
        onClose={onClose}
        foot={
          <>
            <button type="button" className="text-btn" onClick={backToList}>
              Cancel
            </button>
            <button type="button" className="primary-btn" disabled={busy || !name.trim()} onClick={() => void run(() => api.addColumn(workspaceId, tableId, name, type), backToList)}>
              Add column
            </button>
          </>
        }
      >
        <label className="field-group">
          <span className="label">Name</span>
          <input className="field" autoFocus maxLength={60} placeholder="Page, Browser, Priority…" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="field-group" role="radiogroup" aria-label="What it holds">
          <span className="label">What it holds</span>
          <div className="type-list">
            {COLUMN_TYPES.map((t) => (
              <button key={t.type} type="button" className="type-row" role="radio" aria-checked={type === t.type} onClick={() => setType(t.type)}>
                <ColumnIcon type={t.type} />
                <span className="person-main">
                  <span className="person-name">{t.label}</span>
                  <span className="task-meta">{t.hint}</span>
                </span>
                {type === t.type && <Icon name="check" className="type-tick" />}
              </button>
            ))}
          </div>
        </div>
        {errorLine}
      </Sheet>
    )
  }

  if (editing) {
    return (
      <>
        <Sheet
          title={editing.name}
          onBack={backToList}
          onClose={onClose}
          foot={
            <>
              <button type="button" className="text-btn" onClick={backToList}>
                Cancel
              </button>
              <button
                type="button"
                className="primary-btn"
                disabled={busy || !name.trim() || name.trim() === editing.name}
                onClick={() => void run(() => api.updateColumn(workspaceId, tableId, editing.id, { name }), backToList)}
              >
                Save
              </button>
            </>
          }
        >
          <label className="field-group">
            <span className="label">Name</span>
            <input className="field" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <p className="task-meta">Holds: {typeLabel(editing.type)}. This can't change once a column is made.</p>
          <div className="panel-rows">
            <button type="button" className="more-row" disabled={busy || index === 0} onClick={() => void run(() => api.updateColumn(workspaceId, tableId, editing.id, { position: index - 1 }))}>
              <span className="person-name">Move earlier</span>
            </button>
            <button type="button" className="more-row" disabled={busy || index === columns.length - 1} onClick={() => void run(() => api.updateColumn(workspaceId, tableId, editing.id, { position: index + 1 }))}>
              <span className="person-name">Move later</span>
            </button>
            <button type="button" className="more-row danger-row" onClick={() => setRemoving(true)}>
              <span className="person-name">Remove column</span>
            </button>
          </div>
          {errorLine}
        </Sheet>
        {removing && (
          <ConfirmAction
            danger
            icon="trash"
            title={`Remove ${editing.name}?`}
            confirmLabel="Remove column"
            onCancel={() => setRemoving(false)}
            onConfirm={async () => {
              onChanged(await api.deleteColumn(workspaceId, tableId, editing.id))
              setRemoving(false)
              backToList()
            }}
          >
            <p>Everything in this column is lost for everyone. This can't be undone.</p>
          </ConfirmAction>
        )}
      </>
    )
  }

  return (
    <Sheet
      title="Columns"
      onClose={onClose}
      foot={
        <>
          <button
            type="button"
            className="text-btn"
            onClick={() => {
              setName('')
              setType('text')
              setError('')
              setAdding(true)
            }}
          >
            <Icon name="plus" />
            Add a column
          </button>
          <button type="button" className="primary-btn" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <div className="panel-rows">
        {columns.map((column) => (
          <button
            key={column.id}
            type="button"
            className="more-row"
            onClick={() => {
              setName(column.name)
              setError('')
              setEditingId(column.id)
            }}
          >
            <ColumnIcon type={column.type} />
            <span className="person-main">
              <span className="person-name">{column.name}</span>
              <span className="task-meta">{typeLabel(column.type)}</span>
            </span>
            <Icon name="chevron" className="more-go" />
          </button>
        ))}
      </div>
    </Sheet>
  )
}
