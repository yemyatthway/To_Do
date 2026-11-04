import { useEffect, useState } from 'react'
import { social, type Member, type Person } from '../api'
import { tr } from '../i18n'
import { initials } from '../user'

const MAX_SHOWN = 20

/** Who to invite: type a @username or an email, or just tap one of your friends who matches. */
export function InviteField({ value, onChange, members, invited }: { value: string; onChange: (value: string) => void; members: Member[]; invited: string[] }) {
  const [friends, setFriends] = useState<Person[]>([])

  useEffect(() => {
    social.friends().then(
      (lists) => setFriends(lists.friends),
      () => undefined, // typing a username or email still works
    )
  }, [])

  const typed = value.trim().replace(/^@/, '').toLowerCase()
  const inTeam = new Set(members.map((member) => member.id))
  const matches = friends
    .filter((friend) => !inTeam.has(friend.id) && !invited.includes(`@${friend.username}`) && [friend.full_name, friend.username, friend.email].some((text) => text?.toLowerCase().includes(typed)))
    .slice(0, MAX_SHOWN)
  const chosen = matches.length === 1 && value.trim().toLowerCase() === `@${matches[0].username}`.toLowerCase()

  return (
    <>
      <input
        data-autofocus
        className="field"
        name="invite-person"
        aria-label={tr('@username or email')}
        value={value}
        placeholder="@username"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore
        onChange={(e) => onChange(e.target.value)}
      />
      {!chosen && matches.length > 0 && (
        <ul className="invite-friends" aria-label={tr('Your friends to invite')}>
          {matches.map((friend) => (
            <li key={friend.id}>
              <button type="button" className="invite-friend" onClick={() => onChange(`@${friend.username}`)}>
                <span className="avatar" aria-hidden="true">
                  {initials(friend)}
                </span>
                <span className="person-main">
                  <span className="person-name">{friend.full_name || `@${friend.username}`}</span>
                  <span className="task-meta">@{friend.username}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
