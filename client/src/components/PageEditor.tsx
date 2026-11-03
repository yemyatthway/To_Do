import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ApiError, workspaces as api, type Block, type BlockType, type Member, type TeamPage } from '../api'
import { Icon } from '../icons'
import { useLiveRefresh } from '../live'
import { applyShortcut, backspaceAtStart, makeBlock, pasteLines, setType, splitAt, type Caret } from '../pageBlocks'
import { PageSaver, pageStorage, type PageDoc, type SaveStatus } from '../pageSaver'
import { Comments, HistoryFold } from './Comments'
import { ConfirmAction } from './ConfirmAction'
import { Loading, SkeletonRows } from './Loading'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
const TYPES: { type: BlockType; label: string }[] = [
  { type: 'p', label: 'Text' },
  { type: 'h', label: 'Heading' },
  { type: 'todo', label: 'Checklist' },
]

interface PageEditorProps {
  workspaceId: number
  pageId: number
  userId: number
  canEdit: boolean
  canComment: boolean
  members: Member[]
  now: Date
  /** A newer title or edit time, for the list of pages. */
  onSaved: (page: TeamPage) => void
  onDeleted: (page: TeamPage) => void
  /** It no longer exists. */
  onGone: () => void
}

/** Loads a page, then hands it to the editor. */
export function PageEditor(props: PageEditorProps) {
  const { workspaceId, pageId, onGone } = props
  const [page, setPage] = useState<TeamPage | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      setPage(await api.getPage(workspaceId, pageId))
      setError('')
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) onGone()
      else setError(errorMessage(err))
    }
  }, [workspaceId, pageId, onGone])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  if (!page) {
    return (
      <section className="card glass panel" aria-label="Page">
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="text-btn" onClick={() => void load()}>
              Retry
            </button>
          </div>
        )}
        <Loading active={!error} skeleton={<SkeletonRows count={4} />} onRetry={() => void load()} />
      </section>
    )
  }
  return <Editor {...props} page={page} />
}

function statusText(status: SaveStatus, canEdit: boolean) {
  if (!canEdit) return "You can read this page. Your role doesn't allow editing."
  switch (status.state) {
    case 'saved':
      return 'Saved'
    case 'saving':
      return 'Saving…'
    case 'waiting':
      return "Can't reach the server. It's safe on this device and will save automatically."
    case 'conflict':
      return 'Not saved yet'
    case 'refused':
      return `Not saved. ${status.message}`
  }
}

function Editor({ workspaceId, userId, canEdit, canComment, members, now, page, onSaved, onDeleted, onGone }: PageEditorProps & { page: TeamPage }) {
  const [saver] = useState(() => new PageSaver(page, workspaceId, userId, (base, doc) => api.savePage(workspaceId, page.id, base, doc), canEdit ? pageStorage() : null))
  const [title, setTitle] = useState(saver.doc.title)
  const [blocks, setBlocks] = useState<Block[]>(() => (saver.doc.blocks.length ? saver.doc.blocks : [makeBlock()]))
  const [status, setStatus] = useState<SaveStatus>(saver.status)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const inputs = useRef(new Map<string, HTMLTextAreaElement>())
  const caret = useRef<Caret | null>(null)

  useEffect(() => {
    saver.start(setStatus, onSaved)
    return () => saver.dispose()
  }, [saver, onSaved])

  const show = useCallback((doc: PageDoc) => {
    setTitle(doc.title)
    setBlocks(doc.blocks.length ? doc.blocks : [makeBlock()])
  }, [])

  // Someone else's saved changes appear while you aren't editing. Live co-editing comes in Phase 8.
  const poll = useCallback(async () => {
    try {
      const fresh = await api.getPage(workspaceId, page.id)
      const doc = saver.adopt(fresh)
      if (doc) {
        show(doc)
        onSaved(fresh)
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        saver.discard()
        onGone()
      }
    }
  }, [workspaceId, page.id, saver, show, onSaved, onGone])
  useLiveRefresh(poll, 15_000)

  // After Enter, Backspace or a paste, put the caret where it belongs.
  useLayoutEffect(() => {
    if (!caret.current) return
    const input = inputs.current.get(caret.current.id)
    if (input) {
      input.focus()
      input.setSelectionRange(caret.current.at, caret.current.at)
    }
    caret.current = null
  }, [blocks])

  function change(nextBlocks: Block[], nextTitle = title) {
    setBlocks(nextBlocks)
    saver.edit({ title: nextTitle, blocks: nextBlocks })
  }

  function apply(edit: { blocks: Block[]; caret: Caret } | null) {
    if (!edit) return
    caret.current = edit.caret
    change(edit.blocks)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>, block: Block, index: number) {
    if (e.nativeEvent.isComposing) return
    const { selectionStart: start, selectionEnd: end, value } = e.currentTarget
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      apply(splitAt(blocks.map((b) => (b.id === block.id ? { ...b, text: value.slice(0, start) + value.slice(end) } : b)), block.id, start))
    } else if (e.key === 'Backspace' && start === 0 && end === 0) {
      const edit = backspaceAtStart(blocks, block.id)
      if (edit) {
        e.preventDefault()
        apply(edit)
      }
    } else if (e.key === 'ArrowUp' && start === 0 && end === 0 && index > 0) {
      e.preventDefault()
      const above = inputs.current.get(blocks[index - 1].id)
      above?.focus()
      above?.setSelectionRange(above.value.length, above.value.length)
    } else if (e.key === 'ArrowDown' && start === value.length && end === value.length && index < blocks.length - 1) {
      e.preventDefault()
      const below = inputs.current.get(blocks[index + 1].id)
      below?.focus()
      below?.setSelectionRange(0, 0)
    }
  }

  const active = useMemo(() => blocks.find((b) => b.id === activeId) ?? null, [blocks, activeId])

  return (
    <section className="card glass panel page-editor" aria-label={title || 'Untitled'}>
      {canEdit ? (
        <input
          className="page-title"
          aria-label="Page name"
          placeholder="Untitled"
          maxLength={120}
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            saver.edit({ title: e.target.value, blocks })
          }}
        />
      ) : (
        <h2 className="page-title">{title}</h2>
      )}

      <div className="page-bar">
        <span className={`page-status${status.state === 'refused' ? ' bad' : ''}`} role="status">
          {statusText(status, canEdit)}
        </span>
        {canEdit && (
          <button type="button" className="icon-btn" aria-label="Delete this page" onClick={() => setDeleting(true)}>
            <Icon name="trash" />
          </button>
        )}
      </div>

      {status.state === 'conflict' && (
        <div className="device-banner" role="alert">
          <Icon name="users" />
          <span>
            <strong>{status.theirs.updated_by ?? 'Someone'} changed this page while you were editing.</strong> Which version do you want to keep?
          </span>
          <button type="button" className="text-btn" onClick={() => show(saver.useTheirs())}>
            Use theirs
          </button>
          <button type="button" className="primary-btn small" onClick={() => saver.keepMine()}>
            Keep mine
          </button>
        </div>
      )}

      {canEdit && (
        <div className="chips page-tools" role="group" aria-label="Line type">
          {TYPES.map(({ type, label }) => (
            <button
              key={type}
              type="button"
              className="chip"
              aria-pressed={active?.type === type}
              disabled={!active}
              // Keep the caret in the line being changed.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => active && change(blocks.map((b) => (b.id === active.id ? setType(b, type) : b)))}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="panel-scroll page-blocks">
        {blocks.map((block, index) =>
          canEdit ? (
            <div key={block.id} className={`page-block is-${block.type}${block.done ? ' done' : ''}`} style={{ ['--cat' as string]: 'var(--work)' }}>
              {block.type === 'todo' && (
                <button
                  type="button"
                  className={`check${block.done ? ' on' : ''}`}
                  role="checkbox"
                  aria-checked={Boolean(block.done)}
                  aria-label={`${block.done ? 'Mark not done' : 'Mark done'}: ${block.text || 'empty item'}`}
                  onClick={() => change(blocks.map((b) => (b.id === block.id ? { ...b, done: !b.done } : b)))}
                >
                  {block.done && <Icon name="check" />}
                </button>
              )}
              <AutoGrowText
                ref={(el) => {
                  if (el) inputs.current.set(block.id, el)
                  else inputs.current.delete(block.id)
                }}
                label={block.type === 'h' ? 'Heading' : block.type === 'todo' ? 'Checklist item' : 'Text'}
                placeholder={index === 0 && blocks.length === 1 ? 'Start writing. Type # for a heading or [] for a checklist.' : ''}
                value={block.text}
                onFocus={() => setActiveId(block.id)}
                onChange={(text) => change(blocks.map((b) => (b.id === block.id ? applyShortcut(b, text) : b)))}
                onKeyDown={(e) => onKeyDown(e, block, index)}
                onPaste={(e) => {
                  const edit = pasteLines(blocks, block.id, e.currentTarget.selectionStart, e.currentTarget.selectionEnd, e.clipboardData.getData('text'))
                  if (edit) {
                    e.preventDefault()
                    apply(edit)
                  }
                }}
              />
            </div>
          ) : (
            <ReadOnlyBlock key={block.id} block={block} />
          ),
        )}
        <Comments target={{ workspaceId, pageId: page.id }} now={now} members={members} canComment={canComment} />
        <HistoryFold workspaceId={workspaceId} now={now} pageId={page.id} />
      </div>

      {deleting && (
        <ConfirmAction
          danger
          icon="trash"
          title={`Delete ${title.trim() || 'this page'}?`}
          confirmLabel="Delete page"
          onCancel={() => setDeleting(false)}
          onConfirm={async () => {
            await api.deletePage(workspaceId, page.id)
            saver.discard()
            setDeleting(false)
            onDeleted(page)
          }}
        >
          <p>Everyone in the workspace loses it. You can undo this right after.</p>
        </ConfirmAction>
      )}
    </section>
  )
}

function ReadOnlyBlock({ block }: { block: Block }) {
  if (block.type === 'h') return <h3 className="page-read is-h">{block.text}</h3>
  if (block.type === 'todo') {
    return (
      <div className={`page-block is-todo${block.done ? ' done' : ''}`} style={{ ['--cat' as string]: 'var(--work)' }}>
        <span className={`check${block.done ? ' on' : ''}`} role="img" aria-label={block.done ? 'Done' : 'Not done'}>
          {block.done && <Icon name="check" />}
        </span>
        <p className="page-read">{block.text}</p>
      </div>
    )
  }
  return <p className="page-read">{block.text}</p>
}

interface AutoGrowProps {
  ref: (el: HTMLTextAreaElement | null) => void
  label: string
  placeholder: string
  value: string
  onFocus: () => void
  onChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
}

/** A line of the page: as tall as its text, so the page reads as one piece of writing. */
function AutoGrowText({ ref, label, placeholder, value, onFocus, onChange, onKeyDown, onPaste }: AutoGrowProps) {
  const own = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const el = own.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  return (
    <textarea
      ref={(el) => {
        own.current = el
        ref(el)
      }}
      className="page-text"
      rows={1}
      maxLength={10_000}
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onFocus={onFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    />
  )
}
