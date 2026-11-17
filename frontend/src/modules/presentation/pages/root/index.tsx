// SPHERE's RootPage (frontend/src/routes/router.tsx, revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Pattern only: `/` is the landing for a visitor and the dashboard for a signed-in account, decided once the stored
// session has been checked.

import { lazy } from 'react';
import { useAuth } from '../../../auth/hooks/useAuth';
import LoadingView from '../../../core/pages/loading';

const DashboardPage = lazy(() => import('../dashboard'));
const HomePage = lazy(() => import('../home'));

export default function RootPage() {
  const { user, loading } = useAuth();
  if (loading) return <LoadingView />;
  return user ? <DashboardPage /> : <HomePage />;
}
