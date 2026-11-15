import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import type { Job } from '../../api/platform';
import { caseOf, org, renderOrgScreen, revisionOf } from '../../features/workspace/testKit';
import { CaseDetail } from './CaseDetail';

const problems = vi.hoisted(() => ({ get: vi.fn(), revisions: vi.fn() }));
const runsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock('../../api/problems', () => ({ problemsApi: problems }));
vi.mock('../../api/runs', async () => ({ ...await vi.importActual<typeof import('../../api/runs')>('../../api/runs'), runsApi }));

const member = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const checkout = caseOf('flujo-checkout', 'Flujo de checkout');
const r1 = revisionOf(checkout, 1);
const r2 = revisionOf(checkout, 2);
const root = '/app/isa-demo';
const runs = '/app/isa-demo';

const jobOf = (id: string, created: string, revision: { id: string; revision: number }): Job => ({
  id, engine_id: 'multi-heuristic', status: 'completed', cancellation_requested: false, retry_of_id: null, organization_id: 'org-isa-demo',
  created_at: created, finished_at: created, termination: 'OPTIMAL', revision,
});

function renderRuns() {
  return renderOrgScreen(<CaseDetail />, {
    path: '/app/:org/problems/:case/:tab?', url: `${root}/problems/flujo-checkout/runs`, organizations: [member],
  });
}

/** The table of the runs, which the data table names through the region around it. */
const runsTable = async () => within(await screen.findByRole('region', { name: 'Runs of the problem' })).getByRole('table');

describe('Runs tab of the problem page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    problems.get.mockResolvedValue(checkout);
    problems.revisions.mockResolvedValue([r1, r2]);
    runsApi.list.mockResolvedValue({ total: 3, runs: [
      jobOf('job-old', '2026-09-01T00:00:00Z', { id: r1.id, revision: 1 }),
      jobOf('job-other', '2026-09-02T00:00:00Z', { id: 'rev-elsewhere', revision: 4 }),
      jobOf('job-new', '2026-09-03T00:00:00Z', { id: r2.id, revision: 2 }),
    ] });
  });

  it('lists the organization’s runs of a version of the problem by the revision they name, newest first, each linking to its page', async () => {
    renderRuns();

    const table = await runsTable();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('link', { name: 'Run 2' })).toHaveAttribute('href', `${runs}/runs/job-new`);
    expect(within(rows[0]).getByRole('link', { name: 'Version 2' })).toHaveAttribute('href', `${root}/problems/flujo-checkout?version=2`);
    expect(within(rows[1]).getByRole('link', { name: 'Run 1' })).toHaveAttribute('href', `${runs}/runs/job-old`);
    expect(within(rows[1]).getByRole('link', { name: 'Version 1' })).toHaveAttribute('href', `${root}/problems/flujo-checkout?version=1`);
    expect(table.textContent).not.toMatch(/job-|sha256-|[0-9a-f]{12}/);
    expect(runsApi.list).toHaveBeenCalledTimes(1);
    expect(runsApi.list).toHaveBeenCalledWith('isa-demo', { problem: 'flujo-checkout', limit: 200 });
  });

  it('says so when no run is of the problem, and offers to start one to a MEMBER', async () => {
    runsApi.list.mockResolvedValue({ runs: [], total: 0 });
    renderRuns();

    expect(await screen.findByText('No runs of this problem yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start a run' })).toHaveAttribute('href', `${runs}/runs/new?problem=flujo-checkout&revision=2`);
  });

  it('says the runs cannot be loaded, and retries', async () => {
    runsApi.list.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    renderRuns();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The runs can’t be loaded right now');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await runsTable()).toBeInTheDocument();
  });
});
