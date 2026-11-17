// Adapted from SPHERE frontend/src/modules/presentation/layouts/authenticated-layout/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a skip link and a focusable main landmark; ORBIT's widget arrives in F7.

import type { ReactNode } from 'react';
import SunsetStripeBand from '../../../core/components/sunset-stripe';
import AppFooter from './app-footer';
import AppHeader from './app-header';

export default function AuthenticatedLayout({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-tp-surface">
      <a
        className="skip-link fixed top-3 left-3 z-[1000] -translate-y-[180%] border border-tp-ink bg-tp-canvas px-4 py-3 text-tp-ink transition-transform focus:translate-y-0"
        href="#main-content"
      >
        Skip to content
      </a>
      <AppHeader />

      <main id="main-content" className="flex-1" tabIndex={-1}>
        {children}
      </main>

      <SunsetStripeBand />
      <AppFooter />
    </div>
  );
}
