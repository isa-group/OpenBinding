// Adapted from SPHERE frontend/src/modules/organization/hooks/useOrganization.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the list is every organization the account can read, from OpenBinding's client, in one page (the paged tree comes
// with the gateway's `tree=true`, B1); the session comes from OpenBinding's useAuth; a failed load keeps its message.

import { useCallback, useContext, useEffect, useState } from 'react';
import { platformApi, type Organization } from '../../../api/platform';
import { useAuth } from '../../auth/hooks/useAuth';
import OrganizationContext from '../contexts/organizationContext';

export const useOrganization = () => {
  return useContext(OrganizationContext);
};

export const useOrganizationManager = () => {
  const { user, loading } = useAuth();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const userId = user?.id ?? null;

  const load = useCallback(async () => {
    setError(null);
    setIsLoading(true);
    try {
      setOrganizations(await platformApi.organizations());
    } catch (caught) {
      setOrganizations([]);
      setError(caught instanceof Error ? caught.message : 'The organizations could not be loaded.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (loading) return;
    if (!userId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- nobody is signed in: there is nothing to load
      setOrganizations([]);
      setIsLoading(false);
      return;
    }
    void load();
  }, [loading, userId, load]);

  const handlePageChange = useCallback((newPage: number) => {
    setPage(newPage);
  }, []);

  return {
    organizations,
    isLoading,
    error,
    page,
    totalPages: 1,
    setPage: handlePageChange,
    refresh: load,
  };
};
