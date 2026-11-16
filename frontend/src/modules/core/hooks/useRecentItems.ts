// Adapted from SPHERE frontend/src/modules/core/hooks/useRecentItems.ts (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: OpenBinding's kinds and keys: recent compositions, problems and organizations under
// `openbinding:recent{Compositions,Problems,Organizations}` (collections arrive in F9).

import { useCallback, useMemo, useState } from 'react';
import {
  addRecentComposition as addRecentCompositionUtil,
  addRecentProblem as addRecentProblemUtil,
  addRecentOrganization as addRecentOrganizationUtil,
  getRecentCompositions as getRecentCompositionsUtil,
  getRecentProblems as getRecentProblemsUtil,
  getRecentOrganizations as getRecentOrganizationsUtil,
  type RecentItem,
} from '../utils/recentItems';

export type { RecentItem };

export function useRecentItems() {
  const [recentCompositions, setRecentCompositions] = useState<RecentItem[]>(() =>
    getRecentCompositionsUtil()
  );
  const [recentProblems, setRecentProblems] = useState<RecentItem[]>(() => getRecentProblemsUtil());
  const [recentOrganizations, setRecentOrganizations] = useState<RecentItem[]>(() =>
    getRecentOrganizationsUtil()
  );

  const addRecentComposition = useCallback((item: Omit<RecentItem, 'visitedAt'>) => {
    addRecentCompositionUtil(item);
    setRecentCompositions(getRecentCompositionsUtil());
  }, []);

  const addRecentProblem = useCallback((item: Omit<RecentItem, 'visitedAt'>) => {
    addRecentProblemUtil(item);
    setRecentProblems(getRecentProblemsUtil());
  }, []);

  const addRecentOrganization = useCallback((item: Omit<RecentItem, 'visitedAt'>) => {
    addRecentOrganizationUtil(item);
    setRecentOrganizations(getRecentOrganizationsUtil());
  }, []);

  return useMemo(
    () => ({
      recentCompositions,
      recentProblems,
      recentOrganizations,
      addRecentComposition,
      addRecentProblem,
      addRecentOrganization,
    }),
    [
      recentCompositions,
      recentProblems,
      recentOrganizations,
      addRecentComposition,
      addRecentProblem,
      addRecentOrganization,
    ]
  );
}
