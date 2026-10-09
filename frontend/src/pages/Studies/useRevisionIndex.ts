import { useMemo } from 'react';
import { useResource } from '../../utils/useResource';
import { loadCases } from '../Project/projectData';
import type { CaseContent } from '../Project/projectModel';
import { revisionIndex, type RevisionInfo } from './studiesModel';

export interface RevisionDirectory {
  cases: CaseContent[];
  index: Map<string, RevisionInfo>;
  /** The cases have been read (or could not be): the labels are as good as they will get. */
  settled: boolean;
}

/** The case revisions of the project by id, to name the rows of a matrix. A project whose cases can't be read still draws: its rows read by id. */
export function useRevisionIndex(org: string, project: string): RevisionDirectory {
  const resource = useResource<CaseContent[]>(`study-cases:${org}/${project}`, () => loadCases(org, project).catch(() => []));
  const cases = resource.data ?? resource.stale ?? [];
  const index = useMemo(() => revisionIndex(cases), [cases]);
  return { cases, index, settled: resource.status !== 'loading' || Boolean(resource.stale) };
}
