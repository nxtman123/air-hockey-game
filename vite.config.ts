import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    react(),
    // Suppress the dev server URL banner — TelemetryOS apps run inside a host (the Developer App during development), not by visiting a URL.
    {
      name: 'suppress-urls',
      configureServer(server) {
        return () => {
          server.printUrls = () => { }
        }
      },
    },
  ],
})
