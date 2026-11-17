// Pattern only, after SPHERE frontend/src/modules/pricing/pages/card/index.tsx (revision 73779a8a),
// https://github.com/SCORELabUS/SPHERE. Copyright (c) 2024 Alejandro García Fernández.
// MIT licence: the full text is in THIRD_PARTY_NOTICES.md.
// Changes: the Settings, Provenance and Timeline tabs of a run's card page, each a hairline card of SPHERE's card page:
// what was asked beside what was used, what the result comes from, and the status changes the live feed reported.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { JobCompilationRef } from '../../../../api/platform';
import { Chip } from '../../../core/components/chip';
import { DataTable } from '../../../core/components/data-table';
import { useCopy } from '../../../core/hooks/useCopy';
import { orgPath } from '../../../organization/types/paths';
import { problemPath } from '../../../../routes/paths/problems';
import { runPath } from '../../../../routes/paths/runs';
import { formatDateTime } from '../../../../utils/format';
import type { Origin } from '../../utils/runOrigin';
import {
  optionRows,
  readPins,
  timelineOf,
  type ResourcePin,
  type TimelineStep,
} from '../../utils/runsModel';

const pinText = (pin: ResourcePin | null): string | null =>
  pin
    ? `${pin.namespace ? `${pin.namespace}/` : ''}${pin.name}${pin.version ? ` ${pin.version}` : ''}`
    : null;

/** A hairline card of a tab, with its heading and, at the right, what it offers. */
export function RunCard({
  id,
  title,
  aside,
  tone = 'plain',
  children,
}: {
  id: string;
  title: string;
  aside?: ReactNode;
  tone?: 'plain' | 'warning';
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`flex min-w-0 flex-col gap-3 rounded-xl border p-5 ${
        tone === 'warning'
          ? 'border-tp-severity-warning-border bg-tp-severity-warning-bg'
          : 'border-tp-hairline bg-tp-canvas'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="font-display text-lg text-tp-ink">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const FEED_TONE = {
  live: 'bg-tp-severity-success',
  paused: 'bg-tp-severity-warning',
  finished: 'bg-tp-muted',
} as const;

const STEP_DOT: Record<TimelineStep['state'], string> = {
  done: 'border-tp-primary bg-tp-primary',
  current: 'border-tp-primary bg-tp-canvas ring-4 ring-tp-primary/15',
  waiting: 'border-tp-hairline-strong bg-tp-canvas',
  bad: 'border-tp-severity-error bg-tp-severity-error',
};

/** Status changes only: the live feed reports snapshots, so there is no progress to draw. */
export function Timeline({
  status,
  created,
  finished,
  feed,
}: {
  status: string;
  created?: string | null;
  finished?: string | null;
  feed: 'live' | 'finished' | 'paused';
}) {
  const steps = timelineOf(status, { created, finished });
  return (
    <RunCard
      id="run-timeline"
      title="Timeline"
      aside={
        <span className="inline-flex items-center gap-1.5 text-xs text-tp-steel">
          <span className={`h-2 w-2 rounded-full ${FEED_TONE[feed]}`} aria-hidden="true" />
          {feed === 'live'
            ? 'Live · connected'
            : feed === 'paused'
              ? 'Live updates paused'
              : 'Finished · not live'}
        </span>
      }
    >
      <ol aria-live="polite" className="flex flex-col gap-0 sm:flex-row sm:gap-4">
        {steps.map((step, index) => (
          <li
            key={step.key}
            aria-current={step.state === 'current' ? 'step' : undefined}
            className="flex min-w-0 flex-1 items-start gap-3 sm:flex-col sm:gap-2"
          >
            <span className="flex flex-col items-center sm:w-full sm:flex-row" aria-hidden="true">
              <i
                className={`block h-3.5 w-3.5 shrink-0 rounded-full border-2 ${STEP_DOT[step.state]}`}
              />
              {index < steps.length - 1 && (
                <b
                  className={`block h-6 w-0.5 sm:h-0.5 sm:w-full ${step.state === 'done' ? 'bg-tp-primary' : 'bg-tp-hairline'}`}
                />
              )}
            </span>
            <span className="min-w-0">
              <strong className="block text-sm font-semibold text-tp-ink">{step.label}</strong>
              <span className="block text-xs text-tp-steel">{step.when}</span>
            </span>
          </li>
        ))}
      </ol>
      <span className="block text-xs text-tp-steel">
        Live updates report status changes only; there’s no progress percentage to show.
      </span>
    </RunCard>
  );
}

/** What was asked for and what the run used, with the plan’s reductions named instead of hidden. */
export function Settings({ provenance }: { provenance: Record<string, unknown> }) {
  const rows = optionRows(provenance);
  const pins = readPins(provenance);
  return (
    <RunCard id="run-settings" title="Settings: asked vs used">
      {pins.configuration && (
        <span className="block text-sm text-tp-slate">
          Run with the sealed settings <Chip mono>{pins.configuration}</Chip>; the engine, mode and
          options come from them.
        </span>
      )}
      {rows.length > 0 ? (
        <DataTable label="Settings asked and used" minWidth={520}>
          <thead>
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">Asked</th>
              <th scope="col">Used</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.key}>
                <td>{row.label}</td>
                <td>{row.asked}</td>
                <td>
                  <strong>{row.used}</strong>
                </td>
                <td>
                  {row.reduced ? <Chip tone="warning">Reduced to the plan’s ceiling</Chip> : null}
                  {row.note && <span className="block text-xs text-tp-steel">{row.note}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      ) : (
        !pins.configuration && (
          <span className="block text-sm text-tp-steel">
            The run asked for no setting of its own; the engine ran with its defaults.
          </span>
        )
      )}
    </RunCard>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      data-fact
      className="min-w-0 rounded-lg border border-tp-hairline-soft bg-tp-surface/40 p-3"
    >
      <div className="text-[11px] font-medium text-tp-steel">{label}</div>
      <div className="mt-0.5 text-sm [overflow-wrap:anywhere] text-tp-ink">{children}</div>
    </div>
  );
}

const linkClass = 'cursor-pointer text-tp-accent hover:underline';

interface ProvenanceProps {
  provenance: Record<string, unknown>;
  compilation: JobCompilationRef | null;
  origin: Origin | null;
  /** The organization the run belongs to. */
  org: string;
  created?: string | null;
  retryOf?: string | null;
}

/** Where this result comes from: the problem version and compilation it ran, the engine and the checker. */
export function Provenance({
  provenance,
  compilation,
  origin,
  org,
  created,
  retryOf,
}: ProvenanceProps) {
  const pins = readPins(provenance);
  const { copy, status } = useCopy();
  const digest = (value: string | null, key: string, label: string) =>
    value && (
      <button
        type="button"
        className="cursor-pointer text-xs font-medium text-tp-accent hover:underline"
        onClick={() => void copy(value, key)}
        aria-label={`Copy ${label} digest`}
      >
        {status(key) === 'copied'
          ? 'Copied'
          : status(key) === 'failed'
            ? 'Copy failed'
            : 'Copy digest'}
      </button>
    );
  return (
    <RunCard id="run-provenance" title="Where this result comes from">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Problem version">
          {origin ? (
            <Link
              to={problemPath(origin.org, origin.caseSlug, undefined, { version: origin.revision })}
              className={linkClass}
            >
              {origin.caseName} · version {origin.revision}
            </Link>
          ) : (
            'Not recorded'
          )}
        </Fact>
        <Fact label="Compilation">
          {compilation && origin ? (
            <>
              <Link
                to={problemPath(origin.org, origin.caseSlug, 'source', {
                  version: origin.revision,
                })}
                className={linkClass}
              >
                Source and compiled form
              </Link>{' '}
              {digest(compilation.compilation_digest, 'compilation', 'compilation')}
            </>
          ) : (
            '—'
          )}
        </Fact>
        <Fact label="Compiled problem">
          {digest(pins.compiledForm, 'ir', 'compiled problem') || '—'}
        </Fact>
        <Fact label="Instance">{digest(pins.instance, 'instance', 'instance') || '—'}</Fact>
        <Fact label="Engine">
          {pinText(pins.engine) ?? '—'}
          {pins.mode ? ` · mode ${pins.mode}` : ''}
          {pins.engine?.digest && <> {digest(pins.engine.digest, 'engine', 'engine')}</>}
        </Fact>
        <Fact label="Deployment">{pinText(pins.registration) ?? 'Built-in pool'}</Fact>
        {pins.preset && (
          <Fact label="Run preset">
            <Link to={orgPath(org, 'presets')} className={linkClass}>
              {pins.preset.slug}
            </Link>{' '}
            <span className="text-xs text-tp-steel">
              its settings were copied when the run started
            </span>
          </Fact>
        )}
        <Fact label="Checked by">{pins.checkedBy ?? 'bim-reference-evaluator'}</Fact>
        <Fact label="Limits applied">
          {pins.limits.length ? pins.limits.join(' · ') : 'Plan defaults'}
        </Fact>
        {created && <Fact label="Sent">{formatDateTime(created) ?? '—'}</Fact>}
        {retryOf && (
          <Fact label="Retry of">
            <Link to={runPath(org, retryOf)} className={linkClass}>
              Earlier run
            </Link>
          </Fact>
        )}
      </div>
    </RunCard>
  );
}
