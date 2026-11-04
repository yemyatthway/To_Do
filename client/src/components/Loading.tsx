import type { CSSProperties, ReactNode } from 'react'
import { useLoadingStage } from './loadingStage'
import { tr } from '../i18n'

/**
 * What to show while something loads: nothing under a second, then `skeleton` (the shape of what's
 * coming), then past ten seconds "Still working…" too, with a way to try again.
 */
export function Loading({ active = true, skeleton, onRetry, quiet }: { active?: boolean; skeleton: ReactNode; onRetry?: () => void; quiet?: boolean }) {
  const { stage, restart } = useLoadingStage(active)
  if (stage === 'hidden') return null
  return (
    <div className="loading" role="status" aria-busy="true" aria-label={tr('Loading')}>
      <div aria-hidden="true">{skeleton}</div>
      {stage === 'slow' && !quiet && (
        <div className="still-working">
          <span>{tr('Still working…')}</span>
          {onRetry && (
            <button
              type="button"
              className="text-btn"
              onClick={() => {
                restart()
                onRetry()
              }}
            >
              {tr('Try again')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const reload = () => window.location.reload()

/** For screens and code still downloading, where starting over is the only retry there is. */
export function LoadingPage({ skeleton }: { skeleton: ReactNode }) {
  return <Loading skeleton={skeleton} onRetry={reload} />
}

export function Bone({ width = '100%', height = 14, round, style }: { width?: number | string; height?: number | string; round?: boolean; style?: CSSProperties }) {
  return <span className={`bone${round ? ' round' : ''}`} style={{ width, height, ...style }} />
}

/** Rows like a task or a person: an optional circle, then a title and a shorter line. */
export function SkeletonRows({ count = 4, avatar = false }: { count?: number; avatar?: boolean }) {
  const widths = ['62%', '48%', '70%', '55%', '66%', '44%']
  return (
    <div className="skeleton-rows">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton-row">
          <Bone width={avatar ? 40 : 26} height={avatar ? 40 : 26} round />
          <div className="skeleton-lines">
            <Bone width={widths[i % widths.length]} height={13} />
            <Bone width="34%" height={10} />
          </div>
        </div>
      ))}
    </div>
  )
}

/** The Clock screen: the dial beside the list. */
export function HomeSkeleton() {
  return (
    <div className="home">
      <section className="clock-panel">
        <Bone width={180} height={36} style={{ borderRadius: 14 }} />
        <Bone width="min(100%, 340px)" height="auto" round style={{ aspectRatio: '1' }} />
      </section>
      <section className="list-panel glass">
        <Bone width="40%" height={18} />
        <Bone height={10} />
        <SkeletonRows count={4} />
      </section>
    </div>
  )
}

/** Any screen made of cards, while its code or data arrives. */
export function CardsSkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <div className="skeleton-cards">
      {Array.from({ length: cards }, (_, i) => (
        <section key={i} className="card glass">
          <Bone width="36%" height={18} />
          <SkeletonRows count={3} />
        </section>
      ))}
    </div>
  )
}

/** The first moment after opening the app: the top of the page and the Clock screen. */
export function AppSkeleton() {
  return (
    <div className="app">
      <div className="skeleton-header">
        <Bone width={110} height={12} />
        <Bone width={210} height={28} />
      </div>
      <HomeSkeleton />
    </div>
  )
}

/** A chat opening: bubbles on both sides. */
export function ThreadSkeleton() {
  return (
    <div className="skeleton-thread">
      <Bone width="52%" height={38} style={{ borderRadius: 18 }} />
      <Bone width="38%" height={38} style={{ borderRadius: 18, alignSelf: 'flex-end' }} />
      <Bone width="64%" height={58} style={{ borderRadius: 18 }} />
      <Bone width="46%" height={38} style={{ borderRadius: 18, alignSelf: 'flex-end' }} />
    </div>
  )
}
