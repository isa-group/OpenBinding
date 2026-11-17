import type { ReactElement, ReactNode } from 'react';
import type { Mock } from 'vitest';
import type { UserProfile } from '../modules/core/api/account';
import type { Problem, ProblemRevision } from '../modules/problem/api/problemsClient';
import type { Organization } from '../modules/organization/api/organizationsApi';
import { fakeGateway, orgNode, type Answer } from './moduleKit';
import { renderModule } from './moduleKit';

// Rendering the problem module's screens in a test: the problem card page (`/problems/:org/:problem/:tab?`) with the
// account's organizations (which decide its role and whether the problem can be read), a gateway that answers the problem and
// its revisions, and a stand-in for anything else the page leads to.

export const PROBLEM_AUTHOR = '00000000-0000-4000-8000-000000000005';

/** A problem of an organization, as the gateway reads it. */
export function problemOf(
  slug: string,
  name = slug,
  over: Partial<Problem> & { revision_count?: number } = {}
): Problem & { revision_count: number } {
  return {
    id: `case-${slug}`,
    organization_id: 'org-isa',
    slug,
    name,
    description: '',
    created_by_id: PROBLEM_AUTHOR,
    created_at: '2026-04-02T00:00:00Z',
    updated_at: '2026-04-02T00:00:00Z',
    revision_count: 0,
    ...over,
  };
}

/** A sealed revision of a problem, uploaded on the day of its number. */
export function versionOf(
  problem: Problem,
  revision: number,
  over: Partial<ProblemRevision & { origin: string }> = {}
): ProblemRevision & { origin: 'upload' | 'editor' | 'qacoforge' | 'sphere' } {
  return {
    id: `${problem.id}-r${revision}`,
    problem_id: problem.id,
    revision,
    package_digest: `sha256-${String(revision).repeat(64)}`.slice(0, 71),
    package_size: 2048,
    created_by_id: PROBLEM_AUTHOR,
    created_at: `2026-04-0${revision}T00:00:00Z`,
    origin: 'upload',
    ...over,
  } as ProblemRevision & { origin: 'upload' };
}

/** The gateway's answers for one problem and its revisions (newest first, as the gateway lists them), plus `extra`. */
export function problemGateway(
  org: string,
  problem: Problem,
  revisions: ProblemRevision[],
  extra: Record<string, Answer> = {}
): Mock {
  const root = `/v1/organizations/${org}/problems/${problem.slug}`;
  return fakeGateway({
    [`GET ${root}`]: { body: problem, headers: { ETag: 'W/"1"' } },
    [`GET ${root}/revisions`]: {
      body: [...revisions].sort((a, b) => b.revision - a.revision),
    },
    ...extra,
  });
}

/** An organization of the account, with its role. */
export const memberOf = (slug: string, role: Organization['effective_role'], name?: string) =>
  orgNode(slug, { effective_role: role, ...(name ? { name } : {}) });

export function renderProblemPage(
  ui: ReactElement,
  options: {
    url: string;
    organizations?: Organization[];
    user?: UserProfile | null;
    gateway?: Mock;
    routes?: Record<string, ReactNode>;
  }
) {
  return renderModule(ui, {
    path: '/problems/:org/:problem/:tab?',
    entry: options.url,
    tree: options.organizations ?? [],
    user: options.user,
    gateway: options.gateway,
    routes: { '*': <p>elsewhere</p>, ...options.routes },
  });
}
