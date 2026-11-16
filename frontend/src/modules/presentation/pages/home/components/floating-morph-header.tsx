// Adapted from SPHERE frontend/src/modules/presentation/pages/home/components/floating-morph-header.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's wordmark, menus and account places, as links with an active state instead of buttons; Log in and
// Sign up lead to OpenBinding's sign-in pages; SPHERE's hex slate colours are Tailwind's slate scale; the menus open from the
// keyboard, close on Escape and are labelled; the institutional mark of a verified account sits by the wordmark.

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { InstitutionMark } from '../../../../../components/InstitutionMark';
import { config } from '../../../../../config';
import { useAuth } from '../../../../auth/hooks/useAuth';
import UserAvatar from '../../../../core/components/user-avatar';
import { isActive, userEntries, type HeaderRoute } from '../../../layouts/router/header-routes';

type Props = {
  navItems: HeaderRoute[];
};

export default function FloatingMorphHeader({ navItems }: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const [menu, setMenu] = useState<{ open: boolean; at: string }>({
    open: false,
    at: location.key,
  });
  const isMenuOpen = menu.open && menu.at === location.key;
  const setIsMenuOpen = (open: boolean) => setMenu({ open, at: location.key });
  const [openDesktopDropdown, setOpenDesktopDropdown] = useState<string | null>(null);
  const [openMobileDropdown, setOpenMobileDropdown] = useState<string | null>(null);
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false);
  const headerMorphRef = useRef<HTMLElement | null>(null);
  const userMenuContainerRef = useRef<HTMLDivElement | null>(null);
  const headerMorphTargetRef = useRef(0);
  const headerMorphCurrentRef = useRef(0);
  const headerMorphRafRef = useRef(0);
  const menuToggleRef = useRef<HTMLButtonElement | null>(null);
  const { user, isAdmin, signOut } = useAuth();

  useEffect(() => {
    document.body.style.overflow = isMenuOpen ? 'hidden' : '';

    return () => {
      document.body.style.overflow = '';
    };
  }, [isMenuOpen]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsUserMenuOpen(false);
        setOpenDesktopDropdown(null);
        setMenu(current => {
          if (current.open) menuToggleRef.current?.focus();
          return { ...current, open: false };
        });
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, []);

  useEffect(() => {
    if (!isUserMenuOpen) {
      return;
    }

    const handleOutsideClick = (event: MouseEvent | TouchEvent) => {
      if (!userMenuContainerRef.current?.contains(event.target as Node)) {
        setIsUserMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick);

    return () => {
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
    };
  }, [isUserMenuOpen]);

  useEffect(() => {
    const applyMorph = (value: number) => {
      if (!headerMorphRef.current) {
        return;
      }

      headerMorphRef.current.style.setProperty('--header-morph', value.toFixed(4));
    };

    const animateMorph = () => {
      const current = headerMorphCurrentRef.current;
      const target = headerMorphTargetRef.current;
      const next = current + (target - current) * 0.24;
      const isSettled = Math.abs(target - next) < 0.0015;
      const finalValue = isSettled ? target : next;

      headerMorphCurrentRef.current = finalValue;
      applyMorph(finalValue);

      if (!isSettled) {
        headerMorphRafRef.current = window.requestAnimationFrame(animateMorph);
        return;
      }

      headerMorphRafRef.current = 0;
    };

    const scheduleMorph = () => {
      if (headerMorphRafRef.current !== 0) {
        return;
      }

      headerMorphRafRef.current = window.requestAnimationFrame(animateMorph);
    };

    const updateMorphTarget = () => {
      const progress = Math.min(window.scrollY / 160, 1);
      headerMorphTargetRef.current = progress;
      scheduleMorph();
    };

    applyMorph(0);
    updateMorphTarget();

    window.addEventListener('scroll', updateMorphTarget, { passive: true });
    window.addEventListener('resize', updateMorphTarget, { passive: true });

    return () => {
      if (headerMorphRafRef.current !== 0) {
        window.cancelAnimationFrame(headerMorphRafRef.current);
        headerMorphRafRef.current = 0;
      }

      window.removeEventListener('scroll', updateMorphTarget);
      window.removeEventListener('resize', updateMorphTarget);
    };
  }, []);

  const handleLogout = () => {
    setIsUserMenuOpen(false);
    setIsMenuOpen(false);
    void signOut().then(() => navigate('/'));
  };

  const headerStyle: CSSProperties = {
    ['--header-morph' as string]: 0,
    marginTop: 'calc(24px * (1 - var(--header-morph)))',
    paddingLeft: 'calc(16px * (1 - var(--header-morph)))',
    paddingRight: 'calc(16px * (1 - var(--header-morph)))',
  };

  const barStyle: CSSProperties = {
    maxWidth: 'calc(1080px + (100vw - 1080px) * var(--header-morph))',
    borderRadius: 'calc(9999px * (1 - var(--header-morph)))',
    paddingLeft: 'calc(20px + 12px * var(--header-morph))',
    paddingRight: 'calc(20px + 12px * var(--header-morph))',
    backgroundColor: 'rgb(255 255 255 / calc(0.75 + 0.2 * var(--header-morph)))',
    boxShadow:
      '0 calc(6px + 8px * var(--header-morph)) calc(26px + 18px * var(--header-morph)) rgb(15 23 42 / calc(0.08 + 0.08 * var(--header-morph)))',
    borderBottomWidth: 'calc(1px * var(--header-morph))',
    borderBottomColor: 'rgba(15,23,42,0.1)',
  };

  const ease = 'transition-all duration-700 ease-[cubic-bezier(0.32,0.72,0,1)]';

  return (
    <>
      <header
        ref={headerMorphRef}
        style={headerStyle}
        className="site-header fixed inset-x-0 top-0 z-30 flex justify-center will-change-transform"
      >
        <div
          style={barStyle}
          className="flex w-full items-center justify-between border border-black/10 py-3 backdrop-blur-3xl"
        >
          <Link
            to="/"
            aria-label={`${config.name} home`}
            className={`flex cursor-pointer items-center gap-2 text-sm font-medium tracking-[0.22em] text-slate-900 uppercase ${ease} hover:text-black`}
          >
            OpenBinding
            <InstitutionMark variant="compact" />
          </Link>

          <nav className="hidden items-center gap-3 md:flex" aria-label="Primary navigation">
            {navItems.map(item => {
              const active = isActive(item, location.pathname);
              const itemClass = `inline-flex cursor-pointer items-center gap-1 rounded-full px-3 py-1.5 text-xs tracking-[0.16em] uppercase ${ease} hover:text-slate-900 ${
                active
                  ? 'text-slate-900 underline decoration-tp-primary decoration-2 underline-offset-8'
                  : 'text-slate-700'
              }`;
              if (!item.children) {
                return (
                  <Link
                    key={item.name}
                    to={item.to!}
                    className={itemClass}
                    aria-current={active ? 'page' : undefined}
                  >
                    {item.name}
                  </Link>
                );
              }
              const open = openDesktopDropdown === item.name;
              return (
                <div
                  key={item.name}
                  className="relative"
                  onMouseEnter={() => setOpenDesktopDropdown(item.name)}
                  onMouseLeave={() => setOpenDesktopDropdown(null)}
                  onBlur={event => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                      setOpenDesktopDropdown(null);
                  }}
                >
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenDesktopDropdown(open ? null : item.name)}
                    className={itemClass}
                  >
                    {item.name}
                    <span className="text-[11px]" aria-hidden="true">
                      ▾
                    </span>
                  </button>

                  <div
                    aria-hidden={!open}
                    className={`absolute top-full left-0 min-w-55 pt-2 transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${open ? 'pointer-events-auto visible translate-y-0 opacity-100' : 'pointer-events-none invisible -translate-y-2 opacity-0'}`}
                  >
                    <div className="rounded-2xl border border-black/10 bg-white p-2 shadow-elevation-3">
                      {item.children.map(child => (
                        <Link
                          key={child.name}
                          to={child.to!}
                          onClick={() => setOpenDesktopDropdown(null)}
                          aria-current={isActive(child, location.pathname) ? 'page' : undefined}
                          className="block w-full cursor-pointer rounded-xl px-3 py-2 text-center text-xs tracking-[0.12em] text-slate-700 uppercase transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-slate-50 hover:text-slate-900"
                        >
                          {child.name}
                        </Link>
                      ))}
                    </div>
                  </div>
                </div>
              );
            })}
          </nav>

          <div className="hidden md:block">
            {user ? (
              <div ref={userMenuContainerRef} className="relative">
                <button
                  type="button"
                  onClick={() => setIsUserMenuOpen(prev => !prev)}
                  aria-label="Account menu"
                  aria-expanded={isUserMenuOpen}
                  className="cursor-pointer overflow-hidden rounded-full border border-black/15 bg-white"
                >
                  <UserAvatar username={user.username} size={40} />
                </button>

                <div
                  aria-hidden={!isUserMenuOpen}
                  className={`absolute top-full right-0 mt-2 w-55 rounded-2xl border border-black/10 bg-white p-2 shadow-elevation-3 transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] ${isUserMenuOpen ? 'pointer-events-auto visible translate-y-0 opacity-100' : 'pointer-events-none invisible -translate-y-2 opacity-0'}`}
                >
                  <div className="mb-2 rounded-xl border border-black/10 bg-stone-50 px-3 py-2 text-center">
                    <p className="text-sm font-medium text-slate-900">{user.username}</p>
                    <p className="truncate text-xs text-slate-500">{user.email}</p>
                  </div>
                  {userEntries(isAdmin).map(entry => (
                    <Link
                      key={entry.label}
                      to={entry.to}
                      onClick={() => setIsUserMenuOpen(false)}
                      className="block w-full cursor-pointer rounded-xl px-3 py-2 text-center text-xs tracking-[0.12em] text-slate-700 uppercase transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-slate-50 hover:text-slate-900"
                    >
                      {entry.label}
                    </Link>
                  ))}
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="mt-1 block w-full cursor-pointer rounded-xl px-3 py-2 text-center text-xs tracking-[0.12em] text-slate-700 uppercase transition-all duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-slate-50 hover:text-slate-900"
                  >
                    Sign out
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <Link
                  to="/authentication"
                  className={`inline-flex h-10 cursor-pointer items-center justify-center rounded-full border border-black/15 bg-white px-5 text-xs tracking-[0.14em] text-slate-700 uppercase ${ease} hover:text-slate-900`}
                >
                  Log in
                </Link>
                <Link
                  to="/authentication?view=register"
                  className={`group inline-flex h-10 cursor-pointer items-center gap-2 rounded-full border border-black/10 bg-slate-900 px-5 text-xs tracking-[0.14em] text-white uppercase ${ease} hover:bg-slate-800 active:scale-[0.98]`}
                >
                  Sign up
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full bg-white/15 text-[11px] ${ease} group-hover:translate-x-1 group-hover:-translate-y-px`}
                    aria-hidden="true"
                  >
                    ↗
                  </span>
                </Link>
              </div>
            )}
          </div>

          <button
            ref={menuToggleRef}
            type="button"
            aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={isMenuOpen}
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className={`relative flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-black/10 bg-white ${ease} active:scale-[0.98] md:hidden`}
          >
            <span
              className={`absolute h-px w-5 bg-slate-900 ${ease} ${isMenuOpen ? 'translate-y-0 rotate-45' : '-translate-y-1.25 rotate-0'}`}
            />
            <span
              className={`absolute h-px w-5 bg-slate-900 ${ease} ${isMenuOpen ? 'translate-y-0 -rotate-45' : 'translate-y-1.25 rotate-0'}`}
            />
          </button>
        </div>
      </header>

      <div
        aria-hidden={!isMenuOpen}
        inert={!isMenuOpen}
        className={`fixed inset-0 z-20 bg-white/85 px-4 pt-28 backdrop-blur-3xl ${ease} md:hidden ${isMenuOpen ? 'pointer-events-auto visible opacity-100' : 'pointer-events-none invisible opacity-0'}`}
      >
        <nav
          className="mx-auto flex w-full max-w-112 flex-col gap-3"
          aria-label="Mobile navigation"
        >
          {navItems.map((item, index) => (
            <div
              key={item.name}
              className="rounded-[1.35rem] border border-black/10 bg-white px-5 py-3"
            >
              {item.children ? (
                <button
                  type="button"
                  aria-expanded={openMobileDropdown === item.name}
                  style={{ transitionDelay: `${100 + index * 50}ms` }}
                  onClick={() =>
                    setOpenMobileDropdown(prev => (prev === item.name ? null : item.name))
                  }
                  className={`flex w-full cursor-pointer items-center justify-between text-left text-sm tracking-[0.15em] text-slate-900 uppercase ${ease} ${isMenuOpen ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0'}`}
                >
                  {item.name}
                  <span className="text-[11px]" aria-hidden="true">
                    {openMobileDropdown === item.name ? '▴' : '▾'}
                  </span>
                </button>
              ) : (
                <Link
                  to={item.to!}
                  onClick={() => setIsMenuOpen(false)}
                  style={{ transitionDelay: `${100 + index * 50}ms` }}
                  aria-current={isActive(item, location.pathname) ? 'page' : undefined}
                  className={`flex w-full cursor-pointer items-center justify-between text-left text-sm tracking-[0.15em] text-slate-900 uppercase ${ease} ${isMenuOpen ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0'}`}
                >
                  {item.name}
                </Link>
              )}

              {item.children && openMobileDropdown === item.name ? (
                <div className="mt-3 flex flex-col gap-2">
                  {item.children.map(child => (
                    <Link
                      key={child.name}
                      to={child.to!}
                      onClick={() => setIsMenuOpen(false)}
                      className="cursor-pointer rounded-xl border border-black/10 bg-slate-50 px-3 py-2 text-center text-xs tracking-[0.12em] text-slate-700 uppercase"
                    >
                      {child.name}
                    </Link>
                  ))}
                </div>
              ) : null}
            </div>
          ))}

          {user ? (
            <div
              className={`mt-2 rounded-[1.35rem] border border-black/10 bg-white px-5 py-4 ${ease} ${isMenuOpen ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0'}`}
            >
              <div className="mb-3 flex items-center gap-3">
                <div className="overflow-hidden rounded-full border border-black/10 bg-white">
                  <UserAvatar username={user.username} size={40} />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900">{user.username}</p>
                  <p className="truncate text-xs text-slate-500">{user.email}</p>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                {userEntries(isAdmin).map(entry => (
                  <Link
                    key={entry.label}
                    to={entry.to}
                    onClick={() => setIsMenuOpen(false)}
                    className="rounded-xl border border-black/10 bg-slate-50 px-3 py-2 text-center text-xs tracking-[0.12em] text-slate-700 uppercase"
                  >
                    {entry.label}
                  </Link>
                ))}
                <button
                  type="button"
                  onClick={handleLogout}
                  className="cursor-pointer rounded-xl border border-black/10 bg-slate-50 px-3 py-2 text-center text-xs tracking-[0.12em] text-slate-700 uppercase"
                >
                  Sign out
                </button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex flex-col gap-2">
              <Link
                to="/authentication"
                onClick={() => setIsMenuOpen(false)}
                className={`inline-flex cursor-pointer items-center justify-center rounded-full border border-black/10 bg-white px-6 py-3 text-sm font-medium text-slate-700 ${ease} ${isMenuOpen ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0'}`}
              >
                Log in
              </Link>
              <Link
                to="/authentication?view=register"
                onClick={() => setIsMenuOpen(false)}
                className={`inline-flex cursor-pointer items-center justify-between rounded-full border border-black/10 bg-slate-900 px-6 py-3 text-sm font-medium text-white ${ease} ${isMenuOpen ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0'}`}
              >
                Sign up
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-white/15 text-[13px]"
                  aria-hidden="true"
                >
                  ↗
                </span>
              </Link>
            </div>
          )}
        </nav>
      </div>
    </>
  );
}
