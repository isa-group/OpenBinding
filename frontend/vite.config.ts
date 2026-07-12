import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Example instances live in the repository's examples/ directory and are
      // served by nginx (see docker-compose.yml). Proxying keeps `npm run dev`
      // fully functional when the dev stack is up; without nginx the examples
      // dropdown simply fails to fetch, as before.
      '/examples': {
        // Inside docker compose the nginx service is reachable as nginx-dev;
        // locally it is exposed on localhost:80.
        target: process.env.EXAMPLES_PROXY_TARGET || 'http://localhost:80',
        changeOrigin: true,
      },
    },
  },
})
