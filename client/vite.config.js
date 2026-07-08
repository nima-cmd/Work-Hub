import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In dev (`npm run dev`), Vite serves the UI on 5173 and proxies /api to the
// Express server on 3001. In production the Express server serves the built
// files itself, so no proxy is needed.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:3001' },
  },
})
