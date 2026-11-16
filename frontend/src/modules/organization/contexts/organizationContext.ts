// Adapted from SPHERE frontend/src/modules/organization/contexts/organizationContext.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's organization type; an `error` for a list that could not be loaded; `refresh` resolves when the list
// is back, so a screen can wait for it.

import { createContext } from 'react';
import type { Organization } from '../../../api/platform';

export interface OrganizationContextInterface {
  organizations: Organization[];
  isLoading: boolean;
  /** Why the list could not be loaded, or null. */
  error: string | null;
  page: number;
  totalPages: number;
  setPage: (page: number) => void;
  refresh: () => Promise<void>;
}

const OrganizationContext = createContext<OrganizationContextInterface>({
  organizations: [],
  isLoading: true,
  error: null,
  page: 1,
  totalPages: 1,
  setPage: () => {},
  refresh: async () => {},
});

export default OrganizationContext;
