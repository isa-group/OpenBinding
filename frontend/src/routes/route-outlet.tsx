import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import ErrorBoundary from '../modules/core/components/error-boundary';
import { RouteFallback } from '../modules/core/components/route-fallback';

/**
 * Where a layout draws its screen: a screen that fails to render shows the error inside the layout, which stays (and is reset
 * on the next address), and a screen still being fetched shows the route's loading state.
 */
export function RouteOutlet() {
  const location = useLocation();
  return (
    <ErrorBoundary resetKey={location.pathname}>
      <Suspense fallback={<RouteFallback />}>
        <Outlet key={location.pathname} />
      </Suspense>
    </ErrorBoundary>
  );
}
