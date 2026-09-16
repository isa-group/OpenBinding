import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 15000,
    hookTimeout: 15000,
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    coverage: { reporter: ['text', 'json-summary'] },
  },
});
