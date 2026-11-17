// Adapted from SPHERE frontend/src/modules/organization/hooks/useOrganization.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the gateway's `tree=true` list, loaded whole once (the command palette, the selectors and the screens not yet moved
// need every organization), with the top-level nodes paged here instead of by the API; OpenBinding's useAuth; a failed load
// keeps its message.

import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { readApiError } from '../../core/api/errors';
import { useAuth } from '../../auth/hooks/useAuth';
import {
  flattenOrganizations,
  useOrganizationsApi,
  type Organization,
} from '../api/organizationsApi';
import OrganizationContext from '../contexts/organizationContext';

/** Top-level organizations per page of `/me/orgs`. */
export const ORG_PAGE_SIZE = 20;

export const useOrganization = () => {
  return useContext(OrganizationContext);
};

export const useOrganizationManager = () => {
  const { user, loading } = useAuth();
  const { getMyOrganizations } = useOrganizationsApi();
  const [tree, setTree] = useState<Organization[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const userId = user?.id ?? null;

  const load = useCallback(async () => {
    setError(null);
    setIsLoading(true);
    try {
      setTree(await getMyOrganizations());
    } catch (caught) {
      setTree([]);
      setError(readApiError(caught).message || 'The organizations could not be loaded.');
    } finally {
      setIsLoading(false);
    }
  }, [getMyOrganizations]);

  useEffect(() => {
    if (loading) return;
    if (!userId) {
      setTree([]);
      setIsLoading(false);
      return;
    }
    void load();
  }, [loading, userId, load]);

  const organizations = useMemo(() => flattenOrganizations(tree), [tree]);
  const totalPages = Math.max(1, Math.ceil(tree.length / ORG_PAGE_SIZE));

  const handlePageChange = useCallback((newPage: number) => {
    setPage(newPage);
  }, []);

  return {
    organizations,
    tree,
    isLoading,
    error,
    page: Math.min(page, totalPages),
    totalPages,
    setPage: handlePageChange,
    refresh: load,
  };
};
