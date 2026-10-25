// Service worker: receives pushes from the server and shows them, even when the page is closed.

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {}
  const title = data.title || 'To-Do'

  // Safari revokes push permission if a push arrives without a visible notification.
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon.svg',
      // High-priority reminders stay on screen until you deal with them.
      requireInteraction: Boolean(data.urgent),
      data: { url: data.url || '/' },
    }),
  )
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
