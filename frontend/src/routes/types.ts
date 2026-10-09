import type { ReactNode } from 'react';

export type ScreenLayout = 'public' | 'app';
export type ScreenStatus = 'live' | 'pending';

/** One screen of the design prototype and the route that serves it. */
export interface RouteDefinition {
  /** Screen id from the prototype index (for example `case-detail`). */
  id: string;
  /** Route pattern, exactly as listed in the prototype index. */
  path: string;
  /** `app` screens live under /app and render inside the authenticated workspace layout. */
  layout: ScreenLayout;
  element: ReactNode;
  /** `pending` screens render the temporary PendingScreen until their page is rebuilt. */
  status: ScreenStatus;
  requireAuth?: boolean;
  requireAdmin?: boolean;
  /**
   * Parameter names the existing page still reads, keyed by the prototype name
   * (`{ case: 'caseSlug' }`). Lets a page keep working while its route moves to the new pattern.
   */
  paramAliases?: Record<string, string>;
  /**
   * A public address that also serves signed-in people (an invitation link): it renders inside the
   * application layout when there is a session and inside the public layout when there is not.
   */
  sessionHeader?: boolean;
}

export interface ScreenOptions {
  requireAdmin?: boolean;
  paramAliases?: Record<string, string>;
  sessionHeader?: boolean;
}
