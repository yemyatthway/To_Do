import { useState } from 'react'
import { chat, type Chat, type GroupMember, type Person } from '../api'
import { tr } from '../i18n'
import { Icon } from '../icons'
import { handle, initials } from '../user'
import { ConfirmAction } from './ConfirmAction'
import { SearchField } from './SearchField'
import { Sheet } from './Sheet'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
const nameOf = (person: Person) => person.full_name || `@${person.username}`
const matches = (person: Person, search: string) => `${person.full_name} ${person.username}`.toLowerCase().includes(search.trim().replace(/^@/, '').toLowerCase())

/** Friends with a tick beside each: the one way of choosing people, for a new group or adding to one. */
function PeoplePicker({ people, chosen, onToggle }: { people: Person[]; chosen: ReadonlySet<number>; onToggle: (id: number) => void }) {
  const [search, setSearch] = useState('')
  const shown = people.filter((person) => matches(person, search))
  return (
    <>
      {people.length > 6 && <SearchField label={tr('Search friends')} placeholder={tr('Search friends')} value={search} onChange={setSearch} />}
      <ul className="group-people">
        {shown.map((person) => (
          <li key={person.id}>
            <label className="group-person">
              <input type="checkbox" className="sr-only" checked={chosen.has(person.id)} onChange={() => onToggle(person.id)} />
              <span className="avatar" aria-hidden="true">
                {initials(person)}
              </span>
              <span className="person-main">
                <span className="person-name">{nameOf(person)}</span>
                <span className="task-meta">{handle(person)}</span>
              </span>
              <span className={`check${chosen.has(person.id) ? ' on' : ''}`} aria-hidden="true">
                {chosen.has(person.id) && <Icon name="check" />}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </>
  )
}

const toggled = (set: ReadonlySet<number>, id: number) => {
  const next = new Set(set)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}

/** Start a group: an optional name and some friends. */
export function GroupDialog({ friends, onClose, onCreate }: { friends: Person[]; onClose: () => void; onCreate: (name: string, members: number[]) => Promise<void> }) {
  const [name, setName] = useState('')
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function create() {
    setBusy(true)
    setError('')
    try {
      await onCreate(name.trim(), [...chosen])
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <Sheet
      title={tr('New group')}
      onClose={onClose}
      foot={
        <button type="button" className="primary-btn" disabled={busy || !chosen.size} onClick={() => void create()}>
          {busy ? tr('One moment…') : tr('Create group')}
        </button>
      }
    >
      <input className="field" maxLength={80} aria-label={tr('Group name')} placeholder={tr('Group name (optional)')} value={name} onChange={(e) => setName(e.target.value)} />
      <PeoplePicker people={friends} chosen={chosen} onToggle={(id) => setChosen((set) => toggled(set, id))} />
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </Sheet>
  )
}

interface MembersSheetProps {
  chatId: number
  title: string
  members: GroupMember[]
  myId: number
  amAdmin: boolean
  friends: Person[]
  onClose: () => void
  onChanged: (chat?: Chat) => void
}

/** Who's in a group. Admins can also rename it, add friends and take people out. */
export function MembersSheet({ chatId, title, members, myId, amAdmin, friends, onClose, onChanged }: MembersSheetProps) {
  const [adding, setAdding] = useState(false)
  const [chosen, setChosen] = useState<ReadonlySet<number>>(new Set())
  const [name, setName] = useState(title)
  const [removing, setRemoving] = useState<GroupMember | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const addable = friends.filter((friend) => !members.some((member) => member.id === friend.id))

  async function run(action: () => Promise<Chat | void>) {
    setBusy(true)
    setError('')
    try {
      onChanged((await action()) ?? undefined)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (adding) {
    return (
      <Sheet
        title={tr('Add people')}
        onBack={() => setAdding(false)}
        onClose={onClose}
        foot={
          <button
            type="button"
            className="primary-btn"
            disabled={busy || !chosen.size}
            onClick={() =>
              void run(async () => {
                const next = await chat.addToGroup(chatId, [...chosen])
                setChosen(new Set())
                setAdding(false)
                return next
              })
            }
          >
            {busy ? tr('One moment…') : tr('Add')}
          </button>
        }
      >
        {addable.length ? <PeoplePicker people={addable} chosen={chosen} onToggle={(id) => setChosen((set) => toggled(set, id))} /> : <p className="hint">{tr('All your friends are already here.')}</p>}
        {error && (
          <span className="field-error" role="alert">
            {error}
          </span>
        )}
      </Sheet>
    )
  }

  return (
    <Sheet
      title={tr('{count} people', { count: members.length })}
      onClose={onClose}
      foot={
        amAdmin ? (
          <button type="button" className="primary-btn" onClick={() => setAdding(true)}>
            <Icon name="plus" />
            {tr('Add people')}
          </button>
        ) : (
          <button type="button" className="primary-btn" onClick={onClose}>
            {tr('Done')}
          </button>
        )
      }
    >
      {amAdmin && (
        <input
          className="field"
          maxLength={80}
          aria-label={tr('Group name')}
          placeholder={tr('Group name (optional)')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() !== title) void run(() => chat.renameGroup(chatId, name.trim()))
          }}
        />
      )}
      <ul className="group-people">
        {members.map((member) => (
          <li key={member.id}>
            <div className="group-person">
              <span className="avatar" aria-hidden="true">
                {initials(member)}
              </span>
              <span className="person-main">
                <span className="person-name">
                  {nameOf(member)}
                  {member.id === myId ? tr(' (you)') : ''}
                </span>
                <span className="task-meta">{handle(member)}</span>
              </span>
              {member.is_admin && <span className="group-person-role">{tr('Group admin')}</span>}
              {amAdmin && member.id !== myId && (
                <button type="button" className="icon-btn" aria-label={tr('Remove {value}', { value: nameOf(member) })} onClick={() => setRemoving(member)}>
                  <Icon name="x" />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
      {removing && (
        <ConfirmAction
          danger
          icon={null}
          title={tr('Remove {name}?', { name: nameOf(removing) })}
          confirmLabel={tr('Remove')}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await chat.removeFromGroup(chatId, removing.id)
            setRemoving(null)
            onChanged()
          }}
        >
          <p>{tr('They\'ll stop getting messages from this group.')}</p>
        </ConfirmAction>
      )}
    </Sheet>
  )
}
