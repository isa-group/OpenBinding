// The Tailwind plugin and the `/api` dev proxy follow SPHERE frontend/vite.config.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The gateway the dev server forwards `/api` to. Overridable, as in SPHERE, when :8000 is taken.
const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // The gateway serves its routes at the root; the lab's nginx strips `/api/` the same way
      // (frontend/nginx.lab.conf), so `VITE_API_BASE_URL=/api` behaves alike in dev and in the lab.
      '/api': {
        target: API_PROXY_TARGET,
        changeOrigin: true,
        rewrite: path => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    testTimeout: 15000,
  },
});
