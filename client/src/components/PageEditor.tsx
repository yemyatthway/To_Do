import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ApiError, workspaces as api, type Block, type BlockType, type Member, type TeamPage } from '../api'
import { Icon } from '../icons'
import { useLiveRefresh } from '../live'
import { pickFiles, uploads } from '../filesClient'
import { applyShortcut, backspaceAtStart, insertBlock, insertFileBlock, makeBlock, pasteLines, splitAt, type Caret } from '../pageBlocks'
import { PageSaver, pageStorage, type PageDoc, type SaveStatus } from '../pageSaver'
import { mapOffset } from '../pageMerge'
import { writingLine } from '../commentText'
import { useEditHold, useWorkspaceLive } from '../workspaceLive'
import { memberName } from '../tableLogic'
import { isLive } from '../realtime'
import { PeerTag, Peers } from './Peers'
import { Comments, HistoryFold } from './Comments'
import { ConfirmAction } from './ConfirmAction'
import { FileView } from './Files'
import { Loading, SkeletonRows } from './Loading'
import { OptionsMenu } from './OptionsMenu'
import { tr } from '../i18n'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** Letters someone is typing, shown until their save arrives. */
const DRAFT_LASTS_MS = 3000
const TITLE = 'title'

interface Draft {
  text: string
  at: number
}

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
  // Kept aside: the screen around this redraws with every save, and that's no reason to load again.
  const gone = useRef(onGone)
  useEffect(() => {
    gone.current = onGone
  })

  const load = useCallback(async () => {
    try {
      setPage(await api.getPage(workspaceId, pageId))
      setError('')
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) gone.current()
      else setError(errorMessage(err))
    }
  }, [workspaceId, pageId])

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    load()
  }, [load])

  if (!page) {
    return (
      <section className="card glass panel" aria-label={tr('Page')}>
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button className="text-btn" onClick={() => void load()}>
              {tr('Retry')}
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
  if (!canEdit) return tr('You can read this page. Your role doesn\'t allow editing.')
  switch (status.state) {
    case 'saved':
      return tr('Saved')
    case 'saving':
      return tr('Saving…')
    case 'waiting':
      return tr('Can\'t reach the server. It\'s safe on this device and will save automatically.')
    case 'refused':
      return tr('Not saved. {message}', { message: status.message })
  }
}

function Editor({ workspaceId, userId, canEdit, canComment, members, now, page, onSaved, onDeleted, onGone }: PageEditorProps & { page: TeamPage }) {
  const [saver] = useState(() => new PageSaver(page, workspaceId, userId, (base, doc) => api.savePage(workspaceId, page.id, base, doc), canEdit ? pageStorage() : null))
  const [title, setTitle] = useState(saver.doc.title)
  const [blocks, setBlocks] = useState<Block[]>(() => (saver.doc.blocks.length ? saver.doc.blocks : [makeBlock()]))
  const [status, setStatus] = useState<SaveStatus>(saver.status)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [fileError, setFileError] = useState('')
  const [dropping, setDropping] = useState(false)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const inputs = useRef(new Map<string, HTMLTextAreaElement>())
  const titleInput = useRef<HTMLInputElement>(null)
  const caret = useRef<Caret | null>(null)
  const remap = useRef<{ id: string; start: number; end: number } | null>(null)
  const composing = useRef(false)
  const held = useRef<TeamPage | null>(null)

  const show = useCallback((doc: PageDoc) => {
    setTitle(doc.title)
    setBlocks(doc.blocks.length ? doc.blocks : [makeBlock()])
  }, [])

  // Someone else's change lands: everything updates, and your cursor stays with the words around it.
  const showMerged = useCallback(
    (doc: PageDoc) => {
      const active = document.activeElement
      if (active && active === titleInput.current) {
        const { value, selectionStart, selectionEnd } = titleInput.current
        remap.current = { id: TITLE, start: mapOffset(value, doc.title, selectionStart ?? 0), end: mapOffset(value, doc.title, selectionEnd ?? 0) }
      } else {
        for (const [id, input] of inputs.current) {
          if (input !== active) continue
          const next = doc.blocks.find((b) => b.id === id)?.text
          if (next !== undefined) remap.current = { id, start: mapOffset(input.value, next, input.selectionStart), end: mapOffset(input.value, next, input.selectionEnd) }
        }
      }
      show(doc)
      // What was being typed has arrived as a save.
      setDrafts((all) => {
        const left = Object.entries(all).filter(([id, draft]) => draft.text !== (id === TITLE ? doc.title : doc.blocks.find((b) => b.id === id)?.text))
        return left.length === Object.keys(all).length ? all : Object.fromEntries(left)
      })
    },
    [show],
  )

  const saved = useRef(onSaved)
  useEffect(() => {
    saved.current = onSaved
  })
  useEffect(() => {
    saver.start(setStatus, (fresh) => saved.current(fresh), showMerged)
    return () => saver.dispose()
  }, [saver, showMerged])

  // A safety net for when live updates are off or a message was missed.
  const poll = useCallback(async () => {
    try {
      saver.receive(await api.getPage(workspaceId, page.id))
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        saver.discard()
        onGone()
      }
    }
  }, [workspaceId, page.id, saver, onGone])
  useLiveRefresh(poll, isLive() ? 60_000 : 15_000)

  const onEvent = (name: string, data: unknown) => {
    const event = data as Partial<TeamPage> & { id?: number }
    if (name !== 'page' || event.id !== page.id) return
    if (!event.blocks) void poll() // too big to send live
    else if (composing.current) held.current = event as TeamPage // never disturb a word still being composed
    else saver.receive(event as TeamPage)
  }
  const onDraft = (_from: number, data: unknown) => {
    const draft = data as { page?: number; block?: string; text?: string }
    if (draft.page !== page.id || !draft.block || typeof draft.text !== 'string') return
    setDrafts((all) => ({ ...all, [draft.block!]: { text: draft.text!, at: Date.now() } }))
  }
  const { idle, touch } = useEditHold()
  const [commenting, setCommenting] = useState(false)
  const { people, sendDraft } = useWorkspaceLive(workspaceId, userId, { page: page.id, ...(focusId && !idle ? { block: focusId } : {}), ...(commenting ? { commenting } : {}) }, onEvent, onDraft)
  const others = people.filter((peer) => peer.place.page === page.id)
  // Someone's in this line: it's theirs until they finish or go idle. Everything else stays open.
  const holder = (id: string) => (focusId === id ? undefined : others.find((peer) => peer.place.block === id))
  const heldBy = (id: string) => {
    const peer = holder(id)
    const member = peer && members.find((m) => m.id === peer.id)
    return member ? tr('{name} is editing this', { name: memberName(member) }) : undefined
  }
  const together = others.length > 0
  const writers = others.filter((peer) => peer.place.commenting).map((peer) => peer.id)
  useEffect(() => saver.setTogether(together), [saver, together])

  // Letters stop showing if their save never comes.
  useEffect(() => {
    const ids = Object.keys(drafts)
    if (!ids.length) return
    const timer = setTimeout(() => {
      const fresh = Date.now() - DRAFT_LASTS_MS
      setDrafts((all) => Object.fromEntries(Object.entries(all).filter(([, draft]) => draft.at > fresh)))
    }, DRAFT_LASTS_MS)
    return () => clearTimeout(timer)
  }, [drafts])

  const typed = (id: string, text: string) => {
    touch()
    if (together) sendDraft({ page: page.id, block: id, text })
  }
  const endComposing = () => {
    composing.current = false
    const waiting = held.current
    held.current = null
    if (waiting) saver.receive(waiting)
  }

  useLayoutEffect(() => {
    const place = remap.current
    if (!place) return
    remap.current = null
    const input = place.id === TITLE ? titleInput.current : inputs.current.get(place.id)
    input?.setSelectionRange(place.start, place.end)
  }, [blocks, title])

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

  // Each file takes a moment to get ready, so they're added to the page as it is by then.
  const latest = useRef({ blocks, activeId, change })
  useEffect(() => {
    latest.current = { blocks, activeId, change }
  })

  async function addFiles(files: File[]) {
    setFileError('')
    for (const file of files) {
      try {
        const record = await uploads.start(workspaceId, file)
        const edit = insertFileBlock(latest.current.blocks, latest.current.activeId, record.id)
        latest.current.change(edit.blocks)
        latest.current.blocks = edit.blocks
        latest.current.activeId = edit.anchor
      } catch (err) {
        setFileError(`${file.name}: ${errorMessage(err)}`)
      }
    }
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

  const addOptions: { type: Exclude<BlockType, 'file'>; label: string; icon: 'text' | 'heading' | 'check' }[] = [
    { type: 'p', label: tr('Text'), icon: 'text' },
    { type: 'h', label: tr('Heading'), icon: 'heading' },
    { type: 'todo', label: tr('Checklist'), icon: 'check' },
  ]

  return (
    <>
    <section
      className={`card glass panel page-editor${dropping ? ' is-dropping' : ''}`}
      aria-label={title || tr('Untitled')}
      onDragOver={(e) => {
        if (!canEdit || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false)
      }}
      onDrop={(e) => {
        if (!canEdit || !e.dataTransfer.files.length) return
        e.preventDefault()
        setDropping(false)
        void addFiles(Array.from(e.dataTransfer.files))
      }}
    >
      {canEdit ? (
        <div className="page-title-wrap">
          {holder(TITLE) && <PeerTag id={holder(TITLE)!.id} members={members} />}
        <input
          ref={titleInput}
          readOnly={Boolean(holder(TITLE))}
          title={heldBy(TITLE)}
          className="page-title"
          aria-label={tr('Page name')}
          placeholder={tr('Untitled')}
          maxLength={120}
          value={focusId !== TITLE && drafts[TITLE] ? drafts[TITLE].text : title}
          onFocus={() => {
            if (holder(TITLE)) return
            setFocusId(TITLE)
            touch()
          }}
          onBlur={() => setFocusId(null)}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={endComposing}
          onChange={(e) => {
            setTitle(e.target.value)
            saver.edit({ title: e.target.value, blocks })
            typed(TITLE, e.target.value)
          }}
        />
        </div>
      ) : (
        <h2 className="page-title">{drafts[TITLE]?.text ?? title}</h2>
      )}

      <div className="page-bar">
        <Peers people={others} members={members} />
        <span className={`page-status${status.state === 'refused' ? ' bad' : ''}`} role="status">
          {statusText(status, canEdit)}
        </span>
        {canEdit && (
          <>
            <OptionsMenu
              label={tr('Add to this page')}
              triggerClass="text-btn"
              trigger={
                <>
                  <Icon name="plus" />
                  {tr('Add')}
                </>
              }
              options={[
                ...addOptions.map(({ type, label, icon }) => ({ icon, label, run: () => apply(insertBlock(blocks, activeId, type)) })),
                { icon: 'attach' as const, label: tr('Screenshot or file'), run: () => pickFiles((files) => void addFiles(files)) },
              ]}
            />
            <OptionsMenu label={tr('Page options')} options={[{ icon: 'trash', label: tr('Delete page'), danger: true, run: () => setDeleting(true) }]} />
          </>
        )}
      </div>

      {fileError && (
        <span className="field-error" role="alert">
          {fileError}
        </span>
      )}

      <div className="panel-scroll page-blocks">
        {blocks.map((block, index) =>
          block.type === 'file' ? (
            <div key={block.id} className="page-block is-file">
              <FileView workspaceId={workspaceId} id={block.file!} onRemove={canEdit ? () => change(blocks.filter((b) => b.id !== block.id)) : undefined} />
            </div>
          ) : canEdit ? (
            <div key={block.id} className={`page-block is-${block.type}${block.done ? ' done' : ''}`} style={{ ['--cat' as string]: 'var(--work)' }}>
              {holder(block.id) && <PeerTag id={holder(block.id)!.id} members={members} />}
              {block.type === 'todo' && (
                <button
                  type="button"
                  className={`check${block.done ? ' on' : ''}`}
                  role="checkbox"
                  disabled={Boolean(holder(block.id))}
                  aria-checked={Boolean(block.done)}
                  aria-label={`${block.done ? tr('Mark not done') : tr('Mark done')}: ${block.text || 'empty item'}`}
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
                label={block.type === 'h' ? tr('Heading') : block.type === 'todo' ? tr('Checklist item') : tr('Text')}
                placeholder={index === 0 && blocks.length === 1 ? tr('Start writing. Type # for a heading or [] for a checklist.') : ''}
                value={focusId !== block.id && drafts[block.id] ? drafts[block.id].text : block.text}
                readOnly={Boolean(holder(block.id))}
                hint={heldBy(block.id)}
                onFocus={() => {
                  setActiveId(block.id)
                  if (holder(block.id)) return
                  setFocusId(block.id)
                  touch()
                }}
                onBlur={() => setFocusId(null)}
                onCompositionStart={() => (composing.current = true)}
                onCompositionEnd={endComposing}
                onChange={(text) => {
                  change(blocks.map((b) => (b.id === block.id ? applyShortcut(b, text) : b)))
                  typed(block.id, text)
                }}
                onKeyDown={(e) => {
                  if (holder(block.id)) {
                    if (e.key === 'Enter' || e.key === 'Backspace') e.preventDefault()
                    return
                  }
                  onKeyDown(e, block, index)
                }}
                onPaste={(e) => {
                  if (holder(block.id)) {
                    e.preventDefault()
                    return
                  }
                  const files = Array.from(e.clipboardData.files)
                  if (files.length) {
                    e.preventDefault()
                    void addFiles(files)
                    return
                  }
                  const edit = pasteLines(blocks, block.id, e.currentTarget.selectionStart, e.currentTarget.selectionEnd, e.clipboardData.getData('text'))
                  if (edit) {
                    e.preventDefault()
                    apply(edit)
                  }
                }}
              />
            </div>
          ) : (
            <ReadOnlyBlock key={block.id} block={drafts[block.id] ? { ...block, text: drafts[block.id].text } : block} />
          ),
        )}
      </div>

      {deleting && (
        <ConfirmAction
          danger
          icon="trash"
          title={tr('Delete {value}?', { value: title.trim() || 'this page' })}
          confirmLabel={tr('Delete page')}
          onCancel={() => setDeleting(false)}
          onConfirm={async () => {
            await api.deletePage(workspaceId, page.id)
            saver.discard()
            setDeleting(false)
            onDeleted(page)
          }}
        >
          <p>{tr('Everyone in the workspace loses it. You can undo this right after.')}</p>
        </ConfirmAction>
      )}
    </section>

    <aside className="card glass page-side" aria-label={tr('Comments and history')}>
      <button type="button" className="flat-row page-side-toggle" aria-expanded={commentsOpen} onClick={() => setCommentsOpen((v) => !v)}>
        <span className="row-main person-name">{tr('Comments and history')}</span>
        {!commentsOpen && writers.length > 0 && <span className="task-meta">{writingLine(writers, members)}</span>}
        <Icon name="chevron" className="more-go" />
      </button>
      <div className={`page-side-body${commentsOpen ? ' open' : ''}`}>
        <Comments target={{ workspaceId, pageId: page.id }} now={now} members={members} canComment={canComment} writers={writers} onWriting={setCommenting} />
        <HistoryFold workspaceId={workspaceId} now={now} pageId={page.id} />
      </div>
    </aside>
    </>
  )
}

export function ReadOnlyBlock({ block }: { block: Block }) {
  if (block.type === 'h') return <h3 className="page-read is-h">{block.text}</h3>
  if (block.type === 'todo') {
    return (
      <div className={`page-block is-todo${block.done ? ' done' : ''}`} style={{ ['--cat' as string]: 'var(--work)' }}>
        <span className={`check${block.done ? ' on' : ''}`} role="img" aria-label={block.done ? tr('Done') : tr('Not done')}>
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
  readOnly: boolean
  /** Why it can't be edited right now. */
  hint?: string
  onFocus: () => void
  onBlur: () => void
  onCompositionStart: () => void
  onCompositionEnd: () => void
  onChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
}

/** A line of the page: as tall as its text, so the page reads as one piece of writing. */
function AutoGrowText({ ref, label, placeholder, value, readOnly, hint, onFocus, onBlur, onCompositionStart, onCompositionEnd, onChange, onKeyDown, onPaste }: AutoGrowProps) {
  const own = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const el = own.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])
  // A narrower window or a turned phone wraps the text onto more lines.
  useEffect(() => {
    const fit = () => {
      const el = own.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])
  return (
    <textarea
      ref={(el) => {
        own.current = el
        ref(el)
      }}
      className={`page-text${readOnly ? ' is-held' : ''}`}
      readOnly={readOnly}
      title={hint}
      rows={1}
      maxLength={10_000}
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onFocus={onFocus}
      onBlur={onBlur}
      onCompositionStart={onCompositionStart}
      onCompositionEnd={onCompositionEnd}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
    />
  )
}
