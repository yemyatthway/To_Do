import { useRef } from 'react'
import { Icon } from '../icons'
import { gsap, useGsap } from '../motion'

const TONES = ['', 'violet', 'teal']

interface DialProps {
  /** Who it is: keeps the same color every time. */
  id: number
  initials: string
  /** A ring that draws itself: blue for new messages, green for online. */
  ring?: 'new' | 'live' | null
  large?: boolean
  /** A group chat: its people's icon instead of letters. */
  group?: boolean
}

/** A profile circle sitting in a hollow, like the clock's face. */
export function Dial({ id, initials, ring, large, group }: DialProps) {
  const ref = useRef<HTMLSpanElement>(null)
  useGsap(
    ref,
    () => {
      if (ring) gsap.fromTo(ref.current, { '--arc': '0deg' }, { '--arc': '360deg', duration: 1.1, ease: 'power3.out', clearProps: '--arc' })
    },
    [ring],
  )
  return (
    <span ref={ref} className={`dial${ring ? ` ${ring}` : ''}${large ? ' large' : ''}`} aria-hidden="true">
      <span className={`avatar ${TONES[id % TONES.length]}`}>{group ? <Icon name="users" /> : initials}</span>
    </span>
  )
}
