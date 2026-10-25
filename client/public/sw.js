// Service worker: receives pushes from the server and shows them, even when the page is closed.

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {}
  const title = data.title || 'To-Do'

  // Tell any open To-Do window, so it refreshes what changed right away (no waiting for a poll).
  const tellOpenApps = self.clients
    .matchAll({ type: 'window', includeUncontrolled: true })
    .then((windows) => windows.forEach((w) => w.postMessage({ type: 'push', url: data.url || '/' })))

  // Safari revokes push permission if a push arrives without a visible notification.
  const show = self.registration.showNotification(title, {
    body: data.body || '',
    icon: '/icon.svg',
    // High-priority reminders stay on screen until you deal with them.
    requireInteraction: Boolean(data.urgent),
    data: { url: data.url || '/' },
  })

  event.waitUntil(Promise.all([show, tellOpenApps]))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = event.notification.data?.url || '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).pathname === url)
      return open ? open.focus() : self.clients.openWindow(url)
    }),
  )
})
