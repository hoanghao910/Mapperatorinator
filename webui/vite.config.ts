import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Port 5180 avoids the desktop UIs (5001/5002) and the generation API (8771).
// /api is proxied to the generation API so the Generate tab and the /analyze
// endpoint can be called same-origin.
// NOTE: the API runs on 8771, NOT 8770 — on macOS port 8770 (dpap) is held by
// Apple's `sharingd`, so proxying there returns a 500. Keep this in sync with
// run_api.sh's default PORT.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    // The API serves routes at the root (/analyze, /health, /jobs …) with no
    // /api prefix, so strip it here: /api/analyze/upload → /analyze/upload.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8771',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
})
