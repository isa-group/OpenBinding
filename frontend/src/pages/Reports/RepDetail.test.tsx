import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import type { Report } from '../../api/platform';
import { detailOf } from '../Analysis/fixtures';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { RUN_ID, cellsFixture, runFixture, studyFixture } from '../Studies/fixtures';
import { DRAFT, EDITION, FROZEN, LEGACY, publicationOf, reportOf } from './fixtures';
import { RepDetail } from './RepDetail';

const platform = vi.hoisted(() => ({
  project: vi.fn(), publicProjects: vi.fn(), report: vi.fn(), reports: vi.fn(), publications: vi.fn(), studies: vi.fn(), studyRuns: vi.fn(), studyCells: vi.fn(),
  updateReport: vi.fn(), freezeReport: vi.fn(), createReportDraft: vi.fn(), publishReport: vi.fn(), deletePublication: vi.fn(), deleteReport: vi.fn(),
}));
const files = vi.hoisted(() => ({ saveBytes: vi.fn() }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../Project/download', () => files);

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const member = org('team-lab', { name: 'Team Lab', effective_role: 'MEMBER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const ROOT = '/app/isa-demo/qos-benchmarks';
const ALL = [FROZEN, DRAFT, LEGACY];

const refusal = (status: number, code: string, message = 'refused') => Object.assign(new HttpError(status, message), { code });

function renderDetail(slug: string, organization = 'isa-demo') {
  return renderProjectScreen(<RepDetail />, {
    path: '/app/:org/:project/reports/:report', url: `/app/${organization}/qos-benchmarks/reports/${slug}`, organizations: [group, viewing, member],
  });
}

const textboxOf = (name: string) => within(screen.getByRole('region', { name })).getByRole('textbox');

describe('One report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.report.mockImplementation(async (_org: string, _project: string, slug: string) => ALL.find((report) => report.slug === slug));
    platform.reports.mockResolvedValue(ALL);
    platform.publications.mockResolvedValue([publicationOf(FROZEN)]);
    platform.studies.mockResolvedValue([studyFixture()]);
    platform.studyRuns.mockResolvedValue([runFixture()]);
    platform.studyCells.mockResolvedValue(cellsFixture());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  it('reads a published edition as a page, with its evidence, fingerprint, citation and history', async () => {
    renderDetail('engines-vs-seeds-informe');

    expect(await screen.findByRole('heading', { level: 1, name: 'Comparativa de engines en checkout' })).toBeInTheDocument();
    const content = screen.getByRole('article', { name: 'Report content' });
    expect(within(content).getByRole('heading', { level: 2, name: 'Comparativa de engines en checkout' })).toBeInTheDocument();
    expect(within(content).getByText('Two engines, two seeds, two revisions of the checkout case.')).toBeInTheDocument();
    expect(screen.getByText('Frozen edition · fingerprint sha256-eeee…eeee')).toBeInTheDocument();
    // Once in the status line, once in the history.
    expect(screen.getAllByText('Published as checkout-comparativa')).toHaveLength(2);

    // The run it cites: the study’s own bar, and the screens of the run (not the route that no longer exists).
    expect(await within(content).findByRole('img', { name: '6 completed, 1 failed, 1 cancelled of 8 cells' })).toBeInTheDocument();
    const compare = await screen.findAllByRole('link', { name: 'Compare results' });
    for (const link of compare) expect(link).toHaveAttribute('href', `${ROOT}/studies/engines-vs-seeds/runs/${RUN_ID}/analytics`);
    expect(screen.getByText('matrix sha256-dddd…dddd')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: 'Verify it' })).toHaveAttribute('href', `/resolve/report/${EDITION}`);
    expect(screen.getByRole('link', { name: 'Check it in the verifier' })).toHaveAttribute('href', `/app/verifier?digest=${encodeURIComponent(EDITION)}`);
    expect(screen.getByRole('link', { name: 'Version history in the library' })).toHaveAttribute('href', '/app/isa-demo/library/artifact-engines-vs-seeds-informe/versions/version-engines-vs-seeds-informe');
    expect(screen.getByRole('link', { name: 'Open the publications' })).toHaveAttribute('href', `${ROOT}/publications`);
    expect(screen.getByText('Lucía Vega (2026). Comparativa de engines en checkout (sintética). ISA Demo Group / QoS Benchmarks.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy citation' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Lucía Vega (2026). Comparativa de engines en checkout (sintética). ISA Demo Group / QoS Benchmarks.'));
    expect(await screen.findByRole('button', { name: 'Citation copied' })).toBeInTheDocument();

    // A frozen edition changes only by starting a new draft; a published one can be withdrawn.
    expect(screen.getByRole('button', { name: 'New draft from this edition' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save draft' })).not.toBeInTheDocument();
    expect(within(content).queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('keeps the document as JSON behind “View source”, to copy or download', async () => {
    renderDetail('engines-vs-seeds-informe');
    await screen.findByRole('heading', { level: 1, name: 'Comparativa de engines en checkout' });

    const source = screen.getByLabelText('Report document (JSON)');
    expect(source.tagName).toBe('PRE');
    expect(source.closest('details')).not.toHaveAttribute('open');
    expect(source).toHaveTextContent('"bimVersion": "bim/v1"');
    fireEvent.click(screen.getByText('Download JSON'));
    expect(files.saveBytes).toHaveBeenCalledWith(expect.anything(), 'engines-vs-seeds-informe.json', 'application/json');
  });

  it('moves between the reports of the project from the switcher', async () => {
    renderDetail('engines-vs-seeds-informe');
    await screen.findByRole('heading', { level: 1, name: 'Comparativa de engines en checkout' });

    expect(within(screen.getByRole('combobox', { name: 'Report' })).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Comparativa de engines en checkout', 'Borrador: placement', 'Notas antiguas',
    ]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Report' }), { target: { value: 'borrador-placement' } });

    expect(await screen.findByRole('heading', { level: 1, name: 'Borrador: placement' })).toBeInTheDocument();
    expect(platform.report).toHaveBeenLastCalledWith('isa-demo', 'qos-benchmarks', 'borrador-placement');
    // Nothing of the previous report stays while the next one is read.
    expect(screen.queryByText('Two engines, two seeds, two revisions of the checkout case.')).not.toBeInTheDocument();
  });

  it('publishes a frozen edition with its citation, and keeps the dialog open when the server refuses', async () => {
    platform.publications.mockResolvedValue([]);
    platform.publishReport.mockRejectedValueOnce(refusal(422, 'private_evidence', 'Job evidence must belong to a public project before report publication.'));
    renderDetail('engines-vs-seeds-informe');
    fireEvent.click(await screen.findByRole('button', { name: 'Publish…' }));

    const dialog = await screen.findByRole('dialog', { name: 'Publish this edition' });
    expect(within(dialog).getByLabelText('Authors')).toHaveValue('lucia.vega');
    expect(within(dialog).getByLabelText('Public address')).toHaveValue('engines-vs-seeds-informe');
    expect(within(dialog).getByRole('list', { name: 'What the server checks' })).toHaveTextContent('Everything it cites is in public projects');
    fireEvent.change(within(dialog).getByLabelText('Authors'), { target: { value: 'Lucía Vega, Marco Díaz' } });
    fireEvent.change(within(dialog).getByLabelText('DOI or link (optional)'), { target: { value: '10.1000/xyz' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));

    expect(await within(dialog).findByText('Some of the evidence is private (422 · private_evidence)')).toBeInTheDocument();
    expect(within(dialog).getByText(/Job evidence must belong to a public project/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));

    expect(await screen.findByText('Published. Anyone can now find, read and verify this edition.')).toBeInTheDocument();
    expect(platform.publishReport).toHaveBeenLastCalledWith('isa-demo', 'qos-benchmarks', {
      report_id: 'report-engines-vs-seeds-informe', version_id: 'version-engines-vs-seeds-informe', slug: 'engines-vs-seeds-informe',
      citation: { title: 'Comparativa de engines en checkout', authors: ['Lucía Vega', 'Marco Díaz'], year: new Date().getFullYear(), doi: '10.1000/xyz' },
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('withdraws a publication and says what stays reachable', async () => {
    platform.deletePublication.mockResolvedValue(undefined);
    renderDetail('engines-vs-seeds-informe');
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));

    const dialog = await screen.findByRole('dialog', { name: 'Withdraw checkout-comparativa?' });
    expect(within(dialog).getByText(/Its link, citation and fingerprint keep working/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));

    expect(await screen.findByText('Withdrawn. It’s no longer listed in Explore, but its link, citation and fingerprint still work.')).toBeInTheDocument();
    expect(platform.deletePublication).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'checkout-comparativa');
  });

  it('starts a new draft from a frozen edition', async () => {
    platform.createReportDraft.mockResolvedValue({ ...FROZEN, state: 'draft' });
    renderDetail('engines-vs-seeds-informe');
    fireEvent.click(await screen.findByRole('button', { name: 'New draft from this edition' }));

    expect(await screen.findByText('New draft started from this edition. The edition itself is unchanged.')).toBeInTheDocument();
    expect(platform.createReportDraft).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds-informe');
  });

  it('edits a draft block by block and saves it with the revision it was read at', async () => {
    platform.updateReport.mockResolvedValue({ ...DRAFT, draft_revision: 4 });
    renderDetail('borrador-placement');
    await screen.findByRole('heading', { level: 1, name: 'Borrador: placement' });

    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
    expect(screen.getByText('Draft revision 3 · saved')).toBeInTheDocument();
    fireEvent.change(textboxOf('Text block 2'), { target: { value: 'Pools and latencies, edited.' } });
    expect(screen.getByText('Draft revision 3 · unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ Heading' }));
    fireEvent.change(textboxOf('Heading block 3'), { target: { value: 'Next steps' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Move block up' })[2]);
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByText('Draft saved.')).toBeInTheDocument();
    expect(platform.updateReport).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'borrador-placement', {
      title: 'Borrador: placement',
      document: {
        blocks: [{ type: 'heading', text: 'Borrador: placement' }, { type: 'heading', text: 'Next steps' }, { type: 'text', text: 'Pools and latencies, edited.' }],
        provenance: {},
      },
      draft_revision: 3,
    });
  });

  it('removes a block and cites a study run as evidence', async () => {
    renderDetail('borrador-placement');
    await screen.findByRole('heading', { level: 1, name: 'Borrador: placement' });

    fireEvent.click(within(screen.getByRole('region', { name: 'Text block 2' })).getByRole('button', { name: 'Remove block' }));
    expect(screen.queryByRole('region', { name: 'Text block 2' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '+ Evidence: study run' }));
    const picker = await screen.findByRole('combobox', { name: 'Study run to cite' });
    await within(picker).findByRole('option', { name: /Engines × semillas · run #1/ });
    fireEvent.change(picker, { target: { value: RUN_ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    const evidence = await screen.findByRole('region', { name: 'Evidence block 2' });
    expect(within(evidence).getByText('Engines × semillas · run #1 · partial')).toBeInTheDocument();
    expect(await within(evidence).findByRole('link', { name: 'Open the run' })).toHaveAttribute('href', `${ROOT}/studies/engines-vs-seeds/runs/${RUN_ID}`);
    expect(screen.getByText('Draft revision 3 · unsaved changes')).toBeInTheDocument();
  });

  it('reads the summary and findings of an older report as blocks and writes them back as blocks', async () => {
    platform.updateReport.mockResolvedValue({ ...LEGACY, draft_revision: 2 });
    renderDetail('notas-antiguas');
    await screen.findByRole('heading', { level: 1, name: 'Notas antiguas' });

    expect(textboxOf('Text block 1')).toHaveValue('Initial notes');
    expect(textboxOf('Text block 2')).toHaveValue('Evolutionary is cheaper but slower.');
    fireEvent.change(textboxOf('Text block 1'), { target: { value: 'Initial notes, revised' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => expect(platform.updateReport).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'notas-antiguas', {
      title: 'Notas antiguas',
      document: { provenance: {}, blocks: [{ type: 'text', text: 'Initial notes, revised' }, { type: 'text', text: 'Evolutionary is cheaper but slower.' }] },
      draft_revision: 1,
    }));
  });

  it('freezes after saving what was typed, and says what the server needs when the provenance is incomplete (422)', async () => {
    platform.updateReport.mockResolvedValue({ ...DRAFT, draft_revision: 4 });
    platform.freezeReport.mockRejectedValueOnce(refusal(422, 'incomplete_provenance', 'Frozen reports require study, datasets, software, bimVersion, engineRevisions and parameters provenance.'));
    renderDetail('borrador-placement');
    await screen.findByRole('heading', { level: 1, name: 'Borrador: placement' });
    fireEvent.change(textboxOf('Text block 2'), { target: { value: 'Edited before freezing.' } });

    fireEvent.click(screen.getByRole('button', { name: 'Freeze edition' }));
    const dialog = await screen.findByRole('dialog', { name: 'Freeze this edition?' });
    expect(within(dialog).getByText(/Your unsaved changes are saved first\./)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Freeze edition' }));

    expect(await screen.findByText('The provenance isn’t complete (422 · incomplete_provenance)')).toBeInTheDocument();
    expect(platform.updateReport).toHaveBeenCalledTimes(1);
    expect(platform.freezeReport).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'borrador-placement');
    expect(screen.getByLabelText('Report document (JSON)').closest('details')).toHaveAttribute('open');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('freezes a draft and says the edition can no longer change', async () => {
    platform.freezeReport.mockResolvedValue({ ...DRAFT, state: 'frozen', digest: EDITION });
    renderDetail('borrador-placement');
    fireEvent.click(await screen.findByRole('button', { name: 'Freeze edition' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Freeze this edition?' })).getByRole('button', { name: 'Freeze edition' }));

    expect(await screen.findByText('Frozen as a new edition. It can’t change any more; its fingerprint was assigned by the server.')).toBeInTheDocument();
    expect(platform.updateReport).not.toHaveBeenCalled();
  });

  it('keeps what was typed when someone else saved a newer revision (409), and loads theirs on request', async () => {
    platform.updateReport.mockRejectedValue(refusal(409, 'draft_conflict'));
    renderDetail('borrador-placement');
    await screen.findByRole('heading', { level: 1, name: 'Borrador: placement' });
    fireEvent.change(textboxOf('Text block 2'), { target: { value: 'My version' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByText('Someone saved a newer draft revision (409 · draft_conflict)')).toBeInTheDocument();
    expect(textboxOf('Text block 2')).toHaveValue('My version');
    platform.report.mockResolvedValueOnce({
      ...DRAFT, draft_revision: 4, document: { blocks: [{ type: 'heading', text: 'Borrador: placement' }, { type: 'text', text: 'Their version' }], provenance: {} },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load the newer draft' }));
    await waitFor(() => expect(platform.report).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(textboxOf('Text block 2')).toHaveValue('Their version'));
    expect(screen.getByText('Draft revision 4 · saved')).toBeInTheDocument();
  });

  it('lets a viewer read and nothing else', async () => {
    renderDetail('borrador-placement', 'read-lab');
    await screen.findByRole('heading', { level: 1, name: 'Borrador: placement' });

    expect(screen.getByText('Read-only for you: editing needs MEMBER, publishing needs ADMIN.')).toBeInTheDocument();
    for (const name of ['Save draft', 'Freeze edition', 'New draft from this edition', 'Publish…', 'Withdraw', 'Delete', '+ Text']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(within(screen.getByRole('article', { name: 'Report content' })).queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Report document (JSON)').tagName).toBe('PRE');
  });

  it('lets a member edit but leaves publishing to an admin', async () => {
    renderDetail('engines-vs-seeds-informe', 'team-lab');
    await screen.findByRole('heading', { level: 1, name: 'Comparativa de engines en checkout' });

    expect(screen.getByRole('button', { name: 'New draft from this edition' })).toBeInTheDocument();
    expect(screen.getByText('Publishing needs ADMIN.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('deletes a draft, and reports the refusal when editions exist (409)', async () => {
    platform.deleteReport.mockRejectedValueOnce(refusal(409, 'report_history_retained')).mockResolvedValueOnce(undefined);
    renderDetail('borrador-placement');
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete Borrador: placement?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete report' }));
    expect(await within(dialog).findByText('This report has frozen editions (409 · report_history_retained)')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete report' }));
    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    expect(platform.deleteReport).toHaveBeenLastCalledWith('isa-demo', 'qos-benchmarks', 'borrador-placement');
  });

  it('shows a saved binding decision and the way to reopen it in the decision space', async () => {
    const recorded = {
      kind: 'binding-decision', version: 'binding-archive/v1', revision: 'sha256-rev', sources: [{ id: 'f1a1b2c3-0000', engine: 'random-search', resultDigest: `sha256-${'f'.repeat(64)}` }], dimensions: [],
      query: { sources: ['f1a1b2c3-0000'], rule: 'balanced' }, scope: 'Stored evaluated bindings only; unexplored space remains unknown', selected: [detailOf()],
    };
    const decision: Report = reportOf('decision-choice', 'draft', { title: 'Checkout choice', document: recorded });
    platform.report.mockResolvedValue(decision);
    platform.reports.mockResolvedValue([decision]);
    renderDetail('decision-choice');

    expect(await screen.findByRole('heading', { level: 2, name: 'Recorded binding decision' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Reopen decision space' })).toHaveAttribute('href', '/app/analysis/workspace?report=isa-demo%2Fqos-benchmarks%2Fdecision-choice');
    expect(screen.getByRole('heading', { level: 3, name: 'Binding a1a1a1a1a1' })).toBeInTheDocument();
    expect(screen.getByText('random-search · job f1a1b2c3…')).toBeInTheDocument();
  });

  it('answers a report that is not there with the same words whoever asks (404)', async () => {
    platform.report.mockRejectedValue(refusal(404, 'not_found'));
    renderDetail('ghost');

    expect(await screen.findByRole('heading', { name: 'Report not found' })).toBeInTheDocument();
    expect(screen.getByText('No report with this address in QoS Benchmarks (404).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All reports' })).toHaveAttribute('href', `${ROOT}/reports`);
  });

  it('says a key cannot read the report (403) and a service that does not answer (503)', async () => {
    platform.report.mockRejectedValueOnce(refusal(403, 'api_key_boundary'));
    const view = renderDetail('borrador-placement');
    expect(await screen.findByText(/This API key can’t read this report \(403 · api_key_boundary\)/)).toBeInTheDocument();
    view.unmount();

    platform.report.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderDetail('borrador-placement');
    const message = await screen.findByText(/The report couldn’t be loaded \(503 · unavailable\)/);
    fireEvent.click(within(message.closest('.ui-notice') as HTMLElement).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Borrador: placement' })).toBeInTheDocument();
  });
});
