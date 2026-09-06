import { useRef } from 'react';
import { ChevronDown, ExternalLink, Menu, Moon, Sun } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useTheme } from '../../contexts/theme';
import { useAuth } from '../../contexts/auth';
import { config } from '../../config';
import './Navigation.css';

const navMenus = [
  {
    label: 'Explore',
    links: [
      { to: '/explore', label: 'Public projects', description: 'Cases, studies and frozen reports' },
      { to: '/examples', label: 'Example corpus', description: 'Executable BIM packages' },
      { to: '/engines', label: 'Engines', description: 'Capabilities and deployments' },
    ],
  },
  {
    label: 'Tools',
    links: [
      { to: '/playground', label: 'BIM Workbench', description: 'Author, validate and solve' },
      { to: '/profiles', label: 'Profiles & dialects', description: 'Language extension points' },
      { to: '/schemas', label: 'Specification', description: 'BIM v1 contracts and schemas' },
    ],
  },
  {
    label: 'Research',
    links: [
      { to: '/research', label: 'Research', description: 'Sources and reproducible evidence' },
      { to: '/funding', label: 'Funding', description: 'Institutions and project register' },
      { to: '/contributions', label: 'Contributions', description: 'Open research topics' },
    ],
  },
] as const;

const directLinks = [
  { to: '/pricing', label: 'Pricing' },
  { to: '/team', label: 'Team' },
  { to: '/changelog', label: 'Changelog' },
] as const;

export function Navigation() {
  const { theme, toggleTheme } = useTheme();
  const { user, isAdmin, signOut } = useAuth();
  const location = useLocation();
  const mobileMenu = useRef<HTMLDetailsElement>(null);
  const desktopMenus = useRef<HTMLDivElement>(null);
  const isActive = (path: string) => path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);
  const closeDesktopMenus = () => desktopMenus.current?.querySelectorAll('details[open]').forEach((menu) => menu.removeAttribute('open'));
  const closeMobileMenu = () => mobileMenu.current?.removeAttribute('open');

  return (
    <header className="site-header">
      <nav className="navigation" aria-label="Primary navigation">
        <Link to="/" viewTransition className="brand-link" aria-label={`${config.name} home`}>
          <span className="brand-symbol" aria-hidden="true"><i /><i /><b /></span>
          <span className="brand-wordmark"><strong>Open</strong>Binding</span>
        </Link>

        <div ref={desktopMenus} className="desktop-primary">
          {navMenus.slice(0, 2).map((menu) => (
            <details className="nav-menu" key={menu.label}>
              <summary className={menu.links.some((link) => isActive(link.to)) ? 'is-active' : undefined}>
                {menu.label}<ChevronDown aria-hidden="true" />
              </summary>
              <div className="nav-menu-panel">
                {menu.links.map((link) => (
                  <Link key={link.to} to={link.to} viewTransition onClick={closeDesktopMenus} aria-current={isActive(link.to) ? 'page' : undefined}>
                    <strong>{link.label}</strong><span>{link.description}</span>
                  </Link>
                ))}
              </div>
            </details>
          ))}

          {directLinks.slice(0, 2).map((link) => (
            <Link key={link.to} to={link.to} viewTransition className={`primary-link ${isActive(link.to) ? 'is-active' : ''}`} aria-current={isActive(link.to) ? 'page' : undefined}>
              {link.label}
            </Link>
          ))}

          <details className="nav-menu">
            <summary className={navMenus[2].links.some((link) => isActive(link.to)) ? 'is-active' : undefined}>
              Research<ChevronDown aria-hidden="true" />
            </summary>
            <div className="nav-menu-panel">
              {navMenus[2].links.map((link) => (
                <Link key={link.to} to={link.to} viewTransition onClick={closeDesktopMenus} aria-current={isActive(link.to) ? 'page' : undefined}>
                  <strong>{link.label}</strong><span>{link.description}</span>
                </Link>
              ))}
            </div>
          </details>

          <Link to="/changelog" viewTransition className={`primary-link ${isActive('/changelog') ? 'is-active' : ''}`} aria-current={isActive('/changelog') ? 'page' : undefined}>Changelog</Link>
        </div>

        <div className="nav-utilities">
          {user ? (
            <>
              {user.institutional_branding && <a className="institution-header-mark" href="https://www.us.es" target="_blank" rel="noreferrer" title="Cuenta institucional · Universidad de Sevilla"><img src="/brands/universidad-sevilla.svg" alt="Universidad de Sevilla" /></a>}
              <Link to="/app" viewTransition className="platform-link">Open platform</Link>
              <Link to="/account" viewTransition className="account-link" title={`Signed in as ${user.username}`}>
                {user.username}<span>{user.plan}</span>
              </Link>
              {isAdmin && <Link to="/admin" viewTransition className="utility-link">Admin</Link>}
              <button type="button" className="text-action" onClick={() => void signOut()}>Sign out</button>
            </>
          ) : (
            <>
              <Link to="/login" viewTransition className="utility-link">Sign in</Link>
              <Link to="/register" viewTransition className="platform-link">Open platform</Link>
            </>
          )}
          <button
            type="button"
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
            title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          >
            {theme === 'light' ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
          </button>
        </div>

        <details ref={mobileMenu} className="mobile-navigation">
          <summary><Menu aria-hidden="true" /> <span>Navigate</span></summary>
          <div className="mobile-navigation-panel">
            <div className="mobile-primary">
              {navMenus.map((menu) => (
                <section key={menu.label}>
                  <span className="micro-label">{menu.label}</span>
                  {menu.links.map((link) => (
                    <Link key={link.to} to={link.to} viewTransition aria-current={isActive(link.to) ? 'page' : undefined} onClick={closeMobileMenu}>{link.label}</Link>
                  ))}
                </section>
              ))}
              <section>
                <span className="micro-label">OpenBinding</span>
                {directLinks.map((link) => <Link key={link.to} to={link.to} viewTransition onClick={closeMobileMenu}>{link.label}</Link>)}
              </section>
            </div>
            <div className="mobile-utilities">
              <a href={`${config.apiBaseUrl}/docs`} target="_blank" rel="noreferrer">API reference <ExternalLink aria-hidden="true" /></a>
              {user ? (
                <>
                  {user.institutional_branding && <a className="mobile-institution-mark" href="https://www.us.es" target="_blank" rel="noreferrer"><img src="/brands/universidad-sevilla.svg" alt="Cuenta institucional · Universidad de Sevilla" /></a>}
                  <Link to="/app" viewTransition onClick={closeMobileMenu}>Open platform</Link>
                  <Link to="/account" viewTransition onClick={closeMobileMenu}>{user.username} · {user.plan}</Link>
                  {isAdmin && <Link to="/admin" viewTransition onClick={closeMobileMenu}>Admin</Link>}
                  <button type="button" onClick={() => { closeMobileMenu(); void signOut(); }}>Sign out</button>
                </>
              ) : (
                <>
                  <Link to="/login" viewTransition onClick={closeMobileMenu}>Sign in</Link>
                  <Link to="/register" viewTransition onClick={closeMobileMenu}>Create account</Link>
                </>
              )}
              <button type="button" onClick={toggleTheme}>Switch to {theme === 'light' ? 'dark' : 'light'} mode</button>
            </div>
          </div>
        </details>
      </nav>
    </header>
  );
}
