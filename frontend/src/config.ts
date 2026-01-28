/**
 * Application configuration
 * Reads from environment variables with safe defaults
 */

export const config = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000',
  version: '1.0.0',
  name: 'OpenBinding',
} as const;
