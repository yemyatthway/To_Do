import { useState } from 'react'
import { Icon, type IconName } from '../icons'
import type { WorkspaceItem } from '../pages/Workspaces'

interface Item {
  id: string
  label: string
  icon: IconName
  badge?: number
  tour?: string
  sub?: boolean
}

interface SideNavProps {
  view: string
  isStaff: boolean
  chatBadge: number
  socialBadge: number
  workspaces: { id: number; name: string }[]
  inviteBadge: number
  noticeBadge: number
  /** The workspace that's open, whose pages and tables show under its name. */
  openWorkspace: { workspaceId: number; items: WorkspaceItem[] } | null
  onGo: (view: string) => void
}

const CLOSED_KEY = 'todo:sideClosed'

/** Desktop navigation: a full sidebar on wide windows, icons only when there's less room. */
export function SideNav({ view, isStaff, chatBadge, socialBadge, workspaces, inviteBadge, noticeBadge, openWorkspace, onGo }: SideNavProps) {
  const [closed, setClosed] = useState(() => {
    try {
      return localStorage.getItem(CLOSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggle = () => {
    setClosed(!closed)
    try {
      localStorage.setItem(CLOSED_KEY, closed ? '0' : '1')
    } catch {
      // This device won't remember it; the menu still works.
    }
  }
  const groups: { label: string; items: Item[] }[] = [
    {
      label: '',
      items: [
        { id: 'home', label: 'Today', icon: 'clock' },
        { id: 'notifications', label: 'Notifications', icon: 'inbox', badge: noticeBadge },
      ],
    },
    {
      label: 'People',
      items: [
        { id: 'chats', label: 'Chats', icon: 'chat', badge: chatBadge, tour: 'chats' },
        { id: 'friends', label: 'Friends', icon: 'users', badge: socialBadge, tour: 'friends' },
      ],
    },
    {
      label: 'Workspaces',
      items: [
        ...workspaces.flatMap((w): Item[] => [
          { id: `workspace:${w.id}`, label: w.name, icon: 'team' },
          ...(openWorkspace?.workspaceId === w.id ? openWorkspace.items.map((i): Item => ({ id: `${i.kind}:${w.id}:${i.id}`, label: i.title, icon: i.kind, sub: true })) : []),
        ]),
        { id: 'workspaces', label: workspaces.length ? 'All workspaces' : 'Workspaces', icon: 'list' as const, badge: inviteBadge, tour: 'workspaces' },
      ],
    },
    {
      label: 'You',
      items: [
        { id: 'progress', label: 'Progress', icon: 'chart', tour: 'progress' },
        { id: 'timer', label: 'Timer', icon: 'timer', tour: 'timer' },
        { id: 'profile', label: 'Profile', icon: 'user', tour: 'profile' },
        ...(isStaff ? [{ id: 'admin', label: 'Admin', icon: 'shield' as const }] : []),
      ],
    },
  ]
  return (
    <nav className={`side-nav${closed ? ' is-closed' : ''}`} aria-label="Main">
      <div className="side-top">
        <div className="side-brand">
          <span className="auth-logo" aria-hidden="true">
            <Icon name="clock" />
          </span>
          <span className="side-text">To-Do</span>
        </div>
        <button type="button" className="icon-btn side-toggle" aria-label={closed ? 'Open the side menu' : 'Close the side menu'} aria-expanded={!closed} onClick={toggle}>
          <Icon name={closed ? 'sideOpen' : 'sideClose'} />
        </button>
      </div>
      {groups.map((group) => (
        <div key={group.label || 'main'} className="side-group">
          {group.label && <div className="side-label">{group.label}</div>}
          {group.items.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`side-item${item.sub ? ' side-sub' : ''}`}
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
