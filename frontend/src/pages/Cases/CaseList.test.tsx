import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { caseOf, org, project, renderProjectScreen, revisionOf } from '../Project/testKit';
import { CaseList } from './CaseList';

const platform = vi.hoisted(() => ({ project: vi.fn(), cases: vi.fn(), revisions: vi.fn(), deleteCase: vi.fn(), publicProjects: vi.fn() }));
const cases = vi.hoisted(() => ({ createCase: vi.fn() }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/cases', () => ({ casesApi: cases }));

const group = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const admin = org('qos-lab', { name: 'QoS Lab', effective_role: 'ADMIN' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });

const checkout = caseOf('flujo-checkout', 'Flujo de checkout', { description: 'Payments with parallel stock and shipping.' });
const draft = caseOf('borrador', 'Borrador', { created_at: '2026-03-01T00:00:00Z' });
const root = '/app/isa-demo/qos-benchmarks';

function renderList(organization = group, slug = organization.slug) {
  return renderProjectScreen(<CaseList />, { path: '/app/:org/:project/cases', url: `/app/${slug}/qos-benchmarks/cases`, organizations: [organization] });
}

const refusal = (status: number, code: string) => Object.assign(new HttpError(status, 'refused'), { code });

describe('Case list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.cases.mockResolvedValue([checkout, draft]);
    platform.revisions.mockImplementation(async (_org: string, _project: string, slug: string) => (slug === 'flujo-checkout' ? [revisionOf(checkout, 1), revisionOf(checkout, 2)] : []));
  });

  it('lists the cases with their revisions, what is ready to run and where each one leads', async () => {
    renderList();

    const list = await screen.findByRole('list', { name: 'Cases' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const first = within(rows[0]);
    expect(first.getByRole('link', { name: /Flujo de checkout/ })).toHaveAttribute('href', `${root}/cases/flujo-checkout`);
    expect(first.getByText('Ready to run')).toBeInTheDocument();
    expect(first.getByText('2 revisions')).toBeInTheDocument();
    expect(first.getByText(/latest r2 · /)).toBeInTheDocument();
    expect(first.getByText('Payments with parallel stock and shipping.')).toBeInTheDocument();
    expect(first.getByRole('link', { name: 'Run latest' })).toHaveAttribute('href', `${root}/jobs/new?case=flujo-checkout&revision=2`);
    expect(first.getByRole('link', { name: 'New revision' })).toHaveAttribute('href', `${root}/cases/flujo-checkout/compose`);
    const second = within(rows[1]);
    expect(second.getByText('No revision yet')).toBeInTheDocument();
    expect(second.getByText('0 revisions')).toBeInTheDocument();
    expect(second.getByText('No description.')).toBeInTheDocument();
    expect(second.queryByRole('link', { name: 'Run latest' })).not.toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Cases' })).toHaveAttribute('aria-current', 'page');
  });

  it('lists the cases of a public project read-only for someone who is not a member: nothing to run, create or delete', async () => {
    platform.project.mockResolvedValue({ ...qos, organization_id: 'org-open', created_by_id: null, access: 'public_read', effective_role: null });
    renderList(group, 'open-lab');

    const list = await screen.findByRole('list', { name: 'Cases' });
    const first = within(within(list).getAllByRole('listitem')[0]);
    expect(first.getByRole('link', { name: /Flujo de checkout/ })).toHaveAttribute('href', '/app/open-lab/qos-benchmarks/cases/flujo-checkout');
    expect(first.queryByRole('link', { name: 'Run latest' })).not.toBeInTheDocument();
    expect(first.queryByRole('link', { name: 'New revision' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New case' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
    expect(screen.queryByText(/Your role here/)).not.toBeInTheDocument();
    expect(screen.getByText('You are viewing a public project (read-only).')).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).queryByRole('link', { name: 'Jobs' })).not.toBeInTheDocument();
  });

  it('finds a case by name or address and says when none matches', async () => {
    renderList();
    await screen.findByRole('list', { name: 'Cases' });

    fireEvent.change(screen.getByLabelText('Search cases'), { target: { value: 'borra' } });
    expect(within(screen.getByRole('list', { name: 'Cases' })).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Search cases'), { target: { value: 'zzz' } });
    expect(screen.getByText('No case matches “zzz”.')).toBeInTheDocument();
  });

  it('sorts by the latest revision or by name', async () => {
    renderList();
    const list = await screen.findByRole('list', { name: 'Cases' });
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Flujo de checkout');

    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'name' } });
    expect(within(screen.getByRole('list', { name: 'Cases' })).getAllByRole('listitem')[0]).toHaveTextContent('Borrador');
  });

  it('explains how to start when the project has no case', async () => {
    platform.cases.mockResolvedValue([]);
    renderList();

    const guide = await screen.findByRole('region', { name: 'No cases yet' });
    expect(within(guide).getByRole('link', { name: 'Import an example' })).toHaveAttribute('href', '/examples');
    // [utest->req~frontend-retire-library-entry-points-removed~1]
    expect(within(guide).queryByRole('link', { name: /library/i })).toBeNull();
  });

  it('keeps the page and offers a retry when the list fails', async () => {
    platform.cases.mockRejectedValueOnce(refusal(503, 'unavailable')).mockResolvedValue([checkout]);
    renderList();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Cases couldn’t be loaded');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Cases' })).toBeInTheDocument();
  });

  it('lets a VIEWER read and compare but not create, edit or delete', async () => {
    renderList(viewing);

    await screen.findByRole('list', { name: 'Cases' });
    expect(screen.getByRole('note')).toHaveTextContent('You’re a VIEWER. You can open and compare cases here; creating and editing need MEMBER.');
    expect(screen.queryByRole('button', { name: 'New case' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New revision' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Run latest' })).toHaveLength(1);
  });

  it('offers a MEMBER the workbench, the examples and a new case, but not deleting', async () => {
    renderList();

    await screen.findByRole('list', { name: 'Cases' });
    expect(screen.getByRole('link', { name: 'Workbench' })).toHaveAttribute('href', `${root}/workbench`);
    expect(screen.getByRole('link', { name: 'Import from example' })).toHaveAttribute('href', '/examples');
    expect(screen.getByRole('button', { name: 'New case' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
  });

  describe('new case', () => {
    async function openDialog() {
      renderList();
      await screen.findByRole('list', { name: 'Cases' });
      fireEvent.click(screen.getByRole('button', { name: 'New case' }));
      return screen.findByRole('dialog', { name: 'New case' });
    }

    it('suggests the address from the name and creates the case', async () => {
      cases.createCase.mockResolvedValue(caseOf('analisis-de-latencia', 'Análisis de latencia'));
      const dialog = await openDialog();

      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Análisis de latencia' } });
      expect(within(dialog).getByLabelText('Address')).toHaveValue('analisis-de-latencia');
      fireEvent.change(within(dialog).getByLabelText(/Description/), { target: { value: 'Edge pools' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create case' }));

      await waitFor(() => expect(cases.createCase).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', { slug: 'analisis-de-latencia', name: 'Análisis de latencia', description: 'Edge pools' }));
      const toast = (await screen.findByText(/created\. Compose its first revision when you’re ready\./)).closest('[role="status"]') as HTMLElement;
      expect(toast).toHaveTextContent('Case “Análisis de latencia” created. Compose its first revision when you’re ready.');
      expect(within(toast).getByRole('link', { name: 'Compose its first revision' })).toHaveAttribute('href', `${root}/cases/analisis-de-latencia/compose`);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      await waitFor(() => expect(platform.cases).toHaveBeenCalledTimes(2));
    });

    it('does not send a form without a name or with an address the gateway would refuse', async () => {
      const dialog = await openDialog();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Create case' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Give it a name and a valid address');
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Ok' } });
      fireEvent.change(within(dialog).getByLabelText('Address'), { target: { value: 'Not Valid' } });
      expect(within(dialog).getByText('Lowercase letters, numbers and hyphens.')).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create case' }));
      expect(cases.createCase).not.toHaveBeenCalled();
    });

    it('keeps the dialog open and says so when the address is taken (409)', async () => {
      cases.createCase.mockRejectedValue(refusal(409, 'slug_conflict'));
      const dialog = await openDialog();

      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Flujo de checkout' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create case' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('That address is already used by another case in this project (409 · slug_conflict).');
      expect(screen.getByRole('dialog', { name: 'New case' })).toBeInTheDocument();
    });

    it('closes with Cancel and creates nothing', async () => {
      const dialog = await openDialog();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(cases.createCase).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('is for an ADMIN, and a case with sealed revisions explains why it can’t go', async () => {
      renderList(admin);
      const list = await screen.findByRole('list', { name: 'Cases' });

      fireEvent.click(within(list).getByRole('button', { name: 'Delete Flujo de checkout' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete Flujo de checkout?' });
      expect(within(dialog).getByText(/2 sealed revisions, so it can’t be deleted/)).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Delete case' })).toBeDisabled();
      expect(within(dialog).getByLabelText('Type flujo-checkout to confirm')).toBeDisabled();
    });

    it('deletes a case without revisions once its address is typed', async () => {
      platform.cases.mockResolvedValueOnce([checkout, draft]).mockResolvedValue([checkout]);
      platform.deleteCase.mockResolvedValue(undefined);
      renderList(admin);
      const list = await screen.findByRole('list', { name: 'Cases' });

      fireEvent.click(within(list).getByRole('button', { name: 'Delete Borrador' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete Borrador?' });
      const confirm = within(dialog).getByRole('button', { name: 'Delete case' });
      expect(confirm).toBeDisabled();
      fireEvent.change(within(dialog).getByLabelText('Type borrador to confirm'), { target: { value: 'borrador' } });
      fireEvent.click(confirm);

      await waitFor(() => expect(platform.deleteCase).toHaveBeenCalledWith('qos-lab', 'qos-benchmarks', 'borrador'));
      expect(await screen.findByText('Case “Borrador” deleted.')).toBeInTheDocument();
      await waitFor(() => expect(within(screen.getByRole('list', { name: 'Cases' })).getAllByRole('listitem')).toHaveLength(1));
    });

    it('shows the 409 of the gateway if the case gained a revision meanwhile', async () => {
      platform.deleteCase.mockRejectedValue(refusal(409, 'historical_references'));
      renderList(admin);
      const list = await screen.findByRole('list', { name: 'Cases' });

      fireEvent.click(within(list).getByRole('button', { name: 'Delete Borrador' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete Borrador?' });
      fireEvent.change(within(dialog).getByLabelText('Type borrador to confirm'), { target: { value: 'borrador' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete case' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('This case has sealed revisions, so it can’t be deleted (409 · historical_references).');
    });
  });

  it('shows the project gate when the project is not there for this account', async () => {
    platform.project.mockRejectedValue(refusal(404, 'not_found'));
    renderList();
    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
  });
});
