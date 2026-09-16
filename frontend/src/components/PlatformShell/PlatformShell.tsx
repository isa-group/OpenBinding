import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, Archive, BarChart3, Boxes, Braces, ChevronDown,
  Command, Cpu, Database, FileText, Fingerprint, FlaskConical, Gauge, Menu, Network, Plus, Search, Settings, Shield, User, Users,
} from 'lucide-react';
import { Link, matchPath, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { platformApi } from '../../api/platform';
import type { Organization, Project } from '../../api/platform';
import { useAuth } from '../../contexts/auth';
import { useTheme } from '../../contexts/theme';
import { CommandPalette } from './CommandPalette';
import { NotificationDropdown } from '../NotificationDropdown/NotificationDropdown';
import './PlatformShell.css';

export interface PlatformOutletContext {
  organizations: Organization[];
  projects: Project[];
  organization?: Organization;
  project?: Project;
  loading: boolean;
  reload: () => Promise<void>;
}

const projectLinks = [
  { suffix: '', label: 'Overview', icon: Gauge },
  { suffix: '/cases', label: 'Binding cases', icon: Boxes },
  { suffix: '/resources', label: 'Resources', icon: Database },
  { suffix: '/collections', label: 'Collections', icon: Archive },
  { suffix: '/workbench', label: 'Workbench', icon: Braces },
  { suffix: '/jobs', label: 'Jobs', icon: Cpu },
  { suffix: '/studies', label: 'Studies', icon: FlaskConical },
  { suffix: '/analytics', label: 'Analysis', icon: BarChart3 },
  { suffix: '/reports', label: 'Reports', icon: FileText },
  { suffix: '/artifacts', label: 'Artifacts', icon: Archive },
];

const RESERVED_SLUGS = new Set([
  'admin', 'account', 'analysis', 'workbench', 'cases', 'resources', 'collections',
  'jobs', 'studies', 'analytics', 'reports', 'artifacts', 'settings', 'engines', 'snapshots', 'verifier',
]);

export function PlatformShell() {
  const { user, isAdmin, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const isExcludedPath = location.pathname.startsWith('/app/admin') || location.pathname.startsWith('/app/account');
  const projectMatch = isExcludedPath ? null : (
    matchPath('/app/:org/:project/*', location.pathname)
      ?? matchPath('/app/:org/:project', location.pathname)
  );
  const organizationMatch = isExcludedPath
    ? null : matchPath('/app/:org', location.pathname);
  const rawOrg = projectMatch?.params.org ?? organizationMatch?.params.org;
  const org = rawOrg && !RESERVED_SLUGS.has(rawOrg) ? rawOrg : undefined;
  const projectSlug = projectMatch?.params.project;
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
  const projectRoot = organization && project
    ? `/app/${organization.slug}/${project.slug}`
    : (organization ? `/app/${organization.slug}` : '/app');
  const context = useMemo<PlatformOutletContext>(() => ({
    organizations, projects: orgProjects, organization, project, loading, reload: load,
  }), [organizations, orgProjects, organization, project, loading, load]);

  const isResearch = Boolean(user && (user.plan === 'RESEARCH' || user.institutional_branding));

  const chooseOrganization = (slug: string) => {
    if (slug === '__new__') {
      navigate('/app', { viewTransition: true });
      return;
    }
    const target = organizations.find((item) => item.slug === slug);
    if (target) navigate(`/app/${target.slug}`, { viewTransition: true });
  };
  const chooseProject = (slug: string) => {
    if (slug === '__new__' && organization) {
      navigate(`/app/${organization.slug}`, { viewTransition: true });
      return;
    }
    if (organization) navigate(`/app/${organization.slug}/${slug}`, { viewTransition: true });
  };

  return (
    <div className="platform-shell">
      <a className="skip-link" href="#platform-main">Skip to workspace</a>
      <header className="platform-topbar">
        <div className="platform-brand-group">
          <Link to="/" className="platform-brand" viewTransition aria-label="OpenBinding home">
            <span className="brand-symbol" aria-hidden="true"><i /><i /><b /></span>
            <span><strong>Open</strong>Binding</span>
            {isResearch && (
              <span
                className="platform-institution-mark"
                title="Institutional account · Universidad de Sevilla"
              >
                <img src="/brands/us-fama.png" alt="Universidad de Sevilla" />
              </span>
            )}
          </Link>
        </div>
        <div className="workspace-switchers" aria-label="Current workspace">
          {organizations.length === 0 ? (
            <Link to="/app" className="workspace-action-btn" title="Create your first organization">
              <Plus aria-hidden="true" /> New Organization
            </Link>
          ) : (
            <label>
              <span>Organization</span>
              <select value={organization?.slug ?? ''} onChange={(event) => chooseOrganization(event.target.value)}>
                {!organization && <option value="">No organization</option>}
                {organizations.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
                <option value="__new__">+ New organization…</option>
              </select>
              <ChevronDown aria-hidden="true" />
            </label>
          )}
          <span className="workspace-separator">/</span>
          {organization && orgProjects.length === 0 ? (
            <Link to={`/app/${organization.slug}`} className="workspace-action-btn" title="Create your first project">
              <Plus aria-hidden="true" /> New Project
            </Link>
          ) : (
            <label>
              <span>Project</span>
              <select value={project?.slug ?? ''} onChange={(event) => chooseProject(event.target.value)} disabled={!orgProjects.length && !organization}>
                {!project && <option value="">No project</option>}
                {orgProjects.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
                {organization && <option value="__new__">+ New project…</option>}
              </select>
              <ChevronDown aria-hidden="true" />
            </label>
          )}
        </div>
        <button className="command-trigger" type="button" onClick={() => window.dispatchEvent(new CustomEvent('openbinding:command'))}>
          <Search aria-hidden="true" /><span>Search or jump to…</span><kbd>⌘ K</kbd>
        </button>
        <div className="platform-top-actions">
          <Link to={organization && project ? `${projectRoot}/workbench` : '/app/workbench'} className="create-trigger"><Plus aria-hidden="true" /> New</Link>
          <NotificationDropdown />
          <details className="account-menu">
            <summary aria-label="Open account menu"><span>{user?.username.slice(0, 2).toUpperCase()}</span></summary>
            <div>
              <strong>{user?.username}</strong><small>{user?.plan}</small>
              <Link to="/app/account">Account</Link>
              <button type="button" onClick={toggleTheme}>{theme === 'light' ? 'Dark' : 'Light'} theme</button>
              <button type="button" onClick={() => void signOut()}>Sign out</button>
            </div>
          </details>
        </div>
      </header>

      <aside className="platform-sidebar">
        <nav aria-label="Workspace navigation">
          <NavLink to="/app" end><Activity aria-hidden="true" />Activity</NavLink>
          <p>Project</p>
          {projectLinks.map(({ suffix, label, icon: Icon }) => (
            <NavLink
              key={label}
              to={project ? `${projectRoot}${suffix}` : (organization ? `/app/${organization.slug}` : '/app')}
              end={suffix === ''}
              className={!project ? 'is-disabled' : undefined}
              onClick={(e) => {
                if (!project) e.preventDefault();
              }}
            >
              <Icon aria-hidden="true" />{label}
            </NavLink>
          ))}
          <p>System</p>
          <NavLink to="/app/analysis" end><BarChart3 aria-hidden="true" />Binding decisions</NavLink>
          <NavLink to="/app/account" end><User aria-hidden="true" />Account</NavLink>
          {isAdmin && <NavLink to="/app/admin" end><Shield aria-hidden="true" />Administration</NavLink>}
          {organization && <NavLink to={`/app/${organization.slug}/settings`}><Users aria-hidden="true" />Organization</NavLink>}
          <NavLink to="/app/engines" end><Network aria-hidden="true" />Engines</NavLink>
          <NavLink to="/app/verifier" end><Fingerprint aria-hidden="true" />Replication studio</NavLink>
          {isAdmin && <NavLink to="/app/admin/pricing"><Settings aria-hidden="true" />Pricing control</NavLink>}
        </nav>
        {isResearch && (
          <a className="us-institution" href="https://www.us.es" target="_blank" rel="noreferrer" title="Institutional account · Universidad de Sevilla">
            <img src="/brands/universidad-sevilla.svg" alt="Universidad de Sevilla" />
            <small>Institutional account</small>
          </a>
        )}
        <div className="platform-help"><Command aria-hidden="true" /><span><strong>Quick actions</strong><small>Press ⌘ K anywhere</small></span></div>
      </aside>

      <details className="platform-mobile-nav">
        <summary><Menu aria-hidden="true" /> Workspace</summary>
        <nav>
          {projectLinks.map(({ suffix, label }) => (
            <Link
              key={label}
              to={project ? `${projectRoot}${suffix}` : (organization ? `/app/${organization.slug}` : '/app')}
              onClick={(e) => {
                if (!project) e.preventDefault();
              }}
            >
              {label}
            </Link>
          ))}
          {organization && <Link to={`/app/${organization.slug}/settings`}>Organization</Link>}
          <Link to="/app/account">Account</Link>
          {isAdmin && <Link to="/app/admin">Administration</Link>}
          {isResearch && <a className="mobile-us-brand" href="https://www.us.es" target="_blank" rel="noreferrer" title="Institutional account · Universidad de Sevilla"><img src="/brands/universidad-sevilla.svg" alt="Universidad de Sevilla" /></a>}
        </nav>
      </details>

      <CommandPalette organization={organization} project={project} isAdmin={isAdmin} />

      <main id="platform-main" className="platform-main" tabIndex={-1}>
        {error && <div className="platform-error" role="alert">{error}</div>}
        <Outlet context={context} key={location.pathname} />
      </main>
    </div>
  );
}
