import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// VITE_BASE is set by the GitHub Pages workflow (e.g. "/abl-token-engine/"); locally it stays "/".
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '')
  return {
    plugins: [react()],
    base: env.VITE_BASE || '/',
    server: { port: 5173 },
  }
})
