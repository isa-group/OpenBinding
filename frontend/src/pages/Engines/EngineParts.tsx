import { useMemo, type ReactNode } from 'react';
import { Check, Minus, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { DataTable } from '../../components/ui/DataTable';
import { formatDateTime } from '../../utils/format';
import { dimensionLabel, readManifest, valueLabel, type CapabilityRow, type ModeView } from './manifestModel';
import type { Allowance, ChipTone, Probe } from './registrationModel';
import { probeSummary } from './registrationModel';
import './EngineParts.css';

interface Crumb {
  label: string;
  to?: string;
  mono?: boolean;
}

/** Where this screen sits: every crumb but the last links back. */
export function Crumbs({ items }: { items: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="eng-crumbs">
      {items.map((item, index) => {
        const last = index === items.length - 1;
        return (
          <span key={`${item.label}-${index}`} className="eng-crumb">
            {item.to && !last
              ? <Link to={item.to} viewTransition className={item.mono ? 'is-mono' : undefined}>{item.label}</Link>
              : <span className={item.mono ? 'is-mono' : undefined} aria-current={last ? 'page' : undefined}>{item.label}</span>}
            {!last && <span aria-hidden="true">/</span>}
          </span>
        );
      })}
    </nav>
  );
}

/** A small rounded status label: the prototype's chips for use, publication and conformance. */
export function StatusChip({ tone = 'plain', children }: { tone?: ChipTone; children: ReactNode }) {
  return <span className={`eng-chip is-${tone}`}>{children}</span>;
}

/** JSON or YAML as written, folded away: the readable views are the way in, this is for people who want the bytes. */
export function ViewSource({ value, label = 'View source' }: { value: unknown; label?: string }) {
  const source = useMemo(() => JSON.stringify(value, null, 2) ?? '', [value]);
  return (
    <details className="eng-source">
      <summary>{label}</summary>
      <pre tabIndex={0} aria-label={`${label} (JSON)`}><code>{source}</code></pre>
    </details>
  );
}

function seconds(durationMs: number): string {
  return durationMs >= 1000 ? `${(durationMs / 1000).toFixed(2)} s` : `${Math.round(durationMs)} ms`;
}

const GLYPH = { passed: Check, failed: X, pending: Minus } as const;

interface ChecklistProps {
  probe: Probe;
  /** What the banner says when the probe failed. */
  failedText?: string;
  /** What the banner says when it has not run. */
  pendingText?: string;
}

/** The conformance probe as a list of checks, each with its own outcome: never the report's JSON. */
export function ConformanceChecklist({ probe, failedText = 'A check failed. Nothing was activated.', pendingText = 'The deployment has not been checked yet. Activating it runs the check.' }: ChecklistProps) {
  const summary = probeSummary(probe);
  const title = probe.verdict === 'verified' ? 'Verified' : probe.verdict === 'failed' ? 'Failed' : 'Not checked yet';
  const text = probe.verdict === 'verified' ? 'Your deployment speaks bim-engine/v1.' : probe.verdict === 'failed' ? failedText : pendingText;
  const verified = formatDateTime(probe.verifiedAt);
  const meta = [probe.durationMs !== null ? seconds(probe.durationMs) : null, verified ? `verified ${verified}` : null].filter(Boolean).join(' · ');
  const Glyph = probe.verdict === 'verified' ? Check : probe.verdict === 'failed' ? X : Minus;
  return (
    <div className="eng-probe">
      <div className={`eng-probe-banner is-${summary.tone}`}>
        <span className="eng-probe-ring" aria-hidden="true"><Glyph /></span>
        <span className="eng-probe-copy">
          <strong>{title}</strong>
          <span>{text}</span>
        </span>
        {meta && <span className="eng-probe-meta">{meta}</span>}
      </div>
      {probe.checks.length > 0 && (
        <ul className="eng-checks" aria-label="Conformance checks">
          {probe.checks.map((check, index) => {
            const Icon = GLYPH[check.state];
            return (
              <li key={`${check.id}-${index}`} className={`is-${check.state}`}>
                <span className="eng-check-glyph" aria-hidden="true"><Icon /></span>
                <span className="eng-check-copy">
                  <strong>{check.label}</strong>
                  {check.detail && <span>{check.detail}</span>}
                </span>
                <span className="eng-check-state">{check.state === 'passed' ? 'Passed' : check.state === 'failed' ? 'Failed' : 'Pending'}</span>
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
  /** `slots` draws one block per engine the plan allows (up to 20); `bar` one continuous bar. */
  variant?: 'bar' | 'slots';
  note?: ReactNode;
}

export function PlanMeter({ allowance, loading = false, variant = 'bar', note }: MeterProps) {
  if (loading) return <div className="eng-meter is-loading" aria-hidden="true" />;
  if (!allowance) {
    return (
      <div className="eng-meter" role="group" aria-label="Federated engines">
        <span className="eng-meter-head"><strong>Federated engines</strong><span>Not reported</span></span>
        <span className="eng-meter-note">Your plan’s room for federated engines couldn’t be read. The gateway still enforces it when you register.</span>
      </div>
    );
  }
  const { used, limit, plan } = allowance;
  const full = limit !== null && used >= limit;
  const percent = limit === null || limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
  const slots = limit === null ? 0 : Math.min(limit, 20);
  return (
    <div className={`eng-meter${full ? ' is-full' : ''}`} role="group" aria-label="Federated engines">
      <span className="eng-meter-head">
        <strong>Federated engines</strong>
        <span>{limit === null ? `${used} in use · no limit` : `${used} of ${limit} used`}</span>
      </span>
      {limit !== null && variant === 'bar' && (
        <span className="eng-meter-bar" role="progressbar" aria-label="Federated engines used" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.min(used, limit)}>
          <span style={{ width: `${percent}%` }} />
        </span>
      )}
      {limit !== null && variant === 'slots' && (
        <span className="eng-meter-slots" aria-hidden="true">
          {Array.from({ length: slots }, (_, index) => <span key={index} className={index < used ? 'is-used' : undefined} />)}
        </span>
      )}
      <span className="eng-meter-note">{note ?? `${plan} plan · limit from the live pricing`}{full ? ' · Limit reached' : ''}</span>
    </div>
  );
}

// -- A manifest, laid out ---------------------------------------------------------------------

function CapabilityValue({ row }: { row: CapabilityRow }) {
  if (row.selector === 'none') return <StatusChip>Nothing</StatusChip>;
  if (row.selector === 'all') return <StatusChip tone="info">Everything the profile defines</StatusChip>;
  if (row.selector === 'unknown') return <span className="eng-muted">Not readable</span>;
  return (
    <span className="eng-values">
      {row.values.map((value) => <span key={value} className="eng-value">{valueLabel(row.id, value)}</span>)}
    </span>
  );
}

function FeatureValues({ mode }: { mode: ModeView }) {
  const { featureValues } = mode;
  if (!featureValues.declared) return null;
  return (
    <section className="eng-features" aria-label={`Feature values of mode ${mode.id}`}>
      <h4>{dimensionLabel('featureValues')}</h4>
      <div className="eng-feature-tiles">
        <div className={featureValues.scalar ? 'is-on' : 'is-off'}>
          <span aria-hidden="true">{featureValues.scalar ? <Check /> : <X />}</span>
          <strong>Scalar</strong>
          <small>Single numbers · {featureValues.scalar ? 'accepted' : 'not accepted'}</small>
        </div>
        <div className={featureValues.interval ? 'is-on' : 'is-off'}>
          <span aria-hidden="true">{featureValues.interval ? <Check /> : <X />}</span>
          <strong>Interval</strong>
          <small>Ranges, min–max · {featureValues.interval ? 'accepted' : 'not accepted'}</small>
        </div>
      </div>
      <small className="eng-muted">
        Ranges are part of the BIM syntax and a manifest may declare them. The bundled engines accept scalar values only, so a job whose
        candidates carry an interval fails with <code>unsupported_capability_value</code> unless the mode declares it.
        An interval includes open ranges: a range with an end <code>null</code> (no lower or no upper limit, such as ≤ 200 or ≥ 100) counts as an interval, and so does one with no limits at all.
        An engine that declares it must read <code>null</code> as infinity, never as 0.
      </small>
    </section>
  );
}

function ModePanel({ mode }: { mode: ModeView }) {
  return (
    <section className="eng-mode" aria-label={`Mode ${mode.id}`}>
      <header>
        <h3>Mode · <code>{mode.id}</code></h3>
        <span className="eng-mode-chips">
          <StatusChip>{mode.algorithm}</StatusChip>
          <StatusChip tone={mode.exact ? 'success' : 'warning'}>{mode.exact ? 'Exact' : 'Heuristic'}</StatusChip>
        </span>
      </header>
      <dl className="eng-facts">
        <div><dt>Profile</dt><dd className="is-mono">{mode.profile}</dd></div>
        <div><dt>Reads problems as</dt><dd className="is-mono">{mode.ir}</dd></div>
        <div><dt>Algorithm</dt><dd>{mode.algorithm}</dd></div>
        <div><dt>Guarantee</dt><dd>{mode.exact ? 'Exact: when it says optimal, it is' : 'No proof of optimality'}{mode.flags.length ? ` · ${mode.flags.join(', ').toLowerCase()}` : ''}</dd></div>
      </dl>

      <h4>Capabilities</h4>
      {mode.capabilities.length === 0 ? <p className="eng-muted">This mode declares no capabilities.</p> : (
        <ul className="eng-caps" aria-label={`Capabilities of mode ${mode.id}`}>
          {mode.capabilities.map((row) => (
            <li key={row.id}>
              <span>{row.label}</span>
              <CapabilityValue row={row} />
            </li>
          ))}
        </ul>
      )}
      <FeatureValues mode={mode} />

      {mode.scalarizations.length > 0 && (
        <>
          <h4>Objective scalarizations</h4>
          <DataTable label={`Scalarizations of mode ${mode.id}`} minWidth={440}>
            <thead><tr><th scope="col">Method</th><th scope="col">Objectives</th><th scope="col">Weights</th></tr></thead>
            <tbody>
              {mode.scalarizations.map((row) => (
                <tr key={row.id}><td className="is-mono">{row.id}</td><td>{row.objectives}</td><td>{row.weights}</td></tr>
              ))}
            </tbody>
          </DataTable>
        </>
      )}

      <h4>Options people can set</h4>
      {mode.options.length === 0 ? <p className="eng-muted">This mode takes no caller options.</p> : (
        <DataTable label={`Options of mode ${mode.id}`} minWidth={520}>
          <thead><tr><th scope="col">Option</th><th scope="col">Type</th><th scope="col">Range</th><th scope="col">Default</th></tr></thead>
          <tbody>
            {mode.options.map((option) => (
              <tr key={option.name}>
                <td className="is-mono">{option.name}{option.required && <small className="eng-required">required</small>}</td>
                <td>{option.fixed ?? option.type}</td>
                <td>{option.range}</td>
                <td>{option.default}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}

      {mode.limits.length > 0 && (
        <div className="eng-limits">
          <span>Declared ceilings</span>
          {mode.limits.map(([name, value]) => <span key={name} className="eng-value is-mono">{name}: {value.toLocaleString('en-US')}</span>)}
        </div>
      )}
      <div className="eng-limits">
        <span>How a run can end</span>
        {['OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNKNOWN'].map((end) => (
          <span key={end} className={`eng-value is-mono${mode.termination.includes(end) ? ' is-declared' : ' is-muted'}`}>{end}</span>
        ))}
      </div>
    </section>
  );
}

/** An Engine manifest as fields, chips and tables. The document itself is behind “View source”. */
export function ManifestPanel({ document }: { document: unknown }) {
  const view = useMemo(() => readManifest(document), [document]);
  if (!view) {
    return (
      <div className="eng-manifest">
        <p className="eng-muted">The engine manifest couldn’t be read as a bim/v1 Engine.</p>
        <ViewSource value={document} />
      </div>
    );
  }
  return (
    <div className="eng-manifest">
      {view.description && <p className="eng-lede">{view.description}</p>}
      {view.modes.length === 0 && <p className="eng-muted">This manifest declares no modes.</p>}
      {view.modes.map((mode) => <ModePanel key={mode.id} mode={mode} />)}
      {view.extras.length > 0 && <small className="eng-muted">The document also carries {view.extras.join(', ')}; they appear in the source.</small>}
      <ViewSource value={document} />
    </div>
  );
}
