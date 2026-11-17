// Adapted from SPHERE frontend/src/modules/presentation/layouts/authenticated-layout/app-header.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's menus (layouts/router/header-routes.ts) as real links with an active state, so middle-click and the
// back button work (SPHERE's are buttons calling router.push); the dropdowns also open from the keyboard and close on Escape;
// New creates in the organization the address names; the palette is fed by OpenBinding's commands; the bell is OpenBinding's
// notification panel until SPHERE's arrives (B4); the white label of New sits on the accent; the mobile drawer opens the
// palette (Search) and gives focus back to its toggle.

import { useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { FaBuilding, FaCogs, FaFileAlt, FaFlask, FaPlay, FaProjectDiagram } from 'react-icons/fa';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { buildCommands } from '../router/paletteCommands';
import { organizationOfPath } from '../router/organizationOfPath';
import NotificationBell from '../../../notification/components/notification-bell';
import { InstitutionMark } from '../../../auth/components/institution-mark';
import { config } from '../../../../config';
import { useAuth } from '../../../auth/hooks/useAuth';
import CommandPalette, { type PaletteCommand } from '../../../core/components/command-palette';
import { useOrganization } from '../../../organization/hooks/useOrganization';
import { headerRoutes, isActive, newEntries } from '../router/header-routes';
import MobileNav from './mobile-nav';
import UserMenu from './user-menu';

const NEW_ICONS: Record<string, typeof FaFileAlt> = {
  Composition: FaFileAlt,
  Problem: FaProjectDiagram,
  Run: FaPlay,
  Study: FaFlask,
  Organization: FaBuilding,
  Engine: FaCogs,
};

const chevron = (open: boolean) => (
  <svg
    className={`h-3.5 w-3.5 text-tp-ink transition-transform ${open ? 'rotate-180' : ''}`}
    fill="none"
    viewBox="0 0 24 24"
    stroke="currentColor"
    strokeWidth={2}
    aria-hidden="true"
  >
    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
  </svg>
);

export default function AppHeader() {
  const location = useLocation();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();
  const { organizations } = useOrganization();
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const mobileToggle = useRef<HTMLButtonElement>(null);

  const org = organizationOfPath(location.pathname, location.search);
  const organization =
    (org ? organizations.find(item => item.slug === org) : undefined) ?? organizations[0];

  const commands = useMemo<PaletteCommand[]>(
    () =>
      buildCommands({ organizations, organization, isAdmin }).map(command => ({
        id: `${command.group}:${command.href}:${command.label}`,
        label: command.label,
        description: command.desc,
        group: command.group,
        action: () => navigate(command.href),
      })),
    [organizations, organization, isAdmin, navigate]
  );

  const close = () => setOpenDropdown(null);
  const closeOnEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && openDropdown) {
      event.stopPropagation();
      close();
    }
  };
  const closeWhenFocusLeaves = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
  };

  return (
    <>
      <header
        className="app-header sticky top-0 z-40 border-b border-tp-hairline bg-tp-canvas/80 backdrop-blur-xl"
        onKeyDown={closeOnEscape}
      >
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center justify-between px-4 md:px-6">
          {/* Left: Logo */}
          <div className="flex items-center gap-4">
            <Link
              to="/"
              aria-label={`${config.name} home`}
              className="flex cursor-pointer items-center gap-2 text-sm font-semibold tracking-[0.22em] text-tp-ink uppercase transition-colors hover:text-tp-accent"
            >
              OpenBinding
              <InstitutionMark variant="compact" />
            </Link>
          </div>

          {/* Center: Navigation (desktop) */}
          <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
            {headerRoutes.map(item => {
              const active = isActive(item, location.pathname);
              const linkClass = `inline-flex cursor-pointer items-center gap-1 rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-tp-surface hover:text-tp-ink ${
                active ? 'bg-tp-surface font-medium text-tp-ink' : 'text-tp-slate'
              }`;
              if (!item.children) {
                return (
                  <Link
                    key={item.name}
                    to={item.to!}
                    className={linkClass}
                    aria-current={active ? 'page' : undefined}
                  >
                    {item.name}
                  </Link>
                );
              }
              const open = openDropdown === item.name;
              return (
                <div
                  key={item.name}
                  className="relative"
                  onMouseEnter={() => setOpenDropdown(item.name)}
                  onMouseLeave={close}
                  onBlur={closeWhenFocusLeaves}
                >
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenDropdown(open ? null : item.name)}
                    className={linkClass}
                  >
                    {item.name}
                    {chevron(open)}
                  </button>
                  <div
                    aria-hidden={!open}
                    className={`absolute top-full left-0 z-50 min-w-50 pt-1 transition-all ${
                      open
                        ? 'pointer-events-auto visible translate-y-0 opacity-100'
                        : 'pointer-events-none invisible -translate-y-1 opacity-0'
                    }`}
                  >
                    <div className="rounded-lg border border-tp-hairline bg-tp-canvas py-1 shadow-elevation-4">
                      {item.children.map(child => {
                        const current = isActive(child, location.pathname);
                        return (
                          <Link
                            key={child.to}
                            to={child.to!}
                            onClick={close}
                            aria-current={current ? 'page' : undefined}
                            className={`block w-full cursor-pointer px-3 py-2 text-left text-sm transition-colors hover:bg-tp-surface hover:text-tp-ink ${
                              current ? 'font-medium text-tp-ink' : 'text-tp-slate'
                            }`}
                          >
                            {child.name}
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                </div>
              );
            })}
          </nav>

          {/* Right: Actions */}
          <div className="flex items-center gap-3">
            <div
              className="relative hidden md:block"
              onMouseEnter={() => setOpenDropdown('new')}
              onMouseLeave={close}
              onBlur={closeWhenFocusLeaves}
            >
              <button
                type="button"
                aria-expanded={openDropdown === 'new'}
                onClick={() => setOpenDropdown(openDropdown === 'new' ? null : 'new')}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-tp-accent px-3 py-1.5 text-sm font-medium text-tp-on-primary transition-colors hover:bg-tp-accent-hover"
              >
                <svg
                  className="h-4 w-4"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                New
                <svg
                  className={`h-3.5 w-3.5 transition-transform ${openDropdown === 'new' ? 'rotate-180' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden="true"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </button>

              <div
                aria-hidden={openDropdown !== 'new'}
                className={`absolute top-full right-0 z-50 min-w-45 pt-1 transition-all ${
                  openDropdown === 'new'
                    ? 'pointer-events-auto visible translate-y-0 opacity-100'
                    : 'pointer-events-none invisible -translate-y-1 opacity-0'
                }`}
              >
                <div className="rounded-lg border border-tp-hairline bg-tp-canvas py-1 shadow-elevation-4">
                  {newEntries(organization?.slug).map(entry => {
                    const Icon = NEW_ICONS[entry.label] ?? FaFileAlt;
                    return (
                      <Link
                        key={entry.label}
                        to={entry.to}
                        onClick={close}
                        className="flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left text-sm text-tp-slate transition-colors hover:bg-tp-surface hover:text-tp-ink"
                      >
                        <Icon className="h-4 w-4" aria-hidden="true" />
                        {entry.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="hidden md:block">
              <CommandPalette
                commands={commands}
                placeholder="Search commands, organizations and pages..."
                open={paletteOpen}
                onOpenChange={setPaletteOpen}
              />
            </div>

            <div className="hidden md:block">
              <NotificationBell />
            </div>

            <div className="hidden md:block">
              <UserMenu />
            </div>

            {/* Mobile menu button */}
            <button
              ref={mobileToggle}
              type="button"
              aria-label="Open menu"
              aria-expanded={mobileNavOpen}
              onClick={() => setMobileNavOpen(true)}
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-tp-steel transition-colors hover:bg-tp-surface hover:text-tp-ink md:hidden"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M3.75 9h16.5m-16.5 6.75h16.5"
                />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <MobileNav
        isOpen={mobileNavOpen}
        onClose={() => {
          setMobileNavOpen(false);
          mobileToggle.current?.focus();
        }}
        onSearch={() => {
          setMobileNavOpen(false);
          setPaletteOpen(true);
        }}
        organization={organization?.slug}
      />
    </>
  );
}
