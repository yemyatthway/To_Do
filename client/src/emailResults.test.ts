import { describe, expect, it } from 'vitest'
import type { EmailResult } from './api'
import { resultsMessage } from './emailResults'

const result = (ok: boolean, kind = 'workspace_update'): EmailResult => ({ id: 1, kind, recipient: 'a•••@x.test', ok, error: ok ? '' : 'Mail server said no', created_at: '' })

describe('email result notifications', () => {
  it('says nothing when nothing is new', () => {
    expect(resultsMessage([])).toBeNull()
  })

  it('names a single result', () => {
    expect(resultsMessage([result(true, 'code')])).toEqual({ title: 'Sign-in or verify code sent', detail: 'a•••@x.test' })
    expect(resultsMessage([result(false)])).toEqual({ title: 'Workspace update failed', detail: 'a•••@x.test: Mail server said no' })
  })

  it('never hides a failure behind a success', () => {
    expect(resultsMessage([result(false), result(true)])?.title).toBe('1 email failed, 1 sent')
    expect(resultsMessage([result(true), result(true)])?.title).toBe('2 emails sent')
    expect(resultsMessage([result(false), result(false)])?.detail).toContain('Mail server said no')
  })
})
