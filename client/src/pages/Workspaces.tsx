import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, workspaces as api, type Member, type Role, type TeamPage, type TeamTable, type WorkspaceDetail, type WorkspaceList } from '../api'
import { ConfirmAction } from '../components/ConfirmAction'
import { ActivityScreen } from '../components/ActivityScreen'
import { InviteField } from '../components/InviteField'
import { ImportFile } from '../components/ImportFile'
import { CardsSkeleton, Loading, SkeletonRows } from '../components/Loading'
import { PageEditor } from '../components/PageEditor'
import { TableView } from '../components/TableView'
import { SearchField } from '../components/SearchField'
import type { ToastData } from '../components/Toast'
import type { ImportPlan } from '../excelImport'
import { copyText } from '../guestLink'
import { Icon } from '../icons'
import { useLiveRefresh } from '../live'
import { useEnterOnChange } from '../motion'
import type { WorkspaceSection } from '../routes'
import { initials, timeAgo } from '../user'
import { tr } from '../i18n'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
const fieldError = (err: unknown, field: string) => (err instanceof ApiError && err.fields[field]?.join(' ')) || errorMessage(err)
const label = (role: string) => role[0].toUpperCase() + role.slice(1)
const nameOf = (m: Member) => m.full_name || `@${m.username}`
const leftField = { width: '100%', textAlign: 'left' } as const

interface ListProps {
  data: WorkspaceList | null
  error: string
  notify: (title: string, detail?: string) => void
  onOpen: (id: number) => void
  onChanged: () => void
  onRetry: () => void
}

/** Your workspaces, invitations waiting for you, and making a new one. */
export function Workspaces({ data, error, notify, onOpen, onChanged, onRetry }: ListProps) {
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  async function answer(id: number, accept: boolean) {
    setBusy(`invite-${id}`)
    try {
      if (accept) {
        const joined = await api.accept(id)
        notify(tr('You joined {name}', { name: joined.name }))
        onOpen(joined.id)
      } else {
        await api.decline(id)
      }
      onChanged()
    } catch (err) {
      notify(tr('That didn\'t work'), errorMessage(err))
      onChanged()
    } finally {
      setBusy(null)
    }
  }

  const q = query.trim().toLowerCase()
  const invitations = data?.invitations.filter((i) => i.workspace.toLowerCase().includes(q)) ?? []
  const list = data?.workspaces.filter((w) => w.name.toLowerCase().includes(q)) ?? []

  return (
    <div className="panel-page">
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button className="text-btn" onClick={onRetry}>
            {tr('Retry')}
          </button>
        </div>
      )}

      <section className="card glass panel" aria-label={tr('Workspaces')}>
        <div className="panel-top">
          <SearchField label={tr('Search workspaces')} placeholder={tr('Search workspaces')} value={query} onChange={setQuery} />
          <button
            className="primary-btn icon-only"
            aria-label={tr('New workspace')}
            onClick={() => {
              setName('')
              setCreating(true)
            }}
          >
            <Icon name="plus" />
          </button>
        </div>

        <div className="panel-scroll">
          {invitations.length > 0 && (
            <>
              <h3 className="section-label">{tr('Invitations')}</h3>
              <ul className="people">
                {invitations.map((invite) => (
                  <li key={invite.id} className="person">
                    <span className="person-main">
                      <span className="person-name">{invite.workspace}</span>
                      <span className="task-meta">
                        {tr('{invited_by} invited you as', { invited_by: invite.invited_by })}{' '}{label(invite.role)}
                      </span>
                    </span>
                    <span className="person-actions">
                      <button className="primary-btn small-btn" disabled={busy !== null} onClick={() => answer(invite.id, true)}>
                        {tr('Accept')}
                      </button>
                      <button className="text-btn" disabled={busy !== null} onClick={() => answer(invite.id, false)}>
                        {tr('Decline')}
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {data === null ? (
            <Loading active={!error} skeleton={<SkeletonRows count={3} />} onRetry={onRetry} />
          ) : data.workspaces.length === 0 ? (
            <p className="empty">{tr('No workspaces yet. Make one for your team, then invite people.')}</p>
          ) : list.length === 0 ? (
            invitations.length === 0 && <p className="empty">{tr('No workspaces match.')}</p>
          ) : (
            <>
              <h3 className="section-label">{tr('Your workspaces')}</h3>
              <ul className="people">
                {list.map((w) => (
                  <li key={w.id}>
                    <button className="more-row" onClick={() => onOpen(w.id)}>
                      <Icon name="team" />
                      <span className="person-main">
                        <span className="person-name">{w.name}</span>
                        <span className="task-meta">
                          {label(w.role)} · {w.member_count} {w.member_count === 1 ? 'member' : 'members'}
                        </span>
                      </span>
                      {w.unread > 0 && (
                        <span className="nav-badge" aria-label={tr('{unread} new', { unread: w.unread })}>
                          {w.unread}
                        </span>
                      )}
                      <Icon name="chevron" className="more-go" />
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>

      {creating && (
        <ConfirmAction
          icon={null}
          title={tr('New workspace')}
          confirmLabel={tr('Create')}
          confirmDisabled={!name.trim()}
          onCancel={() => setCreating(false)}
          onConfirm={async () => {
            try {
              const created = await api.create(name)
              setCreating(false)
              onChanged()
              onOpen(created.id)
            } catch (err) {
              throw new Error(fieldError(err, 'name'), { cause: err })
            }
          }}
        >
          <label className="field-group" style={leftField}>
            <span className="label">{tr('Name')}</span>
            <input data-autofocus className="field" maxLength={80} autoComplete="off" value={name} placeholder={tr('Dev Team')} onChange={(e) => setName(e.target.value)} />
          </label>
        </ConfirmAction>
      )}
    </div>
  )
}

const ROLE_RULES: { action: string; allowed: Role[] }[] = [
  { action: tr('Read everything'), allowed: ['owner', 'admin', 'editor', 'commenter', 'viewer'] },
  { action: tr('Comment'), allowed: ['owner', 'admin', 'editor', 'commenter'] },
  { action: tr('Create and edit'), allowed: ['owner', 'admin', 'editor'] },
  { action: tr('Invite people, change roles'), allowed: ['owner', 'admin'] },
  { action: tr('Delete the workspace'), allowed: ['owner'] },
]
const ALL_ROLES: Role[] = ['owner', 'admin', 'editor', 'commenter', 'viewer']

type Dialog = { kind: 'remove'; member: Member } | { kind: 'transfer' | 'leave' | 'delete' | 'invite' | 'rename' | 'new-item' }

/** A page or table, as the workspace's list and the sidebar show it. */
export interface WorkspaceItem {
  kind: 'page' | 'table'
  id: number
  title: string
  updated_at: string
  updated_by: string | null
}

const newestFirst = (a: WorkspaceItem, b: WorkspaceItem) => b.updated_at.localeCompare(a.updated_at)

interface DetailProps {
  id: number
  myId: number
  now: Date
  /** Which child page is open. */
  section: WorkspaceSection | 'page' | 'table'
  pageId?: number
  tableId?: number
  rowId?: number
  notify: (title: string, detail?: string) => void
  showToast: (toast: Omit<ToastData, 'id'>) => void
  onOpenSection: (section: WorkspaceSection, options?: { replace?: boolean }) => void
  onOpenPage: (pageId: number) => void
  onOpenTable: (tableId: number) => void
  /** Close a row that was opened from a link, back to its table. */
  onRowClosed: (tableId: number) => void
  onOpenUrl: (url: string) => void
  /** The list of pages and tables, for the sidebar. */
  onItems: (workspaceId: number, items: WorkspaceItem[]) => void
  onTasksChanged: () => void
  onChanged: () => void
  /** It was deleted, or you're no longer in it. */
  onGone: () => void
}

/** One workspace and its child pages: home, members, settings and roles. */
export function WorkspacePage({ id, myId, now, section, pageId, tableId, rowId, notify, showToast, onOpenSection, onOpenPage, onOpenTable, onRowClosed, onOpenUrl, onItems, onTasksChanged, onChanged, onGone }: DetailProps) {
  const [data, setData] = useState<WorkspaceDetail | null>(null)
  const [items, setItems] = useState<WorkspaceItem[] | null>(null)
  const [itemQuery, setItemQuery] = useState('')
  const [newKind, setNewKind] = useState<WorkspaceItem['kind'] | 'excel'>('page')
  const [importPlan, setImportPlan] = useState<ImportPlan | null>(null)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [query, setQuery] = useState('')
  const [text, setText] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [newOwner, setNewOwner] = useState('')
  const pageRef = useRef<HTMLDivElement>(null)
  useEnterOnChange(pageRef, `${section}-${pageId ?? tableId ?? ''}`)

  const load = useCallback(async () => {
    try {
      const [detail, pages, tables] = await Promise.all([api.get(id), api.pages(id), api.tables(id)])
      setData(detail)
      setItems(
        [
          ...pages.map((p): WorkspaceItem => ({ kind: 'page', id: p.id, title: p.title, updated_at: p.updated_at, updated_by: p.updated_by })),
          ...tables.map((t): WorkspaceItem => ({ kind: 'table', id: t.id, title: t.title, updated_at: t.updated_at, updated_by: t.updated_by })),
        ].sort(newestFirst),
      )
      setError('')
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) onGone()
      else setError(errorMessage(err))
    }
  }, [id, onGone])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])
  useLiveRefresh(load, 15_000)

  useEffect(() => {
    if (items) onItems(id, items)
  }, [id, items, onItems])

  // A save moves it to the top of the list, with its new name.
  const itemSaved = useCallback((kind: WorkspaceItem['kind'], saved: TeamPage | TeamTable) => {
    const item: WorkspaceItem = { kind, id: saved.id, title: saved.title, updated_at: saved.updated_at, updated_by: saved.updated_by }
    setItems((list) => [item, ...(list ?? []).filter((i) => i.kind !== kind || i.id !== saved.id)].sort(newestFirst))
  }, [])
  const pageSaved = useCallback((page: TeamPage) => itemSaved('page', page), [itemSaved])
  const tableSaved = useCallback((table: TeamTable) => itemSaved('table', table), [itemSaved])

  const closeLinkedRow = useCallback(() => {
    if (tableId) onRowClosed(tableId)
  }, [tableId, onRowClosed])

  const tableGone = useCallback(() => {
    notify(tr('That table was deleted'))
    onOpenSection('home', { replace: true })
    void load()
  }, [notify, onOpenSection, load])

  const tableDeleted = useCallback(
    (table: TeamTable) => {
      setItems((list) => list?.filter((i) => i.kind !== 'table' || i.id !== table.id) ?? null)
      onOpenSection('home', { replace: true })
      showToast({
        title: tr('Table deleted'),
        detail: table.title,
        action: {
          label: tr('Undo'),
          onClick: () => {
            api.restoreTable(id, table.id).then(
              () => void load(),
              (err: unknown) => notify(tr('Couldn\'t bring it back'), errorMessage(err)),
            )
          },
        },
      })
    },
    [id, load, notify, onOpenSection, showToast],
  )

  const pageGone = useCallback(() => {
    notify(tr('That page was deleted'))
    onOpenSection('home', { replace: true })
    void load()
  }, [notify, onOpenSection, load])

  const pageDeleted = useCallback(
    (page: TeamPage) => {
      setItems((list) => list?.filter((i) => i.kind !== 'page' || i.id !== page.id) ?? null)
      onOpenSection('home', { replace: true })
      showToast({
        title: tr('Page deleted'),
        detail: page.title,
        action: {
          label: tr('Undo'),
          onClick: () => {
            api.restorePage(id, page.id).then(
              () => void load(),
              (err: unknown) => notify(tr('Couldn\'t bring it back'), errorMessage(err)),
            )
          },
        },
      })
    },
    [id, load, notify, onOpenSection, showToast],
  )

  async function changeRole(member: Member, next: Role) {
    try {
      setData(await api.setRole(id, member.id, next))
    } catch (err) {
      notify(tr('Couldn\'t change their role'), errorMessage(err))
      void load()
    }
  }

  async function copyInvite(link: string) {
    if (await copyText(link)) notify(tr('Link copied'), tr('Anyone with it can view this workspace until the invitation ends.'))
    else notify(tr('Couldn\'t copy the link'))
  }

  async function cancelInvite(invitationId: number) {
    try {
      await api.cancelInvitation(id, invitationId)
      await load()
    } catch (err) {
      notify(tr('Couldn\'t cancel it'), errorMessage(err))
    }
  }

  if (!data) {
    return (
      <div ref={pageRef} className="panel-page">
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="text-btn" onClick={() => void load()}>
              {tr('Retry')}
            </button>
          </div>
        )}
        <Loading active={!error} skeleton={<CardsSkeleton />} onRetry={() => void load()} />
      </div>
    )
  }

  const manage = data.can.manage_members
  const iAmOwner = data.role === 'owner'
  const canChange = (m: Member) => manage && m.role !== 'owner' && (iAmOwner || m.role !== 'admin')
  // Admins can't hand out admin; the server refuses it too.
  const choices = (current?: Role) => data.assignable_roles.filter((r) => iAmOwner || r !== 'admin' || r === current)
  const q = query.trim().replace(/^@/, '').toLowerCase()
  const members = data.members.filter((m) => `${m.full_name} ${m.username}`.toLowerCase().includes(q))
  const others = data.members.filter((m) => m.id !== myId)
  const itemFilter = itemQuery.trim().toLowerCase()
  const shownItems = items?.filter((i) => i.title.toLowerCase().includes(itemFilter)) ?? []

  const openInvite = () => {
    setText('')
    setRole('editor')
    setDialog({ kind: 'invite' })
  }

  // Everything in the workspace, as plain rows. Beside an open page on wide screens.
  const itemsPanel = (
    <section className="card glass panel items-panel" aria-label={data.name}>
      <div className="panel-top">
        <SearchField label={tr('Search this workspace')} placeholder={tr('Search')} value={itemQuery} onChange={setItemQuery} />
        {data.can.edit && (
          <button
            className="primary-btn icon-only"
            aria-label={tr('New page or table')}
            onClick={() => {
              setText('')
              setNewKind('table')
              setDialog({ kind: 'new-item' })
            }}
          >
            <Icon name="plus" />
          </button>
        )}
      </div>
      <div className="panel-scroll">
        {items?.length === 0 && <p className="empty">{data.can.edit ? tr('Nothing here yet. Press + and name your first table or page.') : tr('Nothing here yet.')}</p>}
        {Boolean(items?.length) && shownItems.length === 0 && <p className="empty">{tr('Nothing matches.')}</p>}
        <ul className="row-list">
          {shownItems.map((item) => (
            <li key={`${item.kind}-${item.id}`}>
              <button className="flat-row" aria-current={section === 'page' && item.kind === 'page' && item.id === pageId ? 'true' : undefined} onClick={() => (item.kind === 'table' ? onOpenTable(item.id) : onOpenPage(item.id))}>
                <span className={`well${item.kind === 'page' ? ' violet' : ''}`}>
                  <Icon name={item.kind} />
                </span>
                <span className="row-main">
                  <span className="person-name">{item.title}</span>
                  <span className="row-sub">
                    {item.kind === 'page' ? tr('Page') : tr('Table')} {tr('· edited')}{' '}{timeAgo(item.updated_at, now).toLowerCase()}
                    {item.updated_by && tr(' by {updated_by}', { updated_by: item.updated_by })}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <h3 className="section-label">{tr('Team')}</h3>
        <ul className="row-list">
          <li>
            <button className="flat-row" onClick={() => onOpenSection('members')}>
              <span className="well quiet">
                <Icon name="users" />
              </span>
              <span className="row-main">
                <span className="person-name">{tr('Members')}</span>
                <span className="row-sub">{tr('{length} in this workspace', { length: data.members.length })}</span>
              </span>
              <Icon name="chevron" className="more-go" />
            </button>
          </li>
          <li>
            <button className="flat-row" onClick={() => onOpenSection('activity')}>
              <span className="well quiet">
                <Icon name="list" />
              </span>
              <span className="row-main person-name">{tr('Activity')}</span>
              <Icon name="chevron" className="more-go" />
            </button>
          </li>
          <li>
            <button className="flat-row" onClick={() => onOpenSection('settings')}>
              <span className="well quiet">
                <Icon name="menu" />
              </span>
              <span className="row-main">
                <span className="person-name">{tr('Workspace settings')}</span>
                <span className="row-sub">{tr('You:')}{' '}{label(data.role)}</span>
              </span>
              <Icon name="chevron" className="more-go" />
            </button>
          </li>
        </ul>
      </div>
    </section>
  )

  return (
    <div ref={pageRef} className={`panel-page${section === 'table' || section === 'page' ? ' wide' : ''}`}>
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
        </div>
      )}

      {section === 'activity' && (
        <ActivityScreen workspaceId={id} userId={myId} members={data.members} now={now} onOpen={onOpenUrl} />
      )}

      {section === 'home' && itemsPanel}

      {section === 'page' && pageId && (
        <div className="page-split">
          <div className="page-grid">
            {itemsPanel}
            <PageEditor key={pageId} workspaceId={id} pageId={pageId} userId={myId} canEdit={data.can.edit} canComment={data.can.comment} members={data.members} now={now} onSaved={pageSaved} onDeleted={pageDeleted} onGone={pageGone} />
          </div>
        </div>
      )}

      {section === 'table' && tableId && (
        <TableView
          key={tableId}
          workspaceId={id}
          tableId={tableId}
          userId={myId}
          canEdit={data.can.edit}
          canComment={data.can.comment}
          now={now}
          rowId={rowId}
          onRowClosed={closeLinkedRow}
          members={data.members}
          notify={notify}
          showToast={showToast}
          onSaved={tableSaved}
          onDeleted={tableDeleted}
          onGone={tableGone}
          onTasksChanged={onTasksChanged}
        />
      )}

      {section === 'members' && (
        <section className="card glass panel" aria-label={tr('Members')}>
          <div className="panel-top">
            <SearchField label={tr('Search members')} placeholder={tr('Search members')} value={query} onChange={setQuery} />
            {manage && (
              <button className="primary-btn" onClick={openInvite}>
                {tr('Invite')}
              </button>
            )}
          </div>
          <div className="panel-scroll">
            {manage && data.invitations.length > 0 && (
              <>
                <h3 className="section-label">{tr('Waiting to accept')}</h3>
                <ul className="people">
                  {data.invitations.map((i) => (
                    <li key={i.id} className="person">
                      <span className="person-main">
                        <span className="person-name">{i.label}</span>
                        <span className="task-meta">{tr('Invited as')}{' '}{label(i.role)}</span>
                      </span>
                      <span className="person-actions">
                        <button className="icon-btn" aria-label={tr('Copy link for {name}', { name: i.label })} title={tr('Copy link')} onClick={() => void copyInvite(i.guest_url)}>
                          <Icon name="link" />
                        </button>
                        <button className="text-btn" onClick={() => void cancelInvite(i.id)}>
                          {tr('Cancel')}
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h3 className="section-label">{tr('Members')}</h3>
            {members.length === 0 && <p className="empty">{tr('No members match.')}</p>}
            <ul className="people member-rows">
              {members.map((m) => (
                <li key={m.id} className="person">
                  <span className="avatar" aria-hidden="true">
                    {initials({ full_name: m.full_name, email: m.username })}
                  </span>
                  <span className="person-main">
                    <span className="person-name">
                      {nameOf(m)}
                      {m.id === myId && tr(' (you)')}
                    </span>
                    <span className="task-meta">@{m.username}</span>
                  </span>
                  <span className="person-actions">
                    {canChange(m) ? (
                      <select className="field small role-select" aria-label={tr('Role for {value}', { value: nameOf(m) })} value={m.role} onChange={(e) => void changeRole(m, e.target.value as Role)}>
                        {choices(m.role).map((r) => (
                          <option key={r} value={r}>
                            {label(r)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="role-pill">{label(m.role)}</span>
                    )}
                    {canChange(m) && m.id !== myId && (
                      <button className="icon-btn" aria-label={tr('Remove {value}', { value: nameOf(m) })} onClick={() => setDialog({ kind: 'remove', member: m })}>
                        <Icon name="x" />
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      {section === 'settings' && (
        <section className="card glass" aria-label={tr('Workspace settings')}>
          <div className="panel-rows">
            {data.can.rename && (
              <button
                className="more-row"
                onClick={() => {
                  setText(data.name)
                  setDialog({ kind: 'rename' })
                }}
              >
                <span className="person-name">{tr('Name')}</span>
                <span className="row-value">{data.name}</span>
                <Icon name="chevron" className="more-go" />
              </button>
            )}
            <button className="more-row" onClick={() => onOpenSection('roles')}>
              <span className="person-name">{tr('What each role can do')}</span>
              <Icon name="chevron" className="more-go" />
            </button>
            {data.can.transfer && others.length > 0 && (
              <button
                className="more-row"
                onClick={() => {
                  setNewOwner('')
                  setDialog({ kind: 'transfer' })
                }}
              >
                <span className="person-name">{tr('Transfer ownership')}</span>
                <Icon name="chevron" className="more-go" />
              </button>
            )}
            {iAmOwner ? (
              <button className="more-row danger-row" onClick={() => setDialog({ kind: 'delete' })}>
                <span className="person-name">{tr('Delete workspace')}</span>
              </button>
            ) : (
              <button className="more-row danger-row" onClick={() => setDialog({ kind: 'leave' })}>
                <span className="person-name">{tr('Leave workspace')}</span>
              </button>
            )}
          </div>
        </section>
      )}

      {section === 'roles' && (
        <section className="card glass" aria-label={tr('What each role can do')}>
          <div className="role-table-box">
            <table className="role-table">
              <thead>
                <tr>
                  <th scope="col">{tr('Action')}</th>
                  {ALL_ROLES.map((r) => (
                    <th key={r} scope="col" className={r === data.role ? 'mine' : undefined}>
                      {label(r)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROLE_RULES.map((rule) => (
                  <tr key={rule.action}>
                    <th scope="row">{rule.action}</th>
                    {ALL_ROLES.map((r) => (
                      <td key={r} className={r === data.role ? 'mine' : undefined}>
                        {rule.allowed.includes(r) ? <Icon name="check" /> : <span className="sr-only">{tr('No')}</span>}
                        {rule.allowed.includes(r) && <span className="sr-only">{tr('Yes')}</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {dialog?.kind === 'new-item' && (
        <ConfirmAction
          icon={null}
          title={tr('New in {name}', { name: data.name })}
          confirmLabel={tr('Create')}
          confirmDisabled={!text.trim() || (newKind === 'excel' && (!importPlan || Boolean(importPlan.problem)))}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            try {
              if (newKind === 'excel' && importPlan) {
                const table = await api.importTable(id, text, importPlan)
                setDialog(null)
                tableSaved(table)
                onOpenTable(table.id)
              } else if (newKind === 'table') {
                const table = await api.createTable(id, text)
                setDialog(null)
                tableSaved(table)
                onOpenTable(table.id)
              } else {
                const page = await api.createPage(id, text)
                setDialog(null)
                pageSaved(page)
                onOpenPage(page.id)
              }
            } catch (err) {
              throw new Error(fieldError(err, 'title'), { cause: err })
            }
          }}
        >
          <div className="chips" role="group" aria-label={tr('What to make')} style={{ justifyContent: 'center' }}>
            <button type="button" className="chip" aria-pressed={newKind === 'table'} onClick={() => setNewKind('table')}>
              {tr('Table')}
            </button>
            <button type="button" className="chip" aria-pressed={newKind === 'page'} onClick={() => setNewKind('page')}>
              {tr('Page')}
            </button>
            <button type="button" className="chip" aria-pressed={newKind === 'excel'} onClick={() => setNewKind('excel')}>
              {tr('Excel')}
            </button>
          </div>
          {newKind === 'excel' && <ImportFile onPlan={setImportPlan} onTitle={setText} />}
          <label className="field-group" style={leftField}>
            <span className="label">{tr('Title')}</span>
            <input data-autofocus className="field" maxLength={120} autoComplete="off" value={text} placeholder={newKind === 'table' ? tr('Sprint 12 testing') : tr('Release plan')} onChange={(e) => setText(e.target.value)} />
          </label>
        </ConfirmAction>
      )}
      {dialog?.kind === 'invite' && (
        <ConfirmAction
          icon={null}
          title={tr('Invite someone')}
          confirmLabel={tr('Send invitation')}
          confirmDisabled={!text.trim()}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            try {
              setData(await api.invite(id, text, role))
              notify(tr('Invitation sent'), text.trim())
              setDialog(null)
            } catch (err) {
              throw new Error(fieldError(err, 'invitee'), { cause: err })
            }
          }}
        >
          <div className="field-group" style={leftField}>
            <span className="label">{tr('@username or email')}</span>
            <InviteField value={text} onChange={setText} members={data.members} invited={data.invitations.map((i) => i.label)} />
          </div>
          <label className="field-group" style={leftField}>
            <span className="label">{tr('Role')}</span>
            <select className="field" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {choices().map((r) => (
                <option key={r} value={r}>
                  {label(r)}
                </option>
              ))}
            </select>
          </label>
          <p className="guest-note" style={leftField}>{tr('No account? They can view this workspace from the email until they join.')}</p>
        </ConfirmAction>
      )}
      {dialog?.kind === 'rename' && (
        <ConfirmAction
          icon={null}
          title={tr('Rename workspace')}
          confirmLabel={tr('Save')}
          confirmDisabled={!text.trim()}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            try {
              setData(await api.rename(id, text))
              setDialog(null)
              onChanged()
            } catch (err) {
              throw new Error(fieldError(err, 'name'), { cause: err })
            }
          }}
        >
          <label className="field-group" style={leftField}>
            <span className="label">{tr('Name')}</span>
            <input data-autofocus className="field" maxLength={80} autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        </ConfirmAction>
      )}
      {dialog?.kind === 'remove' && (
        <ConfirmAction
          danger
          icon="users"
          title={tr('Remove {value}?', { value: nameOf(dialog.member) })}
          confirmLabel={tr('Remove')}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            await api.removeMember(id, dialog.member.id)
            setDialog(null)
            await load()
            onChanged()
          }}
        >
          <p>{tr('They\'ll lose access to {name}. You can invite them again later.', { name: data.name })}</p>
        </ConfirmAction>
      )}
      {dialog?.kind === 'transfer' && (
        <ConfirmAction
          icon="shield"
          title={tr('Transfer ownership?')}
          confirmLabel={tr('Transfer ownership')}
          confirmDisabled={!newOwner}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            setData(await api.transfer(id, Number(newOwner)))
            setDialog(null)
            onChanged()
          }}
        >
          <p>{tr('They\'ll be able to delete this workspace. You\'ll become an admin, and only they could make you owner again.')}</p>
          <label className="field-group" style={leftField}>
            <span className="label">{tr('New owner')}</span>
            <select data-autofocus className="field" value={newOwner} onChange={(e) => setNewOwner(e.target.value)}>
              <option value="">{tr('Choose a member…')}</option>
              {others.map((m) => (
                <option key={m.id} value={m.id}>
                  {nameOf(m)} (@{m.username})
                </option>
              ))}
            </select>
          </label>
        </ConfirmAction>
      )}
      {dialog?.kind === 'leave' && (
        <ConfirmAction
          danger
          icon="logout"
          title={tr('Leave {name}?', { name: data.name })}
          confirmLabel={tr('Leave')}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            await api.removeMember(id, myId)
            setDialog(null)
            onChanged()
            onGone()
          }}
        >
          <p>{tr('You\'ll lose access until someone invites you again.')}</p>
        </ConfirmAction>
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmAction
          danger
          icon="trash"
          title={tr('Delete {name}?', { name: data.name })}
          confirmLabel={tr('Delete workspace')}
          typeToConfirm={data.name}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            await api.remove(id, data.name)
            setDialog(null)
            onChanged()
            onGone()
          }}
        >
          <p>{tr('All {length} members lose access right away.', { length: data.members.length })}</p>
        </ConfirmAction>
      )}
    </div>
  )
}
