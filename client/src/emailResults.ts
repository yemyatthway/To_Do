import type { EmailResult } from './api'
import { tr } from './i18n'

export const EMAIL_NAMES: Record<string, string> = {
  code: tr('Sign-in or verify code'),
  welcome: tr('Welcome'),
  workspace_invite: tr('Workspace invitation'),
  workspace_update: tr('Workspace update'),
}

const nameOf = (result: EmailResult) => EMAIL_NAMES[result.kind] ?? tr('Email')

/** One notification for whatever just came in, so a failure is never hidden behind a success. */
export function resultsMessage(results: EmailResult[]): { title: string; detail: string } | null {
  if (!results.length) return null
  const failed = results.filter((r) => !r.ok)
  if (results.length === 1) {
    const [only] = results
    return only.ok ? { title: tr('{value} sent', { value: nameOf(only) }), detail: only.recipient } : { title: tr('{value} failed', { value: nameOf(only) }), detail: `${only.recipient}: ${only.error}` }
  }
  const sent = results.length - failed.length
  const title = failed.length ? tr('{length} {value} failed, {sent} sent', { length: failed.length, value: failed.length === 1 ? 'email' : 'emails', sent }) : tr('{sent} emails sent', { sent })
  return { title, detail: failed.length ? `${failed[0].recipient}: ${failed[0].error}` : tr('See the list in Emails.') }
}
