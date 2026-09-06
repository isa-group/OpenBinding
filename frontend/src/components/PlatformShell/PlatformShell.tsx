import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity, Archive, BarChart3, Bell, BookOpen, Boxes, Braces, ChevronDown,
  Command, Database, FileText, FlaskConical, Gauge, Menu, Network, Plus, Search, Settings, Users,
} from 'lucide-react';
import { Link, matchPath, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { platformApi } from '../../api/platform';
import type { Organization, Project } from '../../api/platform';
import { useAuth } from '../../contexts/auth';
import { useTheme } from '../../contexts/theme';
import { CommandPalette } from './CommandPalette';
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
  { suffix: '/studies', label: 'Studies', icon: FlaskConical },
  { suffix: '/analytics', label: 'Analysis', icon: BarChart3 },
  { suffix: '/reports', label: 'Reports', icon: FileText },
  { suffix: '/artifacts', label: 'Artifacts', icon: Archive },
];

export function PlatformShell() {
  const { user, isAdmin, signOut } = useAuth();
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const projectMatch = location.pathname.startsWith('/app/admin') ? null : (
    matchPath('/app/:org/:project/*', location.pathname)
      ?? matchPath('/app/:org/:project', location.pathname)
  );
  const organizationMatch = location.pathname.startsWith('/app/admin')
    ? null : matchPath('/app/:org', location.pathname);
  const org = projectMatch?.params.org ?? organizationMatch?.params.org;
  const projectSlug = projectMatch?.params.project;
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const nextOrganizations = await platformApi.organizations();
      setOrganizations(nextOrganizations);
      const selected = org ?? nextOrganizations[0]?.slug;
      setProjects(selected ? await platformApi.projects(selected) : []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The workspace could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [org]);

  useEffect(() => { void load(); }, [load]);

  const organization = organizations.find((item) => item.slug === org) ?? organizations[0];
  const project = projects.find((item) => item.slug === projectSlug) ?? projects[0];
  const projectRoot = organization && project ? `/app/${organization.slug}/${project.slug}` : '/app';
  const context = useMemo<PlatformOutletContext>(() => ({
    organizations, projects, organization, project, loading, reload: load,
  }), [organizations, projects, organization, project, loading, load]);

  const chooseOrganization = (slug: string) => {
    const target = organizations.find((item) => item.slug === slug);
    if (target) navigate(`/app/${target.slug}`, { viewTransition: true });
  };
  const chooseProject = (slug: string) => {
    if (organization) navigate(`/app/${organization.slug}/${slug}`, { viewTransition: true });
  };

  return (
    <div className="platform-shell">
      <a className="skip-link" href="#platform-main">Skip to workspace</a>
      <header className="platform-topbar">
        <Link to="/" className="platform-brand" viewTransition aria-label="OpenBinding home">
          <span className="brand-symbol" aria-hidden="true"><i /><i /><b /></span>
          <span><strong>Open</strong>Binding</span>
        </Link>
        <div className="workspace-switchers" aria-label="Current workspace">
          <label>
            <span>Organization</span>
            <select value={organization?.slug ?? ''} onChange={(event) => chooseOrganization(event.target.value)}>
              {!organization && <option value="">No organization</option>}
              {organizations.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
            </select>
            <ChevronDown aria-hidden="true" />
          </label>
          <span className="workspace-separator">/</span>
          <label>
            <span>Project</span>
            <select value={project?.slug ?? ''} onChange={(event) => chooseProject(event.target.value)} disabled={!projects.length}>
              {!project && <option value="">No project</option>}
              {projects.map((item) => <option key={item.id} value={item.slug}>{item.name}</option>)}
            </select>
            <ChevronDown aria-hidden="true" />
          </label>
        </div>
        <button className="command-trigger" type="button" onClick={() => window.dispatchEvent(new CustomEvent('openbinding:command'))}>
          <Search aria-hidden="true" /><span>Search or jump to…</span><kbd>⌘ K</kbd>
        </button>
        <div className="platform-top-actions">
          {user?.institutional_branding && <a className="platform-institution-mark" href="https://www.us.es" target="_blank" rel="noreferrer" title="Cuenta institucional · Universidad de Sevilla"><img src="/brands/universidad-sevilla.svg" alt="Universidad de Sevilla" /></a>}
          <Link to={`${projectRoot}/workbench`} className="create-trigger"><Plus aria-hidden="true" /> New</Link>
          <Link to="/account" aria-label="Notifications"><Bell aria-hidden="true" /></Link>
          <details className="account-menu">
            <summary aria-label="Open account menu"><span>{user?.username.slice(0, 2).toUpperCase()}</span></summary>
            <div>
              <strong>{user?.username}</strong><small>{user?.plan}</small>
              <Link to="/account">Account</Link>
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
            <NavLink key={label} to={`${projectRoot}${suffix}`} end={suffix === ''} className={!project ? 'is-disabled' : undefined}>
              <Icon aria-hidden="true" />{label}
            </NavLink>
          ))}
          <p>System</p>
          {organization && <NavLink to={`/app/${organization.slug}/settings`}><Users aria-hidden="true" />Organization</NavLink>}
          <NavLink to="/engines"><Network aria-hidden="true" />Engines</NavLink>
          <NavLink to="/schemas"><BookOpen aria-hidden="true" />BIM specification</NavLink>
          {isAdmin && <NavLink to="/app/admin/pricing"><Settings aria-hidden="true" />Pricing control</NavLink>}
        </nav>
        {user?.institutional_branding && (
          <a className="us-institution" href="https://www.us.es" target="_blank" rel="noreferrer" title="Cuenta institucional · Universidad de Sevilla">
            <img src="/brands/universidad-sevilla.svg" alt="Universidad de Sevilla" />
            <small>Institutional account</small>
          </a>
        )}
        <div className="platform-help"><Command aria-hidden="true" /><span><strong>Quick actions</strong><small>Press ⌘ K anywhere</small></span></div>
      </aside>

      <details className="platform-mobile-nav">
        <summary><Menu aria-hidden="true" /> Workspace</summary>
        <nav>{projectLinks.map(({ suffix, label }) => <Link key={label} to={`${projectRoot}${suffix}`}>{label}</Link>)}{organization && <Link to={`/app/${organization.slug}/settings`}>Organization</Link>}{user?.institutional_branding && <a className="mobile-us-brand" href="https://www.us.es" target="_blank" rel="noreferrer" title="Cuenta institucional · Universidad de Sevilla"><img src="/brands/universidad-sevilla.svg" alt="Universidad de Sevilla" /></a>}</nav>
      </details>

      <CommandPalette organization={organization} project={project} isAdmin={isAdmin} />

      <main id="platform-main" className="platform-main" tabIndex={-1}>
        {error && <div className="platform-error" role="alert">{error}</div>}
        <Outlet context={context} key={location.pathname} />
      </main>
    </div>
  );
}
