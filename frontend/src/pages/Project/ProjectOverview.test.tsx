import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import type { Job, StudyCell } from '../../api/platform';
import { ProjectOverview } from './ProjectOverview';
import { caseOf, iker, org, project, renderProjectScreen, reportOf, revisionOf, runOf, studyOf } from './testKit';

const api = vi.hoisted(() => ({ listOwnJobs: vi.fn() }));
const platform = vi.hoisted(() => ({
  project: vi.fn(), cases: vi.fn(), revisions: vi.fn(), projectJobs: vi.fn(), studies: vi.fn(), studyRuns: vi.fn(), studyCells: vi.fn(),
  reports: vi.fn(), publications: vi.fn(), publicProjects: vi.fn(),
}));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks', description: 'Reference binding cases.', visibility: 'public' });
const checkout = caseOf('flujo', 'Flujo de checkout', { description: 'Catalog grown from 5 to 8 candidates.' });
const study = studyOf('engines', { name: 'Engines × seeds' });

const job = (id: string, engine: string, status: string, termination: string | null, createdAt: string, finishedAt: string | null): Job => ({
  id, engine_id: engine, status, cancellation_requested: false, retry_of_id: null, organization_id: group.id, project_id: qos.id, created_at: createdAt, finished_at: finishedAt, termination: termination as Job['termination'],
});

const cell = (n: number, state: StudyCell['state']): StudyCell => ({
  id: `cell-${n}`, study_run_id: 'run', ordinal: n, binding_case_revision_id: 'rev', engine_ref: {}, parameters: {}, seed: n, fingerprint: 'f', job_id: null, state, metrics: {},
});

const jobs = [
  job('job-1', 'minizinc', 'running', null, '2026-10-08T08:00:00Z', null),
  job('job-2', 'minizinc', 'completed', 'INFEASIBLE', '2026-10-01T09:00:00Z', '2026-10-01T09:00:40Z'),
  job('job-3', 'random-search', 'completed', 'FEASIBLE', '2026-09-30T09:00:00Z', '2026-09-30T09:01:05Z'),
];

function renderOverview(options: { organizations?: ReturnType<typeof org>[]; slug?: string; user?: Parameters<typeof renderProjectScreen>[1]['user'] } = {}) {
  return renderProjectScreen(<ProjectOverview />, {
    path: '/app/:org/:project', url: `/app/${options.slug ?? 'isa-demo'}/qos-benchmarks`, organizations: options.organizations ?? [group, viewing], user: options.user,
  });
}

const refusal = (status: number, code = 'refused') => Object.assign(new HttpError(status, 'refused'), { code });

describe('Project overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.cases.mockResolvedValue([checkout]);
    platform.revisions.mockResolvedValue([revisionOf(checkout, 1), revisionOf(checkout, 2)]);
    platform.projectJobs.mockResolvedValue(jobs);
    api.listOwnJobs.mockResolvedValue({ jobs: [{ id: 'job-1' }, { id: 'job-3' }], total: 2, retention_days: 180 });
    platform.studies.mockResolvedValue([study]);
    platform.studyRuns.mockResolvedValue([runOf(study, 1)]);
    platform.studyCells.mockResolvedValue([...[1, 2, 3, 4, 5, 6].map((n) => cell(n, 'completed')), cell(7, 'failed'), cell(8, 'cancelled')]);
    platform.reports.mockResolvedValue([reportOf('comparativa', 'frozen', { title: 'Engine comparison' }), reportOf('borrador', 'draft', { title: 'Draft: placement' })]);
    platform.publications.mockResolvedValue([{ id: 'pub', report_id: 'report-comparativa', withdrawn: false }]);
    platform.publicProjects.mockResolvedValue([]);
  });

  it('opens with the project’s name, visibility, role and the actions of the project', async () => {
    renderOverview();

    const title = await screen.findByRole('heading', { level: 1, name: 'QoS Benchmarks' });
    const band = title.closest('.proj-band') as HTMLElement;
    expect(within(band).getByText('Public')).toBeInTheDocument();
    expect(within(band).getByText('OWNER')).toBeInTheDocument();
    expect(within(band).getByText('Reference binding cases.')).toBeInTheDocument();
    const root = '/app/isa-demo/qos-benchmarks';
    expect(within(band).getByRole('link', { name: 'New case' })).toHaveAttribute('href', `${root}/cases`);
    expect(within(band).getByRole('link', { name: 'Run' })).toHaveAttribute('href', `${root}/jobs/new`);
    expect(within(band).getByRole('link', { name: 'New study' })).toHaveAttribute('href', `${root}/studies/new`);
    expect(within(band).getByRole('link', { name: 'New report' })).toHaveAttribute('href', `${root}/reports`);
    expect(within(band).getByRole('link', { name: 'Workbench' })).toHaveAttribute('href', `${root}/workbench`);
    expect(within(band).getByRole('link', { name: 'Export package' })).toHaveAttribute('href', `${root}/package`);
    const crumbs = within(band).getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute('href', '/app/isa-demo');
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', `${root}/settings`);
  });

  it('shows the sealed against draft strip with what the project holds', async () => {
    renderOverview();

    const strip = await screen.findByRole('region', { name: 'What’s sealed and what’s still a draft' });
    const chips = within(strip).getByRole('list', { name: 'Sealed and draft items' });
    expect(within(chips).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['2 case revisions', '1 study run', '1 frozen report', '1 report draft']);
  });

  it('lists the cases with their revisions', async () => {
    renderOverview();

    const cases = await screen.findByRole('region', { name: 'Cases' });
    const card = await within(cases).findByRole('link', { name: /Flujo de checkout/ });
    expect(card).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/cases/flujo');
    expect(within(card).getByText('2 revisions')).toBeInTheDocument();
    expect(within(card).getByText('r1')).toBeInTheDocument();
    expect(within(card).getByText('r2')).toHaveAttribute('title', expect.stringContaining('latest'));
    expect(within(card).getByText('Catalog grown from 5 to 8 candidates.')).toBeInTheDocument();
    expect(within(cases).getByRole('link', { name: 'All cases' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/cases');
  });

  it('lists every job as a summary but opens only the ones this account launched', async () => {
    renderOverview();

    const card = await screen.findByRole('region', { name: 'Recent jobs' });
    const list = await within(card).findByRole('list', { name: 'Recent jobs' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('Running')).toBeInTheDocument();
    expect(within(list).getByText('No feasible binding')).toBeInTheDocument();
    expect(within(list).getByText('Feasible')).toBeInTheDocument();
    expect(within(list).getByText(/Oct 1, 2026, 09:00 UTC · 40 s/)).toBeInTheDocument();
    const opens = within(list).getAllByRole('link');
    expect(opens.map((link) => link.getAttribute('href'))).toEqual([
      '/app/isa-demo/qos-benchmarks/jobs/job-1', '/app/isa-demo/qos-benchmarks/jobs/job-3',
    ]);
    expect(within(list).getAllByText('Owner only')).toHaveLength(1);
    expect(within(list).getByText('Owner only')).toHaveAttribute('title', 'Jobs open only for whoever launched them');
  });

  it('lets a platform administrator open every job', async () => {
    renderOverview({ user: iker });

    const list = await screen.findByRole('list', { name: 'Recent jobs' });
    expect(within(list).getAllByRole('link')).toHaveLength(3);
    expect(within(list).queryByText('Owner only')).not.toBeInTheDocument();
  });

  it('draws the latest run of a study as a stacked bar', async () => {
    renderOverview();

    const card = await screen.findByRole('region', { name: 'Studies' });
    expect(await within(card).findByText('Run #1 · partial')).toBeInTheDocument();
    expect(within(card).getByText('2 case revisions × 2 engines × 2 seeds = 8 cells · Sep 20, 2026')).toBeInTheDocument();
    expect(within(card).getByRole('img', { name: '6 completed, 1 failed, 1 cancelled of 8' })).toBeInTheDocument();
  });

  it('marks a published report and links to verify it', async () => {
    renderOverview();

    const card = await screen.findByRole('region', { name: 'Reports' });
    expect(await within(card).findByText('Published')).toBeInTheDocument();
    expect(within(card).getByText('Draft · revision 3')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Verify Engine comparison' })).toHaveAttribute('href', `/resolve/report/sha256-${'e'.repeat(64)}`);
    expect(within(card).getByRole('link', { name: 'Engine comparison' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/reports/comparativa');
  });

  describe('a card that fails does not take the others with it', () => {
    it('jobs: says so, keeps the rest, and loads on retry', async () => {
      platform.projectJobs.mockRejectedValueOnce(refusal(503, 'unavailable'));
      renderOverview();

      const card = await screen.findByRole('region', { name: 'Recent jobs' });
      expect(await within(card).findByRole('alert')).toHaveTextContent('Jobs couldn’t be loaded (503 · unavailable). The rest of the page is unaffected.');
      expect(await screen.findByRole('link', { name: /Flujo de checkout/ })).toBeInTheDocument();
      expect(screen.getByRole('region', { name: 'Reports' })).toBeInTheDocument();

      fireEvent.click(within(card).getByRole('button', { name: 'Retry' }));
      expect(await within(card).findByRole('list', { name: 'Recent jobs' })).toBeInTheDocument();
    });

    it('jobs: a key without permission is told apart', async () => {
      platform.projectJobs.mockRejectedValue(refusal(403, 'forbidden'));
      renderOverview();

      const card = await screen.findByRole('region', { name: 'Recent jobs' });
      expect(await within(card).findByRole('alert')).toHaveTextContent('You can’t list jobs with this account or key (403).');
    });

    it('cases: the strip waits for the numbers it can’t compute', async () => {
      platform.cases.mockRejectedValue(refusal(503));
      renderOverview();

      expect(await screen.findByText(/Cases couldn’t be loaded \(503/)).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'What’s sealed and what’s still a draft' })).not.toBeInTheDocument();
      expect(await screen.findByRole('list', { name: 'Recent jobs' })).toBeInTheDocument();
    });
  });

  describe('as a VIEWER', () => {
    beforeEach(() => {
      platform.project.mockResolvedValue(project('qos-benchmarks', { name: 'QoS Benchmarks', organization_id: viewing.id }));
    });

    it('reads everything and exports, but cannot create', async () => {
      renderOverview({ slug: 'read-lab' });

      const title = await screen.findByRole('heading', { level: 1, name: 'QoS Benchmarks' });
      const band = title.closest('.proj-band') as HTMLElement;
      expect(within(band).getByText('VIEWER')).toBeInTheDocument();
      expect(within(band).queryByRole('link', { name: 'New case' })).not.toBeInTheDocument();
      expect(within(band).getByText('New case')).toHaveAttribute('aria-disabled', 'true');
      expect(within(band).getByText('New case')).toHaveAttribute('title', 'Needs MEMBER');
      expect(within(band).getByText('Run')).toHaveAttribute('aria-disabled', 'true');
      expect(within(band).getByRole('link', { name: 'Export package' })).toBeEnabled();
      expect(within(band).getByText('You’re a VIEWER: you can read everything here and export the package; creating needs MEMBER.')).toBeInTheDocument();
    });
  });

  it('guides an empty project instead of showing four empty cards', async () => {
    platform.cases.mockResolvedValue([]);
    platform.projectJobs.mockResolvedValue([]);
    platform.studies.mockResolvedValue([]);
    platform.reports.mockResolvedValue([]);
    renderOverview();

    const guide = await screen.findByRole('region', { name: 'Get started' });
    const steps = within(guide).getAllByRole('listitem');
    expect(steps).toHaveLength(3);
    expect(within(guide).getByRole('link', { name: 'Browse examples' })).toHaveAttribute('href', '/examples');
    expect(within(guide).getByRole('link', { name: 'New case' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/cases');
    expect(within(guide).getByRole('link', { name: 'Open Workbench' })).toHaveAttribute('href', '/workbench');
    expect(screen.queryByRole('region', { name: 'Recent jobs' })).not.toBeInTheDocument();
  });

  describe('when the project can’t be opened', () => {
    it('404: not found, with no hint about what exists, and a way back', async () => {
      platform.project.mockRejectedValue(refusal(404, 'not_found'));
      renderOverview();

      expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
      expect(screen.getByText(/It doesn’t exist, or you’re not a member of its organization\. Even public projects open here only for members\./)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/app');
      expect(screen.queryByRole('link', { name: 'See its public card in Explore' })).not.toBeInTheDocument();
    });

    it('404 of a public project: the gate points to its Explore card', async () => {
      platform.project.mockRejectedValue(refusal(404, 'not_found'));
      platform.publicProjects.mockResolvedValue([{ organization: { slug: 'isa-demo', name: 'ISA' }, project: { slug: 'qos-benchmarks', name: 'QoS', description: '' } }]);
      renderOverview();

      expect(await screen.findByRole('link', { name: 'See its public card in Explore' })).toHaveAttribute('href', '/explore');
    });

    it('the same message when the organization itself is not one of the account’s', async () => {
      renderOverview({ slug: 'ghost-lab' });

      expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
      expect(platform.project).not.toHaveBeenCalled();
    });

    it('403: the role is too low', async () => {
      platform.project.mockRejectedValue(refusal(403, 'organization_forbidden'));
      renderOverview();

      expect(await screen.findByRole('heading', { name: 'Your role doesn’t reach this (403 · organization_forbidden)' })).toBeInTheDocument();
      expect(screen.getByText('This needs a higher role in ISA Demo Group. Ask one of its admins.')).toBeInTheDocument();
    });

    it('503: the gateway did not answer, and it can be asked again', async () => {
      platform.project.mockRejectedValueOnce(refusal(503, 'unavailable'));
      renderOverview();

      expect(await screen.findByRole('heading', { name: 'The project couldn’t be loaded (503 · unavailable)' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'QoS Benchmarks' })).toBeInTheDocument();
      await waitFor(() => expect(platform.project).toHaveBeenCalledTimes(2));
    });
  });
});
