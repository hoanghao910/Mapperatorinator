import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Port 5180 avoids the desktop UIs (5001/5002) and the generation API (8770).
// /api is proxied to the generation API so the future Generate tab and the
// /analyze endpoint can be called same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: { '/api': { target: 'http://127.0.0.1:8770', changeOrigin: true } },
  },
})
