import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Organization } from '../../api/platform';
import { problemsApi, type ProblemRevision } from '../../api/problems';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { problemsPath } from '../../routes/paths/problems';
import { useResource } from '../../utils/useResource';
import { newestFirst } from '../Cases/casesModel';
import { problemAccess } from '../Cases/useRouteProblem';
import { useRouteOrganization } from '../Organization/useRouteOrganization';
import { OrgFrame, OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import { ActionBar, NEW_PROBLEM } from './ActionBar';
import { CheckResult } from './CheckResult';
import { PackageEditor } from './PackageEditor';
import { PackageSource } from './PackageSource';
import { useWorkbench } from './useWorkbench';
import { loadRefusalText } from './workbenchModel';
import './Workbench.css';

const EMPTY_REVISIONS: ProblemRevision[] = [];
/** How many problems the pickers list; the gateway's ceiling for one page. */
const PICKER_LIMIT = 200;

function WorkbenchScreen({ organization, canSave }: { organization: Organization; canSave: boolean }) {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const org = organization.slug;
  const problemRef = params.get('problem');
  const revisionRef = params.get('revision');
  const requestedExample = params.get('template') ?? '';
  const [pickedCase, setPickedCase] = useState(problemRef ?? '');
  const [saveTarget, setSaveTarget] = useState(problemRef ?? NEW_PROBLEM);

  const wb = useWorkbench({ orgSlug: org, userId: user?.id, problemRef, revisionRef, requestedExample });

  const problems = useResource(`wb-problems:${org}`, async () => (await problemsApi.list(org, { limit: PICKER_LIMIT })).problems);
  const revisions = useResource<ProblemRevision[]>(
    `wb-revisions:${org}/${pickedCase}`,
    () => (pickedCase ? problemsApi.revisions(org, pickedCase) : Promise.resolve(EMPTY_REVISIONS)),
  );
  // No plan limits the package or the problem size: the deployment does, and its refusals (413, the binding-space
  // refusal) say so when they happen.
  const problemList = problems.data ?? [];
  const revisionList = revisions.data ? newestFirst(revisions.data) : EMPTY_REVISIONS;

  const pickRevision = (revision: ProblemRevision) => {
    setSaveTarget(pickedCase);
    setParams({ problem: pickedCase, revision: String(revision.revision) }, { replace: true });
  };

  return (
    <OrgFrame organization={organization} trail={[{ label: 'Problems', to: problemsPath(org) }, { label: 'Workbench' }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <h1>Workbench</h1>
          <p>Write or check a package, see which engines can run it, then save it as a new problem or as a new version of one. A saved version runs from its problem page.</p>
        </div>
      </header>

      <div className="wb">
        <PackageSource
          wb={wb}
          requestedExample={Boolean(requestedExample)}
          casesHref={problemsPath(org)}
          choices={{
            cases: problemList,
            state: problems.status === 'ready' ? 'ready' : problems.status === 'error' ? 'failed' : 'loading',
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
            <ActionBar
              wb={wb}
              canSave={canSave}
              org={org}
              problems={problemList}
              target={saveTarget}
              onTarget={setSaveTarget}
              onSaved={(problem) => {
                setSaveTarget(problem);
                problems.reload();
              }}
            />
          </>
        )}
      </div>
    </OrgFrame>
  );
}

/**
 * The workbench (`wb-workbench`, `/app/:org/workbench`): the BIM problem editor of an organization. Check a package, see which engines can
 * run it, then save it as a new problem or a new version of one. `?problem=&revision=` opens a version, `?template=` a template. A VIEWER
 * can edit and check but not save.
 */
export function Workbench() {
  const { organization, waiting } = useRouteOrganization();
  if (waiting) return <OrgSkeleton label="Loading organization…" />;
  if (!organization) return <OrgGate failure={null} />;
  return <WorkbenchScreen organization={organization} canSave={problemAccess(organization).canCreate} />;
}
