import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, auth, guestApi, refreshSession, workspaces, type GuestApi, type GuestTable, type GuestWorkspace, type TeamPage } from '../api'
import { ConfirmAction } from '../components/ConfirmAction'
import { FileThumbs, FileView } from '../components/Files'
import { CardsSkeleton, Loading } from '../components/Loading'
import { ReadOnlyBlock } from '../components/PageEditor'
import { SearchField } from '../components/SearchField'
import { ColumnIcon, GridCell } from '../components/TableView'
import { readFilesWith } from '../filesClient'
import { guestPlaceFrom, rememberJoinEmail } from '../guestLink'
import { chooseLanguage, language, LANGUAGES, tr } from '../i18n'
import { Icon } from '../icons'
import { useEnterOnChange } from '../motion'
import { displayValue, fileIds, rowTitle } from '../tableLogic'
import { useTheme } from '../theme'
import { timeAgo } from '../user'
import { usePhoneLayout } from '../visibility'

const CHECK_EVERY_MS = 60_000
const nothing = () => undefined
const roleName = (role: string) => tr(role[0].toUpperCase() + role.slice(1))

/** Fetches something now, whenever the person comes back to the tab, and every minute while they stay. */
function useLatest<T>(load: () => Promise<T>, key: string) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const latest = useRef(load)
  useEffect(() => {
    latest.current = load
  })
  useEffect(() => {
    let current = true
    const run = () => {
      if (document.hidden) return
      latest.current().then(
        (value) => {
          if (!current) return
          setData(value)
          setError(null)
        },
        (err: unknown) => {
          if (current) setError(err)
        },
      )
    }
    run()
    const timer = window.setInterval(run, CHECK_EVERY_MS)
    document.addEventListener('visibilitychange', run)
    return () => {
      current = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', run)
    }
  }, [key])
  return { data, error }
}

const isGone = (err: unknown) => err instanceof ApiError && err.status === 404

/** Someone invited to a workspace looks around from their link. It can only read: joining takes an account. */
export function GuestScreen({ token }: { token: string }) {
  useTheme()
  const [api] = useState<GuestApi>(() => {
    const made = guestApi(token)
    readFilesWith((_workspace, ids) => made.files(ids))
    return made
  })
  const { data: info, error } = useLatest(api.workspace, token)
  const [place, setPlace] = useState(() => guestPlaceFrom(window.location.hash))
  const [signedIn, setSignedIn] = useState(false)
  const [switching, setSwitching] = useState(false)
  const page = useRef<HTMLDivElement>(null)
  useEnterOnChange(page, place ? `${place.kind}-${place.id}` : 'home')

  useEffect(() => {
    const onHash = () => setPlace(guestPlaceFrom(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Already logged in with the invited address: this is simply their invitation.
  const invitation = info?.invitation
  useEffect(() => {
    if (!invitation) return
    let current = true
    void (async () => {
      if (!(await refreshSession()) || !current) return
      setSignedIn(true)
      const list = await workspaces.list().catch(() => null)
      if (current && list?.invitations.some((waiting) => waiting.id === invitation)) window.location.replace('/?view=workspaces')
    })()
    return () => {
      current = false
    }
  }, [invitation])

  const open = (kind: 'page' | 'table', id: number) => {
    window.location.hash = `${kind}-${id}`
  }
  const home = () => {
    window.location.hash = ''
  }

  function join(masked: string) {
    rememberJoinEmail(masked)
    window.location.assign('/?view=workspaces')
  }

  if (isGone(error)) {
    return (
      <div className="guest-closed">
        <div className="card glass guest-closed-card">
          <span className="auth-logo" aria-hidden="true">
            <Icon name="clock" />
          </span>
          <p>{error instanceof Error ? tr(error.message) : ''}</p>
          <a className="primary-btn" href="/">
            {tr('Open Todo Clock')}
          </a>
        </div>
      </div>
    )
  }

  if (!info) {
    return (
      <div className="guest">
        {error ? (
          <div className="error-banner" role="alert">
            <span>{error instanceof Error ? error.message : ''}</span>
            <button className="text-btn" onClick={() => window.location.reload()}>
              {tr('Retry')}
            </button>
          </div>
        ) : (
          <Loading skeleton={<CardsSkeleton />} />
        )}
      </div>
    )
  }

  return (
    <div className="guest">
      <header className="guest-head">
        <span className="auth-logo" aria-hidden="true">
          <Icon name="clock" />
        </span>
        <span className="guest-name">
          <strong>{info.name}</strong>
          <span className="row-sub">{tr('View only')}</span>
        </span>
        <button className="primary-btn" onClick={() => (signedIn ? setSwitching(true) : join(info.email))}>
          {tr('Join')}
        </button>
      </header>

      <div ref={page} className={`panel-page${place ? ' wide' : ''}`}>
        {!place && <GuestHome info={info} onOpen={open} />}
        {place?.kind === 'page' && <GuestPage key={place.id} api={api} id={place.id} workspaceId={info.id} onBack={home} />}
        {place?.kind === 'table' && <GuestTableScreen key={place.id} api={api} id={place.id} workspaceId={info.id} onBack={home} />}
      </div>

      {switching && (
        <ConfirmAction
          icon="logout"
          title={tr('Log out to join?')}
          confirmLabel={tr('Log out')}
          onCancel={() => setSwitching(false)}
          onConfirm={async () => {
            await auth.logout()
            join(info.email)
          }}
        >
          <p>{tr('This invitation is for {email}, and you\'re logged in with another account.', { email: info.email })}</p>
        </ConfirmAction>
      )}
    </div>
  )
}

function GuestHome({ info, onOpen }: { info: GuestWorkspace; onOpen: (kind: 'page' | 'table', id: number) => void }) {
  const [query, setQuery] = useState('')
  const [now] = useState(() => new Date())
  const q = query.trim().toLowerCase()
  const items = [
    ...info.pages.map((item) => ({ ...item, kind: 'page' as const })),
    ...info.tables.map((item) => ({ ...item, kind: 'table' as const })),
  ].sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  const shown = items.filter((item) => (item.title || tr('Untitled')).toLowerCase().includes(q))

  return (
    <section className="card glass panel" aria-label={info.name}>
      <p className="guest-note">
        {info.invited_by ? tr('{who} invited you as {role}.', { who: info.invited_by, role: roleName(info.role) }) : tr('You\'re invited as {role}.', { role: roleName(info.role) })}{' '}
        {tr('Log in or sign up with {email} to join.', { email: info.email })}
      </p>
      {items.length > 6 && (
        <div className="panel-top">
          <SearchField label={tr('Search')} placeholder={tr('Search')} value={query} onChange={setQuery} />
        </div>
      )}
      <div className="panel-scroll">
        {items.length === 0 && <p className="empty">{tr('Nothing here yet.')}</p>}
        {items.length > 0 && shown.length === 0 && <p className="empty">{tr('Nothing matches.')}</p>}
        <ul className="row-list">
          {shown.map((item) => (
            <li key={`${item.kind}-${item.id}`}>
              <button className="flat-row" onClick={() => onOpen(item.kind, item.id)}>
                <span className={`well${item.kind === 'page' ? ' violet' : ''}`}>
                  <Icon name={item.kind} />
                </span>
                <span className="row-main">
                  <span className="person-name">{item.title || tr('Untitled')}</span>
                  <span className="row-sub">
                    {item.kind === 'page' ? tr('Page') : tr('Table')} {tr('· edited')} {timeAgo(item.updated_at, now).toLowerCase()}
                  </span>
                </span>
                <Icon name="chevron" className="more-go" />
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="segmented guest-language" role="group" aria-label={tr('Language')}>
        {LANGUAGES.map((option) => (
          <button key={option.value} type="button" lang={option.value} aria-pressed={language === option.value} onClick={() => option.value !== language && chooseLanguage(option.value)}>
            {option.name}
          </button>
        ))}
      </div>
    </section>
  )
}

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button className="round-btn" aria-label={tr('Back')} onClick={onBack}>
      <Icon name="back" />
    </button>
  )
}

function Unavailable({ error, onBack }: { error: unknown; onBack: () => void }) {
  return (
    <section className="card glass panel">
      <div className="guest-top">
        <BackButton onBack={onBack} />
      </div>
      <p className="empty">{isGone(error) ? tr('This isn\'t available any more.') : error instanceof Error ? error.message : ''}</p>
    </section>
  )
}

function GuestPage({ api, id, workspaceId, onBack }: { api: GuestApi; id: number; workspaceId: number; onBack: () => void }) {
  const load = useCallback(() => api.page(id), [api, id])
  const { data, error } = useLatest<TeamPage>(load, `page-${id}`)
  if (error && !data) return <Unavailable error={error} onBack={onBack} />
  if (!data) return <Loading skeleton={<CardsSkeleton cards={1} />} />
  return (
    <section className="card glass panel page-editor" aria-label={data.title || tr('Untitled')}>
      <div className="guest-top">
        <BackButton onBack={onBack} />
        <h2 className="page-title">{data.title || tr('Untitled')}</h2>
      </div>
      <div className="panel-scroll page-blocks">
        {data.blocks.length === 0 && <p className="empty">{tr('Nothing here yet.')}</p>}
        {data.blocks.map((block) =>
          block.type === 'file' ? (
            <div key={block.id} className="page-block is-file">
              <FileView workspaceId={workspaceId} id={block.file!} />
            </div>
          ) : (
            <ReadOnlyBlock key={block.id} block={block} />
          ),
        )}
      </div>
    </section>
  )
}

function GuestTableScreen({ api, id, workspaceId, onBack }: { api: GuestApi; id: number; workspaceId: number; onBack: () => void }) {
  const load = useCallback(() => api.table(id), [api, id])
  const { data, error } = useLatest<GuestTable>(load, `table-${id}`)
  const phone = usePhoneLayout()
  if (error && !data) return <Unavailable error={error} onBack={onBack} />
  if (!data) return <Loading skeleton={<CardsSkeleton cards={1} />} />
  const { columns, rows, members } = data
  const title = data.title || tr('Untitled')
  const checkbox = columns.find((c) => c.type === 'checkbox')
  const filesColumn = columns.find((c) => c.type === 'file')
  return (
    <section className="card glass panel table-screen" aria-label={title}>
      <div className="guest-top">
        <BackButton onBack={onBack} />
        <h2 className="page-title">{title}</h2>
      </div>
      {data.description && <p className="row-sub guest-description">{data.description}</p>}
      {rows.length === 0 ? (
        <p className="empty">{tr('Nothing here yet.')}</p>
      ) : phone ? (
        <ul className="panel-scroll table-list">
          {rows.map((row) => {
            const done = Boolean(checkbox && row.values[checkbox.id])
            const file = filesColumn ? fileIds(row.values[filesColumn.id])[0] : undefined
            const name = rowTitle(row, columns)
            const details = columns
              .filter((c) => c.type !== 'checkbox' && c.type !== 'file')
              .map((c) => displayValue(c, row.values[c.id], members))
              .filter((part) => part !== '' && part !== name)
            return (
              <li key={row.id}>
                <div className="flat-row">
                  {file !== undefined && <FileThumbs workspaceId={workspaceId} ids={[file]} limit={1} still />}
                  <span className="row-main">
                    <span className={`person-name${row.highlighted ? ' row-red' : ''}${done ? ' is-done' : ''}`}>{name}</span>
                    <span className="row-sub">{[`${tr('No.')} ${row.no}`, ...details].join(' · ')}</span>
                  </span>
                  {done && <span className="row-status done">{tr('Done')}</span>}
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="panel-scroll grid-box" role="table" aria-label={title}>
          <div className="grid-row grid-head" role="row">
            <div className="grid-cell grid-no" role="columnheader">
              {tr('No.')}
            </div>
            {columns.map((column) => (
              <div key={column.id} className={`grid-cell grid-${column.type}`} role="columnheader">
                <ColumnIcon type={column.type} />
                <span className="grid-name">{column.name}</span>
              </div>
            ))}
          </div>
          {rows.map((row) => (
            <div key={row.id} className={`grid-row${row.highlighted ? ' row-red' : ''}`} role="row">
              <div className="grid-cell grid-no" role="cell">
                {row.no}
              </div>
              {columns.map((column) => (
                <div key={column.id} className={`grid-cell grid-${column.type}`} role="cell">
                  <GridCell row={row} column={column} rows={rows} members={members} canEdit={false} workspaceId={workspaceId} editing={false} onEdit={nothing} onDone={nothing} onChange={nothing} onTyping={nothing} notAssignable={null} />
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
