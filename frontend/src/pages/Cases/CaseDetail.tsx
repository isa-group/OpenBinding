import { useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CheckCircle2, Lock } from 'lucide-react';
import type { Organization } from '../../api/platform';
import { problemsApi, type ProblemRevision } from '../../api/problems';
import { Action } from '../../components/ui/Action';
import { Chip } from '../../components/ui/Chip';
import { Skeleton } from '../../components/ui/Skeleton';
import { TabBar, TabPanel } from '../../components/ui/TabBar';
import { NotFoundScreen } from '../../routes/NotFoundScreen';
import { isProblemTabSegment, problemPath, problemsPath, workbenchPath, type ProblemTabSegment } from '../../routes/paths/problems';
import { useResource } from '../../utils/useResource';
import { OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import { classifyAuthError, isMissing, marker } from './caseErrors';
import { VersionOverview } from './CaseRevision';
import { plural } from './casesModel';
import { VersionCompare } from './CaseCompare';
import { UploadVersionDialog } from './dialogs';
import { CaseFrame, CaseMissing, ReadOnlyNote } from './parts';
import { ProblemSettings } from './ProblemSettings';
import { VersionSource } from './RevisionSource';
import { projectRootOf, runLaunchOf } from './runTarget';
import { useRouteProblem, type RouteProblemContent } from './useRouteProblem';
import { useRouteOrganization } from '../Organization/useRouteOrganization';
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

function ProblemBody({ organization, content, revision, tab, canCreate, canAdminister, role, reload }: {
  organization: Organization; content: RouteProblemContent; revision: ProblemRevision | undefined; tab: ProblemTabSegment | undefined;
  canCreate: boolean; canAdminister: boolean; role: Organization['effective_role']; reload: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { context } = useRouteOrganization();
  const [query] = useSearchParams();
  const { item, revisions } = content;
  const org = organization.slug;
  const active: TabId = tab ?? 'overview';
  const named = query.get('version') ?? '';
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState<string>(() => (location.state as { toast?: string } | null)?.toast ?? '');
  const open = (id: TabId, show: { version?: string } = { version: named }) => void navigate(problemPath(org, item.slug, id === 'overview' ? undefined : id, show), { viewTransition: true });
  const projectRoot = projectRootOf(context, org);
  const runHref = revision ? runLaunchOf(org, item.slug, revision.revision) : null;
  const studyHref = revision && projectRoot ? `${projectRoot}/studies/new?case=${encodeURIComponent(item.slug)}&revision=${revision.revision}` : null;

  return (
    <CaseFrame organization={organization} trail={[{ label: 'Problems', to: problemsPath(org) }, { label: item.name }]}>
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
          {canCreate && <Action variant="primary" onClick={() => setUploading(true)}>Upload new version</Action>}
          {canCreate && <Action to={workbenchPath(org, { problem: item.slug, revision: revision?.revision })} variant="secondary">Edit in the Workbench</Action>}
          {revision && canCreate && runHref && <Action to={runHref} variant="secondary">Run this version</Action>}
          {revision && canCreate && studyHref && <Action to={studyHref} variant="secondary">Add to study</Action>}
        </div>
      </header>

      {toast && (
        <div className="org-toast" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>{toast}</span>
        </div>
      )}
      {!canCreate && <ReadOnlyNote role={role}>You can read and compare versions. New versions need MEMBER; deleting needs ADMIN.</ReadOnlyNote>}

      <TabBar items={TABS} value={active} onChange={(id) => open(id as TabId)} ariaLabel="Problem sections" prefix="pp-tab" />
      <TabPanel prefix="pp-tab" active={active}>
        {active === 'runs' && <VersionRuns organization={organization} content={content} runHref={runHref} canCreate={canCreate} />}
        {active === 'settings' && (
          <ProblemSettings
            key={item.id}
            organization={organization}
            item={item}
            canEdit={canCreate}
            canAdminister={canAdminister}
            onSaved={reload}
            onDeleted={(name) => navigate(problemsPath(org), { state: { toast: `Problem “${name}” deleted.` } })}
          />
        )}
        {(active === 'overview' || active === 'versions' || active === 'source') && !revision && (
          <section className="case-guide" aria-labelledby="cd-empty">
            <h2 id="cd-empty">No versions yet</h2>
            <p>A version is a sealed BIM package. Upload one, or write it in the Workbench, to be able to run this problem.</p>
            {canCreate && <div className="proj-actions"><Action variant="primary" onClick={() => setUploading(true)}>Upload a version</Action></div>}
          </section>
        )}
        {revision && active === 'overview' && <VersionOverview key={revision.id} organization={organization} content={content} revision={revision} />}
        {revision && active === 'versions' && (
          <>
            <VersionHistory org={org} content={content} runOf={(number) => runLaunchOf(org, item.slug, number)} canCreate={canCreate} />
            <VersionCompare org={org} content={content} canCreate={canCreate} />
          </>
        )}
        {revision && active === 'source' && <VersionSource key={revision.id} organization={organization} item={item} revision={revision} />}
      </TabPanel>

      {uploading && (
        <UploadVersionDialog
          organization={organization}
          item={item}
          onClose={() => setUploading(false)}
          onSaved={(saved) => {
            const text = saved.created ? `Saved as version ${saved.revision.revision}.` : `Unchanged: this is version ${saved.revision.revision}.`;
            setUploading(false);
            setToast(text);
            reload();
            // The page may redraw while the new version is read: the toast travels with the address.
            navigate(problemPath(org, item.slug, undefined, { version: saved.revision.revision }), { replace: true, state: { toast: text } });
          }}
        />
      )}
    </CaseFrame>
  );
}

function ProblemPage({ tab }: { tab: ProblemTabSegment | undefined }) {
  const route = useRouteProblem();
  const [query] = useSearchParams();
  const named = query.get('version') ?? '';
  const { slug: orgSlug, caseSlug, organization, access, waiting, content, loaded, caseFailure } = route;
  // The version shown: the one the address names (a number; a fingerprint or an id is asked of the gateway), else the latest.
  const found = named ? loaded?.revisions.find((candidate) => String(candidate.revision) === named) : loaded?.revisions[0];
  const ask = Boolean(named) && !found && loaded !== undefined;
  const remote = useResource<ProblemRevision | null>(
    `revision:${orgSlug}/${caseSlug}/${named}:${ask ? 'ask' : 'skip'}`,
    async () => (organization && ask ? problemsApi.revision(organization.slug, caseSlug, named) : null),
  );

  if (waiting) return <OrgSkeleton label="Loading organization…" />;
  if (!organization) return <OrgGate failure={null} subject="organization" />;
  const org = organization.slug;
  const trail = [{ label: 'Problems', to: problemsPath(org) }, { label: caseSlug }];

  if ((content.status === 'loading' && !loaded) || (ask && remote.status === 'loading')) {
    return (
      <CaseFrame organization={organization} trail={trail}>
        <div role="status" aria-busy="true"><span className="sr-only">Loading the problem…</span><Skeleton variant="panel" /><Skeleton variant="card" /></div>
      </CaseFrame>
    );
  }
  if (caseFailure || !loaded) {
    const missing = isMissing(caseFailure);
    return (
      <CaseFrame organization={organization} trail={trail}>
        <CaseMissing
          title={missing ? `No problem with this address in ${organization.name} (404)` : `The problem couldn’t be loaded${caseFailure ? marker(caseFailure) : ''}`}
          actions={(
            <>
              <Action to={problemsPath(org)} variant="primary">All problems</Action>
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
      <CaseFrame organization={organization} trail={trail}>
        <CaseMissing
          title={missing ? 'This version doesn’t exist (404)' : `The version couldn’t be loaded${marker(remoteFailure ?? { kind: 'unknown' })}`}
          actions={<Action to={problemPath(org, caseSlug, 'versions')} variant="primary">See all versions</Action>}
        >
          {missing ? 'It may belong to another problem, or the problem may have been renamed. We answer the same way when you can’t see it.' : 'The gateway didn’t answer. Try again in a moment.'}
        </CaseMissing>
      </CaseFrame>
    );
  }
  return (
    <ProblemBody
      organization={organization}
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
 * A problem (`case-detail`, `/app/:org/problems/:case/:tab?`): Overview, Runs, Versions, Source and Settings of the problem version named by
 * `?version=` (the latest when none). Any other tab is a page that does not exist.
 */
export function CaseDetail() {
  const { tab } = useParams();
  if (tab !== undefined && !isProblemTabSegment(tab)) return <NotFoundScreen />;
  return <ProblemPage tab={tab} />;
}
