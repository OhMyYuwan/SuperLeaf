import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const devHost = process.env.YLW_VITE_DEV_HOST?.trim() || '127.0.0.1'
const frontendRoot = dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: devHost,
    port: 5173,
    fs: {
      strict: true,
      allow: [frontendRoot],
    },
  },
})
