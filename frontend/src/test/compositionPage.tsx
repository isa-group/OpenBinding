/* eslint-disable react-refresh/only-export-components -- a test kit, never hot-reloaded */
import type { ReactElement } from 'react';
import type { Mock } from 'vitest';
import type { UserProfile } from '../modules/core/api/account';
import type { Organization } from '../modules/organization/api/organizationsApi';
import { renderModule } from './moduleKit';

// Rendering the composition card page (`/compositions/:org/:composition/:tab?`) in a test: the account's organizations
// (which decide its role on the page), the address, and a stand-in for anything else the page leads to.

export function renderCompositionPage(
  ui: ReactElement,
  options: { url: string; organizations?: unknown[]; user?: UserProfile | null; gateway?: Mock }
) {
  return renderModule(ui, {
    path: '/compositions/:org/:composition/:tab?',
    entry: options.url,
    tree: (options.organizations ?? []) as Organization[],
    user: options.user,
    gateway: options.gateway,
    routes: { '*': <p>elsewhere</p> },
  });
}
