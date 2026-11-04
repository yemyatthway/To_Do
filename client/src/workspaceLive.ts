import { useCallback, useEffect, useRef, useState } from 'react'
import { joinWorkspace, type Peer, type Place } from './realtime'

/** A page or table on screen: who else is here, their changes as they happen, and telling them mine. */
export function useWorkspaceLive(workspaceId: number, me: number, place: Place, onEvent: (name: string, data: unknown) => void, onDraft: (from: number, data: unknown) => void) {
  const [people, setPeople] = useState<Peer[]>([])
  const connection = useRef<ReturnType<typeof joinWorkspace> | null>(null)
  const latest = useRef({ onEvent, onDraft })
  useEffect(() => {
    latest.current = { onEvent, onDraft }
  })
  const key = JSON.stringify(place)
  const startPlace = useRef(place)

  useEffect(() => {
    const joined = joinWorkspace(workspaceId, me, startPlace.current, {
      onEvent: (name, data) => latest.current.onEvent(name, data),
      onDraft: (from, data) => latest.current.onDraft(from, data),
      onPeople: setPeople,
    })
    connection.current = joined
    return () => {
      joined.leave()
      connection.current = null
      setPeople([])
    }
  }, [workspaceId, me])

  useEffect(() => {
    startPlace.current = JSON.parse(key) as Place
    connection.current?.move(startPlace.current)
  }, [key])

  const sendDraft = useCallback((data: unknown) => connection.current?.draft(data), [])
  return { people, sendDraft }
}

/** The same colour for the same person on every screen. */
const PEER_COLORS = ['#e0676b', '#2fa597', '#8c7df5', '#e39a3b', '#4a86f0', '#c868b8']
export const peerColor = (id: number) => PEER_COLORS[Math.abs(id) % PEER_COLORS.length]
