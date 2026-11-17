import { checkGateway, type GatewayStatus } from '../../../../api/health';
import { useResource } from '../../../../utils/useResource';

type Health = 'checking' | 'ok' | 'degraded' | 'down';

/** What the chip says about a check. Nothing answering at all is a different thing from the gateway reporting an error. */
function describeGateway(status: GatewayStatus): { health: Health; text: string } {
  const { health, live, ready } = status.probes;
  if (![health, live, ready].some(probe => probe.reached))
    return { health: 'down', text: 'not available right now' };
  if (!health.ok || !live.ok) return { health: 'down', text: 'Gateway reporting errors' };
  if (!ready.ok || status.dependencies.some(dependency => dependency.state === 'down'))
    return { health: 'degraded', text: 'Degraded' };
  return { health: 'ok', text: 'All systems operational' };
}

const DOTS: Record<Health, string> = {
  checking: 'bg-tp-stone',
  ok: 'bg-tp-severity-success',
  degraded: 'bg-tp-severity-warning',
  down: 'bg-tp-severity-error',
};

/**
 * The gateway's health checks (`/health`, `/health/live`, `/health/ready`) in one chip: the footer of every page shows it, and
 * a refusal that may be the service's (sign-in unavailable, say) shows it beside its message.
 */
export default function ServiceStatus({ id, className = '' }: { id?: string; className?: string }) {
  const gateway = useResource('gateway', checkGateway);
  const { health, text } =
    gateway.status === 'loading'
      ? { health: 'checking' as const, text: 'checking…' }
      : gateway.data
        ? describeGateway(gateway.data)
        : { health: 'down' as const, text: 'not available right now' };
  return (
    <span
      id={id}
      aria-live="polite"
      aria-busy={gateway.status === 'loading'}
      data-health={health}
      className={`inline-flex w-fit items-center gap-2 rounded-full border border-current/15 px-3 py-1 text-xs ${className}`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${DOTS[health]}`} aria-hidden="true" />
      {`Service status: ${text}`}
    </span>
  );
}
