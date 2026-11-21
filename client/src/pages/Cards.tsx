import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, flashcards as api, type CardAnswer, type Deck, type Flashcard } from '../api'
import { ConfirmAction } from '../components/ConfirmAction'
import { Loading, SkeletonRows } from '../components/Loading'
import { OptionsMenu } from '../components/OptionsMenu'
import { SearchField } from '../components/SearchField'
import { readSpreadsheet, type ImportSheet } from '../excelImport'
import { pickFiles } from '../filesClient'
import { COMES_BACK_IN_SESSION, MAX_BACK, MAX_FRONT, planCards, waitText, type CardPlan } from '../flashcards'
import { Icon } from '../icons'
import { tr } from '../i18n'

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
const fieldError = (err: unknown, field: string) => (err instanceof ApiError && err.fields[field]?.join(' ')) || errorMessage(err)
const leftField = { width: '100%', textAlign: 'left' } as const
const SHEETS = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,.xlsx,.csv'

const cardsText = (count: number) => (count === 1 ? tr('1 card') : tr('{count} cards', { count: count.toLocaleString('en') }))
const toStudy = (deck: Deck) => deck.due_count + deck.new_count

function ErrorBanner({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <span>{error}</span>
      <button className="text-btn" onClick={onRetry}>
        {tr('Retry')}
      </button>
    </div>
  )
}

/** Your decks, how many cards each has waiting, and making a new one. */
export function Decks({ onOpen }: { onOpen: (id: number) => void }) {
  const [decks, setDecks] = useState<Deck[] | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')

  const load = useCallback(async () => {
    setError('')
    try {
      setDecks((await api.decks()).decks)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
  }, [load])

  const q = query.trim().toLowerCase()
  const shown = decks?.filter((d) => d.title.toLowerCase().includes(q)) ?? []

  return (
    <div className="panel-page">
      {error && <ErrorBanner error={error} onRetry={() => void load()} />}
      <section className="card glass panel" aria-label={tr('Flashcards')}>
        <div className="panel-top">
          <SearchField label={tr('Search decks')} placeholder={tr('Search decks')} value={query} onChange={setQuery} />
          <button
            className="primary-btn icon-only"
            aria-label={tr('New deck')}
            onClick={() => {
              setTitle('')
              setCreating(true)
            }}
          >
            <Icon name="plus" />
          </button>
        </div>
        <div className="panel-scroll">
          {decks === null ? (
            <Loading active={!error} skeleton={<SkeletonRows count={3} />} onRetry={() => void load()} />
          ) : decks.length === 0 ? (
            <p className="empty">{tr('No decks yet. Press + to make one, then add cards or import them from Excel.')}</p>
          ) : shown.length === 0 ? (
            <p className="empty">{tr('No decks match.')}</p>
          ) : (
            <ul className="row-list">
              {shown.map((deck) => (
                <li key={deck.id}>
                  <button className="flat-row" onClick={() => onOpen(deck.id)}>
                    <span className="well">
                      <Icon name="cards" />
                    </span>
                    <span className="row-main">
                      <span className="person-name">{deck.title}</span>
                      <span className="row-sub">
                        {cardsText(deck.card_count)}
                        {toStudy(deck) > 0 ? ` · ${tr('{count} to study', { count: toStudy(deck) })}` : deck.card_count > 0 ? ` · ${tr('All done for today')}` : ''}
                      </span>
                    </span>
                    {toStudy(deck) > 0 && <span className="nav-badge">{toStudy(deck)}</span>}
                    <Icon name="chevron" className="more-go" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {creating && (
        <ConfirmAction
          icon={null}
          title={tr('New deck')}
          confirmLabel={tr('Create')}
          confirmDisabled={!title.trim()}
          onCancel={() => setCreating(false)}
          onConfirm={async () => {
            try {
              const deck = await api.createDeck(title)
              setCreating(false)
              onOpen(deck.id)
            } catch (err) {
              throw new Error(fieldError(err, 'title'), { cause: err })
            }
          }}
        >
          <label className="field-group" style={leftField}>
            <span className="label">{tr('Name')}</span>
            <input data-autofocus className="field" maxLength={80} autoComplete="off" value={title} placeholder={tr('Anatomy: bones')} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </ConfirmAction>
      )}
    </div>
  )
}

type DeckDialog = { kind: 'card'; card: Flashcard | null } | { kind: 'delete-card'; card: Flashcard } | { kind: 'import' | 'rename' | 'delete' }

interface DeckProps {
  id: number
  now: Date
  notify: (title: string, detail?: string) => void
  onTitle: (title: string) => void
  onStudy: () => void
  onGone: () => void
}

/** One deck: study what's waiting, and add, import or edit its cards. */
export function DeckPage({ id, now, notify, onTitle, onStudy, onGone }: DeckProps) {
  const [deck, setDeck] = useState<(Deck & { cards: Flashcard[] }) | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<DeckDialog | null>(null)
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [title, setTitle] = useState('')

  // The page's callbacks can change on every render of the app; loading shouldn't.
  const latest = useRef({ notify, onTitle, onGone })
  useEffect(() => {
    latest.current = { notify, onTitle, onGone }
  })
  const load = useCallback(async () => {
    setError('')
    try {
      const found = await api.deck(id)
      setDeck(found)
      latest.current.onTitle(found.title)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        latest.current.notify(tr('That deck doesn\'t exist.'))
        latest.current.onGone()
        return
      }
      setError(errorMessage(err))
    }
  }, [id])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
  }, [load])

  if (!deck) {
    return (
      <div className="panel-page">
        {error && <ErrorBanner error={error} onRetry={() => void load()} />}
        <Loading active={!error} skeleton={<SkeletonRows count={4} />} onRetry={() => void load()} />
      </div>
    )
  }

  const waiting = toStudy(deck)
  const q = query.trim().toLowerCase()
  const shown = deck.cards.filter((c) => `${c.front} ${c.back}`.toLowerCase().includes(q))
  const openCard = (card: Flashcard | null) => {
    setFront(card?.front ?? '')
    setBack(card?.back ?? '')
    setDialog({ kind: 'card', card })
  }
  const nextText = (card: Flashcard) => {
    if (card.is_new) return tr('New')
    if (!card.due_at || new Date(card.due_at) <= now) return tr('Due now')
    return tr('Next in {wait}', { wait: waitText((new Date(card.due_at).getTime() - now.getTime()) / 1000) })
  }

  return (
    <div className="panel-page">
      {error && <ErrorBanner error={error} onRetry={() => void load()} />}
      <section className="card glass panel" aria-label={deck.title}>
        {deck.card_count > 0 && (
        <div className="study-start">
          <span className="row-main">
            <span className="person-name">{waiting > 0 ? tr('{count} to study', { count: waiting }) : deck.card_count ? tr('All done for today') : tr('No cards yet')}</span>
            <span className="row-sub">
              {deck.card_count === 0
                ? tr('Add cards with +, or import a sheet.')
                : waiting > 0
                  ? [deck.due_count && tr('{count} to review', { count: deck.due_count }), deck.new_count && tr('{count} new', { count: deck.new_count })].filter(Boolean).join(' · ')
                  : tr('Come back later. Cards return when you\'re about to forget them.')}
            </span>
          </span>
          {waiting > 0 && (
            <button className="primary-btn" onClick={onStudy}>
              <Icon name="play" />
              {tr('Study')}
            </button>
          )}
        </div>
        )}

        <div className="panel-top">
          <SearchField label={tr('Search cards')} placeholder={tr('Search cards')} value={query} onChange={setQuery} />
          <button className="primary-btn icon-only" aria-label={tr('New card')} onClick={() => openCard(null)}>
            <Icon name="plus" />
          </button>
          <OptionsMenu
            label={tr('Deck options')}
            options={[
              { icon: 'table', label: tr('Import from Excel'), run: () => setDialog({ kind: 'import' }) },
              {
                icon: 'edit',
                label: tr('Rename'),
                run: () => {
                  setTitle(deck.title)
                  setDialog({ kind: 'rename' })
                },
              },
              { icon: 'trash', label: tr('Delete deck'), danger: true, run: () => setDialog({ kind: 'delete' }) },
            ]}
          />
        </div>

        <div className="panel-scroll">
          {deck.cards.length === 0 ? (
            <p className="empty">{tr('No cards yet. Write the question on the front and the answer on the back.')}</p>
          ) : shown.length === 0 ? (
            <p className="empty">{tr('No cards match.')}</p>
          ) : (
            <>
              <h3 className="section-label">{cardsText(deck.cards.length)}</h3>
              <ul className="row-list">
                {shown.map((card) => (
                  <li key={card.id}>
                    <button className="flat-row card-row" onClick={() => openCard(card)}>
                      <span className="row-main">
                        <span className="person-name">{card.front}</span>
                        <span className="row-sub">{card.back}</span>
                      </span>
                      <span className={`badge ${card.is_new ? 'badge-new' : 'badge-inactive'}`}>{nextText(card)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>

      {dialog?.kind === 'card' && (
        <ConfirmAction
          icon={null}
          title={dialog.card ? tr('Edit card') : tr('New card')}
          confirmLabel={dialog.card ? tr('Save') : tr('Add')}
          confirmDisabled={!front.trim() || !back.trim()}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            if (dialog.card) {
              await api.editCard(dialog.card.id, front, back)
              setDialog(null)
            } else {
              await api.addCard(id, front, back)
              // Keep the dialog open for the next card: making a deck is usually many in a row.
              setFront('')
              setBack('')
              notify(tr('Card added'))
              document.querySelector<HTMLTextAreaElement>('.card-side[data-autofocus]')?.focus()
            }
            await load()
          }}
        >
          <label className="field-group" style={leftField}>
            <span className="label">{tr('Front of the card')}</span>
            <textarea data-autofocus className="field card-side" rows={2} maxLength={MAX_FRONT} value={front} placeholder={tr('Question or word')} onChange={(e) => setFront(e.target.value)} />
          </label>
          <label className="field-group" style={leftField}>
            <span className="label">{tr('Back of the card')}</span>
            <textarea className="field card-side" rows={3} maxLength={MAX_BACK} value={back} placeholder={tr('Answer')} onChange={(e) => setBack(e.target.value)} />
          </label>
          {dialog.card && (
            <button type="button" className="text-btn danger-text" onClick={() => setDialog({ kind: 'delete-card', card: dialog.card! })}>
              {tr('Delete card')}
            </button>
          )}
        </ConfirmAction>
      )}

      {dialog?.kind === 'delete-card' && (
        <ConfirmAction
          danger
          icon="trash"
          title={tr('Delete this card?')}
          confirmLabel={tr('Delete')}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            await api.deleteCard(dialog.card.id)
            setDialog(null)
            await load()
          }}
        >
          <p>{dialog.card.front}</p>
        </ConfirmAction>
      )}

      {dialog?.kind === 'rename' && (
        <ConfirmAction
          icon={null}
          title={tr('Rename deck')}
          confirmLabel={tr('Save')}
          confirmDisabled={!title.trim()}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            try {
              await api.renameDeck(id, title)
            } catch (err) {
              throw new Error(fieldError(err, 'title'), { cause: err })
            }
            setDialog(null)
            await load()
          }}
        >
          <label className="field-group" style={leftField}>
            <span className="label">{tr('Name')}</span>
            <input data-autofocus className="field" maxLength={80} autoComplete="off" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </ConfirmAction>
      )}

      {dialog?.kind === 'delete' && (
        <ConfirmAction
          danger
          icon="trash"
          title={tr('Delete "{title}"?', { title: deck.title })}
          confirmLabel={tr('Delete deck')}
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            await api.deleteDeck(id)
            notify(tr('Deck deleted'))
            onGone()
          }}
        >
          <p>{tr('Its {cards} and your progress on them are deleted too. This can\'t be undone.', { cards: cardsText(deck.card_count) })}</p>
        </ConfirmAction>
      )}

      {dialog?.kind === 'import' && (
        <ImportCards
          deckId={id}
          onCancel={() => setDialog(null)}
          onDone={async (added) => {
            setDialog(null)
            notify(added === 1 ? tr('1 card added') : tr('{count} cards added', { count: added.toLocaleString('en') }))
            await load()
          }}
        />
      )}
    </div>
  )
}

/** A sheet of cards: column A is the front, column B the back. */
function ImportCards({ deckId, onCancel, onDone }: { deckId: number; onCancel: () => void; onDone: (added: number) => Promise<void> }) {
  const [fileName, setFileName] = useState('')
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [sheets, setSheets] = useState<ImportSheet[]>([])
  const [sheet, setSheet] = useState(0)
  const [plan, setPlan] = useState<CardPlan | null>(null)

  async function read(file: File) {
    setFileName(file.name)
    setError('')
    setSheets([])
    setSheet(0)
    setPlan(null)
    setReading(true)
    try {
      const found = await readSpreadsheet(file)
      setSheets(found)
      setPlan(planCards(found[0]?.data ?? []))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setReading(false)
    }
  }

  const problem = error || plan?.problem
  return (
    <ConfirmAction
      icon={null}
      title={tr('Import cards')}
      confirmLabel={tr('Import')}
      confirmDisabled={!plan || Boolean(plan.problem)}
      onCancel={onCancel}
      onConfirm={async () => {
        if (!plan) return
        const { added } = await api.importCards(deckId, plan.cards)
        await onDone(added)
      }}
    >
      <div className="import-file" style={leftField}>
        <p className="row-sub wrap">{tr('Column A is the front of each card, column B the back. A header row like "Front | Back" is skipped.')}</p>
        <button type="button" data-autofocus className={`field import-pick${fileName ? ' has-file' : ''}`} disabled={reading} onClick={() => pickFiles(([file]) => file && void read(file), { accept: SHEETS })}>
          <Icon name="file" />
          <span>{reading ? tr('Reading…') : fileName || tr('Choose a file')}</span>
        </button>
        {sheets.length > 1 && (
          <label className="field-group">
            <span className="label">{tr('Sheet')}</span>
            <select
              className="field"
              value={sheet}
              onChange={(e) => {
                const index = Number(e.target.value)
                setSheet(index)
                setPlan(planCards(sheets[index].data))
              }}
            >
              {sheets.map((one, index) => (
                <option key={one.name} value={index}>
                  {one.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {problem ? (
          <span className="field-error" role="alert">
            {problem}
          </span>
        ) : (
          plan && (
            <div className="import-preview" role="status">
              <span className="person-name">{cardsText(plan.cards.length)}</span>
              <span className="row-sub">
                {plan.cards[0][0]} → {plan.cards[0][1]}
              </span>
            </div>
          )
        )}
      </div>
    </ConfirmAction>
  )
}

const ANSWERS: { answer: CardAnswer; label: string; key: string }[] = [
  { answer: 'again', label: tr('Again'), key: '1' },
  { answer: 'hard', label: tr('Hard'), key: '2' },
  { answer: 'good', label: tr('Good'), key: '3' },
  { answer: 'easy', label: tr('Easy'), key: '4' },
]

/** Studying: the front, then the answer, then how well you knew it. */
export function Study({ id, notify, onTitle, onDone }: { id: number; notify: (title: string, detail?: string) => void; onTitle: (title: string) => void; onDone: () => void }) {
  const [queue, setQueue] = useState<Flashcard[] | null>(null)
  const [error, setError] = useState('')
  const [shown, setShown] = useState(false)
  const [answered, setAnswered] = useState(0)
  // Each card's first answer this sitting: how many you went through, and how many you knew.
  const [firstAnswers, setFirstAnswers] = useState<Map<number, CardAnswer>>(new Map())
  const [sending, setSending] = useState(0)
  const answerRef = useRef<HTMLButtonElement>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const found = await api.study(id)
      onTitle(found.deck.title)
      setQueue(found.cards)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [id, onTitle])
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
    void load()
  }, [load])

  const card = queue?.[0]

  const answer = useCallback(
    (choice: CardAnswer) => {
      if (!card) return
      setQueue((q) => q && q.slice(1))
      setShown(false)
      setAnswered((n) => n + 1)
      setFirstAnswers((seen) => (seen.has(card.id) ? seen : new Map(seen).set(card.id, choice)))
      setSending((n) => n + 1)
      api
        .review(card.id, choice)
        .then((updated) => {
          // Cards you're still learning come back in a few minutes, so they stay in this sitting.
          const wait = updated.due_at ? (new Date(updated.due_at).getTime() - Date.now()) / 1000 : Infinity
          if (wait <= COMES_BACK_IN_SESSION) setQueue((q) => q && [...q, updated])
        })
        .catch((err) => {
          notify(tr('That answer wasn\'t saved'), errorMessage(err))
          setQueue((q) => q && [...q, card])
          setAnswered((n) => n - 1)
        })
        .finally(() => setSending((n) => n - 1))
    },
    [card, notify],
  )

  // Space shows the answer; 1-4 grade it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!card || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, select')) return
      if (!shown && (e.key === ' ' || e.key === 'Enter')) {
        e.preventDefault()
        setShown(true)
        return
      }
      const picked = shown && ANSWERS.find((a) => a.key === e.key)
      if (picked) answer(picked.answer)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [card, shown, answer])

  useEffect(() => {
    if (shown) answerRef.current?.focus()
  }, [shown])

  if (queue === null) {
    return (
      <div className="panel-page">
        {error && <ErrorBanner error={error} onRetry={() => void load()} />}
        <Loading active={!error} skeleton={<SkeletonRows count={2} />} onRetry={() => void load()} />
      </div>
    )
  }

  if (!card) {
    // Waiting for the last answers: one of them may come back to this sitting.
    if (sending > 0) return <div className="panel-page"><Loading skeleton={<SkeletonRows count={2} />} /></div>
    return (
      <div className="panel-page">
        <section className="card glass panel study-done">
          <span className="confirm-icon" aria-hidden="true">
            <Icon name="check" />
          </span>
          <h2>{answered ? tr('Done for now') : tr('Nothing to study right now')}</h2>
          <p className="row-sub wrap">
            {answered
              ? tr('You went through {cards} and knew {known} of them. They come back when you\'re about to forget them.', { cards: cardsText(firstAnswers.size), known: [...firstAnswers.values()].filter((a) => a !== 'again').length })
              : tr('Cards come back when you\'re about to forget them. Add new cards to keep going.')}
          </p>
          <button className="primary-btn" onClick={onDone}>
            {tr('Back to deck')}
          </button>
        </section>
      </div>
    )
  }

  const total = answered + queue.length
  return (
    <div className="panel-page">
      <section className="card glass panel study" aria-label={tr('Study')}>
        <div className="study-progress">
          <span className="row-sub">{tr('{done} of {total}', { done: answered + 1, total })}</span>
          <span className="study-bar" aria-hidden="true">
            <span style={{ width: `${(answered / total) * 100}%` }} />
          </span>
          {card.is_new && <span className="badge badge-new">{tr('New')}</span>}
        </div>

        <div className="flashcard" aria-live="polite">
          <p className="flashcard-front">{card.front}</p>
          {shown && (
            <>
              <hr />
              <p className="flashcard-back">{card.back}</p>
            </>
          )}
        </div>

        {shown ? (
          <div className="grades" role="group" aria-label={tr('How well did you know it?')}>
            {ANSWERS.map((a) => (
              <button key={a.answer} ref={a.answer === 'good' ? answerRef : undefined} className={`row-btn grade grade-${a.answer}`} onClick={() => answer(a.answer)}>
                <span>{a.label}</span>
                <span className="row-sub">{card.previews ? waitText(card.previews[a.answer]) : ''}</span>
              </button>
            ))}
          </div>
        ) : (
          <button className="primary-btn show-answer" onClick={() => setShown(true)}>
            {tr('Show answer')}
          </button>
        )}
      </section>
    </div>
  )
}
