import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { jobsApi, type JobInstanceView } from '../../api/jobs';
import type { Job, Organization, Project } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../Account/accountErrors';
import { saveBytes } from '../Project/download';
import { canOpenSection } from '../Project/accessLevel';
import { MembersOnlyGate, ProjectGate, ProjectSkeleton } from '../Project/parts';
import { useRouteProject } from '../Project/useRouteProject';
import { Provenance, Routing, Settings, Timeline } from './JobFacts';
import { ResultSection, type Origin } from './JobResult';
import { rangeFailureOf, refusalOf, type Refusal } from './jobErrors';
import { findOrigin } from './jobsData';
import { canRetryState, isActive, normalizeStatus, readPins, shortJobId } from './jobsModel';
import { JobFrame, JobMissing, OutcomeChip, RefusalNotice, StatusChip } from './parts';
import { useJobLive } from './useJobLive';

type Outcome = { tone: 'success'; text: string; follow?: string } | { tone: 'error'; refusal: Refusal };
type DownloadKind = 'ir' | 'instance' | 'result';

const DOWNLOADS: ReadonlyArray<{ kind: DownloadKind; label: string; file: string }> = [
  { kind: 'ir', label: 'Download compiled problem', file: 'compiled-problem' },
  { kind: 'instance', label: 'Download instance', file: 'instance' },
  { kind: 'result', label: 'Download result', file: 'result' },
];

function JobDetailBody({ organization, project, jobId }: { organization: Organization; project: Project; jobId: string }) {
  const navigate = useNavigate();
  const { copy, status } = useCopy();
  const org = organization.slug;
  const slug = project.slug;
  const root = `/app/${org}/${slug}`;
  const live = useJobLive(jobId);
  const detail = live.detail;
  const proven = detail !== undefined;

  // Everything below is read only once the gateway has shown the run to this account: a run that is not yours reads as missing.
  const inProject = useResource<Job | null>(`job-in-project:${org}/${slug}/${jobId}:${proven}`, async () => (proven ? jobsApi.inProject(org, slug, jobId).catch(() => null) : null));
  const own = useResource<Job[]>(`job-own:${proven}`, async () => (proven ? jobsApi.mine().catch(() => []) : []));
  const instance = useResource<JobInstanceView | null>(`job-instance:${jobId}:${proven}`, async () => (proven ? jobsApi.instance(jobId).catch(() => null) : null));
  const snapshotId = instance.data?.id ?? null;
  const origin = useResource<Origin | null>(`job-origin:${org}/${slug}:${snapshotId ?? 'none'}`, async () => (snapshotId ? findOrigin(org, slug, snapshotId) : null));

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<'cancel' | 'retry' | null>(null);
  const [asked, setAsked] = useState(false);
  const [downloads, setDownloads] = useState<Partial<Record<DownloadKind, string>>>({});

  const meta: Job | null = inProject.data ?? own.data?.find((row) => row.id === jobId) ?? null;
  const failure = live.phase === 'error' ? classifyAuthError(live.error) : null;
  const trail = [{ label: 'Jobs', to: `${root}/jobs` }, { label: `Job ${shortJobId(jobId)}` }];

  if (live.phase === 'loading') {
    return (
      <JobFrame organization={organization} project={project} trail={trail}>
        <div role="status" aria-busy="true" className="job-connecting">
          <span><span className="job-spinner" aria-hidden="true" />Connecting to live updates…</span>
          <Skeleton variant="card" />
          <Skeleton variant="panel" />
        </div>
      </JobFrame>
    );
  }

  if (live.phase === 'error' || !detail) {
    return (
      <JobFrame organization={organization} project={project} trail={trail}>
        {failure?.status === 403 && (
          <Notice tone="warning">This API key can’t read jobs or doesn’t include this engine{marker(failure)}. Engines outside a key’s list answer as if they didn’t exist.</Notice>
        )}
        {failure?.status === 401 && <Notice tone="warning">Your session ended{marker(failure)}. Log in again to see this job.</Notice>}
        {(!failure || failure.kind === 'not-found') && (
          <JobMissing title="Job not found" actions={<Action to={`${root}/jobs`} variant="primary">All jobs</Action>}>
            Jobs open only for whoever launched them. Everyone else, including platform administrators, gets this same answer.
          </JobMissing>
        )}
        {failure && failure.status !== 403 && failure.status !== 401 && failure.kind !== 'not-found' && (
          <Notice tone="error" action={<Action variant="secondary" size="sm" onClick={live.refresh}>Try again</Action>}>
            The job couldn’t be loaded{marker(failure)}. A service OpenBinding depends on didn’t answer; this says nothing about your access.
          </Notice>
        )}
      </JobFrame>
    );
  }

  const state = normalizeStatus(detail.status);
  const rangeFailure = rangeFailureOf(detail);
  const pins = readPins(detail.provenance);
  const engineName = meta?.engine_id ?? pins.engine?.name ?? 'Job';
  const engineVersion = pins.engine?.version ? ` ${pins.engine.version}` : '';
  const created = meta?.created_at ?? null;
  const finished = meta?.finished_at ?? null;
  const cancelRequested = asked || Boolean(meta?.cancellation_requested);
  const siblings = (own.data ?? []).filter((row) => row.id !== jobId).slice(0, 25);
  const caseLine = origin.data ? `case ${origin.data.caseName}` : instance.data ? 'uploaded package' : null;

  const cancel = async () => {
    setBusy('cancel');
    setOutcome(null);
    try {
      const view = await jobsApi.cancel(jobId);
      setAsked(true);
      if (normalizeStatus(view.status) === 'cancelled') live.adopt('cancelled');
      setOutcome({ tone: 'success', text: 'Cancellation requested. The engine stops at its next check.' });
      live.refresh();
    } catch (caught) {
      setOutcome({ tone: 'error', refusal: refusalOf(caught, 'cancel') });
      live.refresh();
    } finally {
      setBusy(null);
    }
  };

  const retry = async () => {
    setBusy('retry');
    setOutcome(null);
    try {
      const made = await jobsApi.retry(jobId);
      setOutcome({ tone: 'success', text: 'Retry queued as a new attempt. It counts as a new solve.', follow: `${root}/jobs/${made.id}` });
    } catch (caught) {
      setOutcome({ tone: 'error', refusal: refusalOf(caught, 'retry') });
    } finally {
      setBusy(null);
    }
  };

  const download = async (kind: DownloadKind, file: string) => {
    setDownloads((current) => ({ ...current, [kind]: 'busy' }));
    try {
      const body = kind === 'ir' ? await jobsApi.ir(jobId) : kind === 'instance' ? await jobsApi.instance(jobId) : (detail.result ?? {});
      saveBytes(new TextEncoder().encode(JSON.stringify(body, null, 2)).buffer as ArrayBuffer, `job-${jobId.slice(0, 8)}-${file}.json`, 'application/json');
      setDownloads((current) => ({ ...current, [kind]: 'done' }));
    } catch (caught) {
      setDownloads((current) => ({ ...current, [kind]: `failed${marker(classifyAuthError(caught))}` }));
    }
  };

  return (
    <JobFrame organization={organization} project={project} trail={trail}>
      <header className="proj-title-row">
        <div className="proj-title">
          <span className="proj-title-line">
            <h1>{engineName} run</h1>
            <StatusChip status={state} />
            {state === 'completed' && detail.result?.termination && <OutcomeChip termination={detail.result.termination} long />}
          </span>
          <p>
            {engineName}{engineVersion}{pins.mode ? ` · mode ${pins.mode}` : ''}
            {created ? ` · launched ${formatDateTime(created)} by you` : ' · launched by you'}
            {caseLine ? ` · ${caseLine}` : ''}
          </p>
          {siblings.length > 0 && (
            <label className="job-select">
              <span>Another of your runs</span>
              <select aria-label="Another of your runs" value={jobId} onChange={(event) => navigate(`${root}/jobs/${event.target.value}`, { viewTransition: true })}>
                <option value={jobId}>This run</option>
                {siblings.map((row) => <option key={row.id} value={row.id}>{row.engine_id} · {formatDateTime(row.created_at) ?? row.id.slice(0, 8)}</option>)}
              </select>
            </label>
          )}
        </div>
        <div className="proj-actions">
          {isActive(state) && !cancelRequested && <Action variant="danger-outline" busy={busy === 'cancel'} onClick={() => void cancel()}>Cancel run</Action>}
          {canRetryState(state) && <Action variant="primary" busy={busy === 'retry'} onClick={() => void retry()}>Retry</Action>}
          {state === 'completed' && <Action to={`/app/analysis/workspace?job=${encodeURIComponent(jobId)}`} variant="secondary">Analyze</Action>}
          <Action variant="secondary" onClick={() => void copy(`job ${jobId}`, 'ref')}>
            {status('ref') === 'copied' ? 'Copied' : status('ref') === 'failed' ? 'Copy failed' : 'Copy reference'}
          </Action>
          <Action variant="ghost" onClick={() => void copy(`${window.location.origin}${root}/jobs/${jobId}`, 'link')}>
            {status('link') === 'copied' ? 'Link copied' : status('link') === 'failed' ? 'Copy failed' : 'Copy link'}
          </Action>
        </div>
      </header>

      {cancelRequested && isActive(state) && !outcome && <Notice tone="info">Cancellation requested. The engine stops at its next check.</Notice>}
      {outcome?.tone === 'success' && (
        <Notice tone="success" action={outcome.follow ? <Action to={outcome.follow} variant="link" size="sm">Follow the new run</Action> : undefined}>{outcome.text}</Notice>
      )}
      {outcome?.tone === 'error' && <RefusalNotice refusal={outcome.refusal} usageTo />}
      {state === 'failed' && rangeFailure && <RefusalNotice refusal={rangeFailure} editTo={`/app/${org}/library`} />}
      {live.feed === 'paused' && (
        <Notice tone="warning" action={<Action variant="secondary" size="sm" onClick={live.refresh}>Reconnect</Action>}>
          Live updates stopped arriving. What you see is the last state received.
        </Notice>
      )}

      <Timeline status={state} created={created} finished={finished} feed={live.feed} />
      <Routing provenance={detail.provenance} />
      <Settings provenance={detail.provenance} />
      <ResultSection detail={detail} jobId={jobId} root={root} origin={origin.data ?? null} />
      <Provenance
        provenance={detail.provenance}
        instance={instance.data ?? null}
        origin={origin.data ?? null}
        root={root}
        created={created}
        retryOf={meta?.retry_of_id ?? null}
        actions={(
          <>
            {DOWNLOADS.map(({ kind, label, file }) => (
              <Action key={kind} variant="secondary" size="sm" busy={downloads[kind] === 'busy'} onClick={() => void download(kind, file)}>
                {downloads[kind] === 'done' ? 'Downloaded' : downloads[kind]?.startsWith('failed') ? `${label} (failed${downloads[kind]?.slice(6)})` : label}
              </Action>
            ))}
            <Action to={`${root}/reports`} variant="secondary" size="sm">Add to a report</Action>
          </>
        )}
      />
    </JobFrame>
  );
}

/** One run (`job-detail`, `/app/:org/:project/jobs/:job`): live state, the authoritative result, the settings and what it ran on. */
export function JobDetail() {
  const { job: jobId = '' } = useParams();
  const { orgSlug, projectSlug, organization, project, access, waiting, failure, reload } = useRouteProject();
  if (waiting) return <ProjectSkeleton />;
  if (!organization || !project) {
    return <ProjectGate failure={organization ? failure : null} orgSlug={orgSlug} projectSlug={projectSlug} organizationName={organization?.name} onRetry={reload} />;
  }
  if (!canOpenSection(access.level, 'jobs')) return <MembersOnlyGate root={`/app/${organization.slug}/${project.slug}`} />;
  return <JobDetailBody key={jobId} organization={organization} project={project} jobId={jobId} />;
}
