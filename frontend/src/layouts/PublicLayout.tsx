import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Navigation } from '../components/Navigation/Navigation';
import { RouteFallback } from '../components/PlatformShell/RouteFallback';
import { SiteFooter } from '../components/SiteFooter/SiteFooter';
import { ErrorBoundary } from '../components/ui/ErrorBoundary';

/** Layout of public and authentication screens: the capsule header, the screen and the site footer. */
export function PublicLayout() {
  const location = useLocation();
  return (
    <div className="app-container">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <Navigation />
      <main id="main-content" className="main-content" tabIndex={-1}>
        <ErrorBoundary resetKey={location.pathname}>
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </ErrorBoundary>
      </main>
      <SiteFooter />
    </div>
  );
}
