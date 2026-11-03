import { useCallback, useEffect, useState } from 'react'
import { ApiError, workspaces as api, type Member, type Role, type WorkspaceDetail, type WorkspaceList } from '../api'
import { ConfirmAction } from '../components/ConfirmAction'
import { CardsSkeleton, Loading, SkeletonRows } from '../components/Loading'
import { Icon } from '../icons'
import { useLiveRefresh } from '../live'
import { initials } from '../user'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
const fieldError = (err: unknown, field: string) => (err instanceof ApiError && err.fields[field]?.join(' ')) || errorMessage(err)
const label = (role: string) => role[0].toUpperCase() + role.slice(1)
const nameOf = (m: Member) => m.full_name || `@${m.username}`

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
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  async function create(e: React.FormEvent) {
    e.preventDefault()
    setBusy('create')
    setNameError('')
    try {
      const created = await api.create(name)
      setName('')
      onChanged()
      onOpen(created.id)
    } catch (err) {
      setNameError(fieldError(err, 'name'))
    } finally {
      setBusy(null)
    }
  }

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

  return (
    <div className="ws-page">
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button className="text-btn" onClick={onRetry}>
            Retry
          </button>
        </div>
      )}

      {data && data.invitations.length > 0 && (
        <section className="card glass" aria-labelledby="ws-invites-h">
          <h2 id="ws-invites-h">Invitations</h2>
          <ul className="people">
            {data.invitations.map((invite) => (
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
        </section>
      )}

      <section className="card glass" aria-labelledby="ws-list-h">
        <h2 id="ws-list-h">Your workspaces</h2>
        {data === null ? (
          <Loading active={!error} skeleton={<SkeletonRows count={3} />} onRetry={onRetry} />
        ) : data.workspaces.length === 0 ? (
          <p className="empty">No workspaces yet. Make one for your team, then invite people.</p>
        ) : (
          <ul className="people">
            {data.workspaces.map((w) => (
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
        )}
      </section>

      <form className="card glass" onSubmit={create} aria-labelledby="ws-new-h" noValidate>
        <h2 id="ws-new-h">New workspace</h2>
        <label className="field-group">
          <span className="label">Name</span>
          <input
            className="field"
            maxLength={80}
            value={name}
            placeholder="Dev Team"
            aria-invalid={Boolean(nameError)}
            onChange={(e) => {
              setName(e.target.value)
              setNameError('')
            }}
          />
          {nameError && <span className="field-error">{nameError}</span>}
        </label>
        <button className="primary-btn" type="submit" disabled={busy !== null || !name.trim()}>
          Create workspace
        </button>
      </form>
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

type Dialog = { kind: 'remove' | 'transfer'; member: Member } | { kind: 'leave' | 'delete' }

interface DetailProps {
  id: number
  myId: number
  notify: (title: string, detail?: string) => void
  onChanged: () => void
  /** It was deleted, or you're no longer in it. */
  onGone: () => void
}

/** One workspace: who's in it, what they can do, and managing it. */
export function WorkspacePage({ id, myId, notify, onChanged, onGone }: DetailProps) {
  const [data, setData] = useState<WorkspaceDetail | null>(null)
  const [error, setError] = useState('')
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [invitee, setInvitee] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [inviteError, setInviteError] = useState('')
  const [inviting, setInviting] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api.get(id))
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

  async function invite(e: React.FormEvent) {
    e.preventDefault()
    setInviting(true)
    setInviteError('')
    try {
      setData(await api.invite(id, invitee, role))
      notify('Invitation sent', invitee.trim())
      setInvitee('')
    } catch (err) {
      setInviteError(fieldError(err, 'invitee'))
    } finally {
      setInviting(false)
    }
  }

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

  async function saveName(e: React.FormEvent) {
    e.preventDefault()
    if (renaming === null) return
    try {
      setData(await api.rename(id, renaming))
      setRenaming(null)
      onChanged()
    } catch (err) {
      notify("Couldn't rename it", fieldError(err, 'name'))
    }
  }

  if (!data) {
    return (
      <div className="ws-page">
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

  return (
    <div className="ws-page">
      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
        </div>
      )}

      <section className="card glass" aria-labelledby="ws-members-h">
        <div className="section-head">
          <h2 id="ws-members-h">
            <Icon name="users" /> {data.members.length} {data.members.length === 1 ? 'member' : 'members'}
          </h2>
          <span className="count-pill">You: {label(data.role)}</span>
        </div>
        <ul className="people">
          {data.members.map((m) => (
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
      </section>

      {manage && (
        <section className="card glass" aria-labelledby="ws-invite-h">
          <h2 id="ws-invite-h">Invite someone</h2>
          <form className="invite-form" onSubmit={invite} noValidate>
            <label className="field-group invite-who">
              <span className="label">@username or email</span>
              <input
                className="field"
                value={invitee}
                placeholder="@username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={Boolean(inviteError)}
                onChange={(e) => {
                  setInvitee(e.target.value)
                  setInviteError('')
                }}
              />
            </label>
            <label className="field-group">
              <span className="label">Role</span>
              <select className="field" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {choices().map((r) => (
                  <option key={r} value={r}>
                    {label(r)}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary-btn" type="submit" disabled={inviting || !invitee.trim()}>
              <Icon name="send" />
              {inviting ? 'Sending…' : 'Invite'}
            </button>
          </form>
          {inviteError && (
            <span className="field-error" role="alert">
              {inviteError}
            </span>
          )}
          {data.invitations.length > 0 && (
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
        </section>
      )}

      <section className="card glass" aria-labelledby="ws-roles-h">
        <h2 id="ws-roles-h">What each role can do</h2>
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

      <section className="card glass" aria-labelledby="ws-settings-h">
        <h2 id="ws-settings-h">Workspace settings</h2>
        {data.can.rename &&
          (renaming === null ? (
            <button className="row-btn" onClick={() => setRenaming(data.name)}>
              Rename workspace
            </button>
          ) : (
            <form className="invite-form" onSubmit={saveName}>
              <label className="field-group invite-who">
                <span className="label">Name</span>
                <input className="field" maxLength={80} autoFocus value={renaming} onChange={(e) => setRenaming(e.target.value)} />
              </label>
              <button className="text-btn" type="button" onClick={() => setRenaming(null)}>
                Cancel
              </button>
              <button className="primary-btn" type="submit" disabled={!renaming.trim()}>
                Save
              </button>
            </form>
          ))}
        {data.can.transfer && data.members.length > 1 && (
          <label className="field-group">
            <span className="label">Transfer ownership to</span>
            <select
              className="field"
              value=""
              onChange={(e) => {
                const member = data.members.find((m) => m.id === Number(e.target.value))
                if (member) setDialog({ kind: 'transfer', member })
              }}
            >
              <option value="">Choose a member…</option>
              {data.members
                .filter((m) => m.id !== myId)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {nameOf(m)} (@{m.username})
                  </option>
                ))}
            </select>
          </label>
        )}
        {iAmOwner ? (
          <button className="row-btn danger-text" onClick={() => setDialog({ kind: 'delete' })}>
            Delete workspace
          </button>
        ) : (
          <button className="row-btn danger-text" onClick={() => setDialog({ kind: 'leave' })}>
            Leave workspace
          </button>
        )}
      </section>

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
          title={`Make ${nameOf(dialog.member)} the owner?`}
          confirmLabel="Transfer ownership"
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            setData(await api.transfer(id, dialog.member.id))
            setDialog(null)
            onChanged()
          }}
        >
          <p>They'll be able to delete this workspace. You'll become an admin, and only they could make you owner again.</p>
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
