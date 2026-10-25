import type { ReactNode } from 'react'
import { Icon } from '../../icons'
import { PAGE_SIZES, type ServerTable } from './useServerTable'

export function SearchBox({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="admin-search">
      <span className="sr-only">{label}</span>
      <svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-5-5" />
      </svg>
      <input className="field" type="search" placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

export function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: string
  options: readonly (readonly [string, string])[]
  onChange: (value: string) => void
}) {
  return (
    <label className="admin-filter">
      <span className="sr-only">{label}</span>
      <select className="field" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  )
}

/** A column header that sorts the table. */
export function SortHeader({
  table,
  field,
  descFirst,
  className,
  children,
}: {
  table: ServerTable
  field: string
  descFirst?: boolean
  className?: string
  children: ReactNode
}) {
  const direction = table.ordering === field ? 'ascending' : table.ordering === `-${field}` ? 'descending' : 'none'
  return (
    <th scope="col" aria-sort={direction} className={className}>
      <button type="button" className={`sort-btn${direction !== 'none' ? ' sorted' : ''}`} onClick={() => table.sortBy(field, descFirst)}>
        {children}
        <span className={`sort-arrow ${direction}`} aria-hidden="true">
          <Icon name="chevron" />
        </span>
      </button>
    </th>
  )
}

/** "1–25 of 132", rows per page, and ‹ 2 of 6 ›. */
export function Pager({ table, noun }: { table: ServerTable; noun: string }) {
  const { count, page, pageSize } = table
  const pages = Math.max(1, Math.ceil(count / pageSize))
  const first = count ? (page - 1) * pageSize + 1 : 0
  const last = Math.min(count, page * pageSize)

  return (
    <div className="pager">
      <span className="list-sub">
        {first}–{last} of {count} {count === 1 ? noun.replace(/s$/, '') : noun}
      </span>
      <label className="pager-size">
        <span className="list-sub">Rows</span>
        <select className="field" value={pageSize} onChange={(e) => table.setPageSize(Number(e.target.value))}>
          {PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <nav className="pager-pages" aria-label={`${noun} pages`}>
        <button type="button" className="page-btn" aria-label="Previous page" disabled={page <= 1} onClick={() => table.setPage(page - 1)}>
          <Icon name="back" />
        </button>
        <span className="page-status" aria-live="polite">
          <strong>{page}</strong> of {pages}
        </span>
        <button type="button" className="page-btn" aria-label="Next page" disabled={page >= pages} onClick={() => table.setPage(page + 1)}>
          <Icon name="chevron" />
        </button>
      </nav>
    </div>
  )
}

export function TableError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      <button type="button" className="text-btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  )
}
