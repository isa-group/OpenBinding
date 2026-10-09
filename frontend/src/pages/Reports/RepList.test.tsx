import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { RUN_ID, runFixture, studyFixture } from '../Studies/fixtures';
import { DRAFT, FROZEN, LEGACY, MATRIX, publicationOf, reportOf } from './fixtures';
import { RepList } from './RepList';

const platform = vi.hoisted(() => ({
  project: vi.fn(), publicProjects: vi.fn(), reports: vi.fn(), publications: vi.fn(), studies: vi.fn(), studyRuns: vi.fn(), createReport: vi.fn(), deleteReport: vi.fn(),
}));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const member = org('team-lab', { name: 'Team Lab', effective_role: 'MEMBER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const ROOT = '/app/isa-demo/qos-benchmarks';

const refusal = (status: number, code: string) => Object.assign(new HttpError(status, 'refused'), { code });

function renderList(slug = 'isa-demo') {
  return renderProjectScreen(<RepList />, { path: '/app/:org/:project/reports', url: `/app/${slug}/qos-benchmarks/reports`, organizations: [group, viewing, member] });
}

describe('Reports of a project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.reports.mockResolvedValue([FROZEN, DRAFT, LEGACY]);
    platform.publications.mockResolvedValue([publicationOf(FROZEN)]);
    platform.studies.mockResolvedValue([studyFixture()]);
    platform.studyRuns.mockResolvedValue([runFixture()]);
  });

  it('lists drafts and frozen editions, says which are published, and opens each', async () => {
    renderList();

    expect(await screen.findByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument();
    expect(screen.getByText(/Freezing makes an edition that never changes; publishing makes it public and citable\./)).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Reports of the project' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByRole('link', { name: /Comparativa de engines en checkout/ })).toHaveAttribute('href', `${ROOT}/reports/engines-vs-seeds-informe`);
    expect(await within(rows[0]).findByText(/Frozen edition · from Engines × semillas · run #1 · sha256-eeee…eeee/)).toBeInTheDocument();
    expect(within(rows[0]).getByText('Frozen')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Published')).toBeInTheDocument();
    expect(within(rows[1]).getByText(/Draft revision 3 · no edition yet/)).toBeInTheDocument();
    expect(within(rows[1]).getByText('Draft')).toBeInTheDocument();
    expect(within(rows[1]).queryByText('Published')).not.toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Reports' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Publications' })).toHaveAttribute('href', `${ROOT}/publications`);
    expect(platform.reports).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks');
  });

  it('narrows the list to drafts or to frozen editions', async () => {
    renderList();
    const list = await screen.findByRole('list', { name: 'Reports of the project' });

    fireEvent.click(screen.getByRole('button', { name: 'Drafts' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Frozen' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Frozen' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('creates a draft, pinning a study run when one is chosen', async () => {
    platform.createReport.mockResolvedValue(reportOf('mis-hallazgos', 'draft'));
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'New report' }));

    const dialog = await screen.findByRole('dialog', { name: 'New report' });
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Mis hallazgos' } });
    expect(within(dialog).getByLabelText('Address')).toHaveValue('mis-hallazgos');
    await within(dialog).findByRole('option', { name: /Engines × semillas · run #1/ });
    fireEvent.change(within(dialog).getByLabelText('Study run'), { target: { value: RUN_ID } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));

    await waitFor(() => expect(platform.createReport).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', {
      slug: 'mis-hallazgos', title: 'Mis hallazgos', study_run_id: RUN_ID,
      document: { blocks: [{ type: 'heading', text: 'Mis hallazgos' }], provenance: { study: { runId: RUN_ID, matrixDigest: MATRIX } } },
    }));
    expect(await screen.findByText('New draft report created.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the draft' })).toHaveAttribute('href', `${ROOT}/reports/mis-hallazgos`);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the dialog open and says why when the address is taken (409)', async () => {
    platform.createReport.mockRejectedValue(refusal(409, 'slug_conflict'));
    renderList();
    fireEvent.click(await screen.findByRole('button', { name: 'New report' }));

    const dialog = await screen.findByRole('dialog', { name: 'New report' });
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Engines' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create draft' }));

    expect(await within(dialog).findByText('That address is already used (409 · slug_conflict)')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Create draft' })).toBeEnabled();
  });

  it('lets an admin delete a draft and reports the refusal when editions exist (409)', async () => {
    platform.deleteReport.mockResolvedValueOnce(undefined).mockRejectedValueOnce(refusal(409, 'report_history_retained'));
    renderList();
    await screen.findByRole('list', { name: 'Reports of the project' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Borrador: placement' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete Borrador: placement?' })).getByRole('button', { name: 'Delete report' }));
    expect(await screen.findByText('Deleted “Borrador: placement”.')).toBeInTheDocument();
    expect(platform.deleteReport).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'borrador-placement');

    fireEvent.click(screen.getByRole('button', { name: 'Delete Comparativa de engines en checkout' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Delete Comparativa de engines en checkout?' })).getByRole('button', { name: 'Delete report' }));
    expect(await screen.findByText('This report has frozen editions (409 · report_history_retained)')).toBeInTheDocument();
    expect(screen.getByText(/Editions stay citable/)).toBeInTheDocument();
  });

  it('lets a member write but not delete, and a viewer only read', async () => {
    const view = renderList('team-lab');
    expect(await screen.findByRole('button', { name: 'New report' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
    view.unmount();

    renderList('read-lab');
    expect(await screen.findByRole('list', { name: 'Reports of the project' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New report' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Publications' })).toBeInTheDocument();
  });

  it('explains how to start when there are no reports', async () => {
    platform.reports.mockResolvedValue([]);
    platform.publications.mockResolvedValue([]);
    renderList();

    expect(await screen.findByText('No reports yet')).toBeInTheDocument();
    expect(screen.getByText(/Create one from a study run or from a saved analysis\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Drafts' })).not.toBeInTheDocument();
  });

  it('says a key cannot read reports (403) and asks again on Retry', async () => {
    platform.reports.mockRejectedValueOnce(refusal(403, 'api_key_boundary'));
    renderList();

    const message = await screen.findByText(/This API key can’t read reports \(403 · api_key_boundary\)/);
    fireEvent.click(within(message.closest('.ui-notice') as HTMLElement).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Reports of the project' })).toBeInTheDocument();
  });

  it('says the reports could not be loaded on a 503, without claiming there are none', async () => {
    platform.reports.mockRejectedValue(refusal(503, 'unavailable'));
    renderList();

    expect(await screen.findByText(/Reports couldn’t be loaded \(503 · unavailable\)/)).toBeInTheDocument();
    expect(screen.queryByText('No reports yet')).not.toBeInTheDocument();
  });

  it('treats a project that is not there like one the account is not in', async () => {
    platform.project.mockRejectedValue(refusal(404, 'not_found'));
    renderList();

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(platform.reports).not.toHaveBeenCalled();
  });
});
