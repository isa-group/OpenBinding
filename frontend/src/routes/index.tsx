import { Route, Routes } from 'react-router-dom';
import { AppLayout } from '../layouts/AppLayout';
import { PublicLayout } from '../layouts/PublicLayout';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { NotFoundScreen } from './NotFoundScreen';
import { ParamAliases } from './ParamAliases';
import { routeDefinitions } from './registry';
import { SessionLayout } from './SessionLayout';
import type { RouteDefinition } from './types';

function screenElement(definition: RouteDefinition) {
  let element = definition.paramAliases
    ? <ParamAliases aliases={definition.paramAliases}>{definition.element}</ParamAliases>
    : definition.element;
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
        {appScreens.map((definition) => (
          <Route key={definition.id} path={definition.path} element={screenElement(definition)} />
        ))}
      </Route>
    </Routes>
  );
}
