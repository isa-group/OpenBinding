import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import NotFoundPage from '../../core/pages/page-not-found';
import { useAuth } from '../hooks/useAuth';

/**
 * A route that needs an account, and optionally an administrator's (the auth module's guard, in SPHERE's place).
 *
 * The guard is a convenience rather than a control: every one of these pages
 * calls endpoints the gateway guards itself, so getting past this component
 * would show an empty page rather than anybody's data. It exists so that a
 * visitor is sent to sign in instead of watching six requests fail.
 */
export function ProtectedRoute({
  children,
  requireAdmin = false,
}: {
  children: ReactNode;
  requireAdmin?: boolean;
}) {
  const { user, loading, isAdmin } = useAuth();
  const location = useLocation();

  if (loading) {
    // Rendering the redirect before the stored session has been checked would
    // bounce a signed-in user to the login page on every refresh.
    return <div className="loading-state">Checking your session…</div>;
  }

  if (!user) {
    // The query string travels too, so that a deep link (?tab=…) is not lost to the sign-in detour.
    return (
      <Navigate
        to="/authentication"
        replace
        state={{ from: `${location.pathname}${location.search}` }}
      />
    );
  }

  // Administration is unreadable to everybody else, and anything unreadable is the same in-place 404 as a missing page.
  if (requireAdmin && !isAdmin) {
    return <NotFoundPage />;
  }

  return <>{children}</>;
}

export default ProtectedRoute;
