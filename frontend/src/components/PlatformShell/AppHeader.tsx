import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { ChevronDown, Menu, Plus, Search, X } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import type { Organization, Project } from '../../api/platform';
import { config } from '../../config';
import { useAuth } from '../../contexts/auth';
import { personInitials } from '../../utils/initials';
import { InstitutionMark } from '../InstitutionMark';
import { INSTITUTION_NAME, useInstitutionalBranding } from '../InstitutionMark/institution';
import { NotificationDropdown } from '../NotificationDropdown/NotificationDropdown';
import {
  accountLinks, createItems, currentSection, isToolActive, mainLinks, toolLinks,
  type NavLinkItem,
} from './appNavigation';
import { CommandPalette, OPEN_COMMAND_PALETTE_EVENT } from './CommandPalette';
import './AppHeader.css';

type MenuName = 'tools' | 'new' | 'account' | 'mobile';

interface AppHeaderProps {
  organizations?: Organization[];
  projects?: Project[];
  organization?: Organization;
  project?: Project;
}

const shortcutLabel = () => (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K');

export function AppHeader({ organizations = [], projects = [], organization, project }: AppHeaderProps) {
  const { user, isAdmin, signOut } = useAuth();
  const institutional = useInstitutionalBranding();
  const location = useLocation();
  const header = useRef<HTMLElement>(null);
  const toolsToggle = useRef<HTMLButtonElement>(null);
  const newToggle = useRef<HTMLButtonElement>(null);
  const accountToggle = useRef<HTMLButtonElement>(null);
  const mobileToggle = useRef<HTMLButtonElement>(null);
  // Menus belong to the location they were opened on, so navigating closes them.
  const [opened, setOpened] = useState<{ menu: MenuName | null; at: string }>({ menu: null, at: location.key });
  const openMenu = opened.at === location.key ? opened.menu : null;
  const [shortcut] = useState(shortcutLabel);

  const section = currentSection(location.pathname);
  const current = (active: boolean) => (active ? 'page' : undefined);
  const closeMenus = () => setOpened({ menu: null, at: location.key });
  const toggleMenu = (menu: MenuName) => setOpened({ menu: openMenu === menu ? null : menu, at: location.key });

  useEffect(() => {
    if (!openMenu) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest(`[data-app-menu="${openMenu}"]`)) setOpened({ menu: null, at: location.key });
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [openMenu, location.key]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || !openMenu) return;
    closeMenus();
    const toggle = { tools: toolsToggle, new: newToggle, account: accountToggle, mobile: mobileToggle }[openMenu];
    toggle.current?.focus();
  };
  const closeWhenFocusLeaves = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenus();
  };
  const closeAfterLink = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as Element).closest('a')) closeMenus();
  };
  const handleSignOut = () => {
    closeMenus();
    void signOut();
  };
  const openPalette = () => {
    closeMenus();
    window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT));
  };

  const contextLabel = organization ? [organization.name, project?.name].filter(Boolean).join(' / ') : '';
  const initials = personInitials(user?.username);
  const items = createItems(organization, project);
  const toolsActive = section === 'tools';

  const renderTool = (item: NavLinkItem) => (
    <Link key={item.to} to={item.to} viewTransition aria-current={current(isToolActive(location.pathname, item))}>{item.label}</Link>
  );
  const renderCreate = (item: ReturnType<typeof createItems>[number]) => (item.to ? (
    <Link key={item.label} to={item.to} viewTransition>
      {item.label}{item.hint && <small>{item.hint}</small>}
    </Link>
  ) : (
    <span key={item.label} className="app-menu-disabled" aria-disabled="true">
      {item.label}<small>{item.hint}</small>
    </span>
  ));

  return (
    <header ref={header} className="app-header" onKeyDown={handleKeyDown}>
      <div className="app-header-inner">
        <div className="app-header-start">
          <Link to="/app" viewTransition className="app-brand" aria-label={`${config.name} home`}>
            <span className="app-wordmark">OpenBinding</span>
            <InstitutionMark variant="compact" className="app-brand-institution" />
          </Link>

          {contextLabel && (
            <Link to="/app" viewTransition className="app-context" title="Switch organization or project">
              <span>{contextLabel}</span><ChevronDown aria-hidden="true" />
            </Link>
          )}

          <nav className="app-nav" aria-label="Main">
            <Link to={mainLinks.home.to} viewTransition className="app-nav-link" aria-current={current(section === 'home')}>{mainLinks.home.label}</Link>
            <Link to={mainLinks.jobs.to} viewTransition className="app-nav-link" aria-current={current(section === 'jobs')}>{mainLinks.jobs.label}</Link>
            <Link to={mainLinks.analysis.to} viewTransition className="app-nav-link" aria-current={current(section === 'analysis')}>{mainLinks.analysis.label}</Link>
            <Link to={mainLinks.explore.to} viewTransition className="app-nav-link" aria-current={current(section === 'explore')}>{mainLinks.explore.label}</Link>
            <div className="app-menu" data-app-menu="tools" onBlur={openMenu === 'tools' ? closeWhenFocusLeaves : undefined}>
              <button
                ref={toolsToggle}
                type="button"
                className={`app-nav-link${toolsActive ? ' is-active' : ''}`}
                aria-expanded={openMenu === 'tools'}
                aria-controls="app-tools-menu"
                onClick={() => toggleMenu('tools')}
              >
                Tools <ChevronDown aria-hidden="true" />
              </button>
              {openMenu === 'tools' && (
                <div id="app-tools-menu" className="app-menu-panel app-tools-panel" onClick={closeAfterLink}>
                  {toolLinks.map(renderTool)}
                </div>
              )}
            </div>
            {isAdmin && (
              <Link to={mainLinks.admin.to} viewTransition className="app-nav-link" aria-current={current(section === 'admin')}>{mainLinks.admin.label}</Link>
            )}
          </nav>
        </div>

        <div className="app-header-end">
          <div className="app-menu app-new-menu" data-app-menu="new" onBlur={openMenu === 'new' ? closeWhenFocusLeaves : undefined}>
            <button
              ref={newToggle}
              type="button"
              className="app-new-button"
              aria-expanded={openMenu === 'new'}
              aria-controls="app-new-menu"
              onClick={() => toggleMenu('new')}
            >
              <Plus aria-hidden="true" />New<ChevronDown aria-hidden="true" />
            </button>
            {openMenu === 'new' && (
              <div id="app-new-menu" className="app-menu-panel app-new-panel" onClick={closeAfterLink}>
                {items.map(renderCreate)}
              </div>
            )}
          </div>

          <button type="button" className="app-search-button" onClick={openPalette} aria-label="Open command palette (Ctrl or Cmd + K)">
            <Search aria-hidden="true" />Search<kbd>{shortcut}</kbd>
          </button>

          <NotificationDropdown />

          <div className="app-menu" data-app-menu="account" onBlur={openMenu === 'account' ? closeWhenFocusLeaves : undefined}>
            <button
              ref={accountToggle}
              type="button"
              className="app-avatar"
              aria-label="Account menu"
              aria-expanded={openMenu === 'account'}
              aria-controls="app-account-menu"
              onClick={() => toggleMenu('account')}
            >
              {initials}
            </button>
            {openMenu === 'account' && (
              <div id="app-account-menu" className="app-menu-panel app-account-panel" onClick={closeAfterLink}>
                <div className="app-account-card">
                  <strong>{user?.username}</strong>
                  <span>{user?.email}</span>
                  {institutional && (
                    <span className="app-institution-chip">
                      <InstitutionMark variant="compact" />{INSTITUTION_NAME} · Institutional account
                    </span>
                  )}
                </div>
                {accountLinks.map((link) => (
                  <Link key={link.to} to={link.to} viewTransition aria-current={current(location.pathname === link.to)}>{link.label}</Link>
                ))}
                {isAdmin && <Link to="/app/admin" viewTransition>Administration</Link>}
                <hr />
                <button type="button" onClick={handleSignOut}>Log out</button>
              </div>
            )}
          </div>

          <button
            ref={mobileToggle}
            type="button"
            className="app-mobile-toggle"
            data-app-menu="mobile"
            aria-label={openMenu === 'mobile' ? 'Close menu' : 'Open menu'}
            aria-expanded={openMenu === 'mobile'}
            aria-controls="app-mobile-menu"
            onClick={() => toggleMenu('mobile')}
          >
            {openMenu === 'mobile' ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
          </button>
        </div>
      </div>

      <nav
        id="app-mobile-menu"
        className={`app-mobile-menu${openMenu === 'mobile' ? ' is-open' : ''}`}
        data-app-menu="mobile"
        aria-label="Mobile navigation"
        onClick={closeAfterLink}
      >
        {contextLabel && <Link to="/app" viewTransition className="app-mobile-context">{contextLabel}</Link>}
        <Link to={mainLinks.home.to} viewTransition aria-current={current(section === 'home')}>{mainLinks.home.label}</Link>
        <Link to={mainLinks.jobs.to} viewTransition aria-current={current(section === 'jobs')}>{mainLinks.jobs.label}</Link>
        <Link to={mainLinks.analysis.to} viewTransition aria-current={current(section === 'analysis')}>{mainLinks.analysis.label}</Link>
        <Link to={mainLinks.explore.to} viewTransition aria-current={current(section === 'explore')}>{mainLinks.explore.label}</Link>
        {isAdmin && <Link to={mainLinks.admin.to} viewTransition aria-current={current(section === 'admin')}>{mainLinks.admin.label}</Link>}
        <div className="app-mobile-group">
          <span>Tools</span>
          {toolLinks.map(renderTool)}
        </div>
        <div className="app-mobile-group">
          <span>New</span>
          {items.map(renderCreate)}
        </div>
        <button type="button" className="app-mobile-search" onClick={openPalette}>
          <Search aria-hidden="true" />Search
        </button>
        <InstitutionMark variant="wide" className="app-mobile-institution" />
      </nav>

      <CommandPalette
        organizations={organizations}
        projects={projects}
        organization={organization}
        project={project}
        isAdmin={isAdmin}
      />
    </header>
  );
}
