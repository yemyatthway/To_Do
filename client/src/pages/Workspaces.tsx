import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, workspaces as api, type Member, type TeamPage, type TeamPageSummary, type Role, type WorkspaceDetail, type WorkspaceList } from '../api'
import { ConfirmAction } from '../components/ConfirmAction'
import { CardsSkeleton, Loading, SkeletonRows } from '../components/Loading'
import { PageEditor } from '../components/PageEditor'
import { SearchField } from '../components/SearchField'
import type { ToastData } from '../components/Toast'
import { Icon } from '../icons'
import { useLiveRefresh } from '../live'
import { useEnterOnChange } from '../motion'
import type { WorkspaceSection } from '../routes'
import { initials, timeAgo } from '../user'

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
        notify(`You joined ${joined.name}`)
        onOpen(joined.id)
      } else {
        await api.decline(id)
      }
      onChanged()
    } catch (err) {
      notify("That didn't work", errorMessage(err))
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
            Retry
          </button>
        </div>
      )}

      <section className="card glass panel" aria-label="Workspaces">
        <div className="panel-top">
          <SearchField label="Search workspaces" placeholder="Search workspaces" value={query} onChange={setQuery} />
          <button
            className="primary-btn"
            onClick={() => {
              setName('')
              setCreating(true)
            }}
          >
            <Icon name="plus" />
            New
          </button>
        </div>

        <div className="panel-scroll">
          {invitations.length > 0 && (
            <>
              <h3 className="section-label">Invitations</h3>
              <ul className="people">
                {invitations.map((invite) => (
                  <li key={invite.id} className="person">
                    <span className="person-main">
                      <span className="person-name">{invite.workspace}</span>
                      <span className="task-meta">
                        {invite.invited_by} invited you as {label(invite.role)}
                      </span>
                    </span>
                    <span className="person-actions">
                      <button className="primary-btn small-btn" disabled={busy !== null} onClick={() => answer(invite.id, true)}>
                        Accept
                      </button>
                      <button className="text-btn" disabled={busy !== null} onClick={() => answer(invite.id, false)}>
                        Decline
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
            <p className="empty">No workspaces yet. Make one for your team, then invite people.</p>
          ) : list.length === 0 ? (
            invitations.length === 0 && <p className="empty">No workspaces match.</p>
          ) : (
            <>
              <h3 className="section-label">Your workspaces</h3>
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
          icon="team"
          title="New workspace"
          confirmLabel="Create"
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
            <span className="label">Name</span>
            <input data-autofocus className="field" maxLength={80} value={name} placeholder="Dev Team" onChange={(e) => setName(e.target.value)} />
          </label>
        </ConfirmAction>
      )}
    </div>
  )
}

const ROLE_RULES: { action: string; allowed: Role[] }[] = [
  { action: 'Read everything', allowed: ['owner', 'admin', 'editor', 'commenter', 'viewer'] },
  { action: 'Comment', allowed: ['owner', 'admin', 'editor', 'commenter'] },
  { action: 'Create and edit', allowed: ['owner', 'admin', 'editor'] },
  { action: 'Invite people, change roles', allowed: ['owner', 'admin'] },
  { action: 'Delete the workspace', allowed: ['owner'] },
]
const ALL_ROLES: Role[] = ['owner', 'admin', 'editor', 'commenter', 'viewer']

type Dialog = { kind: 'remove'; member: Member } | { kind: 'transfer' | 'leave' | 'delete' | 'invite' | 'rename' | 'new-page' }

interface DetailProps {
  id: number
  myId: number
  now: Date
  /** Which child page is open. */
  section: WorkspaceSection | 'page'
  pageId?: number
  notify: (title: string, detail?: string) => void
  showToast: (toast: Omit<ToastData, 'id'>) => void
  onOpenSection: (section: WorkspaceSection, options?: { replace?: boolean }) => void
  onOpenPage: (pageId: number) => void
  /** The list of pages, for the sidebar. */
  onPages: (workspaceId: number, pages: TeamPageSummary[]) => void
  onChanged: () => void
  /** It was deleted, or you're no longer in it. */
  onGone: () => void
}

/** One workspace and its child pages: home, members, settings and roles. */
export function WorkspacePage({ id, myId, now, section, pageId, notify, showToast, onOpenSection, onOpenPage, onPages, onChanged, onGone }: DetailProps) {
  const [data, setData] = useState<WorkspaceDetail | null>(null)
  const [pages, setPages] = useState<TeamPageSummary[] | null>(null)
  const [pageQuery, setPageQuery] = useState('')
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [query, setQuery] = useState('')
  const [text, setText] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [newOwner, setNewOwner] = useState('')
  const pageRef = useRef<HTMLDivElement>(null)
  useEnterOnChange(pageRef, `${section}-${pageId ?? ''}`)

  const load = useCallback(async () => {
    try {
      const [detail, list] = await Promise.all([api.get(id), api.pages(id)])
      setData(detail)
      setPages(list)
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
    if (pages) onPages(id, pages)
  }, [id, pages, onPages])

  // A save moves the page to the top of the list, with its new name.
  const pageSaved = useCallback((page: TeamPage) => {
    const { blocks: _content, ...summary } = page
    setPages((list) => [summary, ...(list ?? []).filter((p) => p.id !== page.id)])
  }, [])

  const pageGone = useCallback(() => {
    notify('That page was deleted')
    onOpenSection('home', { replace: true })
    void load()
  }, [notify, onOpenSection, load])

  const pageDeleted = useCallback(
    (page: TeamPage) => {
      setPages((list) => list?.filter((p) => p.id !== page.id) ?? null)
      onOpenSection('home', { replace: true })
      showToast({
        title: 'Page deleted',
        detail: page.title,
        action: {
          label: 'Undo',
          onClick: () => {
            api.restorePage(id, page.id).then(
              () => void load(),
              (err: unknown) => notify("Couldn't bring it back", errorMessage(err)),
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
      notify("Couldn't change their role", errorMessage(err))
      void load()
    }
  }

  async function cancelInvite(invitationId: number) {
    try {
      await api.cancelInvitation(id, invitationId)
      await load()
    } catch (err) {
      notify("Couldn't cancel it", errorMessage(err))
    }
  }

  if (!data) {
    return (
      <div ref={pageRef} className="panel-page">
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="text-btn" onClick={() => void load()}>
              Retry
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
  const pageFilter = pageQuery.trim().toLowerCase()
  const shownPages = pages?.filter((p) => p.title.toLowerCase().includes(pageFilter)) ?? []

  const openInvite = () => {
    setText('')
    setRole('editor')
    setDialog({ kind: 'invite' })
  }

  return (
    <div ref={pageRef} className="panel-page">
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
        </div>
      )}

      {section === 'home' && (
        <section className="card glass panel" aria-label={data.name}>
          <div className="panel-top">
            <SearchField label="Search this workspace" placeholder="Search this workspace" value={pageQuery} onChange={setPageQuery} />
            {data.can.edit && (
              <button
                className="primary-btn"
                onClick={() => {
                  setText('')
                  setDialog({ kind: 'new-page' })
                }}
              >
                <Icon name="plus" />
                New
              </button>
            )}
          </div>
          <div className="panel-scroll">
            <h3 className="section-label">Pages</h3>
            {pages?.length === 0 && <p className="empty">{data.can.edit ? 'No pages yet. Press New and name your first one.' : 'No pages yet.'}</p>}
            {Boolean(pages?.length) && shownPages.length === 0 && <p className="empty">No pages match.</p>}
            <ul className="people">
              {shownPages.map((p) => (
                <li key={p.id}>
                  <button className="more-row" onClick={() => onOpenPage(p.id)}>
                    <Icon name="page" />
                    <span className="person-main">
                      <span className="person-name">{p.title}</span>
                      <span className="task-meta">
                        Edited {timeAgo(p.updated_at, now).toLowerCase()}
                        {p.updated_by && ` by ${p.updated_by}`}
                      </span>
                    </span>
                    <Icon name="chevron" className="more-go" />
                  </button>
                </li>
              ))}
            </ul>
            <h3 className="section-label">Manage</h3>
            <div className="panel-rows">
            <button className="more-row" onClick={() => onOpenSection('members')}>
              <Icon name="users" />
              <span className="person-name">Members</span>
              <span className="row-value">{data.members.length}</span>
              <Icon name="chevron" className="more-go" />
            </button>
            <button className="more-row" onClick={() => onOpenSection('settings')}>
              <Icon name="menu" />
              <span className="person-main">
                <span className="person-name">Workspace settings</span>
                <span className="task-meta">You: {label(data.role)}</span>
              </span>
              <Icon name="chevron" className="more-go" />
            </button>
            </div>
          </div>
        </section>
      )}

      {section === 'page' && pageId && (
        <PageEditor key={pageId} workspaceId={id} pageId={pageId} userId={myId} canEdit={data.can.edit} onSaved={pageSaved} onDeleted={pageDeleted} onGone={pageGone} />
      )}

      {section === 'members' && (
        <section className="card glass panel" aria-label="Members">
          <div className="panel-top">
            <SearchField label="Search members" placeholder="Search members" value={query} onChange={setQuery} />
            {manage && (
              <button className="primary-btn" onClick={openInvite}>
                Invite
              </button>
            )}
          </div>
          <div className="panel-scroll">
            {manage && data.invitations.length > 0 && (
              <>
                <h3 className="section-label">Waiting to accept</h3>
                <ul className="people">
                  {data.invitations.map((i) => (
                    <li key={i.id} className="person">
                      <span className="person-main">
                        <span className="person-name">{i.label}</span>
                        <span className="task-meta">Invited as {label(i.role)}</span>
                      </span>
                      <span className="person-actions">
                        <button className="text-btn" onClick={() => void cancelInvite(i.id)}>
                          Cancel
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <h3 className="section-label">Members</h3>
            {members.length === 0 && <p className="empty">No members match.</p>}
            <ul className="people member-rows">
              {members.map((m) => (
                <li key={m.id} className="person">
                  <span className="avatar" aria-hidden="true">
                    {initials({ full_name: m.full_name, email: m.username })}
                  </span>
                  <span className="person-main">
                    <span className="person-name">
                      {nameOf(m)}
                      {m.id === myId && ' (you)'}
                    </span>
                    <span className="task-meta">@{m.username}</span>
                  </span>
                  <span className="person-actions">
                    {canChange(m) ? (
                      <select className="field small role-select" aria-label={`Role for ${nameOf(m)}`} value={m.role} onChange={(e) => void changeRole(m, e.target.value as Role)}>
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
                      <button className="icon-btn" aria-label={`Remove ${nameOf(m)}`} onClick={() => setDialog({ kind: 'remove', member: m })}>
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
        <section className="card glass" aria-label="Workspace settings">
          <div className="panel-rows">
            {data.can.rename && (
              <button
                className="more-row"
                onClick={() => {
                  setText(data.name)
                  setDialog({ kind: 'rename' })
                }}
              >
                <span className="person-name">Name</span>
                <span className="row-value">{data.name}</span>
                <Icon name="chevron" className="more-go" />
              </button>
            )}
            <button className="more-row" onClick={() => onOpenSection('roles')}>
              <span className="person-name">What each role can do</span>
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
                <span className="person-name">Transfer ownership</span>
                <Icon name="chevron" className="more-go" />
              </button>
            )}
            {iAmOwner ? (
              <button className="more-row danger-row" onClick={() => setDialog({ kind: 'delete' })}>
                <span className="person-name">Delete workspace</span>
              </button>
            ) : (
              <button className="more-row danger-row" onClick={() => setDialog({ kind: 'leave' })}>
                <span className="person-name">Leave workspace</span>
              </button>
            )}
          </div>
        </section>
      )}

      {section === 'roles' && (
        <section className="card glass" aria-label="What each role can do">
          <div className="role-table-box">
            <table className="role-table">
              <thead>
                <tr>
                  <th scope="col">Action</th>
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
                        {rule.allowed.includes(r) ? <Icon name="check" /> : <span className="sr-only">No</span>}
                        {rule.allowed.includes(r) && <span className="sr-only">Yes</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {dialog?.kind === 'new-page' && (
        <ConfirmAction
          icon="page"
          title={`New in ${data.name}`}
          confirmLabel="Create"
          confirmDisabled={!text.trim()}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            try {
              const page = await api.createPage(id, text)
              setDialog(null)
              pageSaved(page)
              onOpenPage(page.id)
            } catch (err) {
              throw new Error(fieldError(err, 'title'), { cause: err })
            }
          }}
        >
          <label className="field-group" style={leftField}>
            <span className="label">Name it anything</span>
            <input data-autofocus className="field" maxLength={120} value={text} placeholder="Release plan" onChange={(e) => setText(e.target.value)} />
          </label>
        </ConfirmAction>
      )}
      {dialog?.kind === 'invite' && (
        <ConfirmAction
          icon="send"
          title="Invite someone"
          confirmLabel="Send invitation"
          confirmDisabled={!text.trim()}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            try {
              setData(await api.invite(id, text, role))
              notify('Invitation sent', text.trim())
              setDialog(null)
            } catch (err) {
              throw new Error(fieldError(err, 'invitee'), { cause: err })
            }
          }}
        >
          <label className="field-group" style={leftField}>
            <span className="label">@username or email</span>
            <input data-autofocus className="field" value={text} placeholder="@username" autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setText(e.target.value)} />
          </label>
          <label className="field-group" style={leftField}>
            <span className="label">Role</span>
            <select className="field" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {choices().map((r) => (
                <option key={r} value={r}>
                  {label(r)}
                </option>
              ))}
            </select>
          </label>
        </ConfirmAction>
      )}
      {dialog?.kind === 'rename' && (
        <ConfirmAction
          icon="team"
          title="Rename workspace"
          confirmLabel="Save"
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
            <span className="label">Name</span>
            <input data-autofocus className="field" maxLength={80} value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        </ConfirmAction>
      )}
      {dialog?.kind === 'remove' && (
        <ConfirmAction
          danger
          icon="users"
          title={`Remove ${nameOf(dialog.member)}?`}
          confirmLabel="Remove"
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            await api.removeMember(id, dialog.member.id)
            setDialog(null)
            await load()
            onChanged()
          }}
        >
          <p>They'll lose access to {data.name}. You can invite them again later.</p>
        </ConfirmAction>
      )}
      {dialog?.kind === 'transfer' && (
        <ConfirmAction
          icon="shield"
          title="Transfer ownership?"
          confirmLabel="Transfer ownership"
          confirmDisabled={!newOwner}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            setData(await api.transfer(id, Number(newOwner)))
            setDialog(null)
            onChanged()
          }}
        >
          <p>They'll be able to delete this workspace. You'll become an admin, and only they could make you owner again.</p>
          <label className="field-group" style={leftField}>
            <span className="label">New owner</span>
            <select data-autofocus className="field" value={newOwner} onChange={(e) => setNewOwner(e.target.value)}>
              <option value="">Choose a member…</option>
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
          title={`Leave ${data.name}?`}
          confirmLabel="Leave"
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            await api.removeMember(id, myId)
            setDialog(null)
            onChanged()
            onGone()
          }}
        >
          <p>You'll lose access until someone invites you again.</p>
        </ConfirmAction>
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmAction
          danger
          icon="trash"
          title={`Delete ${data.name}?`}
          confirmLabel="Delete workspace"
          typeToConfirm={data.name}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            await api.remove(id, data.name)
            setDialog(null)
            onChanged()
            onGone()
          }}
        >
          <p>All {data.members.length} members lose access right away.</p>
        </ConfirmAction>
      )}
    </div>
  )
}
