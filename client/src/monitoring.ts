/**
 * Error alerts (Sentry), only when VITE_SENTRY_DSN is set. It's loaded after the app starts, so it
 * adds nothing to the first screen. Reports hold the error and where it happened: no messages,
 * task text, search terms or who was signed in.
 */
type Sentry = typeof import('@sentry/browser')

let sentry: Sentry | null = null

export function startMonitoring() {
  const dsn = import.meta.env.VITE_SENTRY_DSN
  if (!dsn) return
  void import('@sentry/browser')
    .then((module) => {
      module.init({
        dsn,
        maxBreadcrumbs: 0, // they'd include clicks, console output and addresses
        defaultIntegrations: false,
        // Browsers say this when a resize takes one extra frame to settle. Nothing is broken and nobody sees it.
        ignoreErrors: [/ResizeObserver loop/],
        integrations: [module.globalHandlersIntegration(), module.linkedErrorsIntegration(), module.dedupeIntegration()],
        beforeSend(event) {
          delete event.user
          if (event.request?.url) event.request = { url: event.request.url.split(/[?#]/)[0] }
          return event
        },
      })
      sentry = module
    })
    .catch(() => undefined) // alerts must never get in the way of the app
}

export function reportError(error: unknown) {
  sentry?.captureException(error)
}
