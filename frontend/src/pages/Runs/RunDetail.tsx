import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { runsApi } from '../../api/runs';
import { problemsApi } from '../../api/problems';
import type { Job, Organization } from '../../api/platform';
import { Action } from '../../components/ui/Action';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { useCopy } from '../../components/ui/useCopy';
import { useAuth } from '../../modules/auth/hooks/useAuth';
import { runPath, runsPath } from '../../routes/paths/runs';
import { formatDateTime } from '../../utils/format';
import { useResource } from '../../utils/useResource';
import { classifyAuthError, marker } from '../../modules/core/api/errors';
import { saveBytes } from '../../features/workspace/download';
import { OrgGate, OrgSkeleton } from '../../features/workspace/OrgFrame';
import { problemAccess } from '../Problems/useRouteProblem';
import { useRouteOrganization } from '../Organization/useRouteOrganization';
import { Provenance, Settings, Timeline } from './RunFacts';
import { ResultSection } from './RunOutcome';
import { rangeFailureOf, refusalOf, type Refusal } from './runErrors';
import { originOf } from './runsData';
import { canRetryState, isActive, normalizeStatus, readPins } from './runsModel';
import { runLabel } from '../../shared/lib/identity';
import { JobFrame, JobMissing, OutcomeChip, RefusalNotice, StatusChip } from './parts';
import { useRunLive } from './useRunLive';

type Outcome =
  { tone: 'success'; text: string; follow?: string } | { tone: 'error'; refusal: Refusal };
type DownloadKind = 'ir' | 'instance' | 'result';

const DOWNLOADS: ReadonlyArray<{ kind: DownloadKind; label: string; file: string }> = [
  { kind: 'ir', label: 'Download compiled problem', file: 'compiled-problem' },
  { kind: 'instance', label: 'Download instance', file: 'instance' },
  { kind: 'result', label: 'Download result', file: 'result' },
];

function RunDetailBody({
  organization,
  jobId,
  canWork,
}: {
  organization: Organization;
  jobId: string;
  canWork: boolean;
}) {
  const navigate = useNavigate();
  const { copy, status } = useCopy();
  const { user } = useAuth();
  const org = organization.slug;
  const root = `/app/${org}`;
  const live = useRunLive(org, jobId);
  const detail = live.detail;
  const proven = detail !== undefined;

  // The other runs of the organization are read only once the gateway has shown this one: a run of another organization reads as missing.
  const others = useResource<Job[]>(`runs-around:${org}:${proven}`, async () =>
    proven
      ? runsApi.list(org, { limit: 26 }).then(
          page => page.runs,
          () => []
        )
      : []
  );
  const origin = originOf(detail);

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<'cancel' | 'retry' | null>(null);
  const [asked, setAsked] = useState(false);
  const [downloads, setDownloads] = useState<Partial<Record<DownloadKind, string>>>({});

  const meta = detail ?? null;
  const failure = live.phase === 'error' ? classifyAuthError(live.error) : null;
  const trail = [
    { label: 'Runs', to: runsPath(org) },
    { label: runLabel({ engine: { name: meta?.engine_id }, createdAt: meta?.created_at }) },
  ];

  if (live.phase === 'loading') {
    return (
      <JobFrame organization={organization} trail={trail}>
        <div role="status" aria-busy="true" className="job-connecting">
          <span>
            <span className="job-spinner" aria-hidden="true" />
            Connecting to live updates…
          </span>
          <Skeleton variant="card" />
          <Skeleton variant="panel" />
        </div>
      </JobFrame>
    );
  }

  if (live.phase === 'error' || !detail) {
    return (
      <JobFrame organization={organization} trail={trail}>
        {failure?.status === 403 && (
          <Notice tone="warning">
            This API key can’t read runs or doesn’t include this engine{marker(failure)}. Engines
            outside a key’s list answer as if they didn’t exist.
          </Notice>
        )}
        {failure?.status === 401 && (
          <Notice tone="warning">
            Your session ended{marker(failure)}. Log in again to see this run.
          </Notice>
        )}
        {(!failure || failure.kind === 'not-found') && (
          <JobMissing
            title="Run not found"
            actions={
              <Action to={runsPath(org)} variant="primary">
                All runs
              </Action>
            }
          >
            Runs open for the members of their organization. Everyone else, including platform
            administrators, gets this same answer.
          </JobMissing>
        )}
        {failure &&
          failure.status !== 403 &&
          failure.status !== 401 &&
          failure.kind !== 'not-found' && (
            <Notice
              tone="error"
              action={
                <Action variant="secondary" size="sm" onClick={live.refresh}>
                  Try again
                </Action>
              }
            >
              The run couldn’t be loaded{marker(failure)}. A service OpenBinding depends on didn’t
              answer; this says nothing about your access.
            </Notice>
          )}
      </JobFrame>
    );
  }

  const state = normalizeStatus(detail.status);
  const rangeFailure = rangeFailureOf(detail);
  const pins = readPins(detail.provenance);
  const engineName = meta?.engine_id ?? pins.engine?.name ?? 'Run';
  const launcher = meta?.created_by
    ? user && meta.created_by.id === user.id
      ? 'you'
      : meta.created_by.username
    : null;
  const engineVersion = pins.engine?.version ? ` ${pins.engine.version}` : '';
  const created = meta?.created_at ?? null;
  const finished = meta?.finished_at ?? null;
  const cancelRequested = asked || Boolean(meta?.cancellation_requested);
  const siblings = (others.data ?? []).filter(row => row.id !== jobId).slice(0, 25);
  const caseLine = origin ? `problem ${origin.caseName} · version ${origin.revision}` : null;

  const cancel = async () => {
    setBusy('cancel');
    setOutcome(null);
    try {
      const view = await runsApi.cancel(org, jobId);
      setAsked(true);
      if (normalizeStatus(view.status) === 'cancelled') live.adopt('cancelled');
      setOutcome({
        tone: 'success',
        text: 'Cancellation requested. The engine stops at its next check.',
      });
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
      const made = await runsApi.retry(org, jobId);
      setOutcome({
        tone: 'success',
        text: 'Retry queued as a new attempt.',
        follow: runPath(org, made.id),
      });
    } catch (caught) {
      setOutcome({ tone: 'error', refusal: refusalOf(caught, 'retry') });
    } finally {
      setBusy(null);
    }
  };

  const download = async (kind: DownloadKind, file: string) => {
    setDownloads(current => ({ ...current, [kind]: 'busy' }));
    try {
      if (kind !== 'result' && !origin?.compilationId)
        throw new Error('The run names no problem version.');
      const body =
        kind === 'ir' && origin?.compilationId
          ? (
              await problemsApi.ir(
                origin.org,
                origin.caseSlug,
                origin.revision,
                origin.compilationId
              )
            ).ir
          : kind === 'instance' && origin
            ? (await problemsApi.revision(origin.org, origin.caseSlug, origin.revision)).document
            : (detail.result ?? {});
      saveBytes(
        new TextEncoder().encode(JSON.stringify(body, null, 2)).buffer as ArrayBuffer,
        `run-${file}.json`,
        'application/json'
      );
      setDownloads(current => ({ ...current, [kind]: 'done' }));
    } catch (caught) {
      setDownloads(current => ({
        ...current,
        [kind]: `failed${marker(classifyAuthError(caught))}`,
      }));
    }
  };

  return (
    <JobFrame organization={organization} trail={trail}>
      <header className="proj-title-row">
        <div className="proj-title">
          <span className="proj-title-line">
            <h1>{engineName} run</h1>
            <StatusChip status={state} />
            {state === 'completed' && detail.result?.termination && (
              <OutcomeChip termination={detail.result.termination} long />
            )}
          </span>
          <p>
            {engineName}
            {engineVersion}
            {pins.mode ? ` · mode ${pins.mode}` : ''}
            {created ? ` · launched ${formatDateTime(created)}` : ' · launched'}
            {launcher ? ` by ${launcher}` : ''}
            {caseLine ? ` · ${caseLine}` : ''}
          </p>
          {siblings.length > 0 && (
            <label className="job-select">
              <span>Another run</span>
              <select
                aria-label="Another run of the organization"
                value={jobId}
                onChange={event =>
                  navigate(runPath(org, event.target.value), { viewTransition: true })
                }
              >
                <option value={jobId}>This run</option>
                {siblings.map(row => (
                  <option key={row.id} value={row.id}>
                    {row.engine_id} · {formatDateTime(row.created_at) ?? 'earlier run'}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div className="proj-actions">
          {canWork && isActive(state) && !cancelRequested && (
            <Action variant="danger-outline" busy={busy === 'cancel'} onClick={() => void cancel()}>
              Cancel run
            </Action>
          )}
          {canWork && canRetryState(state) && (
            <Action variant="primary" busy={busy === 'retry'} onClick={() => void retry()}>
              Retry
            </Action>
          )}
          <Action variant="secondary" onClick={() => void copy(`run ${jobId}`, 'ref')}>
            {status('ref') === 'copied'
              ? 'Copied'
              : status('ref') === 'failed'
                ? 'Copy failed'
                : 'Copy reference'}
          </Action>
          <Action
            variant="ghost"
            onClick={() => void copy(`${window.location.origin}${runPath(org, jobId)}`, 'link')}
          >
            {status('link') === 'copied'
              ? 'Link copied'
              : status('link') === 'failed'
                ? 'Copy failed'
                : 'Copy link'}
          </Action>
        </div>
      </header>

      {cancelRequested && isActive(state) && !outcome && (
        <Notice tone="info">Cancellation requested. The engine stops at its next check.</Notice>
      )}
      {outcome?.tone === 'success' && (
        <Notice
          tone="success"
          action={
            outcome.follow ? (
              <Action to={outcome.follow} variant="link" size="sm">
                Follow the new run
              </Action>
            ) : undefined
          }
        >
          {outcome.text}
        </Notice>
      )}
      {outcome?.tone === 'error' && <RefusalNotice refusal={outcome.refusal} usageTo />}
      {state === 'failed' && rangeFailure && <RefusalNotice refusal={rangeFailure} />}
      {live.feed === 'paused' && (
        <Notice
          tone="warning"
          action={
            <Action variant="secondary" size="sm" onClick={live.refresh}>
              Reconnect
            </Action>
          }
        >
          Live updates stopped arriving. What you see is the last state received.
        </Notice>
      )}

      <Timeline status={state} created={created} finished={finished} feed={live.feed} />
      <Settings provenance={detail.provenance} />
      <ResultSection detail={detail} org={org} jobId={jobId} origin={origin} canDerive={canWork} />
      <Provenance
        provenance={detail.provenance}
        compilation={detail.compilation ?? null}
        origin={origin}
        root={root}
        created={created}
        retryOf={meta?.retry_of_id ?? null}
        actions={
          <>
            {DOWNLOADS.map(({ kind, label, file }) => (
              <Action
                key={kind}
                variant="secondary"
                size="sm"
                busy={downloads[kind] === 'busy'}
                onClick={() => void download(kind, file)}
              >
                {downloads[kind] === 'done'
                  ? 'Downloaded'
                  : downloads[kind]?.startsWith('failed')
                    ? `${label} (failed${downloads[kind]?.slice(6)})`
                    : label}
              </Action>
            ))}
          </>
        }
      />
    </JobFrame>
  );
}

/** One run (`run-detail`, `/app/:org/runs/:job`): live state, the authoritative result, the settings and what it ran on. */
export function RunDetail() {
  const { job: jobId = '' } = useParams();
  const { organization, waiting } = useRouteOrganization();
  if (waiting) return <OrgSkeleton label="Loading organization…" />;
  if (!organization) return <OrgGate failure={null} />;
  return (
    <RunDetailBody
      key={jobId}
      organization={organization}
      jobId={jobId}
      canWork={problemAccess(organization).canCreate}
    />
  );
}
