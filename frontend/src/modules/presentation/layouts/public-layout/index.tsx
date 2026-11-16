// Adapted from SPHERE frontend/src/modules/presentation/layouts/public-layout/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: every public page keeps the chrome until the landing page arrives (B5); the footer is the cream AppFooter with
// OpenBinding's columns (SPHERE's dark landing footer comes with the landing); a skip link and a focusable main landmark.

import type { ReactNode } from 'react';
import SunsetStripeBand from '../../../core/components/sunset-stripe';
import FloatingMorphHeader from '../../pages/home/components/floating-morph-header';
import AppFooter from '../authenticated-layout/app-footer';
import { headerRoutes } from '../router/header-routes';

export default function PublicLayout({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-tp-canvas">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <FloatingMorphHeader navItems={headerRoutes} />

      <main id="main-content" className="flex-1 pt-24 pb-16" tabIndex={-1}>
        {children}
      </main>

      <SunsetStripeBand />
      <AppFooter />
    </div>
  );
}
