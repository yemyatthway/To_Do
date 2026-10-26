import { useEffect, useState } from 'react'
import { auth, type UsernameCheck } from '../api'
import { normalizeUsername, usernameProblem } from '../user'

export type UsernameState = 'empty' | 'invalid' | 'checking' | 'ok' | 'taken' | 'current'

export interface UsernameStatus {
  value: string
  state: UsernameState
  message: string
  suggestion?: string | null
}

/**
 * Live check while typing a username: the rules right away, then (once typing pauses) whether
 * it's free. `current` is the person's own username, which is always fine for them.
 */
export function useUsernameCheck(raw: string, { current, signedIn = false }: { current?: string; signedIn?: boolean } = {}) {
  const value = normalizeUsername(raw)
  const problem = value ? usernameProblem(value) : null
  const needsServer = Boolean(value) && !problem && value !== current
  const [result, setResult] = useState<(UsernameCheck & { for: string }) | null>(null)
  useEffect(() => {
    if (!needsServer) return
    let live = true
    const id = setTimeout(() => {
      auth.checkUsername(value, signedIn).then(
        (r) => live && setResult({ ...r, for: value }),
        () => undefined, // offline or throttled: the server checks again on save
      )
    }, 400)
    return () => {
      live = false
      clearTimeout(id)
    }
  }, [value, needsServer, signedIn])

  const known = result?.for === value ? result : null
  const status: UsernameStatus = !value
    ? { value, state: 'empty', message: 'Choose a username.' }
    : problem
      ? { value, state: 'invalid', message: problem }
      : value === current
        ? { value, state: 'current', message: '' }
        : !known
          ? { value, state: 'checking', message: '' }
          : known.ok
            ? { value, state: 'ok', message: '' }
            : { value, state: 'taken', message: known.message, suggestion: known.suggestion }
  return status
}

/** Blocks saving only when we already know it won't work (the server has the final say). */
export const usernameBlocks = (status: UsernameStatus) => status.state === 'empty' || status.state === 'invalid' || status.state === 'taken'
