import { gsap } from 'gsap'
import { useLayoutEffect, type DependencyList, type RefObject } from 'react'

/**
 * GSAP setup. Everything animates transform/opacity only (GPU-friendly, no layout work),
 * and people who ask their device for reduced motion get instant changes instead.
 */
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
const applyMotionPreference = () => gsap.globalTimeline.timeScale(reduced.matches ? 1000 : 1)
applyMotionPreference()
reduced.addEventListener('change', applyMotionPreference)

// A new tween on an element takes over from any running one instead of fighting it.
gsap.defaults({ ease: 'power3.out', duration: 0.4, overwrite: 'auto' })

export { gsap }

/** Fade-and-rise in, one after another. */
export function enter(targets: gsap.TweenTarget, vars: gsap.TweenVars = {}) {
  return gsap.fromTo(
    targets,
    { autoAlpha: 0, y: 16 },
    { autoAlpha: 1, y: 0, stagger: 0.06, duration: 0.5, ease: 'power3.out', clearProps: 'transform,opacity,visibility', ...vars },
  )
}

/**
 * Run animations scoped to `scope`, and undo them on cleanup. React may run an effect twice
 * (dev Strict Mode, fast re-renders); reverting first means the second run starts clean
 * instead of jumping into the middle of the first.
 */
export function useGsap(scope: RefObject<Element | null>, animate: () => void, deps: DependencyList) {
  useLayoutEffect(() => {
    const ctx = gsap.context(animate, scope.current ?? undefined)
    return () => ctx.revert()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
