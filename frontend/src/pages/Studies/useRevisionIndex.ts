import { useMemo } from 'react';
import { useResource } from '../../utils/useResource';
import { loadProblems } from '../Problems/problemsData';
import type { CaseContent } from '../../features/workspace/model';
import { revisionIndex, type RevisionInfo } from './studiesModel';

export interface RevisionDirectory {
  cases: CaseContent[];
  index: Map<string, RevisionInfo>;
  /** The problems have been read (or could not be): the labels are as good as they will get. */
  settled: boolean;
}

/**
 * The problem versions of the organization by id, to name the rows of a matrix. An organization whose problems can't be read still draws:
 * its rows read by id.
 */
export function useRevisionIndex(org: string): RevisionDirectory {
  const resource = useResource<CaseContent[]>(`study-problems:${org}`, () =>
    loadProblems(org).catch(() => [])
  );
  const { data, stale } = resource;
  const cases = useMemo(() => data ?? stale ?? [], [data, stale]);
  const index = useMemo(() => revisionIndex(cases), [cases]);
  return { cases, index, settled: resource.status !== 'loading' || Boolean(resource.stale) };
}
