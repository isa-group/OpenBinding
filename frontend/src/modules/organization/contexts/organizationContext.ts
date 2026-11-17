// Adapted from SPHERE frontend/src/modules/organization/contexts/organizationContext.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's organization type; the tree and the flat list of the same organizations; an `error` for a list that
// could not be loaded; `refresh` resolves when the list is back, so a screen can wait for it.

import { createContext } from 'react';
import type { Organization } from '../api/organizationsApi';

export interface OrganizationContextInterface {
  /** Every organization the account holds a role in, directly or through an ancestor, flat. */
  organizations: Organization[];
  /** The same organizations as a tree: the top-level nodes, each with its `children`. */
  tree: Organization[];
  isLoading: boolean;
  /** Why the list could not be loaded, or null. */
  error: string | null;
  /** The page of top-level nodes `/me/orgs` shows, from 1. */
  page: number;
  totalPages: number;
  setPage: (page: number) => void;
  refresh: () => Promise<void>;
}

const OrganizationContext = createContext<OrganizationContextInterface>({
  organizations: [],
  tree: [],
  isLoading: true,
  error: null,
  page: 1,
  totalPages: 1,
  setPage: () => {},
  refresh: async () => {},
});

export default OrganizationContext;
