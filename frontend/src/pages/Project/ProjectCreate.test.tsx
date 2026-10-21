import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { ProjectCreate } from './ProjectCreate';
import { org, project, renderProjectScreen, usageWithProjects } from './testKit';

const api = vi.hoisted(() => ({ getOwnUsage: vi.fn() }));
const platform = vi.hoisted(() => ({ createProject: vi.fn(), members: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const consultora = org('consultora-demo', { name: 'Consultora Demo', effective_role: 'VIEWER', billing_sponsor_user_id: 'user-nora' });

function renderCreate(organizations = [group, consultora], slug = 'isa-demo', projects = [project('qos-benchmarks')]) {
  return renderProjectScreen(<ProjectCreate />, { path: '/app/:org/new-project', url: `/app/${slug}/new-project`, organizations, projects });
}

const refusal = (status: number, code: string) => Object.assign(new HttpError(status, 'refused'), { code });
const fill = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('New project', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getOwnUsage.mockResolvedValue(usageWithProjects());
    platform.members.mockResolvedValue([]);
    platform.createProject.mockImplementation(async (_org: string, value: { slug: string; name: string; visibility: 'public' | 'private' }) => (
      project(value.slug, { name: value.name, visibility: value.visibility })
    ));
  });

  it('frames the form with the breadcrumb, the title and a disabled Create until it is valid', async () => {
    renderCreate();

    expect(await screen.findByRole('heading', { level: 1, name: 'New project in ISA Demo Group' })).toBeInTheDocument();
    expect(screen.getByText('A project holds the cases, runs, studies and reports for one piece of work.')).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute('href', '/app/isa-demo');
    expect(within(crumbs).getByText('New project')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: /^Private/ })).toBeChecked();
    expect(screen.getByRole('link', { name: 'Cancel' })).toHaveAttribute('href', '/app/isa-demo');
  });

  it('suggests the address from the name until the address is edited, and checks it', async () => {
    renderCreate();
    await screen.findByRole('heading', { level: 1 });

    fill('Name', 'Placement multi-región');
    expect(screen.getByLabelText('Address')).toHaveValue('placement-multi-region');
    expect(screen.getByText('Looks good · can’t be changed later.')).toBeInTheDocument();
    expect(screen.getByText('/app/isa-demo/placement-multi-region')).toBeInTheDocument();

    fill('Address', 'Bad Slug');
    expect(screen.getByLabelText('Address')).toBeInvalid();
    expect(screen.getByText(/Use lowercase letters, numbers and hyphens; start and end/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();

    fill('Name', 'Another name');
    expect(screen.getByLabelText('Address')).toHaveValue('Bad Slug');

    fill('Address', 'qos-benchmarks');
    expect(screen.getByText('Already used in this organization.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
  });

  it('counts the description', async () => {
    renderCreate();
    await screen.findByRole('heading', { level: 1 });

    fill(/^Description/, 'Reference cases');
    expect(screen.getByText('15 / 2,000')).toBeInTheDocument();
  });

  it('shows the sponsor’s plan limits, says a private project counts twice, and draws no meter', async () => {
    renderCreate();

    expect(await screen.findByText('Up to 50')).toBeInTheDocument();
    expect(screen.getByText('Up to 30')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
    expect(screen.getByText(/A private project counts twice: once as a project, once as private\./)).toBeInTheDocument();
  });

  it('says whose usage is hidden when someone else sponsors the organization', async () => {
    platform.members.mockResolvedValue([{ id: 'm', organization_id: group.id, user_id: 'user-nora', username: 'nora', email: 'nora@example.test', role: 'OWNER', created_at: '2026-03-04T00:00:00Z' }]);
    renderCreate([org('isa-demo', { name: 'ISA Demo Group', billing_sponsor_user_id: 'user-nora' })]);

    expect(await screen.findByText(/nora’s plan is visible only to them/)).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('creates the project with what was typed and offers to open it', async () => {
    const { reload } = renderCreate();
    await screen.findByRole('heading', { level: 1 });
    fill('Name', 'Placement multi-región');
    fill(/^Description/, ' Pools and latencies ');
    fireEvent.click(screen.getByRole('radio', { name: /^Public/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(platform.createProject).toHaveBeenCalledWith('isa-demo', {
      name: 'Placement multi-región', slug: 'placement-multi-region', description: 'Pools and latencies', visibility: 'public',
    }));
    expect(await screen.findByText('Placement multi-región is ready')).toBeInTheDocument();
    expect(screen.getByText('Public: its card now appears in Explore.')).toBeInTheDocument();
    expect(reload).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Open project' })).toHaveAttribute('href', '/app/isa-demo/placement-multi-region');
  });

  it('is read-only for a VIEWER, who is told why', async () => {
    renderCreate([group, consultora], 'consultora-demo');

    expect(await screen.findByRole('note')).toHaveTextContent('You’re a VIEWER in Consultora Demo, so you can look at this form but not create a project (403).');
    expect(screen.getByLabelText('Name')).toBeDisabled();
    expect(screen.getByLabelText('Address')).toBeDisabled();
    expect(screen.getByRole('radio', { name: /^Public/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Members' })).toHaveAttribute('href', '/app/consultora-demo/settings/members');
  });

  describe('when the gateway refuses', () => {
    async function submit() {
      renderCreate();
      await screen.findByRole('heading', { level: 1 });
      fill('Name', 'Placement');
      fireEvent.click(screen.getByRole('button', { name: 'Create project' }));
    }

    it('409: the address is taken', async () => {
      platform.createProject.mockRejectedValue(refusal(409, 'slug_conflict'));
      await submit();

      expect(await screen.findByRole('alert')).toHaveTextContent('That address is already used in ISA Demo Group (409 · slug_conflict).');
      expect(screen.queryByText(/is ready/)).not.toBeInTheDocument();
    });

    it('402: no private project left, with the way to make it public instead', async () => {
      platform.createProject.mockRejectedValue(new QuotaError('sponsor_quota_exceeded', 'full', { limit_id: 'privateProjects', limit: 30, used: 30 }));
      await submit();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The sponsor has no private projects left (402 · sponsor_quota_exceeded). 30 of 30 private projects.');
      expect(within(alert).getByRole('link', { name: 'Your plan' })).toHaveAttribute('href', '/app/account/usage');
      fireEvent.click(within(alert).getByRole('button', { name: 'Make it public instead' }));

      expect(screen.getByRole('radio', { name: /^Public/ })).toBeChecked();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('402: no project left at all offers no public alternative', async () => {
      platform.createProject.mockRejectedValue(new QuotaError('sponsor_quota_exceeded', 'full', { limit_id: 'projects', limit: 50, used: 50 }));
      await submit();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The sponsor has no projects left');
      expect(within(alert).queryByRole('button', { name: 'Make it public instead' })).not.toBeInTheDocument();
    });

    it('503: limits can’t be checked, and it can be tried again', async () => {
      platform.createProject.mockRejectedValueOnce(new PricingUnavailableError('down'));
      await submit();

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Limits can’t be checked right now (503 · pricing_unavailable). Nothing was created.');
      fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
      expect(await screen.findByText('Placement is ready')).toBeInTheDocument();
      expect(platform.createProject).toHaveBeenCalledTimes(2);
    });

    it('403: the role was not enough', async () => {
      platform.createProject.mockRejectedValue(refusal(403, 'organization_forbidden'));
      await submit();

      expect(await screen.findByRole('alert')).toHaveTextContent('You need MEMBER in ISA Demo Group to create a project (403 · organization_forbidden). Nothing was created.');
    });
  });

  it('gives the same neutral answer for an organization that is missing', async () => {
    renderCreate([group], 'ghost-lab');

    expect(await screen.findByRole('heading', { name: 'Organization not available' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create project' })).not.toBeInTheDocument();
  });

  it('keeps the user from creating twice while the request is open', async () => {
    let finish: (value: unknown) => void = () => undefined;
    platform.createProject.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderCreate();
    await screen.findByRole('heading', { level: 1 });
    fill('Name', 'Placement');
    fireEvent.click(screen.getByRole('button', { name: 'Create project' }));

    expect(await screen.findByText('Creating…')).toBeInTheDocument();
    fireEvent.submit(screen.getByRole('button', { name: 'Create project' }).closest('form')!);
    expect(platform.createProject).toHaveBeenCalledOnce();
    finish(project('placement'));
    expect(await screen.findByText('placement is ready')).toBeInTheDocument();
  });
});
