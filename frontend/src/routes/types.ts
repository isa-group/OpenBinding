import type { ReactNode } from 'react';

export type ScreenLayout = 'public' | 'app';

/** One screen of the design prototype and the route that serves it. */
export interface RouteDefinition {
  /** Screen id from the prototype index (for example `case-detail`). */
  id: string;
  /** Route pattern, exactly as listed in the prototype index. */
  path: string;
  /** `app` screens live under /app and render inside the authenticated workspace layout. */
  layout: ScreenLayout;
  element: ReactNode;
  requireAuth?: boolean;
  requireAdmin?: boolean;
  /**
   * A public address that also serves signed-in people (an invitation link): it renders inside the
   * application layout when there is a session and inside the public layout when there is not.
   */
  sessionHeader?: boolean;
}

export interface ScreenOptions {
  requireAdmin?: boolean;
  sessionHeader?: boolean;
}
