// Adapted from SPHERE frontend/src/routes/app-layout.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's session (useAuth's `user` and `loading`).

import type { ReactNode } from 'react';
import { useAuth } from '../modules/auth/hooks/useAuth';
import LoadingView from '../modules/core/pages/loading';
import AuthenticatedLayout from '../modules/presentation/layouts/authenticated-layout';
import PublicLayout from '../modules/presentation/layouts/public-layout';

interface Props {
  children: ReactNode;
}

export default function AppLayout({ children }: Props) {
  const { user, loading } = useAuth();

  if (loading) {
    return <LoadingView />;
  }

  if (user) {
    return <AuthenticatedLayout>{children}</AuthenticatedLayout>;
  }

  return <PublicLayout>{children}</PublicLayout>;
}
