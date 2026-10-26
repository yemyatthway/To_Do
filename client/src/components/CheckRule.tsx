import { Icon } from '../icons'

export type RuleState = 'ok' | 'bad' | 'wait' | 'checking'

/** One line of a live checklist (email, password, username): a tick, a cross, or an empty circle. */
export function Rule({ state, label }: { state: RuleState; label: string }) {
  return (
    <li className={state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : ''}>
      <Icon name={state === 'ok' ? 'check' : state === 'bad' ? 'x' : 'circle'} />
      {label}
      {state === 'checking' && <span className="rule-note"> · checking…</span>}
      <span className="sr-only">{state === 'ok' ? ' (passed)' : state === 'bad' ? ' (failed)' : ' (not checked yet)'}</span>
    </li>
  )
}
