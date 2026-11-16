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
import {
  isProblemTabSegment,
  problemPath,
  problemsPath,
  problemEditorPath,
  type ProblemTabSegment,
} from '../../routes/paths/problems';
import { useResource } from '../../utils/useResource';
import { OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import { isMissing } from './problemErrors';
import { classifyAuthError, marker } from '../../shared/api/errors';
import { VersionOverview } from './ProblemRevision';
import { plural } from './problemsModel';
import { VersionCompare } from './ProblemCompare';
import { UploadVersionDialog } from './dialogs';
import { CaseFrame, CaseMissing, ReadOnlyNote } from './parts';
import { VersionCandidates } from './ProblemCandidates';
import { ProblemCompositions } from './ProblemCompositions';
import { ProblemSettings } from './ProblemSettings';
import { VersionSource } from './RevisionSource';
import { runLaunchOf } from './runTarget';
import { newStudyPath } from '../../routes/paths/studies';
import { useRouteProblem, type RouteProblemContent } from './useRouteProblem';
import { VersionHistory } from './VersionHistory';
import { VersionRuns } from './VersionRuns';

type TabId = 'overview' | ProblemTabSegment;

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'candidates', label: 'Candidates' },
  { id: 'versions', label: 'Versions' },
  { id: 'runs', label: 'Runs' },
  { id: 'compositions', label: 'Compositions' },
  { id: 'source', label: 'Source' },
  { id: 'settings', label: 'Settings' },
];

/** The tabs that show one version of the problem: without a version they say how to make one. */
const VERSION_TABS: ReadonlySet<TabId> = new Set(['overview', 'candidates', 'versions', 'source']);

function ProblemBody({
  organization,
  content,
  revision,
  tab,
  canCreate,
  canAdminister,
  role,
  reload,
}: {
  organization: Organization;
  content: RouteProblemContent;
  revision: ProblemRevision | undefined;
  tab: ProblemTabSegment | undefined;
  canCreate: boolean;
  canAdminister: boolean;
  role: Organization['effective_role'];
  reload: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [query] = useSearchParams();
  const { item, revisions } = content;
  const org = organization.slug;
  const active: TabId = tab ?? 'overview';
  const named = query.get('version') ?? '';
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState<string>(
    () => (location.state as { toast?: string } | null)?.toast ?? ''
  );
  const open = (id: TabId, show: { version?: string } = { version: named }) =>
    void navigate(problemPath(org, item.slug, id === 'overview' ? undefined : id, show), {
      viewTransition: true,
    });
  const runHref = revision ? runLaunchOf(org, item.slug, revision.revision) : null;
  const studyHref = revision
    ? newStudyPath(org, { case: item.slug, revision: revision.revision })
    : null;

  return (
    <CaseFrame
      organization={organization}
      trail={[{ label: 'Problems', to: problemsPath(org) }, { label: item.name }]}
    >
      <header className="proj-title-row">
        <div className="proj-title">
          <div className="proj-title-line">
            <h1>{item.name}</h1>
            {revision && (
              <span className="case-sealed">
                <Lock aria-hidden="true" />
                Sealed
              </span>
            )}
          </div>
          <div className="proj-title-line">
            <code className="case-slug">{item.slug}</code>
            <Chip tone={revisions.length > 0 ? 'success' : 'plain'}>
              {plural(revisions.length, 'version')}
            </Chip>
          </div>
          <p className="case-description">
            {item.description || <span className="org-muted">No description.</span>}
          </p>
          {revision && (
            <label className="case-sort">
              Version
              <select
                aria-label="Version"
                value={String(revision.revision)}
                onChange={event => open(active, { version: event.target.value })}
              >
                {revisions.map((candidate, index) => (
                  <option key={candidate.id} value={candidate.revision}>
                    Version {candidate.revision}
                    {index === 0 ? ' · latest' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="proj-actions">
          {canCreate && (
            <Action variant="primary" onClick={() => setUploading(true)}>
              Upload new version
            </Action>
          )}
          {canCreate && (
            <Action
              to={problemEditorPath(org, { problem: item.slug, revision: revision?.revision })}
              variant="secondary"
            >
              Edit in the problem editor
            </Action>
          )}
          {revision && canCreate && runHref && (
            <Action to={runHref} variant="secondary">
              Run this version
            </Action>
          )}
          {revision && canCreate && studyHref && (
            <Action to={studyHref} variant="secondary">
              Add to study
            </Action>
          )}
        </div>
      </header>

      {toast && (
        <div className="org-toast" role="status">
          <CheckCircle2 aria-hidden="true" />
          <span>{toast}</span>
        </div>
      )}
      {!canCreate && (
        <ReadOnlyNote role={role}>
          You can read and compare versions. New versions need MEMBER; deleting needs ADMIN.
        </ReadOnlyNote>
      )}

      <TabBar
        items={TABS}
        value={active}
        onChange={id => open(id as TabId)}
        ariaLabel="Problem sections"
        prefix="pp-tab"
      />
      <TabPanel prefix="pp-tab" active={active}>
        {active === 'runs' && (
          <VersionRuns
            organization={organization}
            content={content}
            runHref={runHref}
            canCreate={canCreate}
          />
        )}
        {active === 'compositions' && (
          <ProblemCompositions organization={organization} item={item} />
        )}
        {active === 'settings' && (
          <ProblemSettings
            key={item.id}
            organization={organization}
            item={item}
            canEdit={canCreate}
            canAdminister={canAdminister}
            onSaved={reload}
            onDeleted={name =>
              navigate(problemsPath(org), { state: { toast: `Problem “${name}” deleted.` } })
            }
          />
        )}
        {VERSION_TABS.has(active) && !revision && (
          <section className="case-guide" aria-labelledby="cd-empty">
            <h2 id="cd-empty">No versions yet</h2>
            <p>
              A version is a sealed BIM package. Upload one, or write it in the problem editor, to
              be able to run this problem.
            </p>
            {canCreate && (
              <div className="proj-actions">
                <Action variant="primary" onClick={() => setUploading(true)}>
                  Upload a version
                </Action>
              </div>
            )}
          </section>
        )}
        {revision && active === 'overview' && (
          <VersionOverview
            key={revision.id}
            organization={organization}
            content={content}
            revision={revision}
          />
        )}
        {revision && active === 'candidates' && (
          <VersionCandidates
            key={revision.id}
            organization={organization}
            content={content}
            revision={revision}
          />
        )}
        {revision && active === 'versions' && (
          <>
            <VersionHistory
              org={org}
              content={content}
              runOf={number => runLaunchOf(org, item.slug, number)}
              canCreate={canCreate}
            />
            <VersionCompare org={org} content={content} canCreate={canCreate} />
          </>
        )}
        {revision && active === 'source' && (
          <VersionSource
            key={revision.id}
            organization={organization}
            item={item}
            revision={revision}
          />
        )}
      </TabPanel>

      {uploading && (
        <UploadVersionDialog
          organization={organization}
          item={item}
          onClose={() => setUploading(false)}
          onSaved={saved => {
            const text = saved.created
              ? `Saved as version ${saved.revision.revision}.`
              : `Unchanged: this is version ${saved.revision.revision}.`;
            setUploading(false);
            setToast(text);
            reload();
            // The page may redraw while the new version is read: the toast travels with the address.
            navigate(problemPath(org, item.slug, undefined, { version: saved.revision.revision }), {
              replace: true,
              state: { toast: text },
            });
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
  const {
    slug: orgSlug,
    caseSlug,
    organization,
    access,
    waiting,
    content,
    loaded,
    caseFailure,
  } = route;
  // The version shown: the one the address names (a number; a fingerprint or an id is asked of the gateway), else the latest.
  const found = named
    ? loaded?.revisions.find(candidate => String(candidate.revision) === named)
    : loaded?.revisions[0];
  const ask = Boolean(named) && !found && loaded !== undefined;
  const remote = useResource<ProblemRevision | null>(
    `revision:${orgSlug}/${caseSlug}/${named}:${ask ? 'ask' : 'skip'}`,
    async () =>
      organization && ask ? problemsApi.revision(organization.slug, caseSlug, named) : null
  );

  if (waiting) return <OrgSkeleton label="Loading organization…" />;
  if (!organization) return <OrgGate failure={null} />;
  const org = organization.slug;
  const trail = [{ label: 'Problems', to: problemsPath(org) }, { label: caseSlug }];

  if ((content.status === 'loading' && !loaded) || (ask && remote.status === 'loading')) {
    return (
      <CaseFrame organization={organization} trail={trail}>
        <div role="status" aria-busy="true">
          <span className="sr-only">Loading the problem…</span>
          <Skeleton variant="panel" />
          <Skeleton variant="card" />
        </div>
      </CaseFrame>
    );
  }
  if (caseFailure || !loaded) {
    const missing = isMissing(caseFailure);
    return (
      <CaseFrame organization={organization} trail={trail}>
        <CaseMissing
          title={
            missing
              ? `No problem with this address in ${organization.name} (404)`
              : `The problem couldn’t be loaded${caseFailure ? marker(caseFailure) : ''}`
          }
          actions={
            <>
              <Action to={problemsPath(org)} variant="primary">
                All problems
              </Action>
              <Action variant="secondary" onClick={content.reload}>
                Retry
              </Action>
            </>
          }
        >
          {missing
            ? 'It may have been deleted or renamed.'
            : 'The gateway didn’t answer for this problem. This says nothing about your access. Try again in a moment.'}
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
          title={
            missing
              ? 'This version doesn’t exist (404)'
              : `The version couldn’t be loaded${marker(remoteFailure ?? { kind: 'unknown' })}`
          }
          actions={
            <Action to={problemPath(org, caseSlug, 'versions')} variant="primary">
              See all versions
            </Action>
          }
        >
          {missing
            ? 'It may belong to another problem, or the problem may have been renamed. We answer the same way when you can’t see it.'
            : 'The gateway didn’t answer. Try again in a moment.'}
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
 * A problem (`problem-detail`, `/app/:org/problems/:case/:tab?`): Overview, Candidates, Versions, Runs, Compositions, Source and Settings of
 * the problem version named by `?version=` (the latest when none). The Candidates tab highlights what a composition version chose
 * (`?composition=&compositionVersion=`). Any other tab is a page that does not exist.
 */
export function ProblemDetail() {
  const { tab } = useParams();
  if (tab !== undefined && !isProblemTabSegment(tab)) return <NotFoundScreen />;
  return <ProblemPage tab={tab} />;
}
