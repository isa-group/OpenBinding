/**
 * Application configuration
 * Reads from environment variables with safe defaults
 */

export const config = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000',
  spaceFrontendUrl: import.meta.env.VITE_SPACE_FRONTEND_URL || 'http://localhost:5174',
  version: '1.0.0',
  name: 'OpenBinding',
} as const;
