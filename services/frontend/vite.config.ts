import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const devHost = process.env.YLW_VITE_DEV_HOST?.trim() || '127.0.0.1'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: devHost,
    port: 5173,
    fs: {
      strict: true,
      allow: [],
    },
  },
})
