import type { ReactNode } from 'react';
import type { RouteDefinition, ScreenLayout, ScreenOptions } from './types';

/** Every screen under /app renders inside the authenticated workspace layout. */
export function layoutFor(path: string): ScreenLayout {
  return path === '/app' || path.startsWith('/app/') ? 'app' : 'public';
}

/**
 * A screen of the application. Keep one call per line with a literal id and path:
 * the end-to-end smoke test and the QA gallery read them straight from the area files (routes/areas).
 */
export function live(id: string, path: string, element: ReactNode, options: ScreenOptions = {}): RouteDefinition {
  const layout = layoutFor(path);
  return {
    id,
    path,
    layout,
    element,
    requireAuth: layout === 'app',
    requireAdmin: options.requireAdmin ?? false,
    sessionHeader: options.sessionHeader ?? false,
  };
}
