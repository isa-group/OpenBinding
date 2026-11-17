import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../../../api/auth';
import { HttpError } from '../../../../api/client';
import type { StudyRun } from '../../api/studiesApi';
import { addressNow } from '../../../../test/moduleKit';
import { renderStudyScreen } from '../../../../test/studyPage';
import {
  CHECKOUT,
  REVISION_1,
  REVISION_2,
  RUN_ID,
  analyticsFixture,
  cellsFixture,
  runFixture,
  studyFixture,
} from '../../../../test/fixtures/studies';
import StudyCardPage from '.';

const platform = vi.hoisted(() => ({
  get: vi.fn(),
  runs: vi.fn(),
  run: vi.fn(),
  cells: vi.fn(),
  start: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  analytics: vi.fn(),
  exportRun: vi.fn(),
}));
const download = vi.hoisted(() => ({ saveBytes: vi.fn() }));

const problems = vi.hoisted(() => ({
  list: vi.fn(),
  revisions: vi.fn(),
  compilation: vi.fn(),
  ir: vi.fn(),
}));
vi.mock('../../api/studiesApi', async () => ({
  ...(await vi.importActual<typeof import('../../api/studiesApi')>('../../api/studiesApi')),
  studiesApi: platform,
}));
vi.mock('../../../../api/problems', () => ({ problemsApi: problems }));
vi.mock('../../../../features/workspace/download', () => download);

const ROOT = '/orgs/isa-demo';
const STUDY = '/studies/isa-demo/engines-vs-seeds';
const ETAG = '"study-revision-1"';

const refusal = (
  status: number,
  code: string,
  message = 'refused',
  extra: Partial<HttpError> = {}
) => Object.assign(new HttpError(status, message), { code }, extra);

/** `tail` is what follows the study in the address: `/setup` unless a test is about the default tab or another one. */
function renderDetail(slug = 'isa-demo', study = 'engines-vs-seeds', tail = '/setup') {
  return renderStudyScreen(<StudyCardPage />, { url: `/studies/${slug}/${study}${tail}` });
}

/** The study's runs, as the list and the one-run read both answer them. */
function withRuns(runs: StudyRun[]) {
  platform.runs.mockResolvedValue(runs);
  platform.run.mockImplementation(async (_org: string, _study: string, id: string) => {
    const found = runs.find(run => run.id === id);
    if (!found) throw refusal(404, 'not_found');
    return found;
  });
}

const where = () => addressNow();
const runTwo = () =>
  runFixture({
    id: 'run-2',
    run_number: 2,
    state: 'completed',
    created_at: '2026-09-21T09:00:00Z',
  });

const sections = () => screen.getByRole('navigation', { name: 'Study sections' });
const tab = (name: string) => within(sections()).getByRole('link', { name });
const getMenu = async () => {
  fireEvent.click(await screen.findByRole('button', { name: /Get study/ }));
  return screen.getByRole('menu', { name: 'Get study' });
};

describe('One study', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.get.mockResolvedValue({ value: studyFixture(), etag: ETAG });
    withRuns([runFixture()]);
    platform.cells.mockResolvedValue(cellsFixture());
    problems.list.mockResolvedValue({ problems: [CHECKOUT], total: 1, limit: 200, offset: 0 });
    problems.revisions.mockResolvedValue([REVISION_1, REVISION_2]);
    platform.analytics.mockResolvedValue(analyticsFixture());
  });

  it('opens Progress on the latest study run when the study has runs, and Setup when it has none', async () => {
    withRuns([runFixture(), runTwo()]);
    const view = renderDetail('isa-demo', 'engines-vs-seeds', '');

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Engines × seeds' })
    ).toBeInTheDocument();
    expect(
      within(sections())
        .getAllByRole('link')
        .map(link => link.textContent)
    ).toEqual(['Setup', 'Progress', 'Results', 'Front', 'Settings']);
    await waitFor(() => expect(tab('Progress')).toHaveAttribute('aria-current', 'page'));
    expect(await screen.findByRole('combobox', { name: 'Study run' })).toHaveValue('run-2');
    expect(await screen.findByRole('heading', { level: 2, name: 'Run #2' })).toBeInTheDocument();
    view.unmount();

    withRuns([]);
    renderDetail('isa-demo', 'engines-vs-seeds', '');
    await screen.findByRole('heading', { level: 1, name: 'Engines × seeds' });
    await waitFor(() => expect(tab('Setup')).toHaveAttribute('aria-current', 'page'));
    expect(screen.queryByRole('combobox', { name: 'Study run' })).not.toBeInTheDocument();
    expect(
      await screen.findByText(
        'No runs yet. Running uses 1 study run from your month and runs up to 8 cells.'
      )
    ).toBeInTheDocument();
  });

  it('shows the formula and the stat tiles: cells, engines, runs and the best value of the shown run', async () => {
    renderDetail();

    expect(await screen.findByLabelText('Matrix')).toHaveTextContent(
      '2 problem versions × 2 engines × 1 setting × 2 seeds = 8 cells'
    );
    const tile = (label: string) => screen.getByText(label, { selector: 'dt' }).nextElementSibling;
    expect(tile('Cells')).toHaveTextContent('8');
    expect(tile('Engines')).toHaveTextContent('2');
    await waitFor(() => expect(tile('Runs')).toHaveTextContent('1'));
    await waitFor(() => expect(tile('Best')).toHaveTextContent('Cost 0.104'));
    expect(screen.getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute(
      'href',
      `${ROOT}/studies`
    );
  });

  it('shows the study run named by ?run= and sets the query when another one is chosen', async () => {
    withRuns([runFixture(), runTwo()]);
    renderDetail('isa-demo', 'engines-vs-seeds', '/results');

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Compare results · run #2' })
    ).toBeInTheDocument();
    expect(platform.analytics).toHaveBeenLastCalledWith('isa-demo', 'engines-vs-seeds', 'run-2');
    fireEvent.change(screen.getByRole('combobox', { name: 'Study run' }), {
      target: { value: RUN_ID },
    });

    await waitFor(() => expect(where()).toBe(`${STUDY}/results?run=${RUN_ID}`));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Compare results · run #1' })
    ).toBeInTheDocument();
    expect(platform.analytics).toHaveBeenLastCalledWith('isa-demo', 'engines-vs-seeds', RUN_ID);
  });

  it('keeps the chosen run when another tab is chosen, and says so for a run that is not the study’s', async () => {
    withRuns([runFixture(), runTwo()]);
    const view = renderDetail('isa-demo', 'engines-vs-seeds', `/progress?run=${RUN_ID}`);

    await screen.findByRole('heading', { level: 1, name: 'Engines × seeds' });
    fireEvent.click(tab('Results'));
    await waitFor(() => expect(where()).toBe(`${STUDY}/results?run=${RUN_ID}`));
    await waitFor(() => expect(tab('Results')).toHaveAttribute('aria-current', 'page'));
    view.unmount();

    renderDetail('isa-demo', 'engines-vs-seeds', '/progress?run=ghost');
    expect(await screen.findByText('Run not found')).toBeInTheDocument();
  });

  it('gets the gateway’s CSV export of the shown run from the Get menu, saved under the name the gateway gives it', async () => {
    withRuns([runFixture(), runTwo()]);
    const bytes = new TextEncoder().encode('cell_id,problem\n').buffer;
    platform.exportRun.mockResolvedValue({
      bytes,
      fileName: 'engines-vs-seeds-run-1.csv',
      mediaType: 'text/csv; charset=utf-8',
    });
    renderDetail('isa-demo', 'engines-vs-seeds', `/results?run=${RUN_ID}`);

    fireEvent.click(within(await getMenu()).getByRole('menuitem', { name: /Export CSV/ }));

    await waitFor(() => expect(download.saveBytes).toHaveBeenCalledTimes(1));
    expect(platform.exportRun).toHaveBeenCalledWith('isa-demo', 'engines-vs-seeds', RUN_ID, 'csv');
    expect(download.saveBytes).toHaveBeenCalledWith(
      bytes,
      'engines-vs-seeds-run-1.csv',
      'text/csv; charset=utf-8'
    );
  });

  it('says when the gateway refuses an export', async () => {
    platform.exportRun.mockRejectedValue(refusal(403, 'api_key_permission_denied'));
    renderDetail('isa-demo', 'engines-vs-seeds', `/results?run=${RUN_ID}`);

    fireEvent.click(within(await getMenu()).getByRole('menuitem', { name: /Export CSV/ }));

    expect(
      await screen.findByText('The CSV export couldn’t be made (403 · api_key_permission_denied).')
    ).toBeInTheDocument();
    expect(download.saveBytes).not.toHaveBeenCalled();
  });

  it('downloads the definition as JSON, with no run to export before the first one', async () => {
    withRuns([]);
    renderDetail();

    const menu = await getMenu();
    expect(within(menu).queryByRole('menuitem', { name: /Export CSV/ })).not.toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Download the definition/ }));
    expect(download.saveBytes).toHaveBeenCalledWith(
      expect.anything(),
      'engines-vs-seeds.definition.json',
      'application/json'
    );
  });

  it('says Progress, Results and Front have nothing to show before the first study run', async () => {
    withRuns([]);
    renderDetail('isa-demo', 'engines-vs-seeds', '/progress');

    expect(
      await screen.findByText(/This study has no run yet\. Start one with Run study/)
    ).toBeInTheDocument();
    fireEvent.click(tab('Results'));
    expect(
      await screen.findByText(/This study has no run yet\. Start one with Run study/)
    ).toBeInTheDocument();
    fireEvent.click(tab('Front'));
    expect(
      await screen.findByText(/This study has no run yet\. Start one with Run study/)
    ).toBeInTheDocument();
    expect(platform.cells).not.toHaveBeenCalled();
  });

  it('does not say a study has no run while its runs load, and offers a retry when they cannot', async () => {
    platform.runs.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderDetail('isa-demo', 'engines-vs-seeds', '/results');

    expect(screen.queryByText(/This study has no run yet/)).not.toBeInTheDocument();
    expect(
      await screen.findByText(/The runs couldn’t be loaded \(503 · unavailable\)/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/This study has no run yet/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Compare results · run #1' })
    ).toBeInTheDocument();
  });

  it('answers a tab the page does not have with Page not found', async () => {
    renderDetail('isa-demo', 'engines-vs-seeds', '/runs');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 1, name: 'Engines × seeds' })
    ).not.toBeInTheDocument();
  });

  it('shows the definition, the matrix it expands to, and the runs it has', async () => {
    renderDetail();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Engines × seeds' })
    ).toBeInTheDocument();
    const grid = await screen.findByRole('region', { name: 'The cells of the matrix' });
    expect(within(grid).getAllByRole('columnheader')).toHaveLength(5);
    expect(
      within(grid).getByRole('columnheader', { name: 'random-search (sampling) · seed 2' })
    ).toBeInTheDocument();
    expect(
      await within(grid).findByRole('rowheader', { name: 'Checkout flow r2' })
    ).toBeInTheDocument();
    expect(within(grid).getByText('cell 7')).toBeInTheDocument();
    expect(
      screen.getByText(
        /2 problem versions × 2 engines × 1 setting × 2 seeds = 8 cells\. Settings: 1 · engine defaults\. Seeds: 1, 2\. Every run repeats exactly these cells\./
      )
    ).toBeInTheDocument();

    expect(await screen.findByRole('region', { name: 'Runs' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Run #1/ })).toHaveAttribute(
      'href',
      `${STUDY}/progress?run=00000000-0000-4000-8000-000000000101`
    );
    expect(
      await screen.findByRole('img', { name: '6 completed, 1 failed, 1 cancelled of 8 cells' })
    ).toBeInTheDocument();
    const definition = screen.getByRole('region', { name: 'Definition' });
    expect(
      within(definition).getByRole('button', { name: 'Copy the definition digest' })
    ).toBeInTheDocument();
    expect(definition.textContent).not.toMatch(/sha256-/);
    expect(within(definition).getByRole('button', { name: 'Edit definition' })).toBeEnabled();
  });

  it('keeps the raw definition in the Source view, with Overview as the default', async () => {
    renderDetail();

    await screen.findByRole('heading', { level: 1, name: 'Engines × seeds' });
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.queryByRole('region', { name: 'Study definition source' })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
    expect(screen.getByRole('tab', { name: 'Source' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: 'Study definition source' })).toHaveTextContent(
      '"revision_ids"'
    );
    expect(
      screen.queryByRole('region', { name: 'The cells of the matrix' })
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(
      await screen.findByRole('region', { name: 'The cells of the matrix' })
    ).toBeInTheDocument();
  });

  it('runs the study (the run freezes its current definition) and offers to follow the new run', async () => {
    platform.start.mockResolvedValue(
      runFixture({ id: 'run-2', run_number: 2, state: 'queued', finished_at: null })
    );
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Run study' }));

    expect(
      await screen.findByText('Run #2 accepted (202). Cells start as run slots free up.')
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Follow run #2' })).toHaveAttribute(
      'href',
      `${STUDY}/progress?run=run-2`
    );
    expect(platform.start).toHaveBeenCalledWith('isa-demo', 'engines-vs-seeds');
  });

  it.each([
    [
      '402 out of storage',
      new QuotaError('quota_exceeded', 'full', {
        limit_id: 'maxRepositoryStorage',
        limit: 100,
        used: 100,
      }),
      'Out of storage (402 · quota_exceeded)',
    ],
    [
      '429 job slots busy',
      refusal(429, 'concurrency_limit_exceeded', 'busy', {
        concurrency: { limit_id: 'maxConcurrentRuns', limit: 3, used: 3 },
        retryAfter: 15,
      }),
      'All your run slots are busy (429 · concurrency_limit_exceeded)',
    ],
    [
      '403 feature',
      refusal(403, 'feature_not_entitled', 'No studies.'),
      'Your plan doesn’t include studies right now (403 · feature_not_entitled)',
    ],
    [
      '422 not recompilable',
      refusal(422, 'revision_not_recompilable'),
      'A problem version can’t be compiled by the installed toolchain (422 · revision_not_recompilable)',
    ],
    [
      '403 key engine',
      refusal(403, 'api_key_engine_forbidden', 'This key does not grant Evolutionary.'),
      'This API key isn’t allowed to use one of the study’s engines (403 · api_key_engine_forbidden)',
    ],
  ])('says why a run was refused: %s', async (_name, failure, title) => {
    platform.start.mockRejectedValue(failure);
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Run study' }));

    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.queryByText(/accepted \(202\)/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run study' })).toBeEnabled();
  });

  it('cannot start a run while archived, and can be restored', async () => {
    platform.get.mockResolvedValue({ value: studyFixture({ archived: true }), etag: ETAG });
    platform.update.mockResolvedValue({ value: studyFixture(), etag: '"study-revision-2"' });
    renderDetail();

    expect(
      await screen.findByText(
        'Archived studies keep their runs and results but can’t start new runs until restored.'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run study' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Restored. It can start new runs again.')).toBeInTheDocument();
    expect(platform.update).toHaveBeenCalledWith('isa-demo', 'engines-vs-seeds', {
      archived: false,
    });
  });

  it('edits the definition with the revision it read, and offers to reload when it changed since (412)', async () => {
    platform.update.mockResolvedValue({ value: studyFixture(), etag: '"study-revision-2"' });
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit definition' });
    const next = { ...studyFixture().definition, seeds: [1, 2, 3] };
    fireEvent.change(within(dialog).getByLabelText('Definition (JSON)'), {
      target: { value: JSON.stringify(next) },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save definition' }));

    expect(await screen.findByText(/Definition saved\. The next run uses it/)).toBeInTheDocument();
    expect(platform.update).toHaveBeenCalledWith(
      'isa-demo',
      'engines-vs-seeds',
      { definition: next },
      ETAG
    );

    platform.update.mockRejectedValue(refusal(412, 'precondition_failed'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit definition' }));
    const again = await screen.findByRole('dialog', { name: 'Edit definition' });
    fireEvent.click(within(again).getByRole('button', { name: 'Save definition' }));
    expect(
      await screen.findByText(/Someone else changed Engines × seeds since you opened it/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('does not send a definition that is not a JSON object with the four lists', async () => {
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit definition' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit definition' });
    fireEvent.change(within(dialog).getByLabelText('Definition (JSON)'), {
      target: { value: '{"seeds": [1]}' },
    });

    expect(
      within(dialog).getByText('It needs the lists revision_ids, engines, parameter_sets.')
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save definition' })).toBeDisabled();
  });

  it('shows the definition the selected run froze, and makes it the study’s again', async () => {
    platform.get.mockResolvedValue({
      value: studyFixture({ definition: { ...studyFixture().definition, seeds: [7] } }),
      etag: ETAG,
    });
    platform.update.mockResolvedValue({ value: studyFixture(), etag: '"study-revision-2"' });
    renderDetail('isa-demo', 'engines-vs-seeds', `/setup?run=${RUN_ID}`);

    const card = await screen.findByRole('region', { name: 'Frozen definition' });
    expect(
      within(card).getByRole('button', { name: 'Copy the digest of the frozen definition' })
    ).toBeInTheDocument();
    expect(
      within(within(card).getByRole('list', { name: 'Problem versions of the run' })).getAllByRole(
        'listitem'
      )
    ).toHaveLength(2);
    expect(
      await within(card).findByRole('button', {
        name: 'Copy the compilation digest of Checkout flow r2',
      })
    ).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/sha256-/);
    fireEvent.click(within(card).getByRole('button', { name: 'Use it for the next runs' }));

    expect(
      await screen.findByText(/The study’s definition is now the one run #1 froze/)
    ).toBeInTheDocument();
    expect(platform.update).toHaveBeenCalledWith(
      'isa-demo',
      'engines-vs-seeds',
      { definition: studyFixture().definition },
      ETAG
    );
  });

  it('shows the options and the run preset each frozen engine ran with', async () => {
    const frozen = runFixture();
    frozen.definition.engines = [
      {
        ...frozen.definition.engines[0],
        optimization: { type: 'SINGLE', scalarization: 'weighted-sum' },
        options: { time_budget_ms: 30000 },
        preset: { id: 'p-1', slug: 'fast-sampling' },
      },
      { ...frozen.definition.engines[1], options: {}, preset: null },
    ];
    withRuns([frozen]);
    renderDetail('isa-demo', 'engines-vs-seeds', `/setup?run=${RUN_ID}`);

    const card = await screen.findByRole('region', { name: 'Frozen definition' });
    const engines = within(card).getByRole('list', { name: 'Engines of the run' });
    const [first, second] = within(engines).getAllByRole('listitem');
    expect(first).toHaveTextContent('random-search 1.0.0 (sampling)');
    expect(first).toHaveTextContent(
      'Options: time budget 30 s · optimization SINGLE · weighted-sum · from the run preset fast-sampling, as it was when the run started'
    );
    expect(second).toHaveTextContent('evolutionary 1.0.0 (genetic)');
    expect(second).toHaveTextContent('Options: Engine defaults');
    expect(second).not.toHaveTextContent('run preset');
  });

  it('names a preset row of the definition in the matrix and says each run expands it', async () => {
    platform.get.mockResolvedValue({
      value: studyFixture({
        definition: {
          ...studyFixture().definition,
          engines: [studyFixture().definition.engines[0], { preset: 'fast-sampling' }],
        },
      }),
      etag: ETAG,
    });
    renderDetail();

    const matrix = await screen.findByRole('region', { name: 'The cells of the matrix' });
    expect(
      within(matrix).getByRole('columnheader', { name: 'preset fast-sampling · seed 1' })
    ).toBeInTheDocument();
    expect(within(matrix).queryByText('cell 0')).not.toBeInTheDocument();
    expect(
      screen.getByText(
        /Each run expands the run preset fast-sampling into the engine, mode and options it holds then\./
      )
    ).toBeInTheDocument();
  });

  it('edits the name and the description in Settings, with the revision it read', async () => {
    platform.update.mockResolvedValue({
      value: studyFixture({ name: 'Renamed' }),
      etag: '"study-revision-2"',
    });
    renderDetail('isa-demo', 'engines-vs-seeds', '/settings');

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Renamed' } });
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: 'Two engines, two seeds.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Details saved.')).toBeInTheDocument();
    expect(platform.update).toHaveBeenCalledWith(
      'isa-demo',
      'engines-vs-seeds',
      { name: 'Renamed', description: 'Two engines, two seeds.' },
      ETAG
    );
  });

  it('archives from the Settings switch', async () => {
    platform.update.mockResolvedValue({
      value: studyFixture({ archived: true }),
      etag: '"study-revision-2"',
    });
    renderDetail('isa-demo', 'engines-vs-seeds', '/settings');

    fireEvent.click(await screen.findByRole('switch', { name: 'Archived' }));
    expect(
      await screen.findByText('Archived: it can’t start new runs, and existing results stay.')
    ).toBeInTheDocument();
  });

  it('deletes a study that has no runs and goes back to the organization’s studies', async () => {
    withRuns([]);
    platform.remove.mockResolvedValue(undefined);
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(
      within(await screen.findByRole('dialog', { name: 'Delete Engines × seeds?' })).getByRole(
        'button',
        { name: 'Delete study' }
      )
    );

    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    expect(where()).toBe(`${ROOT}/studies`);
    expect(platform.remove).toHaveBeenCalledWith('isa-demo', 'engines-vs-seeds');
  });

  it('archives instead of deleting when the study has runs', async () => {
    platform.remove.mockRejectedValue(refusal(409, 'study_history_retained'));
    platform.update.mockResolvedValue({
      value: studyFixture({ archived: true }),
      etag: '"study-revision-2"',
    });
    renderDetail();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete study' })
    );

    expect(
      await screen.findByText(
        'This study has runs, so it was archived instead of deleted. Its runs and results stay intact.'
      )
    ).toBeInTheDocument();
    expect(platform.update).toHaveBeenCalledWith('isa-demo', 'engines-vs-seeds', {
      archived: true,
    });
  });

  it('lets a viewer read only, and a member run but not delete', async () => {
    const view = renderDetail('read-lab');
    expect(
      await screen.findByText(
        /You can read this study\. Running, archiving and editing it need MEMBER in Read Lab\./
      )
    ).toBeInTheDocument();
    for (const name of ['Run study', 'Archive', 'Edit', 'Edit definition', 'Delete'])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(within(sections()).queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    view.unmount();

    renderDetail('team-lab');
    expect(await screen.findByRole('button', { name: 'Run study' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('answers a study that is not there, or of an organization that is not the account’s, with the same 404', async () => {
    platform.get.mockRejectedValue(refusal(404, 'not_found'));
    const view = renderDetail('isa-demo', 'ghost');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    view.unmount();

    platform.get.mockResolvedValue({ value: studyFixture(), etag: ETAG });
    renderDetail('other-lab', 'engines-vs-seeds');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(platform.get).not.toHaveBeenCalledWith('other-lab', 'engines-vs-seeds');
  });

  it('offers a retry when the study cannot be read', async () => {
    platform.get.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderDetail();

    expect(await screen.findByText('The study couldn’t be loaded.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Engines × seeds' })
    ).toBeInTheDocument();
  });

  it('keeps the page when only the runs fail to load', async () => {
    platform.runs.mockRejectedValue(refusal(503, 'unavailable'));
    renderDetail();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Engines × seeds' })
    ).toBeInTheDocument();
    expect(
      await screen.findByText(/The runs couldn’t be loaded \(503 · unavailable\)/)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run study' })).toBeInTheDocument();
  });
});
