import { useEffect, useSyncExternalStore } from 'react'
import { putFile, workspaces as api, type TeamFile } from './api'
import { prepareFile } from './imageShrink'
import { TeamFiles } from './teamFiles'
import { Uploads } from './uploads'

const STALE_CHECK_MS = 5000

export const teamFiles = new TeamFiles((workspaceId, ids) => api.files(workspaceId, ids))

export const uploads = new Uploads<TeamFile>({
  prepare: prepareFile,
  preview: (blob) => URL.createObjectURL(blob),
  onDone: (file) => teamFiles.put(file),
  transport: { prepare: api.prepareFile, restart: api.restartFile, finish: api.finishFile, cancel: api.cancelFile, put: putFile },
})

// Closing the tab would lose what's still being sent.
window.addEventListener('beforeunload', (e) => {
  if (uploads.busy) e.preventDefault()
})

/** Details for these files, kept fresh while anything is uploading or a link is about to run out. */
export function useTeamFiles(workspaceId: number, ids: number[]) {
  useSyncExternalStore(teamFiles.subscribe, teamFiles.getVersion)
  const key = ids.join(',')
  useEffect(() => {
    const list = key ? key.split(',').map(Number) : []
    teamFiles.want(workspaceId, list)
    const timer = window.setInterval(() => {
      const stale = list.filter((id) => teamFiles.isStale(id))
      if (stale.length) teamFiles.want(workspaceId, stale, true)
    }, STALE_CHECK_MS)
    return () => clearInterval(timer)
  }, [workspaceId, key])
  return ids.map((id) => teamFiles.get(id))
}

export function useUploads() {
  return useSyncExternalStore(uploads.subscribe, uploads.getSnapshot)
}

/** Opens the system's file chooser (on phones: photos, camera or files). */
export function pickFiles(onFiles: (files: File[]) => void) {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.style.display = 'none'
  input.onchange = () => {
    onFiles(Array.from(input.files ?? []))
    input.remove()
  }
  document.body.append(input)
  input.click()
}
