import { useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { platformApi, type CaseRevision, type Organization, type Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { problemsPath } from '../../routes/paths/problems';
import { useResource } from '../../utils/useResource';
import { newestFirst } from '../Cases/casesModel';
import { ProjectFrame, ProjectGate, ProjectSkeleton } from '../Project/parts';
import { useRouteProject } from '../Project/useRouteProject';
import { ActionBar } from './ActionBar';
import { CheckResult } from './CheckResult';
import { PackageEditor } from './PackageEditor';
import { PackageSource } from './PackageSource';
import { RunPanel } from './RunPanel';
import { useWorkbench } from './useWorkbench';
import { loadRefusalText } from './workbenchModel';
import './Workbench.css';

const EMPTY_REVISIONS: CaseRevision[] = [];

function WorkbenchScreen({ organization, project, canSave }: { organization: Organization; project: Project; canSave: boolean }) {
  const { user } = useAuth();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const caseRef = params.get('case');
  const revisionRef = params.get('revision');
  const requestedExample = params.get('example') ?? '';
  const [pickedCase, setPickedCase] = useState(caseRef ?? '');
  const root = `/app/${organization.slug}/${project.slug}`;

  const wb = useWorkbench({
    orgSlug: organization.slug, projectSlug: project.slug, userId: user?.id, pathname: location.pathname, caseRef, revisionRef, requestedExample,
  });

  const cases = useResource(`wb-cases:${organization.slug}/${project.slug}`, () => platformApi.cases(organization.slug, project.slug));
  const revisions = useResource<CaseRevision[]>(
    `wb-revisions:${organization.slug}/${project.slug}/${pickedCase}`,
    () => (pickedCase ? platformApi.caseRevisions(organization.slug, project.slug, pickedCase) : Promise.resolve(EMPTY_REVISIONS)),
  );
  // No plan limits the package or the problem size: the deployment does, and its refusals (413, the binding-space
  // refusal) say so when they happen.
  const caseList = cases.data ?? [];
  const revisionList = revisions.data ? newestFirst(revisions.data) : EMPTY_REVISIONS;

  const pickRevision = (revision: CaseRevision) => {
    setParams({ case: pickedCase, revision: revision.id }, { replace: true });
  };

  return (
    <ProjectFrame organization={organization} project={project} section="cases" crumb="Workbench">
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Workbench</h1>
          <p>Check a package, see which engines can run it, then snapshot, run or save it as a problem version.</p>
        </div>
      </header>

      <div className="wb">
        <PackageSource
          wb={wb}
          requestedExample={Boolean(requestedExample)}
          casesHref={problemsPath(root)}
          choices={{
            cases: caseList,
            state: cases.status === 'ready' ? 'ready' : cases.status === 'error' ? 'failed' : 'loading',
            revisions: revisionList,
            revisionsState: !pickedCase ? 'idle' : revisions.status === 'ready' ? 'ready' : revisions.status === 'error' ? 'failed' : 'loading',
            picked: pickedCase,
            onPickCase: setPickedCase,
            openedRevision: revisionRef,
            onPickRevision: pickRevision,
          }}
        />

        {wb.loadIssue ? (
          <Notice
            tone="error"
            title="The problem version couldn’t be loaded"
            action={<Action variant="secondary" size="sm" onClick={wb.retryLoad}>Try again</Action>}
          >
            {loadRefusalText(wb.loadIssue)}
          </Notice>
        ) : !wb.hydrated && !requestedExample ? (
          <div role="status" aria-busy="true">
            <span className="sr-only">Opening the package…</span>
            <Skeleton variant="panel" />
          </div>
        ) : (
          <>
            <CheckResult wb={wb} />
            <PackageEditor wb={wb} />
            <RunPanel wb={wb} orgSlug={organization.slug} jobsHref={`${root}/runs`} />
            <ActionBar
              wb={wb}
              canSave={canSave}
              cases={caseList}
              target={pickedCase}
              onTarget={setPickedCase}
              revisions={revisionList}
              revisionsReady={revisions.status === 'ready'}
              root={root}
            />
          </>
        )}
      </div>
    </ProjectFrame>
  );
}

/** The workbench (`wb-workbench`, `/app/:org/:project/workbench`): check a package, see which engines can run it, then snapshot, run or save it as a problem version. */
export function Workbench() {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <WorkbenchScreen organization={organization} project={project} canSave={access.canCreate} />;
}
