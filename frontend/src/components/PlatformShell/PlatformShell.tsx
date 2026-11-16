import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { platformApi } from '../../api/platform';
import type { Organization } from '../../api/platform';
import { PlanChangedNotice } from '../PlanChangedNotice/PlanChangedNotice';
import { SiteFooter } from '../SiteFooter/SiteFooter';
import ErrorBoundary from '../../modules/core/components/error-boundary';
import { AppHeader } from './AppHeader';
import { RouteFallback } from './RouteFallback';
import { workspaceSlugs } from './workspacePath';
import { rememberOrganization } from '../../features/workspace/lastOrganization';
import './PlatformShell.css';

export interface PlatformOutletContext {
  organizations: Organization[];
  /** The organization the address names, else the account's first one. */
  organization?: Organization;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * Layout of every authenticated screen (exported as AppLayout): application header, the
 * screen itself and the site footer. It loads the account's organizations and hands them, with
 * the one the URL names, to the screens through the outlet context.
 */
export function PlatformShell() {
  const location = useLocation();
  const { org } = workspaceSlugs(location.pathname);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      setOrganizations(await platformApi.organizations());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The workspace could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  // The organization the address names, once it is one of the account's: Home shows its recent runs.
  useEffect(() => {
    if (org && organizations.some(item => item.slug === org)) rememberOrganization(org);
  }, [org, organizations]);

  const organization =
    (org ? organizations.find(item => item.slug === org) : null) ?? organizations[0];
  const context = useMemo<PlatformOutletContext>(
    () => ({
      organizations,
      organization,
      loading,
      reload: load,
    }),
    [organizations, organization, loading, load]
  );

  return (
    <div className="platform-shell">
      <a className="skip-link" href="#platform-main">
        Skip to workspace
      </a>
      <AppHeader organizations={organizations} organization={organization} />
      <main id="platform-main" className="platform-main" tabIndex={-1}>
        {error && (
          <div className="platform-error" role="alert">
            {error}
          </div>
        )}
        {/* A plan changed by signing in is told once, wherever the person lands; Identities tells it itself, where they link. */}
        {location.pathname !== '/app/account/identities' && (
          <PlanChangedNotice className="platform-plan-notice" />
        )}
        <ErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={<RouteFallback />}>
            <Outlet context={context} key={location.pathname} />
          </Suspense>
        </ErrorBoundary>
      </main>
      <SiteFooter />
    </div>
  );
}
