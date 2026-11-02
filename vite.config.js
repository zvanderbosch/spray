import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  // The '' prefix loads every variable, not just VITE_-prefixed ones.
  // That's safe here because this runs only in the config, never in browser code.
  const env = loadEnv(mode, process.cwd(), '')

  const allowedHosts = (env.ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)

  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: '0.0.0.0',
      port: 3000,
      proxy: {
        '/api': {
          target: 'http://localhost:3001',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
        '/uploads': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
      allowedHosts,
    },
  }
})