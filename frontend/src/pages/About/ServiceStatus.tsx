import { checkGateway, type GatewayStatus } from '../../api/health';
import { useResource } from '../../utils/useResource';

// [impl->req~frontend-nav-status-retired~1]

/** What the note says about a check. Nothing answering at all is a different thing from the gateway reporting an error. */
function describeGateway(status: GatewayStatus): string {
  const { health, live, ready } = status.probes;
  if (![health, live, ready].some((probe) => probe.reached)) return 'not available right now';
  if (!health.ok || !live.ok) return 'Gateway reporting errors';
  if (!ready.ok || status.dependencies.some((dependency) => dependency.state === 'down')) return 'Degraded';
  return 'All systems operational';
}

/** The one-line note of the gateway check on the About page, which took the place of the status screen. */
export function ServiceStatus() {
  const gateway = useResource('gateway', checkGateway);
  const text = gateway.status === 'loading' ? 'checking…' : gateway.data ? describeGateway(gateway.data) : 'not available right now';
  return (
    <p className="about-service-status" aria-live="polite" aria-busy={gateway.status === 'loading'}>
      {`Service status: ${text}`}
    </p>
  );
}
