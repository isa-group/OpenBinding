import { useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { apiClient } from '../../api/client';
import { platformApi, type CaseRevision, type Organization, type Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useAuth } from '../../contexts/auth';
import { formatByteSize } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { newestFirst } from '../Cases/casesModel';
import { ProjectFrame, ProjectGate, ProjectSkeleton } from '../Project/parts';
import { planLimit } from '../Project/projectModel';
import { useRouteProject } from '../Project/useRouteProject';
import { uploadCeiling } from '../Resources/resourceModel';
import { ActionBar } from './ActionBar';
import { CheckResult } from './CheckResult';
import { PackageEditor } from './PackageEditor';
import { PackageSource } from './PackageSource';
import { RunPanel } from './RunPanel';
import { useWorkbench } from './useWorkbench';
import { complexityCeiling, loadRefusalText } from './workbenchModel';
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
  const usage = useResource('wb-usage', () => apiClient.getOwnUsage().catch(() => null));
  const catalog = useResource('wb-catalog', () => apiClient.getPricingCatalog().catch(() => null));

  const planName = usage.data?.plan ?? user?.plan ?? null;
  const upload = uploadCeiling(usage.data, catalog.data, planName ?? undefined);
  const capability = usage.data?.capabilities && 'maxInstanceComplexityLog10' in usage.data.capabilities ? usage.data.capabilities.maxInstanceComplexityLog10 : undefined;
  const plan = {
    name: planName,
    ceiling: complexityCeiling(capability, planLimit(catalog.data, planName ?? undefined, 'maxInstanceComplexityLog10')),
    maxLabel: upload.plan !== null ? formatByteSize(upload.plan) : null,
  };
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
          <p>Check a package, see which engines can run it, then snapshot, run or save it as a case revision.</p>
        </div>
        <div className="proj-actions">
          <Action to="/app/generator" variant="secondary">Generate a synthetic instance</Action>
        </div>
      </header>

      <div className="wb">
        <PackageSource
          wb={wb}
          requestedExample={Boolean(requestedExample)}
          maxBytes={upload.plan}
          maxLabel={plan.maxLabel}
          planName={planName}
          casesHref={`${root}/cases`}
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
            title="The case revision couldn’t be loaded"
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
            <CheckResult wb={wb} plan={plan} pricingHref="/pricing" />
            <PackageEditor wb={wb} />
            <RunPanel wb={wb} orgSlug={organization.slug} jobsHref={`${root}/jobs`} />
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

/** The workbench (`wb-workbench`, `/app/:org/:project/workbench`): check a package, see which engines can run it, then snapshot, run or save it as a case revision. */
export function Workbench() {
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  return <WorkbenchScreen organization={organization} project={project} canSave={access.canCreate} />;
}
