import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation, useNavigate } from 'react-router-dom';
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

/** Shows the address the router is at, and a way to press the browser's Back button. */
function Where() {
  const where = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="where">{where.pathname + where.search}</output>
      <button type="button" onClick={() => void navigate(-1)}>Browser back</button>
    </>
  );
}

const where = () => screen.getByTestId('where').textContent;

function renderList(organization = group, slug = organization.slug, search = '') {
  return renderProjectScreen(<><CaseList /><Where /></>, {
    path: '/app/:org/:project/problems', url: `/app/${slug}/qos-benchmarks/problems${search}`, organizations: [organization],
  });
}

const refusal = (status: number, code: string) => Object.assign(new HttpError(status, 'refused'), { code });

describe('Problem list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.cases.mockResolvedValue([checkout, draft]);
    platform.revisions.mockImplementation(async (_org: string, _project: string, slug: string) => (slug === 'flujo-checkout' ? [revisionOf(checkout, 1), revisionOf(checkout, 2)] : []));
  });

  // [utest->req~frontend-retire-composer-entry-points-repointed~1]
  // [utest->req~frontend-nav-vocabulary-text~1]
  it('lists the problems with their versions, what is ready to run and where each one leads', async () => {
    renderList();

    expect(await screen.findByRole('heading', { level: 1, name: 'Problems' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Problems' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const first = within(rows[0]);
    expect(first.getByRole('link', { name: /Flujo de checkout/ })).toHaveAttribute('href', `${root}/problems/flujo-checkout`);
    expect(first.getByText('Ready to run')).toBeInTheDocument();
    expect(first.getByText('2 versions')).toBeInTheDocument();
    expect(first.getByText(/latest v2 · /)).toBeInTheDocument();
    expect(first.getByText('Payments with parallel stock and shipping.')).toBeInTheDocument();
    expect(first.getByRole('link', { name: 'Run latest' })).toHaveAttribute('href', `${root}/runs/new?case=flujo-checkout&revision=2`);
    expect(first.getByRole('link', { name: 'New version' })).toHaveAttribute('href', `${root}/workbench?case=flujo-checkout`);
    const second = within(rows[1]);
    expect(second.getByText('No version yet')).toBeInTheDocument();
    expect(second.getByText('0 versions')).toBeInTheDocument();
    expect(second.getByText('No description.')).toBeInTheDocument();
    expect(second.queryByRole('link', { name: 'Run latest' })).not.toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Problems' })).toHaveAttribute('aria-current', 'page');
    for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href'), link.textContent ?? '').not.toMatch(/\/compose([?#]|$)/);
  });

  it('lists the problems of a public project read-only for someone who is not a member: nothing to run, create or delete', async () => {
    platform.project.mockResolvedValue({ ...qos, organization_id: 'org-open', created_by_id: null, access: 'public_read', effective_role: null });
    renderList(group, 'open-lab');

    const list = await screen.findByRole('list', { name: 'Problems' });
    const first = within(within(list).getAllByRole('listitem')[0]);
    expect(first.getByRole('link', { name: /Flujo de checkout/ })).toHaveAttribute('href', '/app/open-lab/qos-benchmarks/problems/flujo-checkout');
    expect(first.queryByRole('link', { name: 'Run latest' })).not.toBeInTheDocument();
    expect(first.queryByRole('link', { name: 'New version' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New problem' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
    expect(screen.queryByText(/Your role here/)).not.toBeInTheDocument();
    expect(screen.getByText('You are viewing a public project (read-only).')).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).queryByRole('link', { name: 'Runs' })).not.toBeInTheDocument();
  });

  it('finds a problem by name or address and says when none matches', async () => {
    renderList();
    await screen.findByRole('list', { name: 'Problems' });

    fireEvent.change(screen.getByLabelText('Search problems'), { target: { value: 'borra' } });
    expect(within(screen.getByRole('list', { name: 'Problems' })).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Search problems'), { target: { value: 'zzz' } });
    expect(screen.getByText('No problem matches “zzz”.')).toBeInTheDocument();
  });

  it('sorts by the latest version or by name', async () => {
    renderList();
    const list = await screen.findByRole('list', { name: 'Problems' });
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Flujo de checkout');
    expect(within(screen.getByLabelText('Sort')).getByRole('option', { name: 'Latest version' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Sort'), { target: { value: 'name' } });
    expect(within(screen.getByRole('list', { name: 'Problems' })).getAllByRole('listitem')[0]).toHaveTextContent('Borrador');
  });

  it('explains how to start when the project has no problem', async () => {
    platform.cases.mockResolvedValue([]);
    renderList();

    const guide = await screen.findByRole('region', { name: 'No problems yet' });
    // [utest->req~frontend-retire-composer-entry-points-repointed~1]
    expect(guide).toHaveTextContent('Start from a ready example, or create a problem and save its first version from the workbench.');
    expect(guide.textContent).not.toMatch(/composer|compose one/);
    expect(within(guide).getByRole('link', { name: 'Import an example' })).toHaveAttribute('href', '/explore/examples');
    // [utest->req~frontend-retire-library-entry-points-removed~1]
    expect(within(guide).queryByRole('link', { name: /library/i })).toBeNull();
  });

  it('keeps the page and offers a retry when the list fails', async () => {
    platform.cases.mockRejectedValueOnce(refusal(503, 'unavailable')).mockResolvedValue([checkout]);
    renderList();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Problems couldn’t be loaded');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Problems' })).toBeInTheDocument();
  });

  // [utest->req~frontend-retire-composer-entry-points-repointed~1]
  it('lets a VIEWER read and compare but not create, edit or delete', async () => {
    renderList(viewing);

    await screen.findByRole('list', { name: 'Problems' });
    expect(screen.queryByRole('link', { name: /New version|Compose its first version/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Workbench' })).not.toBeInTheDocument();
    for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href')).not.toMatch(/\/compose([?#]|$)|\/workbench\?case=/);
    expect(screen.getByRole('note')).toHaveTextContent('You’re a VIEWER. You can open and compare problems here; creating and editing need MEMBER.');
    expect(screen.queryByRole('button', { name: 'New problem' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New version' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Run latest' })).toHaveLength(1);
  });

  it('offers a MEMBER the workbench, the examples and a new problem, but not deleting', async () => {
    renderList();

    await screen.findByRole('list', { name: 'Problems' });
    expect(screen.getByRole('link', { name: 'Workbench' })).toHaveAttribute('href', `${root}/workbench`);
    expect(screen.getByRole('link', { name: 'Import from example' })).toHaveAttribute('href', '/explore/examples');
    expect(screen.getByRole('button', { name: 'New problem' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
  });

  describe('new problem', () => {
    async function openDialog() {
      renderList();
      await screen.findByRole('list', { name: 'Problems' });
      fireEvent.click(screen.getByRole('button', { name: 'New problem' }));
      return screen.findByRole('dialog', { name: 'New problem' });
    }

    // [utest->req~frontend-retire-composer-entry-points-repointed~1]
    it('suggests the address from the name and creates the problem', async () => {
      cases.createCase.mockResolvedValue(caseOf('analisis-de-latencia', 'Análisis de latencia'));
      const dialog = await openDialog();

      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Análisis de latencia' } });
      expect(within(dialog).getByLabelText('Address')).toHaveValue('analisis-de-latencia');
      fireEvent.change(within(dialog).getByLabelText(/Description/), { target: { value: 'Edge pools' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create problem' }));

      await waitFor(() => expect(cases.createCase).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', { slug: 'analisis-de-latencia', name: 'Análisis de latencia', description: 'Edge pools' }));
      const toast = (await screen.findByText(/created\. Compose its first version when you’re ready\./)).closest('[role="status"]') as HTMLElement;
      expect(toast).toHaveTextContent('Problem “Análisis de latencia” created. Compose its first version when you’re ready.');
      expect(within(toast).getByRole('link', { name: 'Compose its first version' })).toHaveAttribute('href', `${root}/workbench?case=analisis-de-latencia`);
      for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href'), link.textContent ?? '').not.toMatch(/\/compose([?#]|$)/);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      // [utest->req~frontend-nav-new-menu~1]
      expect(where()).toBe(`${root}/problems`);
      await waitFor(() => expect(platform.cases).toHaveBeenCalledTimes(2));
    });

    // [utest->req~frontend-nav-create-dialogs~1]
    it('shows the toast with no dialog left open after a successful create', async () => {
      cases.createCase.mockResolvedValue(caseOf('analisis-de-latencia', 'Análisis de latencia'));
      const dialog = await openDialog();
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Análisis de latencia' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create problem' }));

      expect(await screen.findByText(/created\. Compose its first version when you’re ready\./)).toBeInTheDocument();
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('does not send a form without a name or with an address the gateway would refuse', async () => {
      const dialog = await openDialog();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Create problem' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Give it a name and a valid address');
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Ok' } });
      fireEvent.change(within(dialog).getByLabelText('Address'), { target: { value: 'Not Valid' } });
      expect(within(dialog).getByText('Lowercase letters, numbers and hyphens.')).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create problem' }));
      expect(cases.createCase).not.toHaveBeenCalled();
    });

    it('keeps the dialog open and says so when the address is taken (409)', async () => {
      cases.createCase.mockRejectedValue(refusal(409, 'slug_conflict'));
      const dialog = await openDialog();

      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Flujo de checkout' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create problem' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('That address is already used by another problem in this project (409 · slug_conflict).');
      expect(screen.getByRole('dialog', { name: 'New problem' })).toBeInTheDocument();
      expect(where()).toBe(`${root}/problems?create=problem`);
    });

    it('closes with Cancel and creates nothing', async () => {
      const dialog = await openDialog();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(cases.createCase).not.toHaveBeenCalled();
    });
  });

  describe('the dialog in the address', () => {
    // [utest->req~frontend-nav-new-menu~1]
    it('opens from the New problem button with create=problem in the address', async () => {
      renderList();
      await screen.findByRole('list', { name: 'Problems' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'New problem' }));

      expect(await screen.findByRole('dialog', { name: 'New problem' })).toBeInTheDocument();
      expect(where()).toBe(`${root}/problems?create=problem`);
    });

    // [utest->req~frontend-nav-new-menu~1]
    it('is open when the address holds create=problem, over the list', async () => {
      renderList(group, group.slug, '?create=problem');

      expect(await screen.findByRole('dialog', { name: 'New problem' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: 'Problems' })).toBeInTheDocument();
    });

    // [utest->req~frontend-nav-new-menu~1]
    it.each([
      ['Cancel', (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))],
      ['the close button', (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))],
      ['Escape', (dialog: HTMLElement) => fireEvent.keyDown(dialog, { key: 'Escape' })],
    ])('removes the query and returns the focus to New problem on %s', async (_name, close) => {
      renderList(group, group.slug, '?create=problem');
      const dialog = await screen.findByRole('dialog', { name: 'New problem' });

      close(dialog);

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(where()).toBe(`${root}/problems`);
      expect(screen.getByRole('button', { name: 'New problem' })).toHaveFocus();
      expect(cases.createCase).not.toHaveBeenCalled();
    });

    // [utest->req~frontend-nav-new-menu~1]
    it('closes by replacing the entry, so Back does not open the dialog again', async () => {
      renderList();
      await screen.findByRole('list', { name: 'Problems' });
      const opener = screen.getByRole('button', { name: 'New problem' });
      opener.focus();
      fireEvent.click(opener);
      const dialog = await screen.findByRole('dialog', { name: 'New problem' });

      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'New problem' })).toHaveFocus();

      fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
      await waitFor(() => expect(where()).toBe(`${root}/problems`));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // [utest->req~frontend-nav-new-menu~1]
    it('gives a VIEWER no dialog when the address asks for one', async () => {
      renderList(viewing, viewing.slug, '?create=problem');

      await screen.findByRole('list', { name: 'Problems' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'New problem' })).not.toBeInTheDocument();
      expect(cases.createCase).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('is for an ADMIN, and a problem with sealed versions explains why it can’t go', async () => {
      renderList(admin);
      const list = await screen.findByRole('list', { name: 'Problems' });

      fireEvent.click(within(list).getByRole('button', { name: 'Delete Flujo de checkout' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete Flujo de checkout?' });
      expect(within(dialog).getByText(/2 sealed versions, so it can’t be deleted/)).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Delete problem' })).toBeDisabled();
      expect(within(dialog).getByLabelText('Type flujo-checkout to confirm')).toBeDisabled();
    });

    it('deletes a problem without versions once its address is typed', async () => {
      platform.cases.mockResolvedValueOnce([checkout, draft]).mockResolvedValue([checkout]);
      platform.deleteCase.mockResolvedValue(undefined);
      renderList(admin);
      const list = await screen.findByRole('list', { name: 'Problems' });

      fireEvent.click(within(list).getByRole('button', { name: 'Delete Borrador' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete Borrador?' });
      const confirm = within(dialog).getByRole('button', { name: 'Delete problem' });
      expect(confirm).toBeDisabled();
      fireEvent.change(within(dialog).getByLabelText('Type borrador to confirm'), { target: { value: 'borrador' } });
      fireEvent.click(confirm);

      await waitFor(() => expect(platform.deleteCase).toHaveBeenCalledWith('qos-lab', 'qos-benchmarks', 'borrador'));
      expect(await screen.findByText('Problem “Borrador” deleted.')).toBeInTheDocument();
      await waitFor(() => expect(within(screen.getByRole('list', { name: 'Problems' })).getAllByRole('listitem')).toHaveLength(1));
    });

    it('shows the 409 of the gateway if the problem gained a version meanwhile', async () => {
      platform.deleteCase.mockRejectedValue(refusal(409, 'historical_references'));
      renderList(admin);
      const list = await screen.findByRole('list', { name: 'Problems' });

      fireEvent.click(within(list).getByRole('button', { name: 'Delete Borrador' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete Borrador?' });
      fireEvent.change(within(dialog).getByLabelText('Type borrador to confirm'), { target: { value: 'borrador' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete problem' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('This problem has sealed versions, so it can’t be deleted (409 · historical_references).');
    });
  });

  it('shows the project gate when the project is not there for this account', async () => {
    platform.project.mockRejectedValue(refusal(404, 'not_found'));
    renderList();
    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
  });
});
