import { useState } from 'react';
import { ChevronDown, Loader2, WifiOff } from 'lucide-react';
import {
  checkGateway, type Dependency, type DependencyState, type GatewayStatus, type ProbeResult,
} from '../../api/health';
import { Button } from '../../components/ui/Button';
import { Notice } from '../../components/ui/Notice';
import { PageHeader } from '../../components/ui/PageHeader';
import { useCopy } from '../../components/ui/useCopy';
import { useResource } from '../../utils/useResource';
import './Status.css';

type Tone = 'ok' | 'warn' | 'bad' | 'idle';
type Overall = 'operational' | 'degraded' | 'outage';

const OVERALL: Record<Overall, { title: string; tone: Tone }> = {
  operational: { title: 'All systems operational', tone: 'ok' },
  degraded: { title: 'Degraded', tone: 'warn' },
  outage: { title: 'Gateway reporting errors', tone: 'bad' },
};

const GUIDE = [
  'If the pricing dependency is degraded, metered actions such as launching a job or a study run may answer 503. Running jobs aren’t stopped, because plan ceilings are cached.',
  'A 503 never means your quota is used up. Your usage page says “can’t check right now” instead of showing a number.',
  'If accounts are down, sign-in and every private page answer 503 (accounts_unavailable). Public pages and validation keep working.',
  'Retry manually; nothing is retried automatically for you.',
] as const;

const DEPENDENCY_IMPACT: Record<string, string> = {
  database: 'Accounts, organizations, projects and jobs. If it fails, sign-in and private pages answer 503.',
  redis: 'The job queue. It is only needed when the gateway dispatches jobs through the queue; without it, new jobs cannot be started.',
  sphere: 'The pricing source that publishes the plan document. If it fails, the plan catalogue can go stale.',
  space: 'Quotas and plan checks for metered actions. If it fails, metered actions may answer 503 pricing_unavailable; nothing says your quota is used up.',
};

const PROBE_LABEL: Record<ProbeResult['name'], string> = { health: 'Gateway up', live: 'Live', ready: 'Ready' };

const TONE_FOR_STATE: Record<DependencyState, Tone> = { ok: 'ok', inactive: 'idle', down: 'bad', unknown: 'idle' };

function words(value: string) {
  return value.replace(/[-_]+/g, ' ');
}

function impactOf(dependency: Dependency): string {
  const base = DEPENDENCY_IMPACT[dependency.name] ?? 'Required by the gateway to answer requests.';
  if (dependency.state === 'inactive') return `Not in use on this deployment. ${base}`;
  if (dependency.state === 'unknown') return `The gateway reported “${dependency.value}”, which this page does not recognise. ${base}`;
  return base;
}

/** Nothing answered at all, as opposed to the gateway answering that something is wrong. */
function isUnreachable(status: GatewayStatus): boolean {
  return !Object.values(status.probes).some((probe) => probe.reached);
}

function overallOf(status: GatewayStatus): Overall {
  const { health, live, ready } = status.probes;
  if (!health.ok || !live.ok) return 'outage';
  if (!ready.ok || status.dependencies.some((dependency) => dependency.state === 'down')) return 'degraded';
  return 'operational';
}

function failing(status: GatewayStatus): string[] {
  return status.dependencies.filter((dependency) => dependency.state === 'down').map((dependency) => dependency.name);
}

function probeValue(probe: ProbeResult): { value: string; tone: Tone } {
  if (!probe.reached) return { value: 'unreachable', tone: 'bad' };
  if (probe.ok) return { value: 'ok', tone: 'ok' };
  // Readiness answers 503 while a required dependency is down: the gateway is up, so this is degradation.
  if (probe.name === 'ready' && probe.status === 503) return { value: 'degraded', tone: 'warn' };
  return { value: `HTTP ${probe.status}`, tone: 'bad' };
}

function overallText(status: GatewayStatus, overall: Overall): string {
  const down = failing(status);
  if (overall === 'operational') return 'The gateway and every required dependency answered.';
  if (overall === 'degraded') {
    return down.length
      ? `The gateway is up, but ${down.join(' and ')} ${down.length === 1 ? 'is' : 'are'} unavailable. Public pages and validation keep working.`
      : 'The gateway is up but reports that it is not ready to serve every request.';
  }
  const { health, live } = status.probes;
  const bad = [health, live].filter((probe) => !probe.ok).map((probe) => probe.request).join(' and ');
  return `${bad} did not answer successfully. Pages that rely on the gateway may fail.`;
}

function clock(date: Date): string {
  return `${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} (your local time)`;
}

function summaryOf(status: GatewayStatus, title: string): string {
  const { health, live, ready } = status.probes;
  const down = failing(status);
  const readyText = probeValue(ready).value + (down.length ? ` (${down.join(', ')})` : '');
  return `OpenBinding status: ${title}. health ${probeValue(health).value}, live ${probeValue(live).value}, ready ${readyText}. Checked ${clock(status.checkedAt)}`;
}

export function Status() {
  const gateway = useResource('gateway', checkGateway);
  const [guideOpen, setGuideOpen] = useState(false);
  const { copy, status: copyStatus } = useCopy();

  const loading = gateway.status === 'loading';
  const result = gateway.data;
  const unreachable = result ? isUnreachable(result) : false;
  const overall = result && !unreachable ? overallOf(result) : null;
  const title = overall ? OVERALL[overall].title : 'No connection with the gateway';
  const copyState = copyStatus();

  return (
    <div className="status-page">
      <PageHeader
        eyebrow="Status"
        title="Service status"
        lede="Live checks of the gateway and the dependencies it needs. No internal details are exposed."
        actions={(
          <>
            <Button size="sm" onClick={gateway.reload} disabled={loading}>Check again</Button>
            <Button size="sm" variant="secondary" disabled={!result} onClick={() => result && void copy(summaryOf(result, title))}>
              {copyState === 'copied' ? 'Summary copied' : copyState === 'failed' ? 'Could not copy' : 'Copy summary'}
            </Button>
          </>
        )}
      />

      <div className="status-body" aria-live="polite" aria-busy={loading}>
        {loading && (
          <div className="status-checking">
            <Loader2 className="status-spinner" aria-hidden="true" />
            <strong>Checking the gateway and its dependencies…</strong>
          </div>
        )}

        {!loading && result && unreachable && (
          <div className="status-unreachable" role="alert">
            <WifiOff aria-hidden="true" />
            <div>
              <strong>No connection with the gateway</strong>
              <span>
                Your browser couldn’t reach OpenBinding at all, so we can’t tell whether any dependency is down.
                This is different from a dependency failing: check your connection, then check again.
              </span>
              <small>Last attempt {clock(result.checkedAt)}</small>
            </div>
          </div>
        )}

        {!loading && result && overall && (
          <>
            <div className={`status-overall is-${OVERALL[overall].tone}`}>
              <i aria-hidden="true" />
              <div>
                <h2>{title}</h2>
                <p>{overallText(result, overall)}</p>
              </div>
              <small>Checked {clock(result.checkedAt)}</small>
            </div>

            <ul className="status-probes" aria-label="Probes">
              {Object.values(result.probes).map((probe) => {
                const { value, tone } = probeValue(probe);
                return (
                  <li key={probe.name} className="status-probe">
                    <span className="status-probe-label"><i className={`is-${tone}`} aria-hidden="true" />{PROBE_LABEL[probe.name]}</span>
                    <strong>{value}</strong>
                    <code>{probe.request}</code>
                    {probe.ms !== null && <small>{probe.ms} ms</small>}
                  </li>
                );
              })}
            </ul>

            <section aria-labelledby="status-deps-title" className="status-deps">
              <h2 id="status-deps-title">Required dependencies</h2>
              {result.dependencies.length ? (
                <ul className="status-dep-list">
                  {result.dependencies.map((dependency) => (
                    <li key={dependency.name}>
                      <span className="status-dep-name"><i className={`is-${TONE_FOR_STATE[dependency.state]}`} aria-hidden="true" /><code>{dependency.name}</code></span>
                      <strong>{words(dependency.value)}</strong>
                      <span className="status-dep-impact">{impactOf(dependency)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <Notice tone="info">
                  The readiness answer did not list its dependencies, so only the three probes above can be reported.
                </Notice>
              )}
              <small>Dependency names come from the readiness response, whose exact shape is indicative.</small>
            </section>
          </>
        )}
      </div>

      <section className="status-guide">
        <h2>
          <button type="button" aria-expanded={guideOpen} aria-controls="status-guide-list" onClick={() => setGuideOpen((open) => !open)}>
            What to do during an incident
            <ChevronDown aria-hidden="true" className={guideOpen ? 'is-open' : undefined} />
          </button>
        </h2>
        {guideOpen && (
          <ul id="status-guide-list">
            {GUIDE.map((item) => <li key={item}>{item}</li>)}
          </ul>
        )}
      </section>
    </div>
  );
}
