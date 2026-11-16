import { Suspense, useEffect, useMemo } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import type { Organization } from '../api/platform';
import { PlanChangedNotice } from '../components/PlanChangedNotice/PlanChangedNotice';
import { RouteFallback } from '../components/PlatformShell/RouteFallback';
import { workspaceSlugs } from '../components/PlatformShell/workspacePath';
import { rememberOrganization } from '../features/workspace/lastOrganization';
import ErrorBoundary from '../modules/core/components/error-boundary';
import { useOrganization } from '../modules/organization/hooks/useOrganization';

/** What the screens under /app read from their outlet, as the old workspace shell handed it to them. */
export interface PlatformOutletContext {
  organizations: Organization[];
  /** The organization the address names, else the account's first one. */
  organization?: Organization;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * The screens not yet poured into SPHERE's pages (everything under /app) read their organizations from the outlet context of
 * the old workspace shell. This outlet builds that context from SPHERE's OrganizationContext and the address, and keeps the
 * shell's other duties: the workspace error, the plan-changed notice, the error boundary and the loading fallback. It goes
 * with the last screen that reads the context (D8).
 */
export function LegacyOrgOutlet({ workspace = false }: { workspace?: boolean }) {
  const location = useLocation();
  const { org } = workspaceSlugs(location.pathname);
  const { organizations, isLoading, error, refresh } = useOrganization();

  // The organization the address names, once it is one of the account's: Home shows its recent runs.
  useEffect(() => {
    if (org && organizations.some(item => item.slug === org)) rememberOrganization(org);
  }, [org, organizations]);

  const organization =
    (org ? organizations.find(item => item.slug === org) : null) ?? organizations[0];
  const context = useMemo<PlatformOutletContext>(
    () => ({ organizations, organization, loading: isLoading, reload: refresh }),
    [organizations, organization, isLoading, refresh]
  );

  return (
    <>
      {error && (
        <div className="mx-auto mt-4 w-full max-w-7xl px-4 md:px-6" role="alert">
          <p className="rounded-md border border-tp-severity-error-border bg-tp-severity-error-bg px-4 py-3 text-sm text-tp-error-text">
            {error}
          </p>
        </div>
      )}
      {/* A plan changed by signing in is told once, on the workspace screen the person lands on; Identities tells it itself. */}
      {workspace && location.pathname !== '/app/account/identities' && (
        <div className="mx-auto w-full max-w-7xl px-4 md:px-6">
          <PlanChangedNotice className="platform-plan-notice" />
        </div>
      )}
      <ErrorBoundary resetKey={location.pathname}>
        <Suspense fallback={<RouteFallback />}>
          <Outlet context={context} key={location.pathname} />
        </Suspense>
      </ErrorBoundary>
    </>
  );
}
