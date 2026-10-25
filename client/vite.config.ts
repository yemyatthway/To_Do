import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Forward API calls to Django so the browser sees one origin.
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
  // Same for `npm run preview` (the production build served locally).
  preview: {
    proxy: {
      '/api': 'http://127.0.0.1:8000',
    },
  },
})
