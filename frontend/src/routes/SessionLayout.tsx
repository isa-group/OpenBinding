import { useAuth } from '../contexts/auth';
import { AppLayout } from '../layouts/AppLayout';
import { PublicLayout } from '../layouts/PublicLayout';

/**
 * Layout of a public address that signed-in people use too: the application header and workspace
 * context with a session, the public header without one. The address never requires a session.
 */
export function SessionLayout() {
  const { user } = useAuth();
  return user ? <AppLayout /> : <PublicLayout />;
}
