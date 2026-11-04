import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { TeamFile } from '../api'
import { uploads, useTeamFiles, useUploads } from '../filesClient'
import { Icon } from '../icons'
import { gsap, useGsap } from '../motion'
import { fileSizeText, timeLeftText, uploadTiming } from '../uploadProgress'
import type { UploadItem } from '../uploads'
import { ConfirmAction } from './ConfirmAction'
import { Bone } from './Loading'
import { tr } from '../i18n'

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
          {tr('Try again')}
        </button>
      </div>
    )
  }
  const label = item.state === 'finishing' ? tr('Finishing…') : item.state === 'waiting' ? tr('Waiting…') : timing.showProgress ? `${timing.percent}%${timing.secondsLeft !== null ? ` · ${timeLeftText(timing.secondsLeft)}` : ''}` : tr('Uploading…')
  return (
    <div className="upload-status" role="status" aria-label={tr('Uploading {name}: {label}', { name: item.name, label })}>
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
          <a className="round-btn" href={file.download_url} aria-label={tr('Download {name}', { name: file.name })}>
            <Icon name="download" />
          </a>
        )}
        <button type="button" className="round-btn" aria-label={tr('Close')} onClick={onClose}>
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
  const [removing, setRemoving] = useState(false)
  const imageRef = useRef<HTMLImageElement>(null)

  const remove = onRemove && (
    <button
      type="button"
      className="file-remove"
      aria-label={upload ? tr('Cancel this upload') : tr('Remove this file')}
      onClick={() => {
        // Stopping an upload loses nothing. Removing something already shared asks first.
        if (upload) {
          void uploads.cancel(id)
          onRemove()
        } else setRemoving(true)
      }}
    >
      <Icon name="x" />
    </button>
  )
  const removeDialog = removing && onRemove && (
    <ConfirmAction
      danger
      icon="trash"
      title={tr('Remove this file?')}
      confirmLabel={tr('Remove')}
      onCancel={() => setRemoving(false)}
      onConfirm={async () => {
        onRemove()
        setRemoving(false)
      }}
    >
      <p>{tr('It\'s taken off here for everyone.')}</p>
    </ConfirmAction>
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
        <span className="row-sub">{file === 'gone' ? tr('This file isn\'t available any more.') : tr('{name} is still uploading, or the upload didn\'t finish.', { name: file.name })}</span>
        {remove}
        {removeDialog}
      </div>
    )
  }
  if (file.is_image && file.url) {
    return (
      <div className={`file-image-wrap${compact ? ' compact' : ''}`}>
        <button type="button" className="file-image" aria-label={tr('Open {name}', { name: file.name })} onClick={() => setViewing(true)}>
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
        {removeDialog}
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
        <a className="icon-btn" href={file.download_url} aria-label={tr('Download {name}', { name: file.name })}>
          <Icon name="download" />
        </a>
      )}
      {remove}
      {removeDialog}
    </div>
  )
}

/** Small squares for a table cell. */
export function FileThumbs({ workspaceId, ids, limit = 3, still, onRemove }: { workspaceId: number; ids: number[]; limit?: number; still?: boolean; onRemove?: (id: number) => void }) {
  const files = useTeamFiles(workspaceId, ids.slice(0, limit))
  const items = useUploads()
  const [viewing, setViewing] = useState<TeamFile | null>(null)
  const [removing, setRemoving] = useState<number | null>(null)
  const removeKey = (id: number) =>
    onRemove && (
      <button
        type="button"
        className="thumb-remove"
        aria-label={tr('Remove this file')}
        onClick={(e) => {
          e.stopPropagation()
          setRemoving(id)
        }}
      >
        <Icon name="x" />
      </button>
    )
  return (
    <span className="file-thumbs">
      {files.map((file, index) => {
        const id = ids[index]
        if (items.has(id)) {
          const item = items.get(id)!
          return (
            <span key={id} className={`file-thumb busy${item.state === 'failed' ? ' failed' : ''}`} role="img" aria-label={item.state === 'failed' ? tr('{name} didn\'t upload', { name: item.name }) : tr('Uploading {name}', { name: item.name })}>
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
            <span key={id} className="thumb-wrap">
              <button
                type="button"
                className="file-thumb"
                aria-label={tr('Open {name}', { name: file.name })}
                title={file.name}
                onClick={(e) => {
                  e.stopPropagation()
                  setViewing(file)
                }}
              >
                <img src={file.thumb_url ?? ''} alt="" loading="lazy" />
                <span className="thumb-open" aria-hidden="true">
                  <Icon name="search" />
                </span>
              </button>
              {removeKey(id)}
            </span>
          )
        }
        return (
          <span key={id} className="thumb-wrap">
            {file && file !== 'gone' && file.download_url && !still ? (
              <a className="file-thumb" href={file.download_url} aria-label={tr('Download {name}', { name: file.name })} title={file.name}>
                <Icon name="file" />
              </a>
            ) : (
              <span className="file-thumb" role="img" aria-label={file && file !== 'gone' ? file.name : tr('File')}>
                <Icon name="file" />
              </span>
            )}
            {removeKey(id)}
          </span>
        )
      })}
      {ids.length > limit && <span className="file-more">+{ids.length - limit}</span>}
      {viewing && <ImageViewer file={viewing} onClose={() => setViewing(null)} />}
      {removing !== null && (
        <ConfirmAction
          danger
          icon="trash"
          title={tr('Remove this file?')}
          confirmLabel={tr('Remove')}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            onRemove?.(removing)
            setRemoving(null)
          }}
        >
          <p>{tr('It\'s taken off this row for everyone.')}</p>
        </ConfirmAction>
      )}
    </span>
  )
}
