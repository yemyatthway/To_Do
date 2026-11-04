import type { EmailResult } from './api'

export const EMAIL_NAMES: Record<string, string> = {
  code: 'Sign-in or verify code',
  welcome: 'Welcome',
  workspace_invite: 'Workspace invitation',
  workspace_update: 'Workspace update',
}

const nameOf = (result: EmailResult) => EMAIL_NAMES[result.kind] ?? 'Email'

/** One notification for whatever just came in, so a failure is never hidden behind a success. */
export function resultsMessage(results: EmailResult[]): { title: string; detail: string } | null {
  if (!results.length) return null
  const failed = results.filter((r) => !r.ok)
  if (results.length === 1) {
    const [only] = results
    return only.ok ? { title: `${nameOf(only)} sent`, detail: only.recipient } : { title: `${nameOf(only)} failed`, detail: `${only.recipient}: ${only.error}` }
  }
  const sent = results.length - failed.length
  const title = failed.length ? `${failed.length} ${failed.length === 1 ? 'email' : 'emails'} failed, ${sent} sent` : `${sent} emails sent`
  return { title, detail: failed.length ? `${failed[0].recipient}: ${failed[0].error}` : 'See the list in Emails.' }
}
