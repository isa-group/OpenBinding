// The Progress tab of the study page: one study run with every cell and its state, polled while it runs. Pattern only, after
// SPHERE frontend/src/modules/pricing/pages/collection-card/index.tsx (revision 73779a8a), https://github.com/SCORELabUS/SPHERE.
// Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in THIRD_PARTY_NOTICES.md. SPHERE's cards and
// stat tiles hold OpenBinding's run: the cell bar, the heat grid and the table of cells.

import { useState } from 'react';
import { Action } from '../../../core/components/action-button';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import { formatDateTime } from '../../../../utils/format';
import { useResource } from '../../../../utils/useResource';
import { classifyAuthError, marker } from '../../../core/api/errors';
import { studiesApi, type StudyCell } from '../../api/studiesApi';
import { POLL_MS, usePolling } from '../../hooks/usePolling';
import { useRevisionIndex } from '../../hooks/useRevisionIndex';
import type { StudyScopeValue } from '../../pages/card/hooks';
import { loadRun } from '../../utils/runData';
import {
  MAX_GRID_CELLS,
  RUNTIME,
  breakdownText,
  countStates,
  isActiveState,
  isRetryable,
  measureLabel,
  measuresOf,
  metricsOf,
  plural,
  studyPageHref,
} from '../../utils/studiesModel';
import { studyRefusal, type Refusal } from '../../utils/studyErrors';
import { CARD, CARD_TITLE, FIELD_LABEL, MUTED, SELECT } from '../../utils/ui';
import { CellTable, RunHeatmap } from '../cell-views';
import { CopyDigest } from '../copy-digest';
import { StudyRefusal } from '../study-refusal';
import { CellBar, StateChip } from '../study-state';

type Outcome = { tone: 'success'; text: string } | { tone: 'error'; refusal: Refusal };

/** A run the address names that is not one of the study's: said in the tab, the page around it stays. */
export function RunMissing({ studyName }: { studyName: string }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-xl border border-tp-hairline bg-tp-canvas py-16 text-center"
    >
      <h2 className="text-sm font-medium text-tp-ink">Run not found</h2>
      <p className="mt-1 text-xs text-tp-steel">
        This run doesn’t exist (404), or it isn’t one of {studyName}’s runs.
      </p>
    </div>
  );
}

/** The Progress tab of the study page: the study run `runId` with every cell and its state, kept up to date while it runs. */
export function RunProgress({ scope, runId }: { scope: StudyScopeValue; runId: string }) {
  const { study, organization, access, studyPath } = scope;
  const org = organization.slug;
  const { index } = useRevisionIndex(org);
  const resource = useResource(`run:${study.id}/${runId}`, () => loadRun(org, study.slug, runId));
  const [auto, setAuto] = useState(true);
  const [measureChoice, setMeasureChoice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState<'cancel' | 'retry-all' | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const data = resource.data ?? resource.stale;
  const reload = resource.reload;
  const live = Boolean(data && isActiveState(data.run.state));
  usePolling(live && auto, reload, POLL_MS);

  if (resource.status === 'error' && !data) {
    const problem = classifyAuthError(resource.error);
    if (problem.status === 403) {
      return (
        <Notice tone="warning" title={`This API key can’t show this run${marker(problem)}`}>
          {problem.message || 'The key isn’t allowed to use one of the engines this run pinned.'}{' '}
          Use a browser session, or a key whose engine access includes every engine of the study.
        </Notice>
      );
    }
    if (problem.status === 404) return <RunMissing studyName={study.name} />;
    return (
      <Notice
        tone="error"
        action={
          <Action variant="secondary" size="sm" onClick={reload}>
            Retry
          </Action>
        }
      >
        The run couldn’t be loaded{marker(problem)}.
      </Notice>
    );
  }

  if (!data) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading the run…</span>
        <Skeleton variant="panel" />
      </div>
    );
  }

  const { run, cells } = data;
  const measures = measuresOf(cells);
  const measure =
    measureChoice && measures.includes(measureChoice) ? measureChoice : (measures[0] ?? RUNTIME);
  const counts = countStates(cells);
  const retryable = cells.filter(cell => isRetryable(cell.state));
  const feasible = cells.filter(
    cell => cell.state === 'completed' && metricsOf(cell).feasible === true
  ).length;
  const finishedAt = formatDateTime(run.finished_at);

  const cancel = async () => {
    setBusy('cancel');
    setOutcome(null);
    try {
      await studiesApi.cancel(org, study.slug, run.id);
      setOutcome({
        tone: 'success',
        text: 'Run cancelled. Cells that hadn’t finished are cancelled; you can retry them.',
      });
      reload();
    } catch (caught) {
      setOutcome({ tone: 'error', refusal: studyRefusal(caught, 'cancel') });
    } finally {
      setBusy(null);
    }
  };

  const retryOne = async (cell: StudyCell) => {
    setRetrying(cell.id);
    setOutcome(null);
    try {
      await studiesApi.retryCell(org, study.slug, run.id, cell.id);
      setOutcome({ tone: 'success', text: `Cell ${cell.ordinal} queued again.` });
      reload();
    } catch (caught) {
      setOutcome({ tone: 'error', refusal: studyRefusal(caught, 'retry') });
    } finally {
      setRetrying(null);
    }
  };

  const retryAll = async () => {
    setBusy('retry-all');
    setOutcome(null);
    let done = 0;
    try {
      for (const cell of retryable) {
        setRetrying(cell.id);
        await studiesApi.retryCell(org, study.slug, run.id, cell.id);
        done += 1;
      }
      setOutcome({ tone: 'success', text: `${plural(done, 'cell')} queued again.` });
    } catch (caught) {
      const refusal = studyRefusal(caught, 'retry');
      setOutcome({
        tone: 'error',
        refusal:
          done > 0
            ? {
                ...refusal,
                text: `${plural(done, 'cell')} queued again before this stopped. ${refusal.text}`,
              }
            : refusal,
      });
    } finally {
      setRetrying(null);
      setBusy(null);
      reload();
    }
  };

  const cellHref = (cellId: string) =>
    studyPageHref(studyPath, 'progress', { run: runId, cell: cellId });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-tp-ink">Run #{run.run_number}</h2>
            <StateChip state={run.state} />
          </div>
          <p className="mt-1 text-xs text-tp-steel">
            {formatDateTime(run.created_at) ?? '—'}
            {finishedAt ? ` → ${finishedAt}` : ''}
            {' · '}
            <CopyDigest value={run.matrix_digest} label="Copy matrix digest" />
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Action to={studyPageHref(studyPath, 'results', { run: runId })} variant="primary">
            Compare results
          </Action>
          {access.canCreate && isActiveState(run.state) && (
            <Action
              variant="danger-outline"
              busy={busy === 'cancel'}
              disabled={busy !== null}
              onClick={() => void cancel()}
            >
              Cancel run
            </Action>
          )}
        </div>
      </div>

      {outcome?.tone === 'success' && <Notice tone="success">{outcome.text}</Notice>}
      {outcome?.tone === 'error' && <StudyRefusal refusal={outcome.refusal} usageTo />}
      {resource.status === 'error' && data && (
        <Notice
          tone="warning"
          action={
            <Action variant="secondary" size="sm" onClick={reload}>
              Retry
            </Action>
          }
        >
          The latest reading failed, so this shows what was last known.
        </Notice>
      )}

      {cells.length === 0 ? (
        <Notice tone="warning">
          This run has no cells, which shouldn’t happen. Its matrix is still recorded; contact an
          administrator.
        </Notice>
      ) : (
        <>
          <section
            aria-label="Progress of the run"
            className={`${CARD} flex flex-col gap-3 sm:flex-row sm:items-center`}
          >
            <div className="min-w-0 flex-1">
              <CellBar
                cells={cells}
                size="lg"
                legend
                note={
                  counts.completed
                    ? `${feasible} of ${counts.completed} completed are feasible`
                    : undefined
                }
              />
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-tp-steel">
              {live ? (
                <label className="flex cursor-pointer items-center gap-2 text-tp-ink">
                  <input
                    type="checkbox"
                    checked={auto}
                    onChange={event => setAuto(event.target.checked)}
                    className="h-3.5 w-3.5 cursor-pointer accent-tp-primary"
                  />
                  Keep updating
                </label>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-tp-muted" aria-hidden="true" />
                  Finished · not live
                </span>
              )}
              {live && auto && (
                <span className="inline-flex items-center gap-1.5 text-tp-info-text">
                  <span
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-tp-severity-info"
                    aria-hidden="true"
                  />
                  Live · every {POLL_MS / 1000} s
                </span>
              )}
              {access.canCreate && retryable.length > 0 && (
                <Action
                  variant="secondary"
                  size="sm"
                  busy={busy === 'retry-all'}
                  disabled={busy !== null || retrying !== null}
                  onClick={() => void retryAll()}
                >
                  Retry {retryable.length} unfinished {retryable.length === 1 ? 'cell' : 'cells'}
                </Action>
              )}
            </div>
          </section>

          {cells.length <= MAX_GRID_CELLS ? (
            <section aria-labelledby="study-heat-title" className={`${CARD} flex flex-col gap-3`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="study-heat-title" className={CARD_TITLE}>
                  Cells · {measureLabel(measure).toLowerCase()} (lower is better)
                </h2>
                {measures.length > 1 && (
                  <label className={FIELD_LABEL}>
                    <span>Colour by</span>
                    <select
                      aria-label="Colour by"
                      value={measure}
                      onChange={event => setMeasureChoice(event.target.value)}
                      className={SELECT}
                    >
                      {measures.map(name => (
                        <option key={name} value={name}>
                          {measureLabel(name)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <RunHeatmap cells={cells} measure={measure} where={{ cellHref, index }} />
              <span className="flex items-center gap-2 text-[11px] text-tp-steel">
                Better
                <span
                  className="h-2 w-24 rounded-full bg-linear-to-r from-emerald-200 via-amber-200 to-red-300"
                  aria-hidden="true"
                />
                Worse
              </span>
              <small className={MUTED}>{breakdownText(cells)}. Each square opens its cell.</small>
            </section>
          ) : (
            <Notice tone="info">
              This run has {cells.length.toLocaleString('en-US')} cells, too many to draw as
              squares. The table below lists them all, a page at a time.
            </Notice>
          )}

          <CellTable
            cells={cells}
            where={{ cellHref, index }}
            canRetry={access.canCreate}
            retrying={retrying}
            onRetry={cell => void retryOne(cell)}
          />
        </>
      )}
    </div>
  );
}
