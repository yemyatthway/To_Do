import { memberName } from '../tableLogic'
import { tr } from '../i18n'
import type { Member } from '../api'
import type { Peer } from '../realtime'
import { peerColor } from '../workspaceLive'

const MAX_SHOWN = 4

function initials(name: string) {
  return name.replace(/^@/, '').split(/\s+/).slice(0, 2).map((word) => [...word][0] ?? '').join('').toUpperCase()
}

/** Who else has this open, as small circles. */
export function Peers({ people, members }: { people: Peer[]; members: Member[] }) {
  const known = people.flatMap((peer) => {
    const member = members.find((m) => m.id === peer.id)
    return member ? [{ id: peer.id, name: memberName(member) }] : []
  })
  if (!known.length) return null
  const names = known.map((person) => person.name).join(', ')
  return (
    <span className="peers" role="img" aria-label={tr('Also here: {names}', { names })} title={names}>
      {known.slice(0, MAX_SHOWN).map((person) => (
        <span key={person.id} className="peer" style={{ ['--peer' as string]: peerColor(person.id) }}>
          {initials(person.name)}
        </span>
      ))}
      {known.length > MAX_SHOWN && <span className="peer peer-more">+{known.length - MAX_SHOWN}</span>}
    </span>
  )
}

/** A small name on the exact line or cell someone is in. */
export function PeerTag({ id, members }: { id: number; members: Member[] }) {
  const member = members.find((m) => m.id === id)
  if (!member) return null
  return (
    <span className="peer-tag" style={{ ['--peer' as string]: peerColor(id) }} aria-hidden="true">
      {memberName(member).split(/\s+/)[0]}
    </span>
  )
}
