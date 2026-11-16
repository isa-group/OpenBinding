// Adapted from SPHERE frontend/src/modules/core/hooks/useRouter.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a type-only import, as this project's TypeScript settings require.

import { useMemo } from 'react';
import { useNavigate, type To } from 'react-router-dom';

export function useRouter() {
  const navigate = useNavigate();

  const router = useMemo(
    () => ({
      back: () => navigate(-1),
      forward: () => navigate(1),
      reload: () => window.location.reload(),
      push: (href: To) => navigate(href),
      replace: (href: To) => navigate(href, { replace: true }),
    }),
    [navigate]
  );

  return router;
}
