import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../contexts/AuthContext';

/**
 * A route that needs an account, and optionally an administrator's.
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
    return <div className="loading-state">Checking your session...</div>;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (requireAdmin && !isAdmin) {
    return <Navigate to="/account" replace />;
  }

  return <>{children}</>;
}
