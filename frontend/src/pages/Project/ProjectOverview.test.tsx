import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { ProjectOverview } from './ProjectOverview';
import { iker, org, project, renderProjectScreen } from '../../features/workspace/testKit';

const platform = vi.hoisted(() => ({
  project: vi.fn(),
}));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks', description: 'Reference binding cases.', visibility: 'public' });

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
  });

  it('opens with the project’s name, visibility, role and the actions of the project', async () => {
    renderOverview();

    const title = await screen.findByRole('heading', { level: 1, name: 'QoS Benchmarks' });
    const band = title.closest('.proj-band') as HTMLElement;
    expect(within(band).getByText('Public')).toBeInTheDocument();
    expect(within(band).getByText('OWNER')).toBeInTheDocument();
    expect(within(band).getByText('Reference binding cases.')).toBeInTheDocument();
    const root = '/app/isa-demo/qos-benchmarks';
    expect(within(band).getByRole('link', { name: 'Run' })).toHaveAttribute('href', '/app/isa-demo/runs/new');
    // Studies belong to the organization (F0b B7).
    expect(within(band).getByRole('link', { name: 'Studies' })).toHaveAttribute('href', '/app/isa-demo/studies');
    expect(within(band).queryByRole('link', { name: 'New study' })).not.toBeInTheDocument();
    expect(within(band).queryByText('New report')).not.toBeInTheDocument();
    // Problems and the Workbench belong to the organization.
    expect(within(band).getByRole('link', { name: 'Problems' })).toHaveAttribute('href', '/app/isa-demo/problems');
    expect(within(band).getByRole('link', { name: 'Workbench' })).toHaveAttribute('href', '/app/isa-demo/workbench');
    expect(within(band).queryByRole('link', { name: 'Export package' })).not.toBeInTheDocument();
    const crumbs = within(band).getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute('href', '/app/isa-demo');
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).getByRole('link', { name: 'Settings' })).toHaveAttribute('href', `${root}/settings`);
  });

  it('has no Problems, runs or Studies card: they belong to the organization', async () => {
    renderOverview();

    expect(await screen.findByRole('region', { name: 'Get started' })).toBeInTheDocument();
    for (const name of ['Problems', 'Recent runs', 'Studies']) expect(screen.queryByRole('region', { name })).not.toBeInTheDocument();
    const hrefs = Array.from(document.querySelectorAll('a[href]')).map((link) => link.getAttribute('href'));
    expect(hrefs).not.toContain('/app/isa-demo/qos-benchmarks/runs');
    expect(hrefs).not.toContain('/app/isa-demo/qos-benchmarks/studies');
  });

  it('has no Reports card, no All reports link and no link to the retired report addresses, and keeps the other cards', async () => {
    renderOverview();

    expect(await screen.findByRole('region', { name: 'Get started' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Reports' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'All reports' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New report' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No reports yet/)).not.toBeInTheDocument();
    const hrefs = Array.from(document.querySelectorAll('a[href]')).map((link) => link.getAttribute('href') ?? '');
    expect(hrefs.filter((href) => /\/reports([/?#]|$)/.test(href))).toEqual([]);
  });

  describe('as a VIEWER', () => {
    beforeEach(() => {
      platform.project.mockResolvedValue(project('qos-benchmarks', { name: 'QoS Benchmarks', organization_id: viewing.id }));
    });

    it('reads everything, but cannot run or create', async () => {
      renderOverview({ slug: 'read-lab' });

      const title = await screen.findByRole('heading', { level: 1, name: 'QoS Benchmarks' });
      const band = title.closest('.proj-band') as HTMLElement;
      expect(within(band).getByText('VIEWER')).toBeInTheDocument();
      expect(within(band).getByText('Run')).toHaveAttribute('aria-disabled', 'true');
      expect(within(band).getByText('Run')).toHaveAttribute('title', 'Needs MEMBER');
      expect(within(band).queryByRole('link', { name: 'Export package' })).not.toBeInTheDocument();
      expect(within(band).getByText('You’re a VIEWER: you can read everything here; creating needs MEMBER.')).toBeInTheDocument();
    });
  });

  it('guides a member to the organization’s problems and runs', async () => {
    renderOverview();

    const guide = await screen.findByRole('region', { name: 'Get started' });
    const steps = within(guide).getAllByRole('listitem');
    expect(steps).toHaveLength(3);
    expect(within(guide).getByRole('link', { name: 'Open problems' })).toHaveAttribute('href', '/app/isa-demo/problems');
    expect(within(guide).getByRole('link', { name: 'New run' })).toHaveAttribute('href', '/app/isa-demo/runs/new');
    expect(within(guide).getByRole('link', { name: 'Open Workbench' })).toHaveAttribute('href', '/workbench');
    expect(screen.queryByRole('region', { name: 'Recent runs' })).not.toBeInTheDocument();
  });

  describe('a public project opened by someone who is not a member', () => {
    const visitor = { ...qos, organization_id: 'org-open', created_by_id: null, access: 'public_read' as const, effective_role: null };

    function renderVisitor() {
      platform.project.mockResolvedValue(visitor);
      return renderOverview({ slug: 'open-lab' });
    }

    it('opens read-only, with the strip, the reading tabs and no control that writes or reaches the members’ parts', async () => {
      renderVisitor();

      const title = await screen.findByRole('heading', { level: 1, name: 'QoS Benchmarks' });
      expect(platform.project).toHaveBeenCalledWith('open-lab', 'qos-benchmarks');
      const band = title.closest('.proj-band') as HTMLElement;
      expect(screen.getByText('You are viewing a public project (read-only).')).toBeInTheDocument();
      expect(within(band).getByText('Public')).toBeInTheDocument();
      expect(within(band).queryByText('No role')).not.toBeInTheDocument();
      for (const name of ['New problem', 'Run', 'New study', 'New report', 'Export package']) {
        expect(within(band).queryByText(name)).not.toBeInTheDocument();
      }
      expect(within(band).queryByRole('link', { name: 'Problems' })).not.toBeInTheDocument();
      const tabs = within(screen.getByRole('navigation', { name: 'Project sections' }));
      expect(tabs.getAllByRole('link').map((link) => link.textContent)).toEqual(['Overview']);
      expect(tabs.queryByRole('link', { name: 'Published' })).not.toBeInTheDocument();
      expect(tabs.queryByRole('link', { name: 'Reports' })).not.toBeInTheDocument();
      expect(tabs.queryByRole('link', { name: 'Runs' })).not.toBeInTheDocument();
      expect(tabs.queryByRole('link', { name: 'Package' })).not.toBeInTheDocument();
      expect(tabs.queryByRole('link', { name: 'Settings' })).not.toBeInTheDocument();
    });

    it('shows no studies, no runs and not the get-started guide of a member', async () => {
      renderVisitor();

      expect(await screen.findByText('Nothing has been shared in this project yet.')).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Get started' })).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Studies' })).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Recent runs' })).not.toBeInTheDocument();
    });

    it('treats a platform administrator who is not a member as a visitor too: public reading never writes', async () => {
      platform.project.mockResolvedValue(visitor);
      renderOverview({ slug: 'open-lab', user: iker });

      const title = await screen.findByRole('heading', { level: 1, name: 'QoS Benchmarks' });
      expect(within(title.closest('.proj-band') as HTMLElement).queryByText('Run')).not.toBeInTheDocument();
    });
  });

  describe('when the project can’t be opened', () => {
    it('404: not found, with no hint about what exists, and a way back', async () => {
      platform.project.mockRejectedValue(refusal(404, 'not_found'));
      renderOverview();

      expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
      expect(screen.getByText(/It doesn’t exist, or it’s private and you’re not a member of its organization\./)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/app');
      expect(screen.queryByRole('link', { name: /Explore/ })).not.toBeInTheDocument();
    });

    it('the same message when the organization itself is not one of the account’s and the project is private', async () => {
      platform.project.mockRejectedValue(refusal(403, 'organization_forbidden'));
      renderOverview({ slug: 'ghost-lab' });

      expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
      expect(platform.project).toHaveBeenCalledWith('ghost-lab', 'qos-benchmarks');
      expect(screen.queryByText(/Your role doesn’t reach this/)).not.toBeInTheDocument();
    });

    it('429: too many reads of public projects says when to try again, with a countdown', async () => {
      platform.project.mockRejectedValue(Object.assign(refusal(429, 'rate_limit_exceeded'), { retryAfter: 42 }));
      renderOverview({ slug: 'open-lab' });

      expect(await screen.findByRole('heading', { name: 'You’re reading public projects too fast' })).toBeInTheDocument();
      expect(screen.getByText('42s')).toBeInTheDocument();
      expect(screen.getByText('Retry is available when the countdown ends.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry now' })).toBeDisabled();
    });

    it('503 for an organization that is not the account’s says nothing about its access', async () => {
      platform.project.mockRejectedValue(refusal(503, 'unavailable'));
      renderOverview({ slug: 'open-lab' });

      expect(await screen.findByRole('heading', { name: 'The project couldn’t be loaded (503 · unavailable)' })).toBeInTheDocument();
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
