import { Navigate, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import { AppLayout } from '../layouts/AppLayout';
import { PublicLayout } from '../layouts/PublicLayout';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { layoutFor } from './define';
import type { MovedRoute } from './moved';
import { NotFoundScreen } from './NotFoundScreen';
import { movedRoutes, routeDefinitions } from './registry';
import { RETIRED_ROUTES, type RetiredRoute } from './retiredRoutes';
import { SessionLayout } from './SessionLayout';
import type { RouteDefinition } from './types';

// [impl->req~frontend-retire-redirect-generic~1]
// [impl->req~frontend-retire-reports-redirect~1]
// [impl->req~frontend-retire-library-redirect~1]
// [impl->req~frontend-retire-composer-redirect~1]
// [impl->req~frontend-retire-sponsorship-redirect~1]
function RetiredRedirect({ route }: { route: RetiredRoute }) {
  const [query] = useSearchParams();
  const params = useParams();
  return <Navigate to={route.target(query, params)} replace />;
}

// [impl->req~frontend-nav-redirects~1]
function MovedRedirect({ route }: { route: MovedRoute }) {
  const [query] = useSearchParams();
  const params = useParams();
  return <Navigate to={route.target(query, params)} replace />;
}

function screenElement(definition: RouteDefinition) {
  let element = definition.element;
  if (definition.requireAdmin) {
    element = <ProtectedRoute requireAdmin>{element}</ProtectedRoute>;
  } else if (definition.requireAuth && definition.layout === 'public') {
    // App screens are already guarded by their layout.
    element = <ProtectedRoute>{element}</ProtectedRoute>;
  }
  return element;
}

const publicScreens = routeDefinitions.filter((definition) => definition.layout === 'public' && !definition.sessionHeader);
const sessionScreens = routeDefinitions.filter((definition) => definition.layout === 'public' && definition.sessionHeader);
const appScreens = routeDefinitions.filter((definition) => definition.layout === 'app');

interface AppRoutesProps {
  /** The moved addresses to serve; the registry's by default. A test passes its own table. */
  moved?: readonly MovedRoute[];
}

export function AppRoutes({ moved = movedRoutes }: AppRoutesProps = {}) {
  const movedUnderApp = moved.filter((route) => layoutFor(route.path) === 'app');
  const movedPublic = moved.filter((route) => layoutFor(route.path) === 'public');
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        {publicScreens.map((definition) => (
          <Route key={definition.id} path={definition.path} element={screenElement(definition)} />
        ))}
        {movedPublic.map((route) => (
          <Route key={route.id} path={route.path} element={<MovedRedirect route={route} />} />
        ))}
        <Route path="*" element={<NotFoundScreen />} />
      </Route>
      <Route element={<SessionLayout />}>
        {sessionScreens.map((definition) => (
          <Route key={definition.id} path={definition.path} element={screenElement(definition)} />
        ))}
      </Route>
      <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
        {appScreens.map((definition) => (
          <Route key={definition.id} path={definition.path} element={screenElement(definition)} />
        ))}
        {/* After the screens: on a tie of rank a screen wins (a project called `library` keeps its sections). Among the retired routes
            the table order settles the tie: /app/<org>/library/reports is the library artifact `reports`, not a report list. */}
        {RETIRED_ROUTES.map((route) => (
          <Route key={route.id} path={route.path} element={<RetiredRedirect route={route} />} />
        ))}
        {movedUnderApp.map((route) => (
          <Route key={route.id} path={route.path} element={<MovedRedirect route={route} />} />
        ))}
      </Route>
    </Routes>
  );
}
