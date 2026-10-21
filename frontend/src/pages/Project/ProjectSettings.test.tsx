import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingUnavailableError, QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { ProjectSettings } from './ProjectSettings';
import { caseOf, org, project, renderProjectScreen, revisionOf, usageWithProjects } from './testKit';

const api = vi.hoisted(() => ({ getOwnUsage: vi.fn() }));
const platform = vi.hoisted(() => ({
  project: vi.fn(), updateProject: vi.fn(), deleteProject: vi.fn(), cases: vi.fn(), revisions: vi.fn(), studies: vi.fn(), studyRuns: vi.fn(),
  reports: vi.fn(), publications: vi.fn(), publicProjects: vi.fn(),
}));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group' });
const member = org('member-lab', { name: 'Member Lab', effective_role: 'MEMBER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks', description: 'Reference cases.', visibility: 'private' });

const refusal = (status: number, code: string) => Object.assign(new HttpError(status, 'refused'), { code });

function renderSettings(slug = 'isa-demo') {
  return renderProjectScreen(<ProjectSettings />, {
    path: '/app/:org/:project/settings', url: `/app/${slug}/qos-benchmarks/settings`, organizations: [group, member],
  });
}

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
    platform.reports.mockResolvedValue([]);
    platform.publications.mockResolvedValue([]);
    platform.publicProjects.mockResolvedValue([]);
    api.getOwnUsage.mockResolvedValue(usageWithProjects());
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
      expect(screen.getByText(/Its card \(name, description\) appears in Explore/)).toBeInTheDocument();
      expect(screen.getByText(/Already-published reports stay verifiable by fingerprint/)).toBeInTheDocument();
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

  describe('below ADMIN', () => {
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
      platform.reports.mockResolvedValue([]);
      renderSettings();

      const note = await screen.findByRole('note');
      expect(note).toHaveTextContent('Deleting is blocked: this project has sealed history (2 case revisions).');
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
