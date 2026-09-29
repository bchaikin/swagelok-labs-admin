import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // `npm --prefix api run dev` serves the Lambda handler locally on :8788.
    proxy: { '/api': { target: 'http://127.0.0.1:8788', changeOrigin: false } },
  },
})
