import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { JobHistoryPanel } from './JobHistoryPanel';

const api = vi.hoisted(() => ({ listOwnJobs: vi.fn(), getJobStatus: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
// The charts are not what is under test here.
vi.mock('../../components/BindingAnalysis/BindingAnalysis', async () => {
  const { createElement } = await import('react');
  return { BindingAnalysis: () => createElement('div', null, 'binding analysis') };
});

const history = {
  total: 2,
  retention_days: 7,
  jobs: [
    { id: '0123456789abcdef', engine_id: 'bim.builtin/random-search', status: 'completed', termination: 'OPTIMAL', solutions: 2, created_at: '2026-10-08T10:00:00Z' },
    { id: 'fedcba9876543210', engine_id: 'bim.builtin/evolutionary', status: 'failed', termination: null, solutions: null, created_at: '2026-10-07T09:30:00Z' },
  ],
};

const solved = {
  id: '0123456789abcdef',
  status: 'completed',
  result: {
    termination: 'OPTIMAL',
    solutions: [{
      decision: { binding: { t1: { resource: 'service', id: 'a' }, t2: { resource: 'service', id: 'b' } } },
      objectives: { score: 0.5 },
      metrics: { latency: 12.5 },
    }],
  },
};

function renderPanel(props: { limit?: number; headingLevel?: 2 | 3 } = {}) {
  render(<MemoryRouter><JobHistoryPanel {...props} /></MemoryRouter>);
}

describe('JobHistoryPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listOwnJobs.mockResolvedValue(history);
    api.getJobStatus.mockResolvedValue(solved);
  });

  it('asks for the solves of this account and lists them with their retention', async () => {
    renderPanel();

    expect(await screen.findByRole('heading', { level: 2, name: 'Execution history & solves' })).toBeInTheDocument();
    expect(api.listOwnJobs).toHaveBeenCalledWith({ limit: 20 });
    expect(await screen.findByText('Showing 2 of 2 solves, retained for 7 days under your plan.')).toBeInTheDocument();
    expect(screen.getByText('7 days retention')).toBeInTheDocument();

    const table = within(screen.getByRole('region', { name: 'Solve history' }));
    expect(table.getByText('bim.builtin/random-search')).toBeInTheDocument();
    expect(table.getByText('OPTIMAL')).toBeInTheDocument();
    expect(table.getByText(/· 2 solutions/)).toBeInTheDocument();
    expect(table.getByText('Oct 8, 2026, 10:00 UTC')).toBeInTheDocument();
    expect(table.getByText('failed')).toBeInTheDocument();
  });

  it('lets the hosting screen choose the heading level and how many solves to ask for', async () => {
    renderPanel({ limit: 50, headingLevel: 3 });

    expect(await screen.findByRole('heading', { level: 3, name: 'Execution history & solves' })).toBeInTheDocument();
    expect(api.listOwnJobs).toHaveBeenCalledWith({ limit: 50 });
  });

  it('shows the binding a completed solve produced, and offers it as JSON', async () => {
    const createObjectURL = vi.fn(() => 'blob:solution');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    // jsdom cannot follow a download link.
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderPanel();
    const buttons = await screen.findAllByRole('button', { name: 'Solution' });
    expect(buttons).toHaveLength(2);
    expect(buttons[1]).toBeDisabled();

    fireEvent.click(buttons[0]);

    await waitFor(() => expect(api.getJobStatus).toHaveBeenCalledWith('0123456789abcdef'));
    expect(await screen.findByText('binding analysis')).toBeInTheDocument();
    expect(screen.getByText('service:a')).toBeInTheDocument();
    expect(screen.getByText('service:b')).toBeInTheDocument();
    expect(screen.getByText('latency')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(screen.getByRole('button', { name: /Download JSON/ }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();

    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText('service:a')).not.toBeInTheDocument();
  });

  it('says so when a solve can no longer be retrieved', async () => {
    api.getJobStatus.mockRejectedValue(new HttpError(404, 'gone'));
    renderPanel();
    fireEvent.click((await screen.findAllByRole('button', { name: 'Solution' }))[0]);

    expect(await screen.findByText(/That solve could not be retrieved/)).toBeInTheDocument();
  });

  it('says there are no solves yet and points to the Workbench', async () => {
    api.listOwnJobs.mockResolvedValue({ jobs: [], total: 0, retention_days: 7 });
    renderPanel();

    expect(await screen.findByText('No solve executions recorded yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Workbench' })).toHaveAttribute('href', '/workbench');
  });

  it('says plainly when the history cannot be loaded, and tries again on request', async () => {
    api.listOwnJobs.mockRejectedValueOnce(new HttpError(503, 'down'));
    renderPanel();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Nothing was loaded');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('bim.builtin/random-search')).toBeInTheDocument();
  });

  it('explains a refused read (403)', async () => {
    api.listOwnJobs.mockRejectedValue(new HttpError(403, 'forbidden'));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('jobs:read');
  });
});
