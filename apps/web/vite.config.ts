import react from '@vitejs/plugin-react'
import { defaultClientConditions, defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // Workspace packages are bundled from their TypeScript sources (condition "source").
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/readyz': 'http://localhost:3000',
    },
  },
  build: { target: 'es2022', sourcemap: true },
})
