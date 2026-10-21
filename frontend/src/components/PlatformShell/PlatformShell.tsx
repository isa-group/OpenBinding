import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { platformApi } from '../../api/platform';
import type { Organization, Project, ProjectAccessKind } from '../../api/platform';
import { PlanChangedNotice } from '../PlanChangedNotice/PlanChangedNotice';
import { SiteFooter } from '../SiteFooter/SiteFooter';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { AppHeader } from './AppHeader';
import { RouteFallback } from './RouteFallback';
import { workspaceSlugs } from './workspacePath';
import './PlatformShell.css';

export interface PlatformOutletContext {
  organizations: Organization[];
  projects: Project[];
  organization?: Organization;
  project?: Project;
  /**
   * How the account reaches `project`: `member`, or `public_read` for a visitor of a public project. Unset when the shell
   * doesn't know (the address names a project of an organization the account isn't in: the project screens ask the gateway).
   */
  access?: ProjectAccessKind;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * Layout of every authenticated screen (exported as AppLayout): application header, the
 * screen itself and the site footer. It loads the account's organizations and the projects of
 * the organization named by the URL and hands them to the screens through the outlet context.
 */
export function PlatformShell() {
  const location = useLocation();
  const { org, project: projectSlug } = workspaceSlugs(location.pathname);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const nextOrganizations = await platformApi.organizations();
      setOrganizations(nextOrganizations);
      const validOrg = org ? nextOrganizations.find((item) => item.slug === org) : undefined;
      const selectedOrg = validOrg ?? nextOrganizations[0];
      const selectedSlug = selectedOrg?.slug;
      if (selectedSlug) {
        setProjects(await platformApi.projects(selectedSlug));
      } else {
        setProjects([]);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The workspace could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [org]);

  useEffect(() => { void load(); }, [load]);

  const organization = (org ? organizations.find((item) => item.slug === org) : null) ?? organizations[0];
  const orgProjects = useMemo(
    () => (organization ? projects.filter((item) => item.organization_id === organization.id) : []),
    [projects, organization],
  );
  const project = orgProjects.find((item) => item.slug === projectSlug) ?? orgProjects[0];
  // The projects of the account's own organizations are all reached as a member; an address outside them says nothing here.
  const access: ProjectAccessKind | undefined = project && (!org || organizations.some((item) => item.slug === org)) ? project.access ?? 'member' : undefined;
  const context = useMemo<PlatformOutletContext>(() => ({
    organizations, projects: orgProjects, organization, project, access, loading, reload: load,
  }), [organizations, orgProjects, organization, project, access, loading, load]);

  return (
    <div className="platform-shell">
      <a className="skip-link" href="#platform-main">Skip to workspace</a>
      <AppHeader organizations={organizations} projects={orgProjects} organization={organization} project={project} />
      <main id="platform-main" className="platform-main" tabIndex={-1}>
        {error && <div className="platform-error" role="alert">{error}</div>}
        {/* A plan changed by signing in is told once, wherever the person lands; Identities tells it itself, where they link. */}
        {location.pathname !== '/app/account/identities' && <PlanChangedNotice className="platform-plan-notice" />}
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
