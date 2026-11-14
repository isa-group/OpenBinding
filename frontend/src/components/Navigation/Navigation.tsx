import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { Menu, X } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/auth';
import { config } from '../../config';
import { personInitials } from '../../utils/initials';
import { InstitutionMark } from '../InstitutionMark';
import { INSTITUTION_NAME, useInstitutionalBranding } from '../InstitutionMark/institution';
import './Navigation.css';

type MenuName = 'account' | 'mobile';

const underPath = (pathname: string, root: string) => pathname === root || pathname.startsWith(`${root}/`);

interface PublicLink {
  to: string;
  label: string;
  active: (pathname: string) => boolean;
  /** Addresses where a link of the page carries `aria-current`, so the header link keeps only its active style. */
  pageMarks?: (pathname: string) => boolean;
}

const publicLinks: readonly PublicLink[] = [
  { to: '/', label: 'Home', active: (pathname) => pathname === '/' },
  {
    to: '/explore', label: 'Explore', active: (pathname) => underPath(pathname, '/explore'),
    pageMarks: (pathname) => underPath(pathname, '/explore/examples'),
  },
  { to: '/engines', label: 'Engines', active: (pathname) => underPath(pathname, '/engines') },
  { to: '/language', label: 'Language', active: (pathname) => underPath(pathname, '/language') },
  { to: '/pricing', label: 'Pricing', active: (pathname) => underPath(pathname, '/pricing') },
  { to: '/about', label: 'About', active: (pathname) => underPath(pathname, '/about') },
];

export function Navigation() {
  const { user, isAdmin, signOut } = useAuth();
  const institutional = useInstitutionalBranding();
  const location = useLocation();
  const header = useRef<HTMLElement>(null);
  const accountToggle = useRef<HTMLButtonElement>(null);
  const mobileToggle = useRef<HTMLButtonElement>(null);
  // Menus belong to the location they were opened on, so navigating closes them.
  const [opened, setOpened] = useState<{ menu: MenuName | null; at: string }>({ menu: null, at: location.key });
  const openMenu = opened.at === location.key ? opened.menu : null;

  const closeMenus = () => setOpened({ menu: null, at: location.key });
  const toggleMenu = (menu: MenuName) => setOpened({ menu: openMenu === menu ? null : menu, at: location.key });
  const isActive = (link: PublicLink) => link.active(location.pathname);
  const current = (link: PublicLink) => (isActive(link) && !link.pageMarks?.(location.pathname) ? 'page' : undefined);

  useEffect(() => {
    if (!openMenu) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (!header.current?.contains(event.target as Node)) setOpened({ menu: null, at: location.key });
    };

    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [openMenu, location.key]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !openMenu) return;
    closeMenus();
    const toggle = { account: accountToggle, mobile: mobileToggle }[openMenu];
    toggle.current?.focus();
  };
  const closeWhenFocusLeaves = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenus();
  };
  const handleSignOut = () => {
    closeMenus();
    void signOut();
  };

  const initials = personInitials(user?.username);

  return (
    <header ref={header} className="site-header" onKeyDown={handleKeyDown}>
      <div className="public-header">
        <Link to="/" viewTransition className="brand-link" aria-label={`${config.name} home`}>
          <span className="brand-wordmark">OpenBinding</span>
          <InstitutionMark variant="compact" className="brand-institution" />
        </Link>

        <nav className="public-nav" aria-label="Primary navigation">
          {publicLinks.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              viewTransition
              className={`public-nav-link${isActive(link) ? ' is-active' : ''}`}
              aria-current={current(link)}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="public-actions">
          {user ? (
            <>
              <Link to="/app" viewTransition className="public-button public-button-primary">Open workspace</Link>
              <div className="public-nav-menu" onBlur={openMenu === 'account' ? closeWhenFocusLeaves : undefined}>
                <button
                  ref={accountToggle}
                  type="button"
                  className="public-avatar"
                  aria-label="Account menu"
                  aria-expanded={openMenu === 'account'}
                  aria-controls="public-account-menu"
                  onClick={() => toggleMenu('account')}
                >
                  {initials}
                </button>
                {openMenu === 'account' && (
                  <div id="public-account-menu" className="public-menu-panel public-account-panel">
                    <div className="public-account-card">
                      <strong>{user.username}</strong>
                      <span>{user.email}</span>
                      {institutional && (
                        <span className="public-institution-chip">{INSTITUTION_NAME} · Institutional account</span>
                      )}
                    </div>
                    <Link to="/app" viewTransition>Workspace</Link>
                    <Link to="/app/account" viewTransition>Account</Link>
                    {isAdmin && <Link to="/app/admin" viewTransition>Administration</Link>}
                    <button type="button" onClick={handleSignOut}>Log out</button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <Link to="/login" viewTransition className="public-button">Log in</Link>
              <Link to="/register" viewTransition className="public-button public-button-primary">
                Sign up <span className="public-button-arrow" aria-hidden="true">↗</span>
              </Link>
            </>
          )}
        </div>

        <button
          ref={mobileToggle}
          type="button"
          className="public-mobile-toggle"
          aria-label={openMenu === 'mobile' ? 'Close menu' : 'Open menu'}
          aria-expanded={openMenu === 'mobile'}
          aria-controls="public-mobile-menu"
          onClick={() => toggleMenu('mobile')}
        >
          {openMenu === 'mobile' ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>
      </div>

      {openMenu === 'mobile' && (
        <nav id="public-mobile-menu" className="public-mobile-menu" aria-label="Mobile navigation">
          <InstitutionMark variant="wide" className="public-mobile-institution" />
          {publicLinks.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              viewTransition
              className={isActive(link) ? 'is-active' : undefined}
              aria-current={current(link)}
            >
              {link.label}
            </Link>
          ))}
          {user ? (
            <>
              <Link to="/app" viewTransition className="public-button public-button-primary">Open workspace</Link>
              <Link to="/app/account" viewTransition className="public-button">Account</Link>
              {isAdmin && <Link to="/app/admin" viewTransition className="public-button">Administration</Link>}
              <button type="button" className="public-button" onClick={handleSignOut}>Log out</button>
            </>
          ) : (
            <>
              <Link to="/login" viewTransition className="public-button">Log in</Link>
              <Link to="/register" viewTransition className="public-button public-button-primary">Sign up</Link>
            </>
          )}
        </nav>
      )}
    </header>
  );
}
