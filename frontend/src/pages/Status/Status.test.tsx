import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDependencies, type GatewayStatus, type ProbeResult } from '../../api/health';
import { Status } from './Status';

const gateway = vi.hoisted(() => ({ checkGateway: vi.fn() }));

vi.mock('../../api/health', async () => ({
  ...await vi.importActual<typeof import('../../api/health')>('../../api/health'),
  checkGateway: gateway.checkGateway,
}));

const probe = (name: ProbeResult['name'], path: string, overrides: Partial<ProbeResult> = {}): ProbeResult => ({
  name, request: `GET ${path}`, reached: true, status: 200, ok: true, ms: 12, body: { status: 'ok' }, ...overrides,
});

function report(readyBody: unknown, overrides: Partial<Record<ProbeResult['name'], Partial<ProbeResult>>> = {}): GatewayStatus {
  const ready = probe('ready', '/health/ready', { body: readyBody, ...overrides.ready });
  return {
    checkedAt: new Date('2026-10-09T10:00:00Z'),
    probes: { health: probe('health', '/health', overrides.health), live: probe('live', '/health/live', overrides.live), ready },
    dependencies: parseDependencies(readyBody),
  };
}

const HEALTHY = { status: 'ready', dependencies: { database: 'ok', redis: 'not-required', sphere: 'configured', space: 'configured' } };
const DATABASE_DOWN = { detail: { code: 'not_ready', dependencies: { database: 'unavailable', redis: 'not-required' } } };

describe('Status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gateway.checkGateway.mockResolvedValue(report(HEALTHY));
  });

  it('reports every probe and dependency when all is well', async () => {
    render(<Status />);

    expect(screen.getByRole('heading', { level: 1, name: 'Service status' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'All systems operational' })).toBeInTheDocument();
    expect(screen.getByText('The gateway and every required dependency answered.')).toBeInTheDocument();

    const probes = within(screen.getByRole('list', { name: 'Probes' })).getAllByRole('listitem');
    expect(probes.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Gateway upokGET /health12 ms'),
      expect.stringContaining('LiveokGET /health/live12 ms'),
      expect.stringContaining('ReadyokGET /health/ready12 ms'),
    ]);

    const dependencies = within(screen.getByRole('region', { name: 'Required dependencies' }));
    expect(dependencies.getByText('database').closest('li')).toHaveTextContent('ok');
    expect(dependencies.getByText('redis').closest('li')).toHaveTextContent('not required');
    expect(dependencies.getByText('redis').closest('li')).toHaveTextContent('Not in use on this deployment');
    expect(dependencies.getByText('space').closest('li')).toHaveTextContent('configured');
  });

  it('calls a failing dependency degradation, names it and says what it affects', async () => {
    gateway.checkGateway.mockResolvedValue(report(DATABASE_DOWN, { ready: { ok: false, status: 503 } }));
    render(<Status />);

    expect(await screen.findByRole('heading', { name: 'Degraded' })).toBeInTheDocument();
    expect(screen.getByText(/database is unavailable\. Public pages and validation keep working/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Probes' })).getByText('Ready').closest('li')).toHaveTextContent('degraded');
    const row = within(screen.getByRole('region', { name: 'Required dependencies' })).getByText('database').closest('li');
    expect(row).toHaveTextContent('unavailable');
    expect(row).toHaveTextContent('sign-in and private pages answer 503');
  });

  it('does not call a gateway that answers with errors operational', async () => {
    gateway.checkGateway.mockResolvedValue(report(HEALTHY, { health: { ok: false, status: 500 } }));
    render(<Status />);

    expect(await screen.findByRole('heading', { name: 'Gateway reporting errors' })).toBeInTheDocument();
    expect(screen.getByText(/GET \/health did not answer successfully/)).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Probes' })).getByText('Gateway up').closest('li')).toHaveTextContent('HTTP 500');
  });

  it('tells having no connection apart from a dependency being down', async () => {
    const lost = { reached: false, ok: false, status: null, ms: null, body: null };
    gateway.checkGateway.mockResolvedValue(report(null, { health: lost, live: lost, ready: lost }));
    render(<Status />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No connection with the gateway');
    expect(alert).toHaveTextContent('we can’t tell whether any dependency is down');
    expect(alert).toHaveTextContent('Last attempt');
    expect(screen.queryByText('Degraded')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Required dependencies' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeEnabled();
  });

  it('admits when the readiness answer lists no dependencies', async () => {
    gateway.checkGateway.mockResolvedValue(report({ status: 'ready' }));
    render(<Status />);

    expect(await screen.findByText(/did not list its dependencies/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'All systems operational' })).toBeInTheDocument();
  });

  it('shows progress while checking and checks again on request', async () => {
    let finish: (value: GatewayStatus) => void = () => undefined;
    gateway.checkGateway.mockReturnValueOnce(new Promise<GatewayStatus>((resolve) => { finish = resolve; }));
    render(<Status />);

    expect(screen.getByText('Checking the gateway and its dependencies…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Copy summary' })).toBeDisabled();
    finish(report(HEALTHY));
    await screen.findByRole('heading', { name: 'All systems operational' });

    gateway.checkGateway.mockResolvedValueOnce(report(DATABASE_DOWN, { ready: { ok: false, status: 503 } }));
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));

    expect(await screen.findByRole('heading', { name: 'Degraded' })).toBeInTheDocument();
    expect(gateway.checkGateway).toHaveBeenCalledTimes(2);
  });

  it('copies a one-line summary', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    gateway.checkGateway.mockResolvedValue(report(DATABASE_DOWN, { ready: { ok: false, status: 503 } }));
    render(<Status />);

    fireEvent.click(await screen.findByRole('button', { name: 'Copy summary' }));

    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(
      /^OpenBinding status: Degraded\. health ok, live ok, ready degraded \(database\)\. Checked .+\(your local time\)$/,
    ));
    expect(await screen.findByRole('button', { name: 'Summary copied' })).toBeInTheDocument();
  });

  it('keeps the incident guide folded until asked', async () => {
    render(<Status />);
    await screen.findByRole('heading', { name: 'All systems operational' });
    const toggle = screen.getByRole('button', { name: 'What to do during an incident' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/nothing is retried automatically/)).not.toBeInTheDocument();
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Retry manually; nothing is retried automatically for you/)).toBeInTheDocument();
    expect(screen.getByText(/A 503 never means your quota is used up/)).toBeInTheDocument();
  });
});
