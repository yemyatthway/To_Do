import { useCallback, useEffect, useRef, useState } from 'react'
import type { Page, TableQuery } from '../../api'

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const PAGE_SIZES = [10, 25, 50, 100]

interface Loaded<T> {
  key: string
  rows: T[]
  count: number
  error: string
}

/**
 * State for a server-side table: search (sent once typing pauses), filters, sorting and pages.
 * Changing any of them goes back to page 1. The previous rows stay on screen while the next page
 * loads, so the table doesn't flash empty.
 */
export function useServerTable<T, F extends Record<string, string>>(
  load: (query: TableQuery) => Promise<Page<T>>,
  initial: { ordering: string; filters: F; search?: string },
) {
  const [search, setSearchText] = useState(initial.search ?? '')
  const [query, setQuery] = useState(initial.search ?? '')
  const [filters, setFilters] = useState(initial.filters)
  const [ordering, setOrdering] = useState(initial.ordering)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSizeState] = useState(25)
  const [nonce, setNonce] = useState(0)
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null)
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  useEffect(() => {
    const id = setTimeout(() => {
      setQuery(search.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(id)
  }, [search])

  const key = JSON.stringify([query, filters, ordering, page, pageSize, nonce])
  useEffect(() => {
    let live = true
    loadRef.current({ search: query, ...filters, ordering, page, page_size: pageSize }).then(
      (result) => live && setLoaded({ key, rows: result.results, count: result.count, error: '' }),
      (err) => live && setLoaded((prev) => ({ key, rows: prev?.rows ?? [], count: prev?.count ?? 0, error: errorMessage(err) })),
    )
    return () => {
      live = false
    }
  }, [key, query, filters, ordering, page, pageSize])

  const setFilter = useCallback((name: keyof F, value: string) => {
    setFilters((prev) => ({ ...prev, [name]: value }))
    setPage(1)
  }, [])

  /** Click a column: first click sorts it (newest/biggest first when `descFirst`), the next flips it. */
  const sortBy = useCallback((field: string, descFirst = false) => {
    setOrdering((current) => (current === field ? `-${field}` : current === `-${field}` ? field : descFirst ? `-${field}` : field))
    setPage(1)
  }, [])

  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size)
    setPage(1)
  }, [])

  /** Change rows in place (e.g. after a ban) without reloading. */
  const patchRows = useCallback((change: (rows: T[]) => T[]) => setLoaded((prev) => prev && { ...prev, rows: change(prev.rows) }), [])

  return {
    rows: loaded?.rows ?? [],
    count: loaded?.count ?? 0,
    error: loaded?.key === key ? loaded.error : '',
    loading: loaded?.key !== key,
    firstLoad: loaded === null,
    search,
    setSearch: setSearchText,
    query,
    filters,
    setFilter,
    ordering,
    sortBy,
    page,
    setPage,
    pageSize,
    setPageSize,
    reload: useCallback(() => setNonce((n) => n + 1), []),
    patchRows,
  }
}

export type ServerTable = Pick<ReturnType<typeof useServerTable>, 'ordering' | 'sortBy' | 'count' | 'page' | 'setPage' | 'pageSize' | 'setPageSize' | 'loading'>
