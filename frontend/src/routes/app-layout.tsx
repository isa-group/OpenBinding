// Follows SPHERE frontend/src/routes/app-layout.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Pattern only: the public address takes the chrome of the session. Until SPHERE's layouts arrive (A7) it chooses between
// OpenBinding's two outlet layouts, the workspace with a session and the public one without.

import { AppLayout as WorkspaceLayout } from '../layouts/AppLayout';
import { PublicLayout } from '../layouts/PublicLayout';
import { useAuth } from '../modules/auth/hooks/useAuth';
import LoadingView from '../modules/core/pages/loading';

export default function AppLayout() {
  const { user, loading } = useAuth();

  if (loading) {
    return <LoadingView />;
  }

  return user ? <WorkspaceLayout /> : <PublicLayout />;
}
