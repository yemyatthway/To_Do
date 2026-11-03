import type { User } from '../api'
import { Icon, type IconName } from '../icons'
import { initials } from '../user'

interface MoreProps {
  user: User
  inviteBadge: number
  noticeBadge: number
  onGo: (view: 'progress' | 'timer' | 'profile' | 'admin' | 'workspaces' | 'notifications') => void
}

/** Phone: the screens that don't fit in the bottom bar. */
export function More({ user, inviteBadge, noticeBadge, onGo }: MoreProps) {
  const row = (view: 'progress' | 'timer' | 'admin' | 'workspaces' | 'notifications', label: string, icon: IconName, badge = 0) => (
    <li>
      <button type="button" className="more-row" onClick={() => onGo(view)}>
        <Icon name={icon} />
        <span className="person-name">{label}</span>
        {badge > 0 && <span className="nav-badge">{badge}</span>}
        <Icon name="chevron" className="more-go" />
      </button>
    </li>
  )
  return (
    <ul className="more-list">
      <li>
        <button type="button" className="more-row" onClick={() => onGo('profile')}>
          <span className="avatar" aria-hidden="true">
            {initials(user)}
          </span>
          <span className="person-main">
            <span className="person-name">{user.full_name || 'Your profile'}</span>
            <span className="task-meta">@{user.username}</span>
          </span>
          <Icon name="chevron" className="more-go" />
        </button>
      </li>
      {row('notifications', 'Notifications', 'inbox', noticeBadge)}
      {row('workspaces', 'Workspaces', 'team', inviteBadge)}
      {row('progress', 'Progress', 'chart')}
      {row('timer', 'Timer', 'timer')}
      {user.is_staff && row('admin', 'Admin', 'shield')}
    </ul>
  )
}
