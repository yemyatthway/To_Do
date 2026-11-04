import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TeamFile } from '../api'
import { uploads, useTeamFiles, useUploads } from '../filesClient'
import { Icon } from '../icons'
import { gsap, useGsap } from '../motion'
import { fileSizeText, timeLeftText, uploadTiming } from '../uploadProgress'
import type { UploadItem } from '../uploads'
import { Bone } from './Loading'

/** Real progress, once the upload has taken more than a moment. */
function UploadBar({ item }: { item: UploadItem }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  // oxlint-disable-next-line react-hooks/purity
  const timing = uploadTiming(item.loaded, item.total, Date.now() - item.startedAt)
  if (item.state === 'failed') {
    return (
      <div className="upload-status failed" role="alert">
        <span className="upload-text">{item.error}</span>
        <button type="button" className="text-btn" onClick={() => void uploads.retry(item.fileId)}>
          Try again
        </button>
      </div>
    )
  }
  const label = item.state === 'finishing' ? 'Finishing…' : item.state === 'waiting' ? 'Waiting…' : timing.showProgress ? `${timing.percent}%${timing.secondsLeft !== null ? ` · ${timeLeftText(timing.secondsLeft)}` : ''}` : 'Uploading…'
  return (
    <div className="upload-status" role="status" aria-label={`Uploading ${item.name}: ${label}`}>
      <span className="upload-track" aria-hidden="true">
        <span style={{ width: `${timing.showProgress || item.state === 'finishing' ? (item.state === 'finishing' ? 100 : timing.percent) : 0}%` }} />
      </span>
      <span className="upload-text">{label}</span>
    </div>
  )
}

function ImageViewer({ file, onClose }: { file: TeamFile; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useGsap(
    box,
    () => {
      gsap.fromTo('.viewer-image', { opacity: 0, scale: 0.92 }, { opacity: 1, scale: 1, duration: 0.35, ease: 'back.out(1.5)', clearProps: 'transform,opacity' })
    },
    [],
  )
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div ref={box} className="scrim viewer" role="dialog" aria-modal="true" aria-label={file.name} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="viewer-bar">
        <span className="viewer-name">{file.name}</span>
        {file.download_url && (
          <a className="round-btn" href={file.download_url} aria-label={`Download ${file.name}`}>
            <Icon name="download" />
          </a>
        )}
        <button type="button" className="round-btn" aria-label="Close" onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>
      <img className="viewer-image" src={file.url ?? ''} alt={file.name} />
    </div>,
    document.body,
  )
}

interface FileViewProps {
  workspaceId: number
  id: number
  /** Show the small copy, like in a comment. */
  compact?: boolean
  onRemove?: () => void
}

/** One file: its picture or name, its upload while that's happening, or why it isn't there. */
export function FileView({ workspaceId, id, compact, onRemove }: FileViewProps) {
  const [file] = useTeamFiles(workspaceId, [id])
  const items = useUploads()
  const upload = items.get(id)
  const [viewing, setViewing] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)

  const remove = onRemove && (
    <button
      type="button"
      className="file-remove"
      aria-label={upload ? 'Cancel this upload' : 'Remove this file'}
      onClick={() => {
        if (upload) void uploads.cancel(id)
        onRemove()
      }}
    >
      <Icon name="x" />
    </button>
  )

  if (upload) {
    return (
      <div className={`file-card uploading${compact ? ' compact' : ''}`}>
        {upload.previewUrl && <img className="file-preview" src={upload.previewUrl} alt="" />}
        <div className="file-card-main">
          <span className="person-name">{upload.name}</span>
          <UploadBar item={upload} />
        </div>
        {remove}
      </div>
    )
  }
  if (file === undefined) {
    return (
      <div className={`file-card${compact ? ' compact' : ''}`}>
        <Bone width="100%" height={compact ? 44 : 120} />
      </div>
    )
  }
  if (file === 'gone' || file.status === 'pending') {
    return (
      <div className={`file-card missing${compact ? ' compact' : ''}`}>
        <Icon name="file" />
        <span className="row-sub">{file === 'gone' ? "This file isn't available any more." : `${file.name} is still uploading, or the upload didn't finish.`}</span>
        {remove}
      </div>
    )
  }
  if (file.is_image && file.url) {
    return (
      <div className={`file-image-wrap${compact ? ' compact' : ''}`}>
        <button type="button" className="file-image" aria-label={`Open ${file.name}`} onClick={() => setViewing(true)}>
          <img
            ref={imageRef}
            src={(compact ? file.thumb_url : file.url) ?? file.url}
            alt={file.name}
            loading="lazy"
            width={file.width ?? undefined}
            height={file.height ?? undefined}
            onLoad={() => gsap.fromTo(imageRef.current, { opacity: 0, scale: 0.97 }, { opacity: 1, scale: 1, duration: 0.4, ease: 'power2.out', clearProps: 'transform,opacity' })}
          />
        </button>
        {remove}
        {viewing && <ImageViewer file={file} onClose={() => setViewing(false)} />}
      </div>
    )
  }
  return (
    <div className={`file-card${compact ? ' compact' : ''}`}>
      <span className="well quiet">
        <Icon name="file" />
      </span>
      <span className="file-card-main">
        <span className="person-name">{file.name}</span>
        <span className="row-sub">{fileSizeText(file.size)}</span>
      </span>
      {file.download_url && (
        <a className="icon-btn" href={file.download_url} aria-label={`Download ${file.name}`}>
          <Icon name="download" />
        </a>
      )}
      {remove}
    </div>
  )
}

/** Small squares for a table cell. */
export function FileThumbs({ workspaceId, ids, limit = 3, still }: { workspaceId: number; ids: number[]; limit?: number; still?: boolean }) {
  const files = useTeamFiles(workspaceId, ids.slice(0, limit))
  const items = useUploads()
  const [viewing, setViewing] = useState<TeamFile | null>(null)
  return (
    <span className="file-thumbs">
      {files.map((file, index) => {
        const id = ids[index]
        if (items.has(id)) {
          const item = items.get(id)!
          return (
            <span key={id} className={`file-thumb busy${item.state === 'failed' ? ' failed' : ''}`} role="img" aria-label={item.state === 'failed' ? `${item.name} didn't upload` : `Uploading ${item.name}`}>
              {item.previewUrl ? <img src={item.previewUrl} alt="" /> : <Icon name="file" />}
            </span>
          )
        }
        if (file && file !== 'gone' && file.status === 'ready' && file.is_image) {
          if (still) {
            return (
              <span key={id} className="file-thumb" role="img" aria-label={file.name}>
                <img src={file.thumb_url ?? ''} alt="" loading="lazy" />
              </span>
            )
          }
          return (
            <button
              key={id}
              type="button"
              className="file-thumb"
              aria-label={`Open ${file.name}`}
              onClick={(e) => {
                e.stopPropagation()
                setViewing(file)
              }}
            >
              <img src={file.thumb_url ?? ''} alt="" loading="lazy" />
            </button>
          )
        }
        return (
          <span key={id} className="file-thumb" role="img" aria-label={file && file !== 'gone' ? file.name : 'File'}>
            <Icon name="file" />
          </span>
        )
      })}
      {ids.length > limit && <span className="file-more">+{ids.length - limit}</span>}
      {viewing && <ImageViewer file={viewing} onClose={() => setViewing(null)} />}
    </span>
  )
}
