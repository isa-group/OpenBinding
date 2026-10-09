import type { ReactNode } from 'react';
import { PendingScreen } from './PendingScreen';
import type { RouteDefinition, ScreenLayout, ScreenOptions, ScreenStatus } from './types';

/** Every screen under /app renders inside the authenticated workspace layout. */
export function layoutFor(path: string): ScreenLayout {
  return path === '/app' || path.startsWith('/app/') ? 'app' : 'public';
}

function define(status: ScreenStatus, id: string, path: string, element: ReactNode, options: ScreenOptions): RouteDefinition {
  const layout = layoutFor(path);
  return {
    id,
    path,
    layout,
    element,
    status,
    requireAuth: layout === 'app',
    requireAdmin: options.requireAdmin ?? false,
    paramAliases: options.paramAliases,
    sessionHeader: options.sessionHeader ?? false,
  };
}

/**
 * A screen whose page already exists. Keep one call per line with a literal id and path:
 * the end-to-end smoke test reads them straight from the domain files.
 */
export function live(id: string, path: string, element: ReactNode, options: ScreenOptions = {}): RouteDefinition {
  return define('live', id, path, element, options);
}

/** A prototype screen that has no page yet; it renders the temporary PendingScreen. */
export function pending(id: string, path: string, options: ScreenOptions = {}): RouteDefinition {
  return define('pending', id, path, <PendingScreen id={id} path={path} />, options);
}
