import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import type { Job } from '../../api/platform';
import { caseOf, org, project, renderProjectScreen, revisionOf } from '../Project/testKit';
import { CaseDetail } from './CaseDetail';

const platform = vi.hoisted(() => ({ project: vi.fn(), case: vi.fn(), revisions: vi.fn(), projectJobs: vi.fn() }));
const jobs = vi.hoisted(() => ({ instance: vi.fn() }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/jobs', async () => ({ ...await vi.importActual<typeof import('../../api/jobs')>('../../api/jobs'), jobsApi: jobs }));

const member = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const checkout = caseOf('flujo-checkout', 'Flujo de checkout');
const r1 = revisionOf(checkout, 1, { source_snapshot_id: 'snap-1' });
const r2 = revisionOf(checkout, 2, { source_snapshot_id: 'snap-2' });
const root = '/app/isa-demo/qos-benchmarks';

const jobOf = (id: string, created: string, over: Partial<Job> = {}): Job => ({
  id, engine_id: 'multi-heuristic', status: 'completed', cancellation_requested: false, retry_of_id: null, organization_id: 'org-isa-demo',
  project_id: 'project-qos-benchmarks', created_at: created, finished_at: created, termination: 'OPTIMAL', ...over,
});
const snapshotOfJob: Record<string, string> = { 'job-old': 'snap-1', 'job-new': 'snap-2', 'job-other': 'snap-elsewhere' };

function renderRuns() {
  return renderProjectScreen(<CaseDetail />, {
    path: '/app/:org/:project/cases/:case/:tab?', url: `${root}/cases/flujo-checkout/runs`, organizations: [member],
  });
}

/** The table of the runs, which the data table names through the region around it. */
const runsTable = async () => within(await screen.findByRole('region', { name: 'Runs of the problem' })).getByRole('table');

// [utest->req~frontend-nav-problem-page~1]
describe('Runs tab of the problem page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.case.mockResolvedValue(checkout);
    platform.revisions.mockResolvedValue([r1, r2]);
    platform.projectJobs.mockResolvedValue([
      jobOf('job-old', '2026-09-01T00:00:00Z'), jobOf('job-other', '2026-09-02T00:00:00Z'), jobOf('job-new', '2026-09-03T00:00:00Z'),
    ]);
    jobs.instance.mockImplementation(async (id: string) => ({ id: snapshotOfJob[id] }));
  });

  it('lists the runs that started from a revision of the problem, newest first, each linking to its page', async () => {
    renderRuns();

    const table = await runsTable();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('link', { name: 'Run job-new' })).toHaveAttribute('href', `${root}/jobs/job-new`);
    expect(within(rows[0]).getByRole('link', { name: 'Revision 2' })).toHaveAttribute('href', `${root}/cases/flujo-checkout?version=2`);
    expect(within(rows[1]).getByRole('link', { name: 'Run job-old' })).toHaveAttribute('href', `${root}/jobs/job-old`);
    expect(within(rows[1]).getByRole('link', { name: 'Revision 1' })).toHaveAttribute('href', `${root}/cases/flujo-checkout?version=1`);
    expect(screen.queryByRole('link', { name: 'Run job-other' })).not.toBeInTheDocument();
    expect(platform.projectJobs).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks');
  });

  it('skips the runs whose snapshot the account cannot read', async () => {
    jobs.instance.mockImplementation(async (id: string) => {
      if (id === 'job-new') throw new HttpError(404, 'not found');
      return { id: snapshotOfJob[id] };
    });
    renderRuns();

    const table = await runsTable();
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(1);
    expect(within(table).getByRole('link', { name: 'Run job-old' })).toBeInTheDocument();
  });

  it('says so when no run started from the problem, and offers to start one to a MEMBER', async () => {
    platform.projectJobs.mockResolvedValue([]);
    renderRuns();

    expect(await screen.findByText('No runs of this problem yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start a run' })).toHaveAttribute('href', `${root}/jobs/new?case=flujo-checkout`);
  });

  it('says the runs cannot be loaded, and retries', async () => {
    platform.projectJobs.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    renderRuns();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The runs can’t be loaded right now');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await runsTable()).toBeInTheDocument();
  });
});
