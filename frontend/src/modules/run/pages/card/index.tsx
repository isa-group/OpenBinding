// Adapted from SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: a run of an organization on the card shell SPHERE's pricing page is drawn with: the breadcrumb "Org / Runs /
// <engine> run", the status pill with "· started X ago", Cancel, Retry, "Keep as composition" (the derive dialog) and the
// "Get run" menu (its link and reference, the compiled problem, the instance and the result), the stat tiles Status,
// Outcome, Took and Engine, and the tabs Result, Settings, Provenance and Timeline in `?tab=`. The run is read again while it
// is queued or running. A run that is missing, or of an organization the account is not in, is the in-place 404.

import { formatDistanceToNow, parseISO } from 'date-fns';
import { useState } from 'react';
import { Helmet } from 'react-helmet-async';
import { useParams, useSearchParams } from 'react-router-dom';
import { problemsApi } from '../../../problem/api/problemsClient';
import { saveText } from '../../components/rendering/download';
import { Action } from '../../../core/components/action-button';
import { Notice } from '../../../core/components/notice';
import ResourceCardShell, {
  type OverflowAction,
  type ShellTab,
} from '../../../core/components/resource-card-shell';
import PricingCardSkeleton from '../../../core/components/skeletons/pricing-card-skeleton';
import NotFoundPage from '../../../core/pages/page-not-found';
import { classifyAuthError, marker } from '../../../core/api/errors';
import { useAuth } from '../../../auth/hooks/useAuth';
import { useOrganization } from '../../../organization/hooks/useOrganization';
import type { Organization } from '../../../organization/api/organizationsApi';
import { orgPath } from '../../../organization/types/paths';
import { runPath, runsPath } from '../../../../routes/paths/runs';
import { useRunsApi } from '../../api/runsApi';
import { DeriveCompositionDialog } from '../../components/derive/DeriveCompositionDialog';
import GetRunMenu, {
  type RunDownloadKind,
  type RunDownloadState,
} from '../../components/get-run-menu';
import { Provenance, Settings, Timeline } from '../../components/run-facts';
import { ResultSection } from '../../components/run-outcome';
import { OutcomeChip, RefusalNotice, StatusChip } from '../../components/run-status';
import { useRunLive } from '../../hooks/useRunLive';
import { rangeFailureOf, refusalOf, type Refusal } from '../../utils/runErrors';
import { originOf } from '../../utils/runOrigin';
import {
  canRetryState,
  formatTook,
  isActive,
  normalizeStatus,
  readPins,
  solutionsOfRun,
  tookOf,
} from '../../utils/runsModel';
import type { JobSolution } from '../../api/runsApi';

const TABS = [
  { id: 'result', label: 'Result' },
  { id: 'settings', label: 'Settings' },
  { id: 'provenance', label: 'Provenance' },
  { id: 'timeline', label: 'Timeline' },
] as const;

type TabId = (typeof TABS)[number]['id'];

const isTab = (value: string): value is TabId => TABS.some(tab => tab.id === value);

type Outcome =
  { tone: 'success'; text: string; follow?: string } | { tone: 'error'; refusal: Refusal };

const DOWNLOAD_FILES: Record<RunDownloadKind, string> = {
  ir: 'compiled-problem',
  instance: 'instance',
  result: 'result',
};

const actionClass =
  'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-tp-hairline-strong bg-tp-canvas px-3 text-xs font-medium text-tp-ink transition-colors hover:border-tp-accent hover:text-tp-accent disabled:cursor-wait disabled:opacity-60';

const ROLES = ['VIEWER', 'MEMBER', 'ADMIN', 'OWNER'];
const atLeastMember = (role: string | null | undefined) =>
  role ? ROLES.indexOf(role) >= ROLES.indexOf('MEMBER') : false;

function RunCard({
  organization,
  jobId,
  tab,
}: {
  organization: Organization;
  jobId: string;
  tab: TabId;
}) {
  const { user } = useAuth();
  const api = useRunsApi();
  const org = organization.slug;
  const canWork = atLeastMember(organization.effective_role);
  const live = useRunLive(org, jobId);
  const detail = live.detail;

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<'cancel' | 'retry' | null>(null);
  const [asked, setAsked] = useState(false);
  const [deriving, setDeriving] = useState(false);
  const [downloads, setDownloads] = useState<Partial<Record<RunDownloadKind, RunDownloadState>>>(
    {}
  );

  if (live.phase === 'loading') return <PricingCardSkeleton />;

  const failure = live.phase === 'error' ? classifyAuthError(live.error) : null;
  if (!detail || failure) {
    // Missing and unreadable read the same (a 403 is a run the account may not read), so neither reveals that a run exists.
    if (
      !failure ||
      failure.kind === 'not-found' ||
      failure.status === 404 ||
      failure.status === 403
    )
      return <NotFoundPage />;
    return (
      <div className="mx-auto max-w-7xl px-4 py-16 md:px-8">
        <div className="mx-auto flex max-w-[480px] flex-col gap-3">
          {failure.status === 401 ? (
            <Notice tone="warning">
              Your session ended{marker(failure)}. Log in again to see this run.
            </Notice>
          ) : (
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
        </div>
      </div>
    );
  }

  const state = normalizeStatus(detail.status);
  const origin = originOf(detail);
  const rangeFailure = rangeFailureOf(detail);
  const pins = readPins(detail.provenance);
  const engineName = detail.engine_id ?? pins.engine?.name ?? 'Run';
  const engineVersion = pins.engine?.version ? ` ${pins.engine.version}` : '';
  const launcher = detail.created_by
    ? user && detail.created_by.id === user.id
      ? 'you'
      : detail.created_by.username
    : null;
  const created = detail.created_at ?? null;
  const finished = detail.finished_at ?? null;
  const cancelRequested = asked || Boolean(detail.cancellation_requested);
  const solutions = solutionsOfRun(detail);
  const listed = Array.isArray(detail.result?.solutions)
    ? (detail.result.solutions as JobSolution[])
    : [];
  const infeasible = detail.result?.termination === 'INFEASIBLE';
  const canCancel = canWork && isActive(state) && !cancelRequested;
  const canRetry = canWork && canRetryState(state);
  const canDerive = canWork && state === 'completed' && solutions.length > 0 && !infeasible;
  const took = tookOf({ created_at: created ?? '', finished_at: finished });

  const cancel = async () => {
    setBusy('cancel');
    setOutcome(null);
    try {
      const view = await api.cancel(org, jobId);
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
      const made = await api.retry(org, jobId);
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

  const download = async (kind: RunDownloadKind) => {
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
      saveText(
        JSON.stringify(body, null, 2),
        `run-${DOWNLOAD_FILES[kind]}.json`,
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

  const tabTo = (id: TabId) =>
    id === 'result' ? runPath(org, jobId) : `${runPath(org, jobId)}?tab=${id}`;
  const tabs: ShellTab[] = TABS.map(item => ({
    id: item.id,
    label: item.label,
    to: tabTo(item.id),
  }));

  const overflow: OverflowAction[] = [
    ...(canCancel ? [{ label: 'Cancel run', onSelect: () => void cancel() }] : []),
    ...(canRetry ? [{ label: 'Retry', onSelect: () => void retry() }] : []),
    ...(canDerive ? [{ label: 'Keep as composition', onSelect: () => setDeriving(true) }] : []),
  ];

  const subtitle = (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-sm text-tp-steel">
        <StatusChip status={state} />
        {state === 'completed' && detail.result?.termination && (
          <OutcomeChip termination={detail.result.termination} long />
        )}
        {created && <span>· started {formatDistanceToNow(parseISO(created))} ago</span>}
      </div>
      <p className="text-xs text-tp-steel">
        {engineName}
        {engineVersion}
        {pins.mode ? ` · mode ${pins.mode}` : ''}
        {launcher ? ` · launched by ${launcher}` : ''}
        {origin ? ` · problem ${origin.caseName} · version ${origin.revision}` : ''}
      </p>
    </div>
  );

  return (
    <>
      <Helmet>
        <title>OpenBinding - {engineName} run</title>
      </Helmet>
      <ResourceCardShell
        crumbs={[
          { label: organization.name, to: orgPath(org) },
          { label: 'Runs', to: runsPath(org) },
          { label: `${engineName} run` },
        ]}
        title={`${engineName} run`}
        subtitle={subtitle}
        actions={
          <>
            {canCancel && (
              <button
                type="button"
                onClick={() => void cancel()}
                disabled={busy === 'cancel'}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-tp-severity-error-border bg-tp-canvas px-3 text-xs font-medium text-tp-error-strong transition-colors hover:bg-tp-severity-error-bg disabled:cursor-wait disabled:opacity-60"
              >
                {busy === 'cancel' ? 'Cancelling…' : 'Cancel run'}
              </button>
            )}
            {canRetry && (
              <button
                type="button"
                onClick={() => void retry()}
                disabled={busy === 'retry'}
                className={actionClass}
              >
                {busy === 'retry' ? 'Retrying…' : 'Retry'}
              </button>
            )}
            {canDerive && (
              <button type="button" onClick={() => setDeriving(true)} className={actionClass}>
                Keep as composition
              </button>
            )}
          </>
        }
        primaryAction={
          <GetRunMenu
            link={`${window.location.origin}${runPath(org, jobId)}`}
            reference={`run ${jobId}`}
            downloads={downloads}
            onDownload={kind => void download(kind)}
          />
        }
        overflow={overflow}
        stats={[
          { label: 'Status', value: <StatusChip status={state} /> },
          {
            label: 'Outcome',
            value:
              state === 'completed' ? (
                <OutcomeChip termination={detail.result?.termination ?? detail.termination} />
              ) : (
                <span className="text-tp-steel">—</span>
              ),
          },
          {
            label: 'Took',
            value: took !== null ? formatTook(took) : isActive(state) ? 'Still going' : '—',
          },
          {
            label: 'Engine',
            value: (
              <span className="block truncate font-mono text-sm">
                {engineName}
                {engineVersion}
              </span>
            ),
          },
        ]}
        tabs={tabs}
        activeTab={tab}
        tabsLabel="Run sections"
      >
        <div className="flex flex-col gap-4">
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

          {tab === 'result' && (
            <ResultSection detail={detail} org={org} jobId={jobId} origin={origin} />
          )}
          {tab === 'settings' && <Settings provenance={detail.provenance} />}
          {tab === 'provenance' && (
            <Provenance
              provenance={detail.provenance}
              compilation={detail.compilation ?? null}
              origin={origin}
              org={org}
              created={created}
              retryOf={detail.retry_of_id ?? null}
            />
          )}
          {tab === 'timeline' && (
            <Timeline status={state} created={created} finished={finished} feed={live.feed} />
          )}
        </div>
      </ResourceCardShell>

      {deriving && (
        <DeriveCompositionDialog
          org={org}
          source={{ run: jobId, solutions: listed }}
          onClose={() => setDeriving(false)}
        />
      )}
    </>
  );
}

/**
 * One run (`run-detail`, `/runs/:org/:run`): its live state, the authoritative result, the settings and what it ran on, in the
 * tab `?tab=` names. A run of an organization the account is not in, a run that is missing and an unknown tab are the same
 * in-place 404.
 */
export default function RunCardPage() {
  const { org = '', run = '' } = useParams();
  const [query] = useSearchParams();
  const { organizations, isLoading } = useOrganization();
  const tab = query.get('tab') ?? 'result';
  if (!isTab(tab)) return <NotFoundPage />;
  const organization = organizations.find(item => item.slug === org);
  if (!organization) return isLoading ? <PricingCardSkeleton /> : <NotFoundPage />;
  return <RunCard key={`${org}/${run}`} organization={organization} jobId={run} tab={tab} />;
}
