import { Icon } from '../icons'
import { tr } from '../i18n'

export type RuleState = 'ok' | 'bad' | 'wait' | 'checking'

/** One line of a live checklist (email, password, username): a tick, a cross, or an empty circle. */
export function Rule({ state, label }: { state: RuleState; label: string }) {
  return (
    <li className={state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : ''}>
      <Icon name={state === 'ok' ? 'check' : state === 'bad' ? 'x' : 'circle'} />
      {label}
      {state === 'checking' && <span className="rule-note"> {tr('· checking…')}</span>}
      <span className="sr-only">{state === 'ok' ? tr(' (passed)') : state === 'bad' ? tr(' (failed)') : tr(' (not checked yet)')}</span>
    </li>
  )
}
