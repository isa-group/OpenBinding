import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { ProjectSettings } from './ProjectSettings';
import { caseOf, org, project, renderProjectScreen, revisionOf, usageWithProjects } from './testKit';

const api = vi.hoisted(() => ({ getOwnUsage: vi.fn(), getPricingCatalog: vi.fn() }));
const platform = vi.hoisted(() => ({
  project: vi.fn(), updateProject: vi.fn(), deleteProject: vi.fn(), cases: vi.fn(), revisions: vi.fn(), studies: vi.fn(), studyRuns: vi.fn(),
  members: vi.fn(),
}));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const member = org('member-lab', { name: 'Member Lab', effective_role: 'MEMBER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks', description: 'Reference cases.', visibility: 'private' });

const refusal = (status: number, code: string) => Object.assign(new HttpError(status, 'refused'), { code });

function renderSettings(slug = 'isa-demo', section = '') {
  return renderProjectScreen(<ProjectSettings />, {
    path: '/app/:org/:project/settings/:section?', url: `/app/${slug}/qos-benchmarks/settings${section ? `/${section}` : ''}`, organizations: [group, member],
  });
}

const sectionsNav = () => screen.getByRole('navigation', { name: 'Settings sections' });

describe('Project settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.updateProject.mockResolvedValue(qos);
    platform.deleteProject.mockResolvedValue(undefined);
    platform.cases.mockResolvedValue([]);
    platform.revisions.mockResolvedValue([]);
    platform.studies.mockResolvedValue([]);
    platform.studyRuns.mockResolvedValue([]);
    platform.members.mockResolvedValue([
      { id: 'm1', organization_id: group.id, user_id: 'user-1', username: 'lucia', email: 'lucia@example.org', role: 'OWNER', created_at: '2026-01-01T00:00:00Z' },
      { id: 'm2', organization_id: group.id, user_id: 'user-2', username: 'tomas', email: 'tomas@example.org', role: 'MEMBER', created_at: '2026-01-01T00:00:00Z' },
    ]);
    api.getOwnUsage.mockResolvedValue(usageWithProjects());
    api.getPricingCatalog.mockResolvedValue({});
  });

  it('is for members: a visitor of a public project gets the neutral gate, with nothing of the settings', async () => {
    platform.project.mockResolvedValue({ ...qos, visibility: 'public', organization_id: 'org-open', created_by_id: null, access: 'public_read', effective_role: null });
    renderSettings('open-lab');

    expect(await screen.findByRole('heading', { name: 'Members only' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete project/ })).not.toBeInTheDocument();
  });

  it('frames the page with the breadcrumb, the project tabs, the role and the fixed address', async () => {
    renderSettings();

    expect(await screen.findByRole('heading', { level: 1, name: 'Project settings' })).toBeInTheDocument();
    expect(screen.getByText(/QoS Benchmarks · your role/)).toHaveTextContent('QoS Benchmarks · your role OWNER');
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'QoS Benchmarks' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks');
    expect(within(crumbs).getByText('Settings')).toHaveAttribute('aria-current', 'page');
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByLabelText('Name')).toHaveValue('QoS Benchmarks');
    expect(screen.getByLabelText('Description')).toHaveValue('Reference cases.');
    expect(screen.getByText('/app/isa-demo/qos-benchmarks')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('renames and describes the project and points to the audit log', async () => {
    const { reload } = renderSettings();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: ' QoS Reference ' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'New text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(platform.updateProject).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', { name: 'QoS Reference', description: 'New text' }));
    expect(await screen.findByText('Saved. An audit entry was recorded.')).toBeInTheDocument();
    expect(reload).toHaveBeenCalledOnce();
    await waitFor(() => expect(platform.project).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('link', { name: 'Audit log' })).toHaveAttribute('href', '/app/isa-demo/settings/audit');
  });

  it('sends only what changed', async () => {
    renderSettings();
    fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'Only this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(platform.updateProject).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', { description: 'Only this' }));
  });

  it('503: says nothing changed when pricing is down', async () => {
    platform.updateProject.mockRejectedValue(new PricingUnavailableError('down'));
    renderSettings();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Another' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Limits can’t be checked right now (503 · pricing_unavailable). Nothing changed.');
    expect(screen.queryByText('Saved. An audit entry was recorded.')).not.toBeInTheDocument();
  });

  describe('visibility', () => {
    it('explains what a change does and does not do, then changes it', async () => {
      renderSettings();
      expect(await screen.findByRole('radio', { name: 'Private' })).toBeChecked();
      expect(screen.getByRole('button', { name: 'Change visibility' })).toBeDisabled();

      fireEvent.click(screen.getByRole('radio', { name: 'Public' }));
      expect(screen.getByText(/Anybody can read it, without changing anything/)).toBeInTheDocument();
      expect(screen.getByText(/Runs and the settings still need membership to open/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Change visibility' }));

      await waitFor(() => expect(platform.updateProject).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', { visibility: 'public' }));
      expect(await screen.findByText('Visibility changed to public. An audit entry was recorded.')).toBeInTheDocument();
    });

    it('shows the sponsor’s private-project limit after making a public project private, and the 402 when there is no room', async () => {
      platform.project.mockResolvedValue({ ...qos, visibility: 'public' });
      platform.updateProject.mockRejectedValue(new QuotaError('sponsor_quota_exceeded', 'full', { limit_id: 'privateProjects', limit: 30, used: 30 }));
      renderSettings();
      fireEvent.click(await screen.findByRole('radio', { name: 'Private' }));

      expect(await screen.findByText('Up to 30')).toBeInTheDocument();
      expect(screen.queryByRole('meter')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Change visibility' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The sponsor has no private projects left (402 · sponsor_quota_exceeded). 30 of 30 private projects.');
      expect(alert).toHaveTextContent('Nothing changed.');
      expect(within(alert).getByRole('link', { name: 'Your plan' })).toHaveAttribute('href', '/app/account/usage');
    });
  });

  describe('sections', () => {
    it('marks General at /settings and offers Members', async () => {
      renderSettings();

      await screen.findByRole('heading', { level: 1, name: 'Project settings' });
      const nav = within(sectionsNav());
      expect(nav.getByRole('link', { name: 'General' })).toHaveAttribute('aria-current', 'page');
      expect(nav.getByRole('link', { name: 'General' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/settings');
      expect(nav.getByRole('link', { name: 'Members' })).not.toHaveAttribute('aria-current');
      expect(nav.getByRole('link', { name: 'Members' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/settings/members');
      expect(platform.members).not.toHaveBeenCalled();
    });

    it('lists the members of the organization at /settings/members, and links to manage them', async () => {
      renderSettings('isa-demo', 'members');

      const list = await screen.findByRole('list', { name: 'Members of ISA Demo Group' });
      expect(platform.members).toHaveBeenCalledWith('isa-demo');
      expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
        expect.stringContaining('lucia'), expect.stringContaining('tomas'),
      ]);
      expect(within(list).getByText('OWNER')).toBeInTheDocument();
      expect(within(list).getByText('MEMBER')).toBeInTheDocument();
      const nav = within(sectionsNav());
      expect(nav.getByRole('link', { name: 'Members' })).toHaveAttribute('aria-current', 'page');
      expect(nav.getByRole('link', { name: 'General' })).not.toHaveAttribute('aria-current');
      expect(screen.getByRole('link', { name: 'Manage members' })).toHaveAttribute('href', '/app/isa-demo/settings/members');
      expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
      expect(within(screen.getByRole('navigation', { name: 'Project sections' })).getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
    });

    it('says the members could not be loaded, and tries again', async () => {
      platform.members.mockRejectedValueOnce(refusal(503, 'unavailable'));
      renderSettings('isa-demo', 'members');

      expect(await screen.findByText('The members couldn’t be loaded.')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('tomas')).toBeInTheDocument();
    });

    it('is for members at /settings/members too: a visitor of a public project gets the neutral gate', async () => {
      platform.project.mockResolvedValue({ ...qos, visibility: 'public', organization_id: 'org-open', created_by_id: null, access: 'public_read', effective_role: null });
      renderSettings('open-lab', 'members');

      expect(await screen.findByRole('heading', { name: 'Members only' })).toBeInTheDocument();
      expect(platform.members).not.toHaveBeenCalled();
    });

    it('shows Page not found for any other section', async () => {
      renderSettings('isa-demo', 'billing');

      expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
      expect(screen.queryByRole('navigation', { name: 'Settings sections' })).not.toBeInTheDocument();
    });
  });

  describe('below ADMIN', () => {
    it('offers no package export or import', async () => {
      platform.project.mockResolvedValue({ ...qos, organization_id: member.id });
      renderSettings('member-lab');

      await screen.findByRole('heading', { level: 1, name: 'Project settings' });
      expect(screen.queryByRole('heading', { name: 'Export package' })).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Import package' })).not.toBeInTheDocument();
    });

    it('is read-only, with the role named and nothing to save or delete', async () => {
      platform.project.mockResolvedValue({ ...qos, organization_id: member.id });
      renderSettings('member-lab');

      expect(await screen.findByRole('heading', { level: 1, name: 'Project settings' })).toBeInTheDocument();
      expect(screen.getByText(/this page is read-only/)).toHaveTextContent('You’re a MEMBER, so this page is read-only. Editing and deleting a project need ADMIN in Member Lab.');
      expect(screen.getByLabelText('Name')).toBeDisabled();
      expect(screen.getByLabelText('Description')).toBeDisabled();
      expect(screen.getByRole('radio', { name: 'Public' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Change visibility' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Delete project' })).not.toBeInTheDocument();
    });
  });

  describe('deleting', () => {
    it('is blocked while the project has sealed history, and says what that is', async () => {
      const first = caseOf('flujo');
      platform.cases.mockResolvedValue([first]);
      platform.revisions.mockResolvedValue([revisionOf(first, 1), revisionOf(first, 2)]);
      renderSettings();

      const note = await screen.findByRole('note');
      expect(note).toHaveTextContent('Deleting is blocked: this project has sealed history (2 problem versions).');
      expect(note).toHaveTextContent('Sealed history must stay reachable so people can still verify it.');
      expect(screen.getByRole('button', { name: 'Delete project' })).toBeDisabled();
    });

    it('asks for the address before it deletes, then closes the project’s page', async () => {
      const { reload } = renderSettings();
      fireEvent.click(await screen.findByRole('button', { name: 'Delete project' }));

      const dialog = await screen.findByRole('dialog', { name: 'Delete QoS Benchmarks?' });
      const confirm = within(dialog).getByRole('button', { name: 'Delete permanently' });
      expect(confirm).toBeDisabled();
      fireEvent.change(within(dialog).getByLabelText('Type qos-benchmarks to confirm'), { target: { value: 'qos-bench' } });
      expect(confirm).toBeDisabled();
      fireEvent.change(within(dialog).getByLabelText('Type qos-benchmarks to confirm'), { target: { value: 'qos-benchmarks' } });
      fireEvent.click(confirm);

      await waitFor(() => expect(platform.deleteProject).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks'));
      expect(await screen.findByRole('heading', { name: 'QoS Benchmarks was deleted' })).toBeInTheDocument();
      expect(reload).toHaveBeenCalledOnce();
      expect(screen.getByRole('link', { name: 'Back to ISA Demo Group' })).toHaveAttribute('href', '/app/isa-demo');
    });

    it('409: the gateway still refuses sealed history that appeared after the page loaded', async () => {
      platform.deleteProject.mockRejectedValue(refusal(409, 'historical_references'));
      renderSettings();
      fireEvent.click(await screen.findByRole('button', { name: 'Delete project' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete QoS Benchmarks?' });
      fireEvent.change(within(dialog).getByLabelText('Type qos-benchmarks to confirm'), { target: { value: 'qos-benchmarks' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('so it can’t be deleted (409 · historical_references)');
      expect(screen.queryByRole('heading', { name: 'QoS Benchmarks was deleted' })).not.toBeInTheDocument();
    });
  });

  it('gives the neutral answer for a project that is not there', async () => {
    platform.project.mockRejectedValue(refusal(404, 'not_found'));
    renderSettings();

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
