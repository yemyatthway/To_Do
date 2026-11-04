import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { gsap, useGsap } from '../motion'
import { Icon, type IconName } from '../icons'
import type { WorkspaceItem } from '../pages/Workspaces'
import { tr } from '../i18n'

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
  workspaces: { id: number; name: string; unread?: number }[]
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
  // While the words are hidden, a label appears beside each icon. It lives outside the menu, which scrolls and would cut it off.
  const navRef = useRef<HTMLElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ label: string; top: number; left: number } | null>(null)
  const tipFor = (label: string) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => showTip(label, e.currentTarget),
    onMouseLeave: () => setTip(null),
    onFocus: (e: React.FocusEvent<HTMLElement>) => showTip(label, e.currentTarget),
    onBlur: () => setTip(null),
  })
  function showTip(label: string, el: HTMLElement) {
    const words = navRef.current?.querySelector('.side-text')
    const toggleButton = el.classList.contains('side-toggle')
    if (!toggleButton && words && getComputedStyle(words).display !== 'none') return
    const box = el.getBoundingClientRect()
    setTip({ label, top: box.top + box.height / 2, left: box.right + 10 })
  }
  useGsap(
    tipRef,
    () => {
      if (tip) gsap.fromTo(tipRef.current, { opacity: 0, x: -6 }, { opacity: 1, x: 0, duration: 0.2, ease: 'power2.out' })
    },
    [tip?.label],
  )

  const groups: { label: string; items: Item[] }[] = [
    {
      label: '',
      items: [
        { id: 'home', label: tr('Today'), icon: 'clock' },
        { id: 'tasks', label: tr('Tasks'), icon: 'check' },
        { id: 'notifications', label: tr('Notifications'), icon: 'inbox', badge: noticeBadge },
      ],
    },
    {
      label: tr('People'),
      items: [
        { id: 'chats', label: tr('Chats'), icon: 'chat', badge: chatBadge, tour: 'chats' },
        { id: 'friends', label: tr('Friends'), icon: 'users', badge: socialBadge, tour: 'friends' },
      ],
    },
    {
      label: tr('Workspaces'),
      items: [
        ...workspaces.flatMap((w): Item[] => [
          { id: `workspace:${w.id}`, label: w.name, icon: 'team', badge: w.unread },
          ...(openWorkspace?.workspaceId === w.id ? openWorkspace.items.map((i): Item => ({ id: `${i.kind}:${w.id}:${i.id}`, label: i.title, icon: i.kind, sub: true })) : []),
        ]),
        { id: 'workspaces', label: workspaces.length ? tr('All workspaces') : tr('Workspaces'), icon: 'list' as const, badge: inviteBadge, tour: 'workspaces' },
      ],
    },
    {
      label: tr('You'),
      items: [
        { id: 'progress', label: tr('Progress'), icon: 'chart', tour: 'progress' },
        { id: 'timer', label: tr('Timer'), icon: 'timer', tour: 'timer' },
        { id: 'profile', label: tr('Profile'), icon: 'user', tour: 'profile' },
        ...(isStaff ? [{ id: 'admin', label: tr('Admin'), icon: 'shield' as const }] : []),
      ],
    },
  ]
  return (
    <>
    <nav ref={navRef} className={`side-nav${closed ? ' is-closed' : ''}`} aria-label={tr('Main')}>
      <div className="side-top">
        <div className="side-brand">
          <span className="auth-logo" aria-hidden="true">
            <Icon name="clock" />
          </span>
          <span className="side-text">{tr('Todo Clock')}</span>
        </div>
        <button type="button" className="icon-btn side-toggle" aria-label={closed ? tr('Open the side menu') : tr('Close the side menu')} aria-expanded={!closed} {...tipFor(closed ? tr('Open the menu') : tr('Close the menu'))} onClick={toggle}>
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
              {...tipFor(item.label)}
              data-tour={item.tour}
              aria-label={item.badge ? tr('{label}, {badge} new', { label: item.label, badge: item.badge }) : item.label}
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => {
                setTip(null)
                onGo(item.id)
              }}
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
    {tip && createPortal(
      <div ref={tipRef} className="side-tip" role="tooltip" style={{ top: tip.top, left: tip.left }}>
        {tip.label}
      </div>,
      document.body,
    )}
    </>
  )
}
