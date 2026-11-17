import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkGateway,
  type GatewayStatus,
  type ProbeName,
  type ProbeResult,
} from '../../../core/api/health';
import ServiceStatus from '.';

vi.mock('../../../core/api/health', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../core/api/health')>()),
  checkGateway: vi.fn(),
}));

const probe = (
  name: ProbeName,
  state: 'ok' | 'failed' | 'unreached',
  status = 200
): ProbeResult => ({
  name,
  request: `GET /${name}`,
  reached: state !== 'unreached',
  status: state === 'unreached' ? null : status,
  ok: state === 'ok',
  ms: state === 'unreached' ? null : 3,
  body: null,
});

function gatewayStatus(
  probes: Record<ProbeName, ProbeResult>,
  dependencies: GatewayStatus['dependencies'] = []
): GatewayStatus {
  return { checkedAt: new Date('2026-11-01T10:00:00Z'), probes, dependencies };
}

const OPERATIONAL = gatewayStatus(
  { health: probe('health', 'ok'), live: probe('live', 'ok'), ready: probe('ready', 'ok') },
  [{ name: 'database', value: 'ok', state: 'ok' }]
);

beforeEach(() => {
  vi.mocked(checkGateway).mockReset();
  vi.mocked(checkGateway).mockResolvedValue(OPERATIONAL);
});

describe('ServiceStatus', () => {
  it('says that every system is operational when the check reports every dependency up', async () => {
    render(<ServiceStatus id="service-status" />);

    const chip = await screen.findByText('Service status: All systems operational');
    expect(chip).toHaveAttribute('id', 'service-status');
    expect(chip).toHaveAttribute('data-health', 'ok');
    expect(chip).toHaveAttribute('aria-live', 'polite');
  });

  it('is checking while the gateway has not answered', () => {
    vi.mocked(checkGateway).mockReturnValue(new Promise(() => {}));
    render(<ServiceStatus />);

    expect(screen.getByText('Service status: checking…')).toHaveAttribute('aria-busy', 'true');
  });

  it('says Degraded when readiness fails', async () => {
    vi.mocked(checkGateway).mockResolvedValue(
      gatewayStatus({
        health: probe('health', 'ok'),
        live: probe('live', 'ok'),
        ready: probe('ready', 'failed', 503),
      })
    );
    render(<ServiceStatus />);

    expect(await screen.findByText('Service status: Degraded')).toHaveAttribute(
      'data-health',
      'degraded'
    );
  });

  it('says Degraded when a dependency is down although every probe answered', async () => {
    vi.mocked(checkGateway).mockResolvedValue(
      gatewayStatus(
        { health: probe('health', 'ok'), live: probe('live', 'ok'), ready: probe('ready', 'ok') },
        [{ name: 'space', value: 'unavailable', state: 'down' }]
      )
    );
    render(<ServiceStatus />);

    expect(await screen.findByText('Service status: Degraded')).toBeInTheDocument();
  });

  it('says the gateway reports errors when the health or live probe fails', async () => {
    vi.mocked(checkGateway).mockResolvedValue(
      gatewayStatus({
        health: probe('health', 'failed', 500),
        live: probe('live', 'ok'),
        ready: probe('ready', 'ok'),
      })
    );
    render(<ServiceStatus />);

    expect(await screen.findByText('Service status: Gateway reporting errors')).toHaveAttribute(
      'data-health',
      'down'
    );
  });

  it('says it is not available when no probe answers', async () => {
    vi.mocked(checkGateway).mockResolvedValue(
      gatewayStatus({
        health: probe('health', 'unreached'),
        live: probe('live', 'unreached'),
        ready: probe('ready', 'unreached'),
      })
    );
    render(<ServiceStatus />);

    expect(await screen.findByText('Service status: not available right now')).toBeInTheDocument();
  });

  it('says it is not available when the check throws', async () => {
    vi.mocked(checkGateway).mockRejectedValue(new Error('boom'));
    render(<ServiceStatus />);

    expect(await screen.findByText('Service status: not available right now')).toBeInTheDocument();
  });
});
