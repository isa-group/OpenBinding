import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, renderProjectScreen } from '../Project/testKit';
import { AnalysisSources } from './AnalysisSources';
import { JOB_DONE, JOB_OLD, JOB_SECOND, SOURCES, sourceOf } from '../../test/fixtures/analysis';

const api = vi.hoisted(() => ({ sources: vi.fn() }));
const platform = vi.hoisted(() => ({ studyCell: vi.fn(), studyCells: vi.fn(), organizations: vi.fn(), projects: vi.fn() }));

vi.mock('../../analysis/archive', async () => ({ ...await vi.importActual<typeof import('../../analysis/archive')>('../../analysis/archive'), analysisApi: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const WORKSPACE = '/app/analysis/workspace';

const refusal = (status: number, message: string) => new HttpError(status, message);

function renderSources(url = '/app/analysis') {
  return renderProjectScreen(<AnalysisSources />, { path: '/app/analysis', url, organizations: [group] });
}

describe('Analysis sources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.sources.mockResolvedValue({ items: SOURCES, nextCursor: null });
  });

  it('groups the finished runs by the model and checker they share, and sets the rest apart', async () => {
    renderSources();

    expect(await screen.findByRole('heading', { level: 1, name: 'Analysis' })).toBeInTheDocument();
    expect(screen.getByText(/Compare results you already have under the priorities you choose\. Nothing here runs a solver again\./)).toBeInTheDocument();
    const checked = await screen.findByRole('region', { name: 'Model sha256-c3d4…c3d4 · checked by sha256-1a2b…1a2b' });
    expect(within(checked).getAllByRole('checkbox')).toHaveLength(2);
    expect(within(checked).getAllByText('Can be combined')).toHaveLength(2);

    const legacy = screen.getByRole('region', { name: 'Can’t be combined' });
    expect(within(legacy).getByText('random-search · job f7a1b2c3…')).toBeInTheDocument();
    fireEvent.click(within(legacy).getByRole('button', { name: 'Why?' }));
    expect(within(legacy).getByText(/before runs recorded which model and checker they used/)).toBeInTheDocument();

    const pending = screen.getByRole('region', { name: 'Not finished yet' });
    expect(within(pending).getByRole('checkbox')).toBeDisabled();
    expect(within(pending).getByText('Analysis reads stored results. It opens once the run finishes.')).toBeInTheDocument();
  });

  it('opens the decision space with the sources chosen, only from one model at a time', async () => {
    renderSources();
    await screen.findByRole('region', { name: /Model sha256-c3d4/ });
    expect(screen.getByRole('button', { name: 'Open decision space with 0 sources' })).toBeDisabled();

    fireEvent.click(screen.getByRole('checkbox', { name: /random-search · job f1a1b2c3…/ }));
    expect(screen.getByRole('link', { name: 'Open decision space with 1 source' })).toHaveAttribute('href', `${WORKSPACE}?job=${JOB_DONE}`);
    fireEvent.click(screen.getByRole('checkbox', { name: /evolutionary · job f2a1b2c3…/ }));
    expect(screen.getByRole('link', { name: 'Open decision space with 2 sources' })).toHaveAttribute('href', `${WORKSPACE}?job=${JOB_DONE}&job=${JOB_SECOND}`);

    // A result with no recorded model can't join the ones that have one.
    const old = screen.getByRole('checkbox', { name: /random-search · job f7a1b2c3…/ });
    expect(old).toBeDisabled();
    expect(screen.getAllByText('Open it on its own.')).toHaveLength(1);
  });

  it('lets any finished result open alone', async () => {
    renderSources();
    await screen.findByRole('region', { name: /Model sha256-c3d4/ });

    expect(screen.getByRole('link', { name: 'Open random-search · job f7a1b2c3… alone' })).toHaveAttribute('href', `${WORKSPACE}?job=${JOB_OLD}`);
    expect(screen.queryByRole('link', { name: /minizinc · job f3a1b2c3… alone/ })).not.toBeInTheDocument();
  });

  it('arrives with the sources a job link named already chosen', async () => {
    renderSources(`/app/analysis?job=${JOB_DONE}`);

    await waitFor(() => expect(screen.getByRole('checkbox', { name: /random-search · job f1a1b2c3…/ })).toBeChecked());
    expect(screen.getByRole('link', { name: 'Open decision space with 1 source' })).toBeInTheDocument();
    // The other model's results are not offered for combining with it.
    expect(screen.getByRole('checkbox', { name: /random-search · job f7a1b2c3…/ })).toBeDisabled();
  });

  it('arrives from a study cell: the cell’s stored result is chosen', async () => {
    platform.studyCell.mockResolvedValue({ id: 'cell-3', ordinal: 2, job_id: JOB_SECOND });
    renderSources('/app/analysis?org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds&run=run-1&cell=cell-3');

    expect(await screen.findByText(/Preselected from the study: Cell 3 of run run-1/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /evolutionary · job f2a1b2c3…/ })).toBeChecked());
    expect(platform.studyCell).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds', 'run-1', 'cell-3');
  });

  it('says so when the study cell has nothing stored', async () => {
    platform.studyCell.mockResolvedValue({ id: 'cell-3', ordinal: 2, job_id: null });
    renderSources('/app/analysis?org=isa-demo&project=qos-benchmarks&study=engines-vs-seeds&run=run-1&cell=cell-3');

    expect(await screen.findByText('That cell has no stored result yet, so there is nothing to analyse.')).toBeInTheDocument();
  });

  it('explains that analysis needs a finished run when there is none, and offers to start one', async () => {
    api.sources.mockResolvedValue({ items: [], nextCursor: null });
    renderSources();

    expect(await screen.findByText('Nothing to compare yet')).toBeInTheDocument();
    expect(screen.getByText('Analysis works on finished runs you own. Run a case first.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start a run' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open decision space with 0 sources' })).toBeDisabled();
  });

  it('reads a key that cannot list jobs as a 403, and asks again on Retry', async () => {
    api.sources.mockRejectedValueOnce(refusal(403, 'The API key boundary excludes this resource'));
    renderSources();

    const title = await screen.findByText('This API key can’t read these results (403)');
    const notice = title.closest('.ui-notice') as HTMLElement;
    fireEvent.click(within(notice).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: /Model sha256-c3d4/ })).toBeInTheDocument();
    expect(api.sources).toHaveBeenCalledTimes(2);
  });

  it('loads the next page of runs on request', async () => {
    api.sources.mockResolvedValueOnce({ items: [SOURCES[0]], nextCursor: '1' });
    api.sources.mockResolvedValueOnce({ items: [sourceOf('fa000000-0000-4000-8000-00000000000a', 'minizinc')], nextCursor: null });
    renderSources();

    fireEvent.click(await screen.findByRole('button', { name: 'Load more runs' }));
    expect(await screen.findByText('minizinc · job fa000000…')).toBeInTheDocument();
    expect(api.sources).toHaveBeenLastCalledWith('1');
    expect(screen.queryByRole('button', { name: 'Load more runs' })).not.toBeInTheDocument();
  });
});
