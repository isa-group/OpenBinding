import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { Navigation } from '../components/Navigation/Navigation';
import { RouteFallback } from '../components/PlatformShell/RouteFallback';
import { SiteFooter } from '../components/SiteFooter/SiteFooter';

/** Layout of public and authentication screens: the capsule header, the screen and the site footer. */
export function PublicLayout() {
  return (
    <div className="app-container">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <Navigation />
      <main id="main-content" className="main-content" tabIndex={-1}>
        <Suspense fallback={<RouteFallback />}>
          <Outlet />
        </Suspense>
      </main>
      <SiteFooter />
    </div>
  );
}
