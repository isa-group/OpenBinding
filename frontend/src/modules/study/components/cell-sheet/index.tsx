// One cell of a study run, opened as a side sheet over the tab it was opened from. Pattern only, after the "Show details"
// side panel of SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández. MIT licence: the full text is in
// THIRD_PARTY_NOTICES.md. The sheet slides in from the right (from the bottom on a phone), traps the focus and closes with
// Escape; the cell is in the address (`?cell=`), so it can be linked and the back button closes it.

import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { runsApi } from '../../../../api/runs';
import type { Job } from '../../../../api/platform';
import { SourceView } from '../../../../components/rendering/SourceView';
import { normalizeStatus } from '../../../run/api/runModel';
import { problemPath } from '../../../../routes/paths/problems';
import { runPath } from '../../../../routes/paths/runs';
import { formatDateTime } from '../../../../utils/format';
import { useResource } from '../../../../utils/useResource';
import { classifyAuthError, marker } from '../../../core/api/errors';
import { Action } from '../../../core/components/action-button';
import { Modal } from '../../../core/components/modal';
import { Notice } from '../../../core/components/notice';
import { Skeleton } from '../../../core/components/skeleton';
import { TabBar, TabPanel } from '../../../core/components/tab-bar';
import { useFocusTrap } from '../../../core/hooks/useFocusTrap';
import { studiesApi, type StudyCell as StudyCellView } from '../../api/studiesApi';
import { POLL_MS, usePolling } from '../../hooks/usePolling';
import { useRevisionIndex } from '../../hooks/useRevisionIndex';
import type { StudyScopeValue } from '../../pages/card/hooks';
import { loadRun } from '../../utils/runData';
import {
  RUNTIME,
  describeParameters,
  engineKeyOf,
  engineTitle,
  enginesOf,
  explainFailure,
  formatMeasure,
  formatSeconds,
  isActiveState,
  isRetryable,
  measureLabel,
  measureValue,
  measuresOf,
  metricsOf,
  revisionLabel,
  rivalsOf,
  seedsOf,
  studyPageHref,
  type StudyTabId,
} from '../../utils/studiesModel';
import { studyRefusal, type Refusal } from '../../utils/studyErrors';
import { CARD, CARD_TITLE, FIELD_LABEL, LINK, MUTED, SELECT } from '../../utils/ui';
import { CopyDigest } from '../copy-digest';
import { StudyRefusal } from '../study-refusal';
import { StateChip } from '../study-state';

const TABS = [
  { id: 'result', label: 'Result' },
  { id: 'source', label: 'Source' },
];

type Outcome = { tone: 'success'; text: string } | { tone: 'error'; refusal: Refusal };

const TERMINAL_JOB = new Set(['completed', 'failed', 'cancelled']);

/** The finished runs of this organization, whoever launched them, newest first: the ones whose result can stand in for a cell's. */
async function loadAttachable(org: string): Promise<{ jobs: Job[] }> {
  const { runs } = await runsApi.list(org, { limit: 200 });
  const finished = runs.filter(job => TERMINAL_JOB.has(normalizeStatus(job.status)));
  return { jobs: finished.sort((a, b) => b.created_at.localeCompare(a.created_at)) };
}

function AttachDialog({
  scope,
  runId,
  cell,
  onClose,
  onAttached,
}: {
  scope: StudyScopeValue;
  runId: string;
  cell: StudyCellView;
  onClose: () => void;
  onAttached: () => void;
}) {
  const { organization, study } = scope;
  const jobs = useResource(`attachable:${organization.slug}`, () =>
    loadAttachable(organization.slug)
  );
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const list = jobs.data?.jobs ?? [];
  const attach = async () => {
    if (!chosen || busy) return;
    setBusy(true);
    setRefusal(null);
    try {
      await studiesApi.attachResult(organization.slug, study.slug, runId, cell.id, chosen);
      onAttached();
    } catch (caught) {
      setRefusal(studyRefusal(caught, 'attach'));
      setBusy(false);
    }
  };
  return (
    <Modal title="Use an existing run’s result" size="lg" onClose={() => !busy && onClose()}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-tp-slate">
          A finished run of this organization becomes this cell’s result as it is. It has to be a
          run of this cell: the same problem version, engine, mode and seed. The gateway checks, and
          names what differs if it isn’t.
        </p>
        {jobs.status === 'loading' && (
          <div role="status" aria-busy="true">
            <span className="sr-only">Loading the organization’s runs…</span>
            <Skeleton variant="tile" />
          </div>
        )}
        {jobs.status === 'error' && (
          <Notice
            tone="error"
            action={
              <Action variant="secondary" size="sm" onClick={jobs.reload}>
                Retry
              </Action>
            }
          >
            The organization’s runs couldn’t be loaded{marker(classifyAuthError(jobs.error))}.
          </Notice>
        )}
        {jobs.status === 'ready' && list.length === 0 && (
          <p className={MUTED}>This organization has no finished run to attach.</p>
        )}
        {list.length > 0 && (
          <div
            className="flex max-h-80 flex-col gap-1.5 overflow-y-auto"
            role="radiogroup"
            aria-label="Finished runs"
          >
            {list.map(job => (
              <label
                key={job.id}
                className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 transition-colors ${
                  chosen === job.id
                    ? 'border-tp-primary bg-tp-primary/5'
                    : 'border-tp-hairline hover:bg-tp-surface'
                }`}
              >
                <input
                  type="radio"
                  name="attach-job"
                  value={job.id}
                  checked={chosen === job.id}
                  onChange={() => setChosen(job.id)}
                  className="mt-1 cursor-pointer accent-tp-primary"
                />
                <span className="flex flex-col">
                  <span className="text-sm text-tp-ink">{`${job.engine_id} · ${normalizeStatus(job.status)}${job.created_by ? ` · by ${job.created_by.username}` : ''}`}</span>
                  <small
                    className={MUTED}
                  >{`${formatDateTime(job.created_at) ?? 'unknown date'}${job.termination ? ` · ${job.termination.toLowerCase()}` : ''}`}</small>
                </span>
              </label>
            ))}
          </div>
        )}
        {refusal && <StudyRefusal refusal={refusal} />}
        <div className="flex justify-end gap-2">
          <Action variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Action>
          <Action variant="primary" busy={busy} disabled={!chosen} onClick={() => void attach()}>
            Attach this result
          </Action>
        </div>
      </div>
    </Modal>
  );
}

function RivalsCard({
  cell,
  cells,
  measure,
  onMeasure,
  measures,
  cellHref,
}: {
  cell: StudyCellView;
  cells: readonly StudyCellView[];
  measure: string;
  onMeasure: (name: string) => void;
  measures: string[];
  cellHref: (cellId: string) => string;
}) {
  const rivals = rivalsOf(cell, cells);
  const labels = new Map(enginesOf(rivals).map(engine => [engine.key, engine.label]));
  const values = rivals
    .map(item => measureValue(item, measure))
    .filter((value): value is number => value !== null);
  const top = values.length ? Math.max(...values) : 0;
  const best = values.length ? Math.min(...values) : null;
  const seeds = seedsOf(cell, cells);
  return (
    <section className={`${CARD} flex flex-col gap-3`} aria-labelledby="study-rivals-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="study-rivals-title" className={CARD_TITLE}>
          Against the other engines
        </h3>
        {measures.length > 1 && (
          <label className={FIELD_LABEL}>
            <span>Compare by</span>
            <select
              aria-label="Compare by"
              value={measure}
              onChange={event => onMeasure(event.target.value)}
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
      {rivals.length < 2 ? (
        <p className={MUTED}>
          No other engine ran this problem with the same setting and seed in this run.
        </p>
      ) : (
        <ul
          className="flex flex-col gap-2"
          aria-label={`${measureLabel(measure)} of each engine on this input`}
        >
          {rivals.map(item => {
            const value = measureValue(item, measure);
            const isThis = item.id === cell.id;
            const isBest = value !== null && best !== null && value === best;
            return (
              <li
                key={item.id}
                className="grid grid-cols-[minmax(0,9rem)_1fr_auto] items-center gap-2 text-xs"
              >
                <span className="truncate">
                  {isThis ? (
                    <b className="text-tp-ink">
                      {labels.get(engineKeyOf(item.engine_ref)) ?? engineTitle(item.engine_ref)}{' '}
                      (this cell)
                    </b>
                  ) : (
                    <Link to={cellHref(item.id)} viewTransition className={LINK}>
                      {labels.get(engineKeyOf(item.engine_ref)) ?? engineTitle(item.engine_ref)}
                    </Link>
                  )}
                </span>
                <span
                  className="h-2 overflow-hidden rounded-full bg-tp-hairline-soft"
                  aria-hidden="true"
                >
                  <i
                    className={`block h-full rounded-full ${isBest ? 'bg-tp-severity-success' : 'bg-tp-chart-1'}`}
                    style={{
                      width: `${value !== null && top > 0 ? Math.max(3, Math.round((value / top) * 100)) : 0}%`,
                    }}
                  />
                </span>
                <span className="text-right text-tp-ink tabular-nums">
                  {value !== null ? formatMeasure(value) : <StateChip state={item.state} />}
                  {isBest && rivals.length > 1 ? (
                    <small className="ml-1 text-tp-success-strong"> best</small>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {seeds.length > 1 && (
        <p className={MUTED}>
          Same engine, other seeds:{' '}
          {seeds
            .map(item => {
              const value = measureValue(item, measure);
              return `seed ${item.seed} ${value !== null ? formatMeasure(value) : item.state}`;
            })
            .join(' · ')}
          .
        </p>
      )}
    </section>
  );
}

/** One cell of the study run `runId`: what it ran on, how it ended, and how the engines compare on it. */
function CellBody({
  scope,
  runId,
  cellId,
  tab,
  onClose,
}: {
  scope: StudyScopeValue;
  runId: string;
  cellId: string;
  tab: StudyTabId;
  onClose: () => void;
}) {
  const { study, organization, access, studyPath } = scope;
  const org = organization.slug;
  const navigate = useNavigate();
  const cellHref = (id: string) => studyPageHref(studyPath, tab, { run: runId, cell: id });
  const { index } = useRevisionIndex(org);
  const siblings = useResource(`cell-run:${study.id}/${runId}`, () =>
    loadRun(org, study.slug, runId)
  );
  const one = useResource(`cell:${runId}/${cellId}`, () =>
    studiesApi.cell(org, study.slug, runId, cellId)
  );
  const [measureChoice, setMeasureChoice] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [view, setView] = useState<'result' | 'source'>('result');

  const cell = one.data ?? one.stale;
  const all = siblings.data ?? siblings.stale;
  const reloadAll = () => {
    one.reload();
    siblings.reload();
  };
  usePolling(Boolean(cell && isActiveState(cell.state)), reloadAll, POLL_MS);

  if (one.status === 'error' && !cell) {
    const problem = classifyAuthError(one.error);
    if (problem.status === 404) {
      return (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold text-tp-ink">Cell not found</h2>
          <p className="text-sm text-tp-slate">
            No such cell here (404). It may belong to another run, or the run no longer exists.
          </p>
          <div>
            <Action variant="secondary" onClick={onClose}>
              Close
            </Action>
          </div>
        </div>
      );
    }
    if (problem.status === 403) {
      return (
        <Notice tone="warning" title={`This API key can’t show this cell${marker(problem)}`}>
          The key isn’t allowed to use the engine this cell pins.
        </Notice>
      );
    }
    return (
      <Notice
        tone="error"
        action={
          <Action variant="secondary" size="sm" onClick={one.reload}>
            Retry
          </Action>
        }
      >
        The cell couldn’t be loaded{marker(problem)}.
      </Notice>
    );
  }
  if (!cell) {
    return (
      <div role="status" aria-busy="true">
        <span className="sr-only">Loading the cell…</span>
        <Skeleton variant="panel" />
      </div>
    );
  }

  const cells = all?.cells ?? [];
  const metrics = metricsOf(cell);
  const measures = measuresOf(cells.length ? cells : [cell]);
  const measure =
    measureChoice && measures.includes(measureChoice) ? measureChoice : (measures[0] ?? RUNTIME);
  const info = index.get(cell.binding_case_revision_id);
  const failure = cell.state === 'failed' ? explainFailure(metrics) : null;
  const ref = cell.engine_ref;

  const retry = async () => {
    setRetrying(true);
    setOutcome(null);
    try {
      await studiesApi.retryCell(org, study.slug, runId, cell.id);
      setOutcome({ tone: 'success', text: 'Cell queued again.' });
      reloadAll();
    } catch (caught) {
      setOutcome({ tone: 'error', refusal: studyRefusal(caught, 'retry') });
    } finally {
      setRetrying(false);
    }
  };

  const inputs: Array<[string, ReactNode]> = [
    [
      'Problem',
      info ? (
        <Link
          to={problemPath(org, info.caseSlug, undefined, { version: info.revision })}
          viewTransition
          className={LINK}
        >
          {revisionLabel(index, cell.binding_case_revision_id)}
        </Link>
      ) : (
        revisionLabel(index, cell.binding_case_revision_id)
      ),
    ],
    ['Engine', engineTitle(ref)],
    ['Mode', ref.mode ?? '—'],
    ['Settings', describeParameters(cell.parameters)],
    ['Seed', String(cell.seed)],
    [
      'Source',
      info ? (
        <Link
          to={problemPath(org, info.caseSlug, 'source', { version: info.revision })}
          viewTransition
          className={LINK}
        >
          Package and compiled form
        </Link>
      ) : (
        '—'
      ),
    ],
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-lg font-semibold text-tp-ink">Cell {cell.ordinal}</h2>
          <StateChip state={cell.state} />
        </div>
        {cells.length > 1 && (
          <label className={FIELD_LABEL}>
            <span>Other cell</span>
            <select
              aria-label="Other cell"
              value={cell.id}
              onChange={event => void navigate(cellHref(event.target.value), { replace: true })}
              className={`${SELECT} w-full`}
            >
              {cells.map(item => (
                <option key={item.id} value={item.id}>
                  Cell {item.ordinal} · {revisionLabel(index, item.binding_case_revision_id, true)}{' '}
                  · {item.engine_ref.name ?? 'engine'} · seed {item.seed} · {item.state}
                </option>
              ))}
            </select>
          </label>
        )}
        {access.canCreate && (
          <div className="flex flex-wrap gap-2">
            {isRetryable(cell.state) && (
              <Action variant="primary" busy={retrying} onClick={() => void retry()}>
                Retry this cell
              </Action>
            )}
            <Action variant="secondary" disabled={retrying} onClick={() => setAttaching(true)}>
              Use an existing run’s result
            </Action>
          </div>
        )}
      </div>

      {outcome?.tone === 'success' && <Notice tone="success">{outcome.text}</Notice>}
      {outcome?.tone === 'error' && <StudyRefusal refusal={outcome.refusal} usageTo />}
      {!access.canCreate && (
        <p className={MUTED}>
          Read-only: retrying and attaching a result need MEMBER in {organization.name}.
        </p>
      )}

      <TabBar
        items={TABS}
        value={view}
        onChange={id => setView(id as 'result' | 'source')}
        ariaLabel="Cell views"
        prefix="study-cell-view"
      />
      <TabPanel prefix="study-cell-view" active={view}>
        {view === 'source' ? (
          <SourceView
            source={{
              state: cell.state,
              job_id: cell.job_id,
              engine: cell.engine_ref,
              parameters: cell.parameters,
              seed: cell.seed,
              metrics: cell.metrics,
            }}
            label="Cell metrics source"
            filename={`cell-${cell.ordinal}.json`}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <section className={`${CARD} flex flex-col gap-3`} aria-labelledby="study-inputs-title">
              <h3 id="study-inputs-title" className={CARD_TITLE}>
                Frozen inputs
              </h3>
              <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {inputs.map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-tp-hairline-soft px-3 py-2">
                    <dt className="text-[11px] text-tp-steel">{label}</dt>
                    <dd className="text-sm break-words text-tp-ink">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex items-center gap-2 text-xs text-tp-steel">
                <span>Fingerprint</span>
                <CopyDigest value={cell.fingerprint} label="Copy cell digest" />
              </div>
              <span className={MUTED}>
                These never change between runs: the same cell in the next run has the same
                fingerprint.
              </span>
            </section>

            {cell.state === 'completed' && (
              <section aria-labelledby="study-result-title">
                <h3 id="study-result-title" className="sr-only">
                  Result
                </h3>
                <ul className="grid grid-cols-2 gap-3">
                  <li className="rounded-xl border border-tp-hairline bg-tp-canvas p-3">
                    <span className="block text-[11px] text-tp-steel">Outcome</span>
                    <b className="block text-lg font-semibold text-tp-ink">
                      {metrics.feasible === false ? 'Infeasible' : 'Feasible'}
                    </b>
                    <small className={MUTED}>
                      {metrics.termination
                        ? metrics.termination.toLowerCase()
                        : 'meets every must-hold rule'}
                    </small>
                  </li>
                  {Object.entries(metrics.objectives).map(([name, value]) => (
                    <li
                      key={name}
                      className="rounded-xl border border-tp-hairline bg-tp-canvas p-3"
                    >
                      <span className="block text-[11px] text-tp-steel">{measureLabel(name)}</span>
                      <b className="block text-lg font-semibold text-tp-ink">
                        {formatMeasure(value)}
                      </b>
                      <small className={MUTED}>objective · lower is better</small>
                    </li>
                  ))}
                  <li className="rounded-xl border border-tp-hairline bg-tp-canvas p-3">
                    <span className="block text-[11px] text-tp-steel">Took</span>
                    <b className="block text-lg font-semibold text-tp-ink">
                      {formatSeconds(metrics.runtimeSeconds)}
                    </b>
                    <small className={MUTED}>from queued to finished</small>
                  </li>
                </ul>
              </section>
            )}
            {cell.state === 'failed' && failure && (
              <Notice tone="error" title={`Failed: ${failure.title}`}>
                {metrics.code
                  ? `Code ${metrics.code}${failure.detail ? ` · ${failure.detail}` : ''}. `
                  : ''}
                Retrying usually helps.
              </Notice>
            )}
            {cell.state === 'cancelled' && (
              <Notice tone="info">
                Cancelled before it ran. Retry it, or attach the result of a run of the organization
                with the same inputs.
              </Notice>
            )}
            {isActiveState(cell.state) && (
              <Notice tone="info">
                {cell.state === 'queued' ? 'Waiting for a run slot.' : 'The engine is solving it.'}{' '}
                This page updates by itself.
              </Notice>
            )}

            {cell.state === 'completed' && (
              <RivalsCard
                cell={cell}
                cells={cells}
                measure={measure}
                onMeasure={setMeasureChoice}
                measures={measures}
                cellHref={cellHref}
              />
            )}

            <p className="text-sm text-tp-slate">
              <span className="text-tp-steel">Ran as:</span>{' '}
              {cell.job_id ? (
                <Link to={runPath(organization.slug, cell.job_id)} viewTransition className={LINK}>
                  Open run
                </Link>
              ) : (
                <span>none yet</span>
              )}
            </p>
          </div>
        )}
      </TabPanel>

      {attaching && (
        <AttachDialog
          scope={scope}
          runId={runId}
          cell={cell}
          onClose={() => setAttaching(false)}
          onAttached={() => {
            setAttaching(false);
            setOutcome({
              tone: 'success',
              text: 'Result attached. It now counts as this cell’s result.',
            });
            reloadAll();
          }}
        />
      )}
    </div>
  );
}

function Sheet({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const trap = useFocusTrap(panel);
  // Escape closes the sheet wherever the focus is (a choice of another cell moves it); a dialog over the sheet keeps its own.
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) close.current();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, []);
  return createPortal(
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-50 flex justify-end bg-tp-ink/40 max-md:items-end"
      onClick={onClose}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
          return;
        }
        trap(event);
      }}
    >
      <motion.div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', stiffness: 300, damping: 30 }}
        className="flex h-full w-full max-w-[36rem] flex-col overflow-y-auto bg-tp-surface p-5 shadow-elevation-4 outline-none max-md:h-[90vh] max-md:max-w-none max-md:rounded-t-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <p className="text-[10px] font-medium tracking-wider text-tp-steel uppercase">{label}</p>
          <button
            type="button"
            aria-label="Close the cell"
            onClick={onClose}
            className="cursor-pointer rounded-full p-1 text-tp-steel transition-colors hover:bg-tp-canvas hover:text-tp-ink"
          >
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        {children}
      </motion.div>
    </motion.div>,
    document.body
  );
}

/** The cell `cellId` of the study run `runId` as a side sheet over the tab `tab`; closing it takes `?cell=` off the address. */
export function CellSheet({
  scope,
  runId,
  cellId,
  tab,
}: {
  scope: StudyScopeValue;
  runId: string;
  cellId: string | null;
  tab: StudyTabId;
}) {
  const navigate = useNavigate();
  const close = () => void navigate(studyPageHref(scope.studyPath, tab, { run: runId }));
  return (
    <AnimatePresence>
      {cellId && (
        <Sheet key="cell-sheet" label="Study cell" onClose={close}>
          <CellBody
            key={`${runId}/${cellId}`}
            scope={scope}
            runId={runId}
            cellId={cellId}
            tab={tab}
            onClose={close}
          />
        </Sheet>
      )}
    </AnimatePresence>
  );
}
