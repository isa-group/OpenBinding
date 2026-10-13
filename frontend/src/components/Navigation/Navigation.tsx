import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { ChevronDown, Menu, X } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/auth';
import { config } from '../../config';
import { personInitials } from '../../utils/initials';
import { InstitutionMark } from '../InstitutionMark';
import { INSTITUTION_NAME, useInstitutionalBranding } from '../InstitutionMark/institution';
import './Navigation.css';

type MenuName = 'language' | 'account' | 'mobile';

const underPath = (pathname: string, root: string) => pathname === root || pathname.startsWith(`${root}/`);

const languageLinks = [
  {
    to: '/language', label: 'Profiles & dialects', description: 'How an instance becomes a binding problem',
    isActive: (pathname: string) => pathname === '/language',
  },
  {
    to: '/language/schemas/application', label: 'Schemas', description: 'Field reference for every resource kind',
    isActive: (pathname: string) => underPath(pathname, '/language/schemas'),
  },
  {
    to: '/examples', label: 'Examples', description: 'Official BIM packages to start from',
    isActive: (pathname: string) => underPath(pathname, '/examples'),
  },
  {
    to: '/workbench', label: 'Workbench', description: 'Validate a package without an account',
    isActive: (pathname: string) => underPath(pathname, '/workbench'),
  },
] as const;

export function Navigation() {
  const { user, isAdmin, signOut } = useAuth();
  const institutional = useInstitutionalBranding();
  const location = useLocation();
  const header = useRef<HTMLElement>(null);
  const languageToggle = useRef<HTMLButtonElement>(null);
  const accountToggle = useRef<HTMLButtonElement>(null);
  const mobileToggle = useRef<HTMLButtonElement>(null);
  // Menus belong to the location they were opened on, so navigating closes them.
  const [opened, setOpened] = useState<{ menu: MenuName | null; at: string }>({ menu: null, at: location.key });
  const openMenu = opened.at === location.key ? opened.menu : null;

  const isCurrent = (root: string) => underPath(location.pathname, root);
  const languageActive = languageLinks.some((link) => link.isActive(location.pathname));
  const closeMenus = () => setOpened({ menu: null, at: location.key });
  const toggleMenu = (menu: MenuName) => setOpened({ menu: openMenu === menu ? null : menu, at: location.key });
  const current = (active: boolean) => (active ? 'page' : undefined);

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
    const toggle = { language: languageToggle, account: accountToggle, mobile: mobileToggle }[openMenu];
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
          <Link to="/explore" viewTransition className="public-nav-link" aria-current={current(isCurrent('/explore'))}>Explore</Link>
          <Link to="/engines" viewTransition className="public-nav-link" aria-current={current(isCurrent('/engines'))}>Engines</Link>
          <div className="public-nav-menu" onBlur={openMenu === 'language' ? closeWhenFocusLeaves : undefined}>
            <button
              ref={languageToggle}
              type="button"
              className={`public-nav-link${languageActive ? ' is-active' : ''}`}
              aria-expanded={openMenu === 'language'}
              aria-controls="public-language-menu"
              onClick={() => toggleMenu('language')}
            >
              Language <ChevronDown aria-hidden="true" />
            </button>
            {openMenu === 'language' && (
              <div id="public-language-menu" className="public-menu-panel public-language-panel">
                {languageLinks.map((link) => (
                  <Link key={link.to} to={link.to} viewTransition aria-current={current(link.isActive(location.pathname))}>
                    <strong>{link.label}</strong><span>{link.description}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
          <Link to="/pricing" viewTransition className="public-nav-link" aria-current={current(isCurrent('/pricing'))}>Pricing</Link>
          <Link to="/about" viewTransition className="public-nav-link" aria-current={current(isCurrent('/about'))}>About</Link>
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
          <Link to="/explore" viewTransition aria-current={current(isCurrent('/explore'))}>Explore</Link>
          <Link to="/engines" viewTransition aria-current={current(isCurrent('/engines'))}>Engines</Link>
          <div className="public-mobile-group">
            <span>Language</span>
            {languageLinks.map((link) => (
              <Link key={link.to} to={link.to} viewTransition aria-current={current(link.isActive(location.pathname))}>{link.label}</Link>
            ))}
          </div>
          <Link to="/pricing" viewTransition aria-current={current(isCurrent('/pricing'))}>Pricing</Link>
          <Link to="/about" viewTransition aria-current={current(isCurrent('/about'))}>About</Link>
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
