import { useRef } from 'react';
import { ExternalLink, Menu, Moon, Sun } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useTheme } from '../../contexts/theme';
import { useAuth } from '../../contexts/auth';
import { config } from '../../config';
import './Navigation.css';

const journeyLinks = [
  { to: '/', step: '01', label: 'Understand' },
  { to: '/profiles', step: '02', label: 'Profiles' },
  { to: '/examples', step: '03', label: 'Examples' },
  { to: '/playground', step: '04', label: 'Playground' },
  { to: '/schemas', step: '05', label: 'Specification' },
];

export function Navigation() {
  const { theme, toggleTheme } = useTheme();
  const { user, isAdmin, signOut } = useAuth();
  const location = useLocation();
  const mobileMenu = useRef<HTMLDetailsElement>(null);
  const isActive = (path: string) => path === '/' ? location.pathname === '/' : location.pathname.startsWith(path);
  const closeMobileMenu = () => mobileMenu.current?.removeAttribute('open');

  const journey = journeyLinks.map((item) => (
    <Link
      key={item.to}
      to={item.to}
      viewTransition
      className={`journey-link ${isActive(item.to) ? 'is-active' : ''}`}
      aria-current={isActive(item.to) ? 'page' : undefined}
      onClick={closeMobileMenu}
    >
      <span>{item.step}</span>
      {item.label}
    </Link>
  ));

  return (
    <header className="site-header">
      <nav className="navigation" aria-label="Primary navigation">
        <Link to="/" viewTransition className="brand-link" aria-label={`${config.name} home`}>
          <span className="brand-symbol" aria-hidden="true"><i /><i /><b /></span>
          <span className="brand-wordmark"><strong>Open</strong>Binding</span>
        </Link>

        <div className="desktop-journey" aria-label="Learning journey">{journey}</div>

        <div className="nav-utilities">
          {user && <Link
            to="/engines"
            viewTransition
            className={`utility-link engine-nav-link ${isActive('/engines') ? 'is-active' : ''}`}
            aria-current={isActive('/engines') ? 'page' : undefined}
          >
            Engines
          </Link>}
          <Link
            to="/pricing"
            viewTransition
            className={`utility-link pricing-nav-link ${isActive('/pricing') ? 'is-active' : ''}`}
            aria-current={isActive('/pricing') ? 'page' : undefined}
          >
            Pricing
          </Link>
          {user ? (
            <>
              <Link to="/account" viewTransition className="account-link" title={`Signed in as ${user.username}`}>
                {user.username}{user.plan === 'PRO' && <span>Pro</span>}
              </Link>
              {isAdmin && <Link to="/admin" viewTransition className="utility-link">Admin</Link>}
              <button type="button" className="text-action" onClick={() => void signOut()}>Sign out</button>
            </>
          ) : (
            <Link to="/login" viewTransition className="utility-link">Sign in</Link>
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
            <div className="mobile-journey">{journey}</div>
            <div className="mobile-utilities">
              {user && <Link to="/engines" viewTransition aria-current={isActive('/engines') ? 'page' : undefined} onClick={closeMobileMenu}>Engines</Link>}
              <Link to="/pricing" viewTransition aria-current={isActive('/pricing') ? 'page' : undefined} onClick={closeMobileMenu}>Pricing</Link>
              <a href={`${config.apiBaseUrl}/docs`} target="_blank" rel="noreferrer">API reference <ExternalLink aria-hidden="true" /></a>
              {user ? (
                <>
                  <Link to="/account" viewTransition onClick={closeMobileMenu}>{user.username}</Link>
                  {isAdmin && <Link to="/admin" viewTransition onClick={closeMobileMenu}>Admin</Link>}
                  <button type="button" onClick={() => { closeMobileMenu(); void signOut(); }}>Sign out</button>
                </>
              ) : <Link to="/login" viewTransition onClick={closeMobileMenu}>Sign in</Link>}
              <button type="button" onClick={toggleTheme}>Switch to {theme === 'light' ? 'dark' : 'light'} mode</button>
            </div>
          </div>
        </details>
      </nav>
    </header>
  );
}
