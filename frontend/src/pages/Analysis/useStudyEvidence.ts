import { useOutletContext } from 'react-router-dom';
import { platformApi } from '../../api/platform';
import type { PlatformOutletContext } from '../../components/PlatformShell/PlatformShell';
import { useResource } from '../../utils/useResource';
import type { Target } from './analysisModel';

export interface StudyEvidence {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** The stored results the cell, or the finished cells of the run, point at. */
  jobs: string[];
  label: string;
  error: unknown;
}

const IDLE: StudyEvidence = { status: 'idle', jobs: [], label: '', error: undefined };

/**
 * Study evidence named in the address (`?study=&run=&cell=`, with `org` and `project` when they are not the workspace's current ones):
 * the jobs behind a cell, or behind every cell of the run that has finished with a stored result.
 */
export function useStudyEvidence(target: Target['study']): StudyEvidence {
  const context = useOutletContext<PlatformOutletContext | null>();
  const org = target?.org ?? context?.organization?.slug ?? '';
  const project = target?.project ?? context?.project?.slug ?? '';
  const key = target && org && project ? `study-evidence:${org}/${project}/${target.study}/${target.run}/${target.cell ?? '*'}` : 'study-evidence:none';
  const resource = useResource<Omit<StudyEvidence, 'status' | 'error'> | null>(key, async () => {
    if (!target || !org || !project) return null;
    if (target.cell) {
      const cell = await platformApi.studyCell(org, project, target.study, target.run, target.cell);
      if (!cell.job_id) throw new Error('That cell has no stored result yet, so there is nothing to analyse.');
      return { jobs: [cell.job_id], label: `Cell ${cell.ordinal + 1} of run ${target.run.slice(0, 8)}…` };
    }
    const cells = await platformApi.studyCells(org, project, target.study, target.run);
    const jobs = cells.filter((cell) => cell.job_id && cell.state === 'completed').map((cell) => cell.job_id as string);
    if (jobs.length === 0) throw new Error('No cell of this run has a stored result yet, so there is nothing to analyse.');
    return { jobs, label: `${jobs.length} finished cell${jobs.length === 1 ? '' : 's'} of run ${target.run.slice(0, 8)}…` };
  });
  if (!target) return IDLE;
  if (resource.status === 'loading') return { status: 'loading', jobs: [], label: '', error: undefined };
  if (resource.status === 'error' || !resource.data) return { status: 'error', jobs: [], label: '', error: resource.error ?? new Error('The study evidence needs an organization and a project.') };
  return { status: 'ready', jobs: resource.data.jobs, label: resource.data.label, error: undefined };
}
