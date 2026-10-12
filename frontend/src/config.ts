/**
 * Application configuration
 * Reads from environment variables with safe defaults
 */

export const config = {
  apiBaseUrl: import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000',
  /** The native SPACE console, where pricings, plans and contracts are administered. */
  spaceFrontendUrl: import.meta.env.VITE_SPACE_FRONTEND_URL || 'https://space.score.us.es',
  /** The native SPHERE console, where pricing versions are published. Public address, never a key. */
  sphereUrl: import.meta.env.VITE_SPHERE_URL || 'https://sphere.score.us.es',
  version: '1.0.0',
  name: 'OpenBinding',
} as const;
