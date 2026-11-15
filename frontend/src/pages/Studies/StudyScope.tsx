import type { ReactNode } from 'react';
import { useParams } from 'react-router-dom';
import type { Revised } from '../../api/client';
import { platformApi, type Organization, type Study } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { studiesPath, studyPath } from '../../routes/paths/studies';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import { problemAccess, type ProblemAccess } from '../Cases/useRouteProblem';
import { useRouteOrganization } from '../Organization/useRouteOrganization';
import { StudyFrame, StudyGate } from './parts';

export interface StudyScopeValue {
  organization: Organization;
  access: ProblemAccess;
  study: Study;
  /** The study's revision as the gateway gave it: what an edit sends as `If-Match`. */
  etag: string | null;
  /** `/app/:org/studies/:study` */
  studyPath: string;
  /** Read the study again after it changed. */
  reloadStudy: () => void;
}

interface LoaderProps {
  organization: Organization;
  children: (scope: StudyScopeValue) => ReactNode;
}

/** The study named by the address, read with its ETag (archived ones too). */
function StudyLoader({ organization, children }: LoaderProps) {
  const { study: slug = '' } = useParams();
  const org = organization.slug;
  const found = useResource<Revised<Study> | null>(`study:${org}/${slug}`, async () => {
    try {
      return await platformApi.study(org, slug);
    } catch (caught) {
      if (classifyAuthError(caught).status === 404) return null;
      throw caught;
    }
  });
  const list = studiesPath(org);
  const value = found.data ?? found.stale;
  const trail = [{ label: 'Studies', to: list }, { label: slug }];

  if (found.status === 'loading' && value === undefined) {
    return (
      <StudyFrame organization={organization} trail={[{ label: 'Studies', to: list }, { label: 'Loading…' }]}>
        <div role="status" aria-busy="true"><span className="sr-only">Loading the study…</span><Skeleton variant="panel" /></div>
      </StudyFrame>
    );
  }
  if (value === undefined) {
    const problem = classifyAuthError(found.error);
    return (
      <StudyFrame organization={organization} trail={trail}>
        <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={found.reload}>Retry</Action>}>
          {problem.status === 403
            ? `This credential can’t read studies${marker(problem)}. Use a session, or a key with studies:read.`
            : `The study couldn’t be loaded${marker(problem)}.`}
        </Notice>
      </StudyFrame>
    );
  }
  if (value === null) {
    return (
      <StudyFrame organization={organization} trail={trail} width="lg">
        <StudyGate title="Study not found" action={<Action to={list} variant="primary">All studies</Action>}>
          No study with this address in {organization.name} (404).
        </StudyGate>
      </StudyFrame>
    );
  }
  return (
    <>
      {children({
        organization, access: problemAccess(organization), study: value.value, etag: value.etag,
        studyPath: studyPath(org, value.value.slug), reloadStudy: found.reload,
      })}
    </>
  );
}

/**
 * Everything a screen below a study needs before it can draw: the organization the address names, and the study in it. A study that
 * isn't there reads the same whether it never existed or belongs to an organization the account can't see.
 */
export function StudyScope({ children }: { children: (scope: StudyScopeValue) => ReactNode }) {
  const { organization, waiting } = useRouteOrganization();
  if (waiting) return <OrgSkeleton label="Loading organization…" />;
  if (!organization) return <OrgGate failure={null} />;
  return <StudyLoader key={organization.slug} organization={organization}>{children}</StudyLoader>;
}
