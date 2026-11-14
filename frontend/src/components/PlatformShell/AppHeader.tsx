import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
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
  accountLinks, createItems, currentSection, labEntries, labEntryOf, mainLinks, problemsEntry,
  type MenuEntry,
} from './appNavigation';
import { CommandPalette, OPEN_COMMAND_PALETTE_EVENT } from './CommandPalette';
import './AppHeader.css';

type MenuName = 'lab' | 'new' | 'account' | 'mobile';

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
  const hintScope = useId();
  const header = useRef<HTMLElement>(null);
  const labToggle = useRef<HTMLButtonElement>(null);
  const newToggle = useRef<HTMLButtonElement>(null);
  const accountToggle = useRef<HTMLButtonElement>(null);
  const mobileToggle = useRef<HTMLButtonElement>(null);
  // Menus belong to the location they were opened on, so navigating closes them.
  const [opened, setOpened] = useState<{ menu: MenuName | null; at: string }>({ menu: null, at: location.key });
  const openMenu = opened.at === location.key ? opened.menu : null;
  const [shortcut] = useState(shortcutLabel);

  const section = currentSection(location.pathname);
  const labEntry = labEntryOf(location.pathname);
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
    const toggle = { lab: labToggle, new: newToggle, account: accountToggle, mobile: mobileToggle }[openMenu];
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
  const problems = problemsEntry(organization, project);
  const lab = labEntries(organization, project);
  const items = createItems(organization, project);

  /** A link, or an entry that is disabled and says what it needs. `where` keeps the hint ids of the desktop and phone menus apart. */
  const renderEntry = (entry: MenuEntry, where: string, className?: string, active = false) => {
    if (entry.to) {
      return (
        <Link key={entry.label} to={entry.to} viewTransition className={className} aria-current={current(active)}>{entry.label}</Link>
      );
    }
    const hintId = `${hintScope}-${where}-${entry.label}`;
    return (
      <span key={entry.label} className={`app-menu-disabled ${className ?? ''}`.trim()}>
        <span role="link" tabIndex={0} aria-disabled="true" aria-describedby={hintId}>{entry.label}</span>
        <small id={hintId}>{entry.hint}</small>
      </span>
    );
  };

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
            {renderEntry(mainLinks.home, 'nav', 'app-nav-link', section === 'home')}
            {renderEntry(problems, 'nav', 'app-nav-link', section === 'problems')}
            <div className="app-menu" data-app-menu="lab" onBlur={openMenu === 'lab' ? closeWhenFocusLeaves : undefined}>
              <button
                ref={labToggle}
                type="button"
                className={`app-nav-link${section === 'lab' ? ' is-active' : ''}`}
                aria-expanded={openMenu === 'lab'}
                aria-controls="app-lab-menu"
                onClick={() => toggleMenu('lab')}
              >
                Lab <ChevronDown aria-hidden="true" />
              </button>
              {openMenu === 'lab' && (
                <div id="app-lab-menu" className="app-menu-panel app-lab-panel" onClick={closeAfterLink}>
                  {lab.map((entry) => renderEntry(entry, 'lab', undefined, labEntry === entry.id))}
                </div>
              )}
            </div>
            {renderEntry(mainLinks.engines, 'nav', 'app-nav-link', section === 'engines')}
            {isAdmin && renderEntry(mainLinks.admin, 'nav', 'app-nav-link', section === 'admin')}
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
                {items.map((entry) => renderEntry(entry, 'new'))}
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
                <hr />
                <button type="button" onClick={handleSignOut}>Sign out</button>
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
        {renderEntry(mainLinks.home, 'mobile', undefined, section === 'home')}
        {renderEntry(problems, 'mobile', undefined, section === 'problems')}
        <div className="app-mobile-group">
          <span>Lab</span>
          {lab.map((entry) => renderEntry(entry, 'mobile-lab', undefined, labEntry === entry.id))}
        </div>
        {renderEntry(mainLinks.engines, 'mobile', undefined, section === 'engines')}
        {isAdmin && renderEntry(mainLinks.admin, 'mobile', undefined, section === 'admin')}
        <div className="app-mobile-group">
          <span>New</span>
          {items.map((entry) => renderEntry(entry, 'mobile-new'))}
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
