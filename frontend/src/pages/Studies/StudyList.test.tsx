import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { cellsFixture, runFixture, studyFixture } from '../../test/fixtures/studies';
import { StudyList } from './StudyList';

const platform = vi.hoisted(() => ({
  project: vi.fn(), publicProjects: vi.fn(), studies: vi.fn(), studyRuns: vi.fn(), studyCells: vi.fn(), updateStudy: vi.fn(), deleteStudy: vi.fn(),
}));
const client = vi.hoisted(() => ({ getOwnUsage: vi.fn() }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: client }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const member = org('team-lab', { name: 'Team Lab', effective_role: 'MEMBER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const ROOT = '/app/isa-demo/qos-benchmarks';

const tracked = (id: string, limit: number, used: number, extra: Record<string, unknown> = {}) => ({ limit_id: id, limit, used, remaining: Math.max(0, limit - used), unit: null, renews_at: null, ...extra });
const usage = (runsUsed = 4) => ({
  plan: 'RESEARCH', contract_pending: false, features: {}, capabilities: {},
  limits: { studies: tracked('studies', 25, 1), studyRuns: tracked('studyRuns', 100, runsUsed, { renews_at: '2026-11-01T00:00:00Z' }) },
});

const refusal = (status: number, code: string) => Object.assign(new HttpError(status, 'refused'), { code });

function renderList(options: { organizations?: ReturnType<typeof org>[]; slug?: string } = {}) {
  return renderProjectScreen(<StudyList />, {
    path: '/app/:org/:project/studies', url: `/app/${options.slug ?? 'isa-demo'}/qos-benchmarks/studies`, organizations: options.organizations ?? [group, viewing, member],
  });
}

describe('Studies of a project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.studies.mockResolvedValue([studyFixture()]);
    platform.studyRuns.mockResolvedValue([runFixture()]);
    platform.studyCells.mockResolvedValue(cellsFixture());
    client.getOwnUsage.mockResolvedValue(usage());
  });

  it('lists each study with its matrix, its latest run and how that run ended', async () => {
    renderList();

    expect(await screen.findByRole('heading', { level: 1, name: 'Studies' })).toBeInTheDocument();
    expect(screen.getByText(/A study runs every combination of cases × engines × settings × seeds/)).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Studies of the project' });
    expect(within(list).getByRole('link', { name: /Engines × seeds/ })).toHaveAttribute('href', `${ROOT}/studies/engines-vs-seeds`);
    expect(within(list).getByText('2 case revisions × 2 engines × 1 setting × 2 seeds = 8 cells')).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Last run #1' })).toHaveAttribute('href', `${ROOT}/studies/engines-vs-seeds/runs/00000000-0000-4000-8000-000000000101`);
    expect(within(list).getByRole('img', { name: '6 completed, 1 failed, 1 cancelled of 8 cells' })).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Studies' })).toHaveAttribute('aria-current', 'page');
    expect(platform.studies).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', true);
  });

  it('shows what the sponsor’s plan and the month have left', async () => {
    client.getOwnUsage.mockResolvedValue(usage(100));
    renderList();

    expect(await screen.findByText('1 of 25')).toBeInTheDocument();
    expect(screen.getByText('Counted across the sponsor’s organizations · doesn’t renew')).toBeInTheDocument();
    expect(screen.getByText('100 of 100')).toBeInTheDocument();
    expect(screen.getByText('Used up · renews Nov 1, 2026')).toBeInTheDocument();
  });

  it('does not show the sponsor’s figures to someone who is not the sponsor, and says why', async () => {
    renderList({ organizations: [org('isa-demo', { name: 'ISA Demo Group', billing_sponsor_user_id: 'user-nora' })] });

    expect(await screen.findByText('Counted against the sponsor’s plan; their usage isn’t shown to you')).toBeInTheDocument();
    expect(screen.queryByText('1 of 25')).not.toBeInTheDocument();
  });

  it('explains what a study is when there are none, and offers to build one', async () => {
    platform.studies.mockResolvedValue([]);
    renderList();

    expect(await screen.findByText('No studies yet')).toBeInTheDocument();
    expect(screen.getByText('2 case revisions × 2 engines × 2 seeds = 8 runs, all with the same rules. That’s a study.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Build a study' })).toHaveAttribute('href', `${ROOT}/studies/new`);
    expect(screen.getByRole('link', { name: 'New study' })).toHaveAttribute('href', `${ROOT}/studies/new`);
  });

  it('lets a viewer read: no new study, no archive, no delete', async () => {
    renderList({ slug: 'read-lab' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Studies' })).toBeInTheDocument();
    expect(await screen.findByRole('list', { name: 'Studies of the project' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New study' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('lets a member create and archive but not delete', async () => {
    renderList({ slug: 'team-lab' });

    expect(await screen.findByRole('link', { name: 'New study' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('archives a study and restores it', async () => {
    platform.updateStudy.mockResolvedValue(studyFixture({ archived: true }));
    renderList();

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('Archived: it can’t start new runs, and existing results stay.')).toBeInTheDocument();
    expect(platform.updateStudy).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds', { archived: true });
  });

  it('keeps archived studies out of sight until asked', async () => {
    platform.studies.mockResolvedValue([studyFixture(), studyFixture({ id: 'study-old', slug: 'old', name: 'Old study', archived: true })]);
    renderList();

    const list = await screen.findByRole('list', { name: 'Studies of the project' });
    expect(within(list).queryByText('Old study')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /Show archived studies/ }));
    expect(within(list).getByText('Old study')).toBeInTheDocument();
    expect(within(list).getByText('Archived')).toBeInTheDocument();
    expect(within(list).getByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('archives instead when a study with runs is deleted, because runs are history', async () => {
    platform.deleteStudy.mockRejectedValue(refusal(409, 'study_history_retained'));
    platform.updateStudy.mockResolvedValue(studyFixture({ archived: true }));
    renderList();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Engines × seeds?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete study' }));

    expect(await screen.findByText('This study has runs, so it was archived instead of deleted. Results cited by reports stay intact.')).toBeInTheDocument();
    expect(platform.deleteStudy).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds');
    expect(platform.updateStudy).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'engines-vs-seeds', { archived: true });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('says why a delete was refused', async () => {
    platform.deleteStudy.mockRejectedValue(refusal(403, 'forbidden'));
    renderList();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete study' }));

    expect(await screen.findByText(/This account or key can’t do that \(403 · forbidden\)/)).toBeInTheDocument();
    expect(platform.updateStudy).not.toHaveBeenCalled();
  });

  it('offers a retry when the list cannot be loaded', async () => {
    platform.studies.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderList();

    expect(await screen.findByText(/Studies couldn’t be loaded \(503 · unavailable\)/)).toBeInTheDocument();
    expect(screen.queryByText('No studies yet')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Studies of the project' })).toBeInTheDocument();
  });

  it('reads a project that is not there like one the account cannot see', async () => {
    platform.project.mockRejectedValue(refusal(404, 'not_found'));
    renderList();

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
  });
});
