import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Compass } from 'lucide-react';
import type { JobInstanceView } from '../../api/jobs';
import { Chip } from '../../components/ui/Chip';
import { useCopy } from '../../components/ui/useCopy';
import { shortDigest } from '../../utils/digest';
import { formatDateTime } from '../../utils/format';
import type { Origin } from './JobResult';
import { readAdminRouting, readPins, readRouting, timelineOf, optionRows, type ResourcePin } from './jobsModel';

const pinText = (pin: ResourcePin | null): string | null => (pin ? `${pin.namespace ? `${pin.namespace}/` : ''}${pin.name}${pin.version ? ` ${pin.version}` : ''}` : null);

/** Status changes only: the live feed reports snapshots, so there is no progress to draw. */
export function Timeline({ status, created, finished, feed }: { status: string; created?: string | null; finished?: string | null; feed: 'live' | 'finished' | 'paused' }) {
  const steps = timelineOf(status, { created, finished });
  return (
    <section className="job-card" aria-labelledby="job-timeline">
      <div className="job-card-head">
        <h2 id="job-timeline">Timeline</h2>
        <span className={`job-feed is-${feed}`}>
          <span className="job-feed-dot" aria-hidden="true" />
          {feed === 'live' ? 'Live · connected' : feed === 'paused' ? 'Live updates paused' : 'Finished · not live'}
        </span>
      </div>
      <ol className="job-timeline" aria-live="polite">
        {steps.map((step) => (
          <li key={step.key} className={`is-${step.state}`} aria-current={step.state === 'current' ? 'step' : undefined}>
            <span className="job-timeline-track"><i aria-hidden="true" /><b aria-hidden="true" /></span>
            <strong>{step.label}</strong>
            <small>{step.when}</small>
          </li>
        ))}
      </ol>
      <p className="org-muted">Live updates report status changes only; there’s no progress percentage to show.</p>
    </section>
  );
}

/** What was asked for and what the run used, with the plan’s reductions named instead of hidden. */
export function Settings({ provenance }: { provenance: Record<string, unknown> }) {
  const rows = optionRows(provenance);
  const pins = readPins(provenance);
  if (rows.length === 0 && !pins.configuration) return null;
  return (
    <section className="job-card" aria-labelledby="job-settings">
      <h2 id="job-settings">Settings: asked vs used</h2>
      {pins.configuration && (
        <p className="org-muted">Run with the sealed settings <Chip mono>{pins.configuration}</Chip>; the engine, mode and options come from them.</p>
      )}
      {rows.length > 0 && (
        <div className="job-table" role="region" aria-label="Settings asked and used" tabIndex={0}>
          <table>
            <thead><tr><th scope="col">Setting</th><th scope="col">Asked</th><th scope="col">Used</th><th scope="col">Note</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <td>{row.label}</td>
                  <td>{row.asked}</td>
                  <td><strong>{row.used}</strong></td>
                  <td>{row.reduced ? <Chip tone="warning">Reduced to the plan’s ceiling</Chip> : null}{row.note && <small className="org-muted job-note">{row.note}</small>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** What the AutoRouter chose and why; the diagnostic telemetry only appears on an administrator’s own runs. */
export function Routing({ provenance }: { provenance: Record<string, unknown> }) {
  const decision = readRouting(provenance);
  const admin = readAdminRouting(provenance);
  if (!decision) return null;
  return (
    <section className="job-card is-routing" aria-labelledby="job-routing">
      <div className="job-card-head">
        <h2 id="job-routing"><Compass aria-hidden="true" className="job-icon" />AutoRouter decision</h2>
        <span className="job-chips">
          <Chip tone="accent">{decision.engine} · {decision.mode}</Chip>
          {decision.fallback && <Chip tone="warning">Fallback activated</Chip>}
        </span>
      </div>
      <p>{decision.reason || 'The AutoRouter did not say why.'}</p>
      <p className="org-muted">
        {decision.utility !== null ? `Utility ${decision.utility.toFixed(3)}` : 'Utility not reported'}
        {' · '}
        {decision.credits !== null ? `Cost ${decision.credits} CU` : 'Cost 1 CU'}
      </p>
      {admin && (
        <details className="job-source" open>
          <summary>Routing diagnostics (administrators, own runs)</summary>
          <dl className="job-facts">
            {admin.loop && <div><dt>Adaptation loop</dt><dd><code>{admin.loop}</code></dd></div>}
            {admin.workload.length > 0 && <div><dt>Workload</dt><dd>{admin.workload.map(([key, value]) => `${key} ${value}`).join(' · ')}</dd></div>}
          </dl>
          {admin.candidates.length > 0 && (
            <div className="job-table" role="region" aria-label="Candidate engines considered" tabIndex={0}>
              <table>
                <thead><tr><th scope="col">Engine</th><th scope="col">Admissible</th><th scope="col">Utility</th><th scope="col">Rejected because</th></tr></thead>
                <tbody>
                  {admin.candidates.map((candidate) => (
                    <tr key={candidate.engine}>
                      <td><code>{candidate.engine}</code></td>
                      <td>{candidate.admissible ? 'Yes' : 'No'}</td>
                      <td>{candidate.utility !== null ? candidate.utility.toFixed(3) : '—'}</td>
                      <td>{candidate.rejection ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </details>
      )}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="job-fact"><div>{label}</div><div>{children}</div></div>;
}

interface ProvenanceProps {
  provenance: Record<string, unknown>;
  instance: JobInstanceView | null;
  origin: Origin | null;
  root: string;
  created?: string | null;
  retryOf?: string | null;
  actions: ReactNode;
}

/** Where this result comes from: the compiled problem, the engine, the checker, the snapshot and the case revision it used. */
export function Provenance({ provenance, instance, origin, root, created, retryOf, actions }: ProvenanceProps) {
  const pins = readPins(provenance);
  const { copy, status } = useCopy();
  const digest = (value: string | null, key: string, label: string) => value && (
    <span className="job-digest">
      <code title={value}>{shortDigest(value)}</code>
      <button type="button" className="job-link-button" onClick={() => void copy(value, key)} aria-label={`Copy ${label} fingerprint`}>
        {status(key) === 'copied' ? 'Copied' : status(key) === 'failed' ? 'Copy failed' : 'Copy'}
      </button>
    </span>
  );
  return (
    <section className="job-card" aria-labelledby="job-provenance">
      <h2 id="job-provenance">Where this result comes from</h2>
      <div className="job-facts-grid">
        <Fact label="Snapshot used">
          {instance ? <Link to={`${root}/snapshots/${encodeURIComponent(instance.id)}`} viewTransition>Snapshot {instance.id.slice(0, 8)}…</Link> : 'Not kept for this run'}
        </Fact>
        <Fact label="Case revision">
          {origin
            ? <Link to={`${root}/cases/${encodeURIComponent(origin.caseSlug)}/revisions/${origin.revision}`} viewTransition>{origin.caseName} · revision {origin.revision}</Link>
            : 'Not from a revision of this project'}
        </Fact>
        <Fact label="Compiled problem">{digest(pins.compiledForm, 'ir', 'compiled problem') || '—'}</Fact>
        <Fact label="Instance">{digest(instance?.instanceDigest ?? pins.instance, 'instance', 'instance') || '—'}</Fact>
        <Fact label="Engine">
          {pinText(pins.engine) ?? '—'}{pins.mode ? ` · mode ${pins.mode}` : ''}
          {pins.engine?.digest && <> {digest(pins.engine.digest, 'engine', 'engine')}</>}
        </Fact>
        <Fact label="Deployment">{pinText(pins.registration) ?? 'Built-in pool'}</Fact>
        <Fact label="Checked by">{pins.checkedBy ?? 'bim-reference-evaluator'}</Fact>
        <Fact label="Limits applied">{pins.limits.length ? pins.limits.join(' · ') : 'Plan defaults'}</Fact>
        {created && <Fact label="Sent">{formatDateTime(created) ?? '—'}</Fact>}
        {retryOf && <Fact label="Retry of"><Link to={`${root}/jobs/${retryOf}`} viewTransition>{retryOf.slice(0, 8)}…</Link></Fact>}
      </div>
      <span className="job-buttons">{actions}</span>
    </section>
  );
}
