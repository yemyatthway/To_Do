import { Icon, type IconName } from '../icons'

interface Item {
  id: string
  label: string
  icon: IconName
  badge?: number
  tour?: string
}

interface SideNavProps {
  view: string
  isStaff: boolean
  chatBadge: number
  socialBadge: number
  onGo: (view: string) => void
}

/** Desktop navigation: a full sidebar on wide windows, icons only when there's less room. */
export function SideNav({ view, isStaff, chatBadge, socialBadge, onGo }: SideNavProps) {
  const groups: { label: string; items: Item[] }[] = [
    { label: '', items: [{ id: 'home', label: 'Today', icon: 'clock' }] },
    {
      label: 'People',
      items: [
        { id: 'chats', label: 'Chats', icon: 'chat', badge: chatBadge, tour: 'chats' },
        { id: 'friends', label: 'Friends', icon: 'users', badge: socialBadge, tour: 'friends' },
      ],
    },
    {
      label: 'You',
      items: [
        { id: 'progress', label: 'Progress', icon: 'chart', tour: 'progress' },
        { id: 'timer', label: 'Timer', icon: 'timer' },
        { id: 'profile', label: 'Profile', icon: 'user', tour: 'profile' },
        ...(isStaff ? [{ id: 'admin', label: 'Admin', icon: 'shield' as const }] : []),
      ],
    },
  ]
  return (
    <nav className="side-nav" aria-label="Main">
      <div className="side-brand">
        <span className="auth-logo" aria-hidden="true">
          <Icon name="clock" />
        </span>
        <span className="side-text">To-Do</span>
      </div>
      {groups.map((group) => (
        <div key={group.label || 'main'} className="side-group">
          {group.label && <div className="side-label">{group.label}</div>}
          {group.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="side-item"
              title={item.label}
              data-tour={item.tour}
              aria-label={item.badge ? `${item.label}, ${item.badge} new` : item.label}
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => onGo(item.id)}
            >
              <Icon name={item.icon} />
              <span className="side-text">{item.label}</span>
              {Boolean(item.badge) && (
                <span className="nav-badge" aria-hidden="true">
                  {item.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      ))}
    </nav>
  )
}
