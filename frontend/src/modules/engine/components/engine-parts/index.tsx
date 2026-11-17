// The small pieces every engine screen shares: the status pill, a copy button that says what it copies, the folded source
// view, the conformance checklist, the plan's room for federated engines and a manifest laid out as fields. Drawn with the
// theme's tokens (SPHERE's pill, card and meter recipes); the administration screens borrow the breadcrumb and the checklist.

import { useMemo, useState, type ReactNode } from 'react';
import { MdCheck, MdClose, MdRemove } from 'react-icons/md';
import { Link } from 'react-router-dom';
import { SourceView } from '../../../../components/rendering/SourceView';
import { DataTable } from '../../../core/components/data-table';
import { TabBar, TabPanel } from '../../../core/components/tab-bar';
import { useCopy } from '../../../core/hooks/useCopy';
import { formatDateTime } from '../../../../utils/format';
import {
  dimensionLabel,
  readManifest,
  valueLabel,
  type CapabilityRow,
  type ModeView,
} from '../../api/manifestModel';
import type { Allowance, ChipTone, Probe } from '../../api/registrationModel';
import { probeSummary } from '../../api/registrationModel';

import { MUTED } from './styles';

interface Crumb {
  label: string;
  to?: string;
  mono?: boolean;
}

/** Where this screen sits: every crumb but the last links back (SPHERE's `text-xs` breadcrumb). */
export function Crumbs({ items }: { items: Crumb[] }) {
  return (
    <nav
      aria-label="Breadcrumb"
      className="mb-2 flex flex-wrap items-center gap-2 text-xs text-tp-steel"
    >
      {items.map((item, index) => {
        const last = index === items.length - 1;
        const mono = item.mono ? 'font-mono' : '';
        return (
          <span key={`${item.label}-${index}`} className="flex min-w-0 items-center gap-2">
            {item.to && !last ? (
              <Link
                to={item.to}
                viewTransition
                className={`cursor-pointer truncate hover:text-tp-ink ${mono}`}
              >
                {item.label}
              </Link>
            ) : (
              <span
                className={`truncate text-tp-ink ${mono}`}
                aria-current={last ? 'page' : undefined}
              >
                {item.label}
              </span>
            )}
            {!last && <span aria-hidden="true">/</span>}
          </span>
        );
      })}
    </nav>
  );
}

const TONES: Record<ChipTone, string> = {
  plain: 'bg-tp-surface text-tp-slate',
  info: 'bg-tp-severity-info-bg text-tp-info-text',
  success: 'bg-tp-severity-success-bg text-tp-success-text',
  warning: 'bg-tp-severity-warning-bg text-tp-warning-text',
  error: 'bg-tp-severity-error-bg text-tp-error-text',
};

/** SPHERE's status pill (`rounded-full text-[10px]`) in one of the five tones. */
export function StatusChip({ tone = 'plain', children }: { tone?: ChipTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** Copies a value without showing it: the button says in words what it copies. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const { copy, status } = useCopy();
  const state = status();
  return (
    <button
      type="button"
      className="cursor-pointer text-xs font-medium text-tp-link hover:underline"
      aria-label={`Copy ${label}`}
      onClick={() => void copy(value)}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : `Copy ${label}`}
    </button>
  );
}

/** JSON or YAML as written, folded away: the readable views are the way in, this is for people who want the bytes. */
export function ViewSource({
  value,
  label = 'View source',
  sourceLabel,
  filename,
}: {
  value: unknown;
  /** The disclosure’s summary. */
  label?: string;
  /** What the document is, as the source view names it; defaults to the summary. */
  sourceLabel?: string;
  /** Offers a Download button that saves the document under this name. */
  filename?: string;
}) {
  const name = sourceLabel ?? (label === 'View source' ? 'Source document' : label);
  return (
    <details className="group rounded-xl border border-tp-hairline-soft">
      <summary className="cursor-pointer px-3.5 py-2.5 text-sm font-medium text-tp-ink">
        {label}
      </summary>
      <div className="px-3.5 pb-3">
        <SourceView
          source={sourceOf(value)}
          label={name}
          language="json"
          filename={filename}
          maxHeight="22rem"
        />
      </div>
    </details>
  );
}

/** SourceView takes a string or an object: a primitive is shown as written, a missing value as empty. */
function sourceOf(value: unknown): string | object {
  if (typeof value === 'object' && value !== null) return value;
  return value === undefined ? '' : String(value);
}

function seconds(durationMs: number): string {
  return durationMs >= 1000
    ? `${(durationMs / 1000).toFixed(2)} s`
    : `${Math.round(durationMs)} ms`;
}

const GLYPH = { passed: MdCheck, failed: MdClose, pending: MdRemove } as const;

const BANNER: Record<ChipTone, string> = {
  plain: 'border-tp-hairline bg-tp-surface text-tp-ink',
  info: 'border-tp-severity-info-border bg-tp-severity-info-bg text-tp-info-text',
  success: 'border-tp-severity-success-border bg-tp-severity-success-bg text-tp-success-text',
  warning: 'border-tp-severity-warning-border bg-tp-severity-warning-bg text-tp-warning-text',
  error: 'border-tp-severity-error-border bg-tp-severity-error-bg text-tp-error-text',
};

const CHECK_TONE = {
  passed: 'text-tp-success-text',
  failed: 'text-tp-error-text',
  pending: 'text-tp-steel',
} as const;

interface ChecklistProps {
  probe: Probe;
  /** What the banner says when the probe failed. */
  failedText?: string;
  /** What the banner says when it has not run. */
  pendingText?: string;
}

/** The conformance probe as a list of checks, each with its own outcome: never the report's JSON. */
export function ConformanceChecklist({
  probe,
  failedText = 'A check failed. Nothing was activated.',
  pendingText = 'The deployment has not been checked yet. Activating it runs the check.',
}: ChecklistProps) {
  const summary = probeSummary(probe);
  const title =
    probe.verdict === 'verified'
      ? 'Verified'
      : probe.verdict === 'failed'
        ? 'Failed'
        : 'Not checked yet';
  const text =
    probe.verdict === 'verified'
      ? 'Your deployment speaks bim-engine/v1.'
      : probe.verdict === 'failed'
        ? failedText
        : pendingText;
  const verified = formatDateTime(probe.verifiedAt);
  const meta = [
    probe.durationMs !== null ? seconds(probe.durationMs) : null,
    verified ? `verified ${verified}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const Glyph = GLYPH[probe.verdict === 'verified' ? 'passed' : probe.verdict];
  return (
    <div className="flex flex-col gap-2">
      <div
        className={`flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5 text-sm ${BANNER[summary.tone]}`}
      >
        <span
          className="inline-flex h-7 w-7 flex-none items-center justify-center rounded-full border border-current"
          aria-hidden="true"
        >
          <Glyph className="h-4 w-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <strong className="font-semibold">{title}</strong>
          <span>{text}</span>
        </span>
        {meta && <span className="text-xs">{meta}</span>}
      </div>
      {probe.checks.length > 0 && (
        <ul
          className="flex flex-col divide-y divide-tp-hairline-soft rounded-lg border border-tp-hairline"
          aria-label="Conformance checks"
        >
          {probe.checks.map((check, index) => {
            const Icon = GLYPH[check.state];
            return (
              <li key={`${check.id}-${index}`} className="flex items-start gap-3 px-3 py-2 text-sm">
                <span className={`mt-0.5 flex-none ${CHECK_TONE[check.state]}`} aria-hidden="true">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <strong className="font-medium text-tp-ink">{check.label}</strong>
                  {check.detail && (
                    <span className="text-xs [overflow-wrap:anywhere] text-tp-steel">
                      {check.detail}
                    </span>
                  )}
                </span>
                <span className={`flex-none text-xs font-semibold ${CHECK_TONE[check.state]}`}>
                  {check.state === 'passed'
                    ? 'Passed'
                    : check.state === 'failed'
                      ? 'Failed'
                      : 'Pending'}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// -- The plan's room for federated engines -----------------------------------------------

interface MeterProps {
  allowance: Allowance | null;
  /** `true` while the usage view is still on its way. */
  loading?: boolean;
  note?: ReactNode;
}

/** SPHERE's usage meter (the API keys page's "Active keys" box) for the plan's federated engines. */
export function PlanMeter({ allowance, loading = false, note }: MeterProps) {
  const box = 'rounded-lg border border-tp-hairline bg-tp-canvas p-4';
  if (loading) return <div className={`${box} h-20 animate-pulse`} aria-hidden="true" />;
  if (!allowance) {
    return (
      <div className={box} role="group" aria-label="Federated engines">
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="font-medium text-tp-ink">Federated engines</span>
          <span className="text-tp-steel">Not reported</span>
        </div>
        <p className="mt-2 text-xs text-tp-steel">
          Your plan’s room for federated engines couldn’t be read. The gateway still enforces it
          when you register.
        </p>
      </div>
    );
  }
  const { used, limit, plan } = allowance;
  const full = limit !== null && used >= limit;
  const percent =
    limit === null || limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  return (
    <div className={box} role="group" aria-label="Federated engines">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium text-tp-ink">Federated engines</span>
        <span className="text-tp-steel">
          {limit === null ? `${used} in use · no limit` : `${used} of ${limit} used`}
        </span>
      </div>
      {limit !== null && (
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-tp-hairline"
          role="progressbar"
          aria-label="Federated engines used"
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(used, limit)}
        >
          <div
            className={`h-full rounded-full ${full ? 'bg-amber-500' : 'bg-tp-primary'}`}
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      <p className={`mt-2 text-xs ${full ? 'text-tp-warning-text' : 'text-tp-steel'}`}>
        {note ?? `${plan} plan · limit from the live pricing`}
        {full ? ' · Limit reached' : ''}
      </p>
    </div>
  );
}

// -- A manifest, laid out ---------------------------------------------------------------------

const VALUE = 'inline-flex rounded bg-tp-surface px-1.5 py-0.5 text-[11px] text-tp-ink';
const HEADING = 'mt-2 text-xs font-semibold tracking-wide text-tp-steel uppercase';

function CapabilityValue({ row }: { row: CapabilityRow }) {
  if (row.selector === 'none') return <StatusChip>Nothing</StatusChip>;
  if (row.selector === 'all')
    return <StatusChip tone="info">Everything the profile defines</StatusChip>;
  if (row.selector === 'unknown') return <span className={MUTED}>Not readable</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {row.values.map(value => (
        <span key={value} className={VALUE}>
          {valueLabel(row.id, value)}
        </span>
      ))}
    </span>
  );
}

function FeatureValues({ mode }: { mode: ModeView }) {
  const { featureValues } = mode;
  if (!featureValues.declared) return null;
  const tile = (on: boolean) =>
    `flex flex-col gap-0.5 rounded-lg border p-3 text-sm ${
      on
        ? 'border-tp-severity-success-border bg-tp-severity-success-bg text-tp-success-text'
        : 'border-tp-hairline bg-tp-surface text-tp-steel'
    }`;
  return (
    <section className="flex flex-col gap-2" aria-label={`Feature values of mode ${mode.id}`}>
      <h4 className={HEADING}>{dimensionLabel('featureValues')}</h4>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className={tile(featureValues.scalar)}>
          <span aria-hidden="true">
            {featureValues.scalar ? (
              <MdCheck className="h-4 w-4" />
            ) : (
              <MdClose className="h-4 w-4" />
            )}
          </span>
          <strong>Scalar</strong>
          <small>Single numbers · {featureValues.scalar ? 'accepted' : 'not accepted'}</small>
        </div>
        <div className={tile(featureValues.interval)}>
          <span aria-hidden="true">
            {featureValues.interval ? (
              <MdCheck className="h-4 w-4" />
            ) : (
              <MdClose className="h-4 w-4" />
            )}
          </span>
          <strong>Interval</strong>
          <small>Ranges, min–max · {featureValues.interval ? 'accepted' : 'not accepted'}</small>
        </div>
      </div>
      <small className={MUTED}>
        Ranges are part of the BIM syntax and a manifest may declare them. The bundled engines
        accept scalar values only, so a run whose candidates carry an interval fails with{' '}
        <code>unsupported_capability_value</code> unless the mode declares it. An interval includes
        open ranges: a range with an end <code>null</code> (no lower or no upper limit, such as ≤
        200 or ≥ 100) counts as an interval, and so does one with no limits at all. An engine that
        declares it must read <code>null</code> as infinity, never as 0.
      </small>
    </section>
  );
}

function ModePanel({ mode }: { mode: ModeView }) {
  const fact = 'flex flex-col gap-0.5 rounded-lg bg-tp-surface p-3';
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border border-tp-hairline p-4"
      aria-label={`Mode ${mode.id}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-tp-ink">
          Mode · <code className="font-mono">{mode.id}</code>
        </h3>
        <span className="flex flex-wrap gap-1.5">
          <StatusChip>{mode.algorithm}</StatusChip>
          <StatusChip tone={mode.exact ? 'success' : 'warning'}>
            {mode.exact ? 'Exact' : 'Heuristic'}
          </StatusChip>
        </span>
      </header>
      <dl className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div className={fact}>
          <dt className="text-[11px] text-tp-steel">Profile</dt>
          <dd className="font-mono [overflow-wrap:anywhere] text-tp-ink">{mode.profile}</dd>
        </div>
        <div className={fact}>
          <dt className="text-[11px] text-tp-steel">Reads problems as</dt>
          <dd className="font-mono [overflow-wrap:anywhere] text-tp-ink">{mode.ir}</dd>
        </div>
        <div className={fact}>
          <dt className="text-[11px] text-tp-steel">Algorithm</dt>
          <dd className="text-tp-ink">{mode.algorithm}</dd>
        </div>
        <div className={fact}>
          <dt className="text-[11px] text-tp-steel">Guarantee</dt>
          <dd className="text-tp-ink">
            {mode.exact ? 'Exact: when it says optimal, it is' : 'No proof of optimality'}
            {mode.flags.length ? ` · ${mode.flags.join(', ').toLowerCase()}` : ''}
          </dd>
        </div>
      </dl>

      <h4 className={HEADING}>Capabilities</h4>
      {mode.capabilities.length === 0 ? (
        <p className={MUTED}>This mode declares no capabilities.</p>
      ) : (
        <ul
          className="flex flex-col divide-y divide-tp-hairline-soft rounded-lg border border-tp-hairline"
          aria-label={`Capabilities of mode ${mode.id}`}
        >
          {mode.capabilities.map(row => (
            <li
              key={row.id}
              className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
            >
              <span className="text-tp-slate">{row.label}</span>
              <CapabilityValue row={row} />
            </li>
          ))}
        </ul>
      )}
      <FeatureValues mode={mode} />

      {mode.scalarizations.length > 0 && (
        <>
          <h4 className={HEADING}>Objective scalarizations</h4>
          <DataTable label={`Scalarizations of mode ${mode.id}`} minWidth={440}>
            <thead>
              <tr>
                <th scope="col">Method</th>
                <th scope="col">Objectives</th>
                <th scope="col">Weights</th>
              </tr>
            </thead>
            <tbody>
              {mode.scalarizations.map(row => (
                <tr key={row.id}>
                  <td className="font-mono">{row.id}</td>
                  <td>{row.objectives}</td>
                  <td>{row.weights}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      )}

      <h4 className={HEADING}>Options people can set</h4>
      {mode.options.length === 0 ? (
        <p className={MUTED}>This mode takes no caller options.</p>
      ) : (
        <DataTable label={`Options of mode ${mode.id}`} minWidth={520}>
          <thead>
            <tr>
              <th scope="col">Option</th>
              <th scope="col">Type</th>
              <th scope="col">Range</th>
              <th scope="col">Default</th>
            </tr>
          </thead>
          <tbody>
            {mode.options.map(option => (
              <tr key={option.name}>
                <td className="font-mono">
                  {option.name}
                  {option.required && (
                    <small className="ml-2 font-sans text-[11px] text-tp-warning-text">
                      required
                    </small>
                  )}
                </td>
                <td>{option.fixed ?? option.type}</td>
                <td>{option.range}</td>
                <td>{option.default}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {mode.limits.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-tp-steel">
          <span>Declared ceilings</span>
          {mode.limits.map(([name, value]) => (
            <span key={name} className={`${VALUE} font-mono`}>
              {name}: {value.toLocaleString('en-US')}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-tp-steel">
        <span>How a run can end</span>
        {['OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNKNOWN'].map(end => (
          <span
            key={end}
            className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${
              mode.termination.includes(end)
                ? 'bg-tp-severity-success-bg text-tp-success-text'
                : 'bg-tp-surface text-tp-muted line-through'
            }`}
          >
            {end}
          </span>
        ))}
      </div>
    </section>
  );
}

const MANIFEST_VIEWS = [
  { id: 'manifest', label: 'Manifest' },
  { id: 'source', label: 'Source' },
] as const;

/** An Engine manifest as fields, chips and tables on the Manifest tab; the document itself on the Source tab. */
export function ManifestPanel({ document }: { document: unknown }) {
  const view = useMemo(() => readManifest(document), [document]);
  const [tab, setTab] = useState<string>('manifest');
  return (
    <div className="flex flex-col gap-3">
      <TabBar
        items={MANIFEST_VIEWS}
        value={tab}
        onChange={setTab}
        ariaLabel="Engine manifest views"
        prefix="eng-manifest-view"
      />
      <TabPanel prefix="eng-manifest-view" active={tab}>
        {tab === 'source' ? (
          <SourceView
            source={sourceOf(document)}
            label="Engine manifest source"
            language="json"
            filename="engine.json"
            maxHeight="32rem"
          />
        ) : !view ? (
          <p className={MUTED}>
            The engine manifest couldn’t be read as a bim/v1 Engine. Its document is on the Source
            tab.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {view.description && <p className="text-sm text-tp-slate">{view.description}</p>}
            {view.modes.length === 0 && <p className={MUTED}>This manifest declares no modes.</p>}
            {view.modes.map(mode => (
              <ModePanel key={mode.id} mode={mode} />
            ))}
            {view.extras.length > 0 && (
              <small className={MUTED}>
                The document also carries {view.extras.join(', ')}; they appear on the Source tab.
              </small>
            )}
          </div>
        )}
      </TabPanel>
    </div>
  );
}
