import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import type { StudyCell as StudyCellView } from '../../api/platform';
import { jobOf } from '../../test/fixtures/jobs';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { CHECKOUT, REVISION_1, REVISION_2, RUN_ID, cellsFixture, runFixture, studyFixture } from '../../test/fixtures/studies';
import { StudyCell } from './StudyCell';

const platform = vi.hoisted(() => ({
  project: vi.fn(), publicProjects: vi.fn(), studies: vi.fn(), studyRuns: vi.fn(), studyCells: vi.fn(), studyCell: vi.fn(), retryStudyCell: vi.fn(),
  attachStudyCellResult: vi.fn(), projectJobs: vi.fn(), cases: vi.fn(), revisions: vi.fn(),
}));
const jobs = vi.hoisted(() => ({ jobsApi: { mine: vi.fn() } }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/jobs', () => jobs);

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const ROOT = '/app/isa-demo/qos-benchmarks';
const RUN = `${ROOT}/studies/engines-vs-seeds/runs/${RUN_ID}`;

const cells = cellsFixture();
const byOrdinal = (n: number): StudyCellView => cells[n];
const refusal = (status: number, code: string, message = 'refused') => Object.assign(new HttpError(status, message), { code });

function renderCell(ordinal: number, slug = 'isa-demo') {
  return renderProjectScreen(<StudyCell />, {
    path: '/app/:org/:project/studies/:study/runs/:run/cells/:cell', url: `/app/${slug}/qos-benchmarks/studies/engines-vs-seeds/runs/${RUN_ID}/cells/${byOrdinal(ordinal).id}`, organizations: [group, viewing],
  });
}

describe('One cell of a run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.studies.mockResolvedValue([studyFixture()]);
    platform.studyRuns.mockResolvedValue([runFixture()]);
    platform.studyCells.mockResolvedValue(cells);
    platform.studyCell.mockImplementation((_org: string, _project: string, _study: string, _run: string, cell: string) => {
      const found = cells.find((item) => item.id === cell);
      return found ? Promise.resolve(found) : Promise.reject(refusal(404, 'not_found'));
    });
    platform.cases.mockResolvedValue([CHECKOUT]);
    platform.revisions.mockResolvedValue([REVISION_1, REVISION_2]);
    platform.projectJobs.mockResolvedValue([]);
    jobs.jobsApi.mine.mockResolvedValue([]);
  });

  it('shows what the cell ran on and how it ended', async () => {
    renderCell(2);

    expect(await screen.findByRole('heading', { level: 1, name: 'Cell 2' })).toBeInTheDocument();
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
    const inputs = screen.getByRole('region', { name: 'Frozen inputs' });
    expect(await within(inputs).findByRole('link', { name: 'Checkout flow · revision 1' })).toHaveAttribute('href', `${ROOT}/cases/checkout-flow/revisions/1`);
    expect(within(inputs).getByText('random-search 1.0.0')).toBeInTheDocument();
    expect(within(inputs).getByText('sampling')).toBeInTheDocument();
    expect(within(inputs).getByText('Engine defaults')).toBeInTheDocument();
    expect(within(inputs).getByRole('link', { name: 'snapshot…' })).toHaveAttribute('href', `${ROOT}/snapshots/snapshot-1`);
    expect(within(inputs).getByRole('button', { name: 'Copy cell fingerprint' })).toBeInTheDocument();
    const result = screen.getByRole('region', { name: 'Result' });
    expect(within(result).getByText('Feasible')).toBeInTheDocument();
    expect(within(result).getByText('0.121')).toBeInTheDocument();
    expect(within(result).getByText('430')).toBeInTheDocument();
    expect(within(result).getByText('58 s')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '00000000…0302' })).toHaveAttribute('href', `${ROOT}/jobs/00000000-0000-4000-8000-000000000302`);
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(await within(crumbs).findByRole('link', { name: 'Run #1' })).toHaveAttribute('href', RUN);
  });

  it('compares the engines on the same case, setting and seed', async () => {
    renderCell(2);

    const rivals = await screen.findByRole('list', { name: 'Cost of each engine on this input' });
    expect(within(rivals).getAllByRole('listitem')).toHaveLength(2);
    expect(within(rivals).getByText('random-search (this cell)')).toBeInTheDocument();
    expect(within(rivals).getByRole('link', { name: 'evolutionary' })).toHaveAttribute('href', `${RUN}/cells/${cells[0].id}`);
    expect(within(rivals).getByText('best')).toBeInTheDocument();
    expect(screen.getByText('Same engine, other seeds: seed 1 0.121 · seed 2 0.118.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Compare by' }), { target: { value: 'latency' } });
    expect(screen.getByRole('list', { name: 'Latency of each engine on this input' })).toBeInTheDocument();
  });

  it('moves to another cell of the run', async () => {
    renderCell(2);

    fireEvent.change(await screen.findByRole('combobox', { name: 'Other cell' }), { target: { value: cells[4].id } });

    expect(await screen.findByRole('heading', { level: 1, name: 'Cell 4' })).toBeInTheDocument();
  });

  it('explains a failed cell and retries it', async () => {
    platform.retryStudyCell.mockResolvedValue({ id: cells[1].id, state: 'queued', fingerprint: 'f' });
    renderCell(1);

    expect(await screen.findByRole('heading', { level: 1, name: 'Cell 1' })).toBeInTheDocument();
    expect(screen.getByText('Failed: The engine deployment didn’t answer in time.')).toBeInTheDocument();
    expect(screen.getByText(/Code engine_unreachable · timeout\. Retrying usually helps\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry this cell' }));

    expect(await screen.findByText('Cell queued again.')).toBeInTheDocument();
    expect(platform.retryStudyCell).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds', RUN_ID, cells[1].id);
  });

  it.each([
    ['402', new QuotaError('quota_exceeded', 'full', { limit_id: 'studies', limit: 50, used: 50 }), /The sponsor has no study definitions left \(402 · quota_exceeded\)/],
    ['429', refusal(429, 'concurrency_limit_exceeded', 'busy'), /All your job slots are busy \(429 · concurrency_limit_exceeded\)/],
    ['409', refusal(409, 'sealed_evidence'), /A sealed report cites this run \(409 · sealed_evidence\)/],
  ])('says why a retry was refused: %s', async (_name, failure, expected) => {
    platform.retryStudyCell.mockRejectedValue(failure);
    renderCell(1);

    fireEvent.click(await screen.findByRole('button', { name: 'Retry this cell' }));

    expect(await screen.findByText(expected)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry this cell' })).toBeEnabled();
  });

  it('says a cancelled cell never ran and has no job yet', async () => {
    renderCell(5);

    expect(await screen.findByText('Cancelled before it ran. Retry it, or attach the result of a job you already ran with the same inputs.')).toBeInTheDocument();
    expect(screen.getByText('none yet')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Result' })).not.toBeInTheDocument();
  });

  it('attaches the result of a finished job of the account', async () => {
    const mine = [
      jobOf('job-mine-a', 'random-search', 'completed', 'FEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:01:00Z'),
      jobOf('job-mine-b', 'evolutionary', 'failed', 'UNKNOWN', '2026-10-02T09:00:00Z', '2026-10-02T09:00:20Z'),
      jobOf('job-mine-c', 'minizinc', 'running', null, '2026-10-03T09:00:00Z', null),
    ];
    platform.projectJobs.mockResolvedValue([...mine, jobOf('job-theirs', 'random-search', 'completed', 'FEASIBLE', '2026-10-04T09:00:00Z', '2026-10-04T09:01:00Z')]);
    jobs.jobsApi.mine.mockResolvedValue(mine);
    platform.attachStudyCellResult.mockResolvedValue({ id: cells[5].id, state: 'completed', metrics: {} });
    renderCell(5);

    fireEvent.click(await screen.findByRole('button', { name: 'Use an existing job’s result' }));
    const dialog = await screen.findByRole('dialog', { name: 'Use an existing job’s result' });
    const choices = await within(dialog).findByRole('radiogroup', { name: 'Finished jobs' });
    expect(within(choices).getAllByRole('radio')).toHaveLength(2);
    expect(within(dialog).getByRole('button', { name: 'Attach this result' })).toBeDisabled();
    fireEvent.click(within(choices).getByRole('radio', { name: /random-search · completed/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Attach this result' }));

    expect(await screen.findByText('Result attached. It now counts as this cell’s result.')).toBeInTheDocument();
    expect(platform.attachStudyCellResult).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds', RUN_ID, cells[5].id, 'job-mine-a');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('says when a job cannot be attached', async () => {
    const mine = [jobOf('job-mine-a', 'random-search', 'completed', 'FEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:01:00Z')];
    platform.projectJobs.mockResolvedValue(mine);
    jobs.jobsApi.mine.mockResolvedValue(mine);
    platform.attachStudyCellResult.mockRejectedValue(refusal(409, 'sealed_evidence'));
    renderCell(5);

    fireEvent.click(await screen.findByRole('button', { name: 'Use an existing job’s result' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('radio', { name: /random-search · completed/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Attach this result' }));

    expect(await within(dialog).findByText('A sealed report cites this run (409 · sealed_evidence)')).toBeInTheDocument();
  });

  it('names what differs when the job is not a run of this cell (409 cell_job_mismatch)', async () => {
    const mine = [jobOf('job-mine-a', 'random-search', 'completed', 'FEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:01:00Z')];
    platform.projectJobs.mockResolvedValue(mine);
    jobs.jobsApi.mine.mockResolvedValue(mine);
    platform.attachStudyCellResult.mockRejectedValue(Object.assign(refusal(409, 'cell_job_mismatch'), {
      problem: { detail: { code: 'cell_job_mismatch', fields: ['case_revision', 'engine', 'mode', 'seed'], details: { seed: { cell: 2, job: 9 }, engine: { cell: 'evolutionary', job: 'random-search' } } } },
    }));
    renderCell(5);

    fireEvent.click(await screen.findByRole('button', { name: 'Use an existing job’s result' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/the same case revision, engine, mode and seed/)).toBeInTheDocument();
    fireEvent.click(await within(dialog).findByRole('radio', { name: /random-search · completed/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Attach this result' }));

    expect(await within(dialog).findByText('That job isn’t a run of this cell (409 · cell_job_mismatch)')).toBeInTheDocument();
    expect(within(dialog).getByText(/It differs in the case, engine, mode and seed\./)).toBeInTheDocument();
    expect(within(dialog).getByText('Seed: the cell has 2, the job ran 9')).toBeInTheDocument();
    expect(within(dialog).getByText('Engine: the cell has evolutionary, the job ran random-search')).toBeInTheDocument();
  });

  it.each([
    ['job_result_missing', 'That job finished without a result (409 · job_result_missing)'],
    ['job_already_attached', 'That job is already the result of another cell (409 · job_already_attached)'],
  ])('says why a job can not be attached: %s', async (code, title) => {
    const mine = [jobOf('job-mine-a', 'random-search', 'completed', 'FEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:01:00Z')];
    platform.projectJobs.mockResolvedValue(mine);
    jobs.jobsApi.mine.mockResolvedValue(mine);
    platform.attachStudyCellResult.mockRejectedValue(refusal(409, code));
    renderCell(5);

    fireEvent.click(await screen.findByRole('button', { name: 'Use an existing job’s result' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('radio', { name: /random-search · completed/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Attach this result' }));

    expect(await within(dialog).findByText(title)).toBeInTheDocument();
  });

  it('says there is nothing to attach when the account has no finished job here', async () => {
    renderCell(5);

    fireEvent.click(await screen.findByRole('button', { name: 'Use an existing job’s result' }));

    expect(await screen.findByText('You have no finished job in this project to attach.')).toBeInTheDocument();
  });

  it('is read-only for a viewer', async () => {
    renderCell(1, 'read-lab');

    expect(await screen.findByRole('heading', { level: 1, name: 'Cell 1' })).toBeInTheDocument();
    expect(screen.getByText('Read-only: retrying and attaching a result need MEMBER in Read Lab.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry this cell' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use an existing job’s result' })).not.toBeInTheDocument();
  });

  it('says a cell that is not in the run is not there', async () => {
    platform.studyCell.mockRejectedValue(refusal(404, 'not_found'));
    renderCell(1);

    expect(await screen.findByRole('heading', { name: 'Cell not found' })).toBeInTheDocument();
    expect(screen.getByText(/No such cell here \(404\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the study' })).toHaveAttribute('href', `${ROOT}/studies/engines-vs-seeds`);
  });

  it('says a key without the engine cannot show the cell, and offers a retry on an outage', async () => {
    platform.studyCell.mockRejectedValueOnce(refusal(403, 'api_key_engine_forbidden', 'No Evolutionary.'));
    const view = renderCell(1);
    expect(await screen.findByText(/This API key can’t show this cell \(403 · api_key_engine_forbidden\)/)).toBeInTheDocument();
    view.unmount();

    platform.studyCell.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderCell(1);
    expect(await screen.findByText(/The cell couldn’t be loaded \(503 · unavailable\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Cell 1' })).toBeInTheDocument();
  });

  it('says a cell that is waiting or running is not done and keeps the page current', async () => {
    const waiting = { ...cells[5], state: 'queued' as const };
    platform.studyCell.mockResolvedValue(waiting);
    platform.studyCells.mockResolvedValue(cells.map((cell) => (cell.id === waiting.id ? waiting : cell)));
    renderCell(5);

    expect(await screen.findByText('Waiting for a job slot. This page updates by itself.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Result' })).not.toBeInTheDocument();
  });

  it('marks a result that meets no rule as infeasible and keeps the raw metrics behind View source', async () => {
    const infeasible = { ...cells[2], metrics: { ...cells[2].metrics, feasible: false, termination: 'INFEASIBLE' } };
    platform.studyCell.mockResolvedValue(infeasible);
    renderCell(2);

    expect(await screen.findByText('Infeasible')).toBeInTheDocument();
    const source = screen.getByText('View source').closest('details') as HTMLDetailsElement;
    expect(source.open).toBe(false);
    expect(screen.getByLabelText('Cell metrics source')).toHaveTextContent('"INFEASIBLE"');
  });
});
