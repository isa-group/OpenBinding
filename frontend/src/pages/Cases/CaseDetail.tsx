import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { casesApi } from '../../api/cases';
import type { CaseRevision, Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Skeleton } from '../../components/ui/Skeleton';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { NotFoundScreen } from '../../routes/NotFoundScreen';
import { isProblemTabSegment, problemPath, problemsPath, type ProblemTabSegment } from '../../routes/paths/problems';
import { useResource } from '../../utils/useResource';
import { ProjectGate, ProjectSkeleton } from '../Project/parts';
import { classifyAuthError, isMissing, marker } from './caseErrors';
import { VersionOverview } from './CaseRevision';
import { plural } from './casesModel';
import { VersionCompare } from './CaseCompare';
import { CaseFrame, CaseMissing, ReadOnlyNote } from './parts';
import { ProblemSettings } from './ProblemSettings';
import { VersionSource } from './SnapshotDetail';
import { useRouteCase, type RouteCaseContent } from './useRouteCase';
import { VersionHistory } from './VersionHistory';
import { VersionRuns } from './VersionRuns';

type TabId = 'overview' | ProblemTabSegment;

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'runs', label: 'Runs' },
  { id: 'versions', label: 'Versions' },
  { id: 'source', label: 'Source' },
  { id: 'settings', label: 'Settings' },
];

/** A visitor of a public project reads the problem; its runs and its settings are for the people of the organization. */
const MEMBERS_ONLY: readonly TabId[] = ['runs', 'settings'];

// [impl->req~frontend-retire-composer-entry-points-repointed~1]
function ProblemBody({ organization, project, content, revision, tab, canCreate, canAdminister, role, reload }: {
  organization: Organization; project: Project; content: RouteCaseContent; revision: CaseRevision | undefined; tab: ProblemTabSegment | undefined;
  canCreate: boolean; canAdminister: boolean; role: Organization['effective_role']; reload: () => void;
}) {
  const navigate = useNavigate();
  const [query] = useSearchParams();
  const { item, revisions } = content;
  const root = `/app/${organization.slug}/${project.slug}`;
  const publicRead = project.access === 'public_read';
  const active: TabId = tab ?? 'overview';
  const named = query.get('version') ?? '';
  const tabs = TABS.filter((entry) => !publicRead || !MEMBERS_ONLY.includes(entry.id));
  const open = (id: TabId, show: { version?: string } = { version: named }) => void navigate(problemPath(root, item.slug, id === 'overview' ? undefined : id, show), { viewTransition: true });

  return (
    <CaseFrame organization={organization} project={project} trail={[{ label: 'Problems', to: problemsPath(root) }, { label: item.name }]}>
      <header className="proj-title-row">
        <div className="proj-title">
          <div className="proj-title-line">
            <h1>{item.name}</h1>
            {revision && <span className="case-sealed"><Lock aria-hidden="true" />Sealed</span>}
          </div>
          <div className="proj-title-line"><code className="case-slug">{item.slug}</code><Chip tone={revisions.length > 0 ? 'success' : 'plain'}>{plural(revisions.length, 'version')}</Chip></div>
          <p className="case-description">{item.description || <span className="org-muted">No description.</span>}</p>
          {revision && (
            <label className="case-sort">
              Version
              <select aria-label="Version" value={String(revision.revision)} onChange={(event) => open(active, { version: event.target.value })}>
                {revisions.map((candidate, index) => <option key={candidate.id} value={candidate.revision}>Version {candidate.revision}{index === 0 ? ' · latest' : ''}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="proj-actions">
          {canCreate && <Action to={`${root}/workbench?case=${encodeURIComponent(item.slug)}`} variant="primary">New version</Action>}
          {revision && !publicRead && <Action to={`${root}/jobs/new?case=${encodeURIComponent(item.slug)}&revision=${revision.revision}`} variant="secondary">Run this version</Action>}
          {revision && <Action to={`${root}/workbench?case=${encodeURIComponent(item.slug)}&revision=${revision.id}`} variant="secondary">Open in Workbench</Action>}
          {revision && !publicRead && <Action to={`${root}/studies/new?case=${encodeURIComponent(item.slug)}&revision=${revision.revision}`} variant="secondary">Add to study</Action>}
        </div>
      </header>

      {!canCreate && <ReadOnlyNote role={role}>You can read and compare versions. New versions need MEMBER; deleting needs ADMIN.</ReadOnlyNote>}

      <TabBar items={tabs} value={active} onChange={(id) => open(id as TabId)} ariaLabel="Problem sections" prefix="pp-tab" />
      <TabPanel prefix="pp-tab" active={active}>
        {active === 'runs' && <VersionRuns organization={organization} project={project} content={content} canCreate={canCreate} />}
        {active === 'settings' && (
          <ProblemSettings
            key={item.id}
            organization={organization}
            project={project}
            item={item}
            sealed={revisions.length}
            canEdit={canCreate}
            canAdminister={canAdminister}
            onSaved={reload}
            onDeleted={(name) => navigate(problemsPath(root), { state: { toast: `Problem “${name}” deleted.` } })}
          />
        )}
        {(active === 'overview' || active === 'versions' || active === 'source') && !revision && (
          <section className="case-guide" aria-labelledby="cd-empty">
            <h2 id="cd-empty">No versions yet</h2>
            <p>A problem version pins exact library versions of an application, candidate catalog, rules and goal. Compose the first one to be able to run this problem.</p>
            {canCreate && <div className="proj-actions"><Action to={`${root}/workbench?case=${encodeURIComponent(item.slug)}`} variant="primary">Compose the first version</Action></div>}
          </section>
        )}
        {revision && active === 'overview' && <VersionOverview key={revision.id} organization={organization} project={project} content={content} revision={revision} />}
        {revision && active === 'versions' && (
          <>
            <VersionHistory root={root} content={content} publicRead={publicRead} />
            <VersionCompare root={root} content={content} canCreate={canCreate} />
          </>
        )}
        {revision && active === 'source' && <VersionSource key={revision.id} organization={organization} project={project} revision={revision} />}
      </TabPanel>
    </CaseFrame>
  );
}

function ProblemPage({ tab }: { tab: ProblemTabSegment | undefined }) {
  const route = useRouteCase();
  const [query] = useSearchParams();
  const named = query.get('version') ?? '';
  const { orgSlug, projectSlug, caseSlug, organization, project, access, waiting, failure, reload, content, loaded, caseFailure } = route;
  // The version shown: the one the address names (a number; a fingerprint or an id is asked of the gateway), else the latest.
  const found = named ? loaded?.revisions.find((candidate) => String(candidate.revision) === named) : loaded?.revisions[0];
  const ask = Boolean(named) && !found && loaded !== undefined;
  const remote = useResource<CaseRevision | null>(
    `revision:${orgSlug}/${projectSlug}/${caseSlug}/${named}:${ask ? 'ask' : 'skip'}`,
    async () => (organization && project && ask ? casesApi.revision(organization.slug, project.slug, caseSlug, named) : null),
  );

  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  if (project.access === 'public_read' && tab !== undefined && MEMBERS_ONLY.includes(tab)) return <NotFoundScreen />;
  const root = `/app/${organization.slug}/${project.slug}`;
  const trail = [{ label: 'Problems', to: problemsPath(root) }, { label: caseSlug }];

  if ((content.status === 'loading' && !loaded) || (ask && remote.status === 'loading')) {
    return (
      <CaseFrame organization={organization} project={project} trail={trail}>
        <div role="status" aria-busy="true"><span className="sr-only">Loading the problem…</span><Skeleton variant="panel" /><Skeleton variant="card" /></div>
      </CaseFrame>
    );
  }
  if (caseFailure || !loaded) {
    const missing = isMissing(caseFailure);
    return (
      <CaseFrame organization={organization} project={project} trail={trail}>
        <CaseMissing
          title={missing ? `No problem with this address in ${project.name} (404)` : `The problem couldn’t be loaded${caseFailure ? marker(caseFailure) : ''}`}
          actions={(
            <>
              <Action to={problemsPath(root)} variant="primary">All problems</Action>
              <Action variant="secondary" onClick={content.reload}>Retry</Action>
            </>
          )}
        >
          {missing ? 'It may have been deleted or renamed.' : 'The gateway didn’t answer for this problem. This says nothing about your access. Try again in a moment.'}
        </CaseMissing>
      </CaseFrame>
    );
  }
  const revision = found ?? remote.data ?? undefined;
  if (named && !revision) {
    const remoteFailure = remote.status === 'error' ? classifyAuthError(remote.error) : null;
    const missing = isMissing(remoteFailure) || !remoteFailure;
    return (
      <CaseFrame organization={organization} project={project} trail={trail}>
        <CaseMissing
          title={missing ? 'This version doesn’t exist (404)' : `The version couldn’t be loaded${marker(remoteFailure ?? { kind: 'unknown' })}`}
          actions={<Action to={problemPath(root, caseSlug, 'versions')} variant="primary">See all versions</Action>}
        >
          {missing ? 'It may belong to another problem, or the problem may have been renamed. We answer the same way when you can’t see it.' : 'The gateway didn’t answer. Try again in a moment.'}
        </CaseMissing>
      </CaseFrame>
    );
  }
  return (
    <ProblemBody
      organization={organization}
      project={project}
      content={loaded}
      revision={revision}
      tab={tab}
      canCreate={access.canCreate}
      canAdminister={access.canAdminister}
      role={access.role}
      reload={content.reload}
    />
  );
}

/**
 * A problem (`case-detail`, `/app/:org/:project/problems/:case/:tab?`): Overview, Runs, Versions, Source and Settings of the problem version named by
 * `?version=` (the latest when none). Any other tab is a page that does not exist.
 */
// [impl->req~frontend-nav-problem-page~1]
export function CaseDetail() {
  const { tab } = useParams();
  if (tab !== undefined && !isProblemTabSegment(tab)) return <NotFoundScreen />;
  return <ProblemPage tab={tab} />;
}
