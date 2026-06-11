import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Stamped into the bundle AND written to /version.json at build time. The
// app polls version.json and prompts a reload when they diverge — long-lived
// SPA tabs were silently running days-old code ("the popup shows nothing"
// while the deployed fix sat unloaded, 2026-06-11).
const BUILD_ID = Date.now().toString(36)

const emitVersionJson = () => ({
  name: 'emit-version-json',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) })
  },
})

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [react(), tailwindcss(), emitVersionJson()],
  build: {
    // Keep chunks under the 500kb warning threshold by splitting out heavy
    // vendor libs. Gives us long-term browser caching: a SetterOverview edit
    // no longer busts the recharts / dnd-kit cache.
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          'charts-vendor': ['recharts'],
          'dnd-vendor': ['@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities'],
          'supabase-vendor': ['@supabase/supabase-js'],
        },
      },
    },
  },
})
