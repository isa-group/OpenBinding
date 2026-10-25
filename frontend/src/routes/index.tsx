import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { AppLayout } from '../layouts/AppLayout';
import { PublicLayout } from '../layouts/PublicLayout';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { NotFoundScreen } from './NotFoundScreen';
import { routeDefinitions } from './registry';
import { RETIRED_ROUTES, type RetiredRoute } from './retiredRoutes';
import { SessionLayout } from './SessionLayout';
import type { RouteDefinition } from './types';

// [impl->req~frontend-retire-redirect-generic~1]
function RetiredRedirect({ route }: { route: RetiredRoute }) {
  const [query] = useSearchParams();
  return <Navigate to={route.target(query)} replace />;
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

export function AppRoutes() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        {publicScreens.map((definition) => (
          <Route key={definition.id} path={definition.path} element={screenElement(definition)} />
        ))}
        <Route path="*" element={<NotFoundScreen />} />
      </Route>
      <Route element={<SessionLayout />}>
        {sessionScreens.map((definition) => (
          <Route key={definition.id} path={definition.path} element={screenElement(definition)} />
        ))}
      </Route>
      <Route element={<ProtectedRoute><AppLayout /></ProtectedRoute>}>
        {RETIRED_ROUTES.map((route) => (
          <Route key={route.id} path={route.path} element={<RetiredRedirect route={route} />} />
        ))}
        {appScreens.map((definition) => (
          <Route key={definition.id} path={definition.path} element={screenElement(definition)} />
        ))}
      </Route>
    </Routes>
  );
}
