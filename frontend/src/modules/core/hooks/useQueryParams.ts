// Copied verbatim from SPHERE frontend/src/modules/core/hooks/useQueryParams.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.

import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';

export function useQueryParams() {
  const { search } = useLocation();

  return useMemo(() => new URLSearchParams(search), [search]);
}
