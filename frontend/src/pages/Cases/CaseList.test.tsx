import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import type { ProblemUpload } from '../../api/problems';
import { caseOf, org, project, renderProjectScreen, revisionOf } from '../../features/workspace/testKit';
import { CaseList } from './CaseList';

const problems = vi.hoisted(() => ({ list: vi.fn(), revisions: vi.fn(), create: vi.fn(), remove: vi.fn() }));

vi.mock('../../api/problems', () => ({ problemsApi: problems }));

const group = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const admin = org('qos-lab', { name: 'QoS Lab', effective_role: 'ADMIN' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });

const checkout = caseOf('flujo-checkout', 'Flujo de checkout', { description: 'Payments with parallel stock and shipping.' });
const draft = caseOf('borrador', 'Borrador', { created_at: '2026-03-01T00:00:00Z' });
const root = '/app/isa-demo';

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

function renderList(organization = group, search = '', projects = [qos]) {
  return renderProjectScreen(<><CaseList /><Where /></>, {
    path: '/app/:org/problems', url: `/app/${organization.slug}/problems${search}`, organizations: [organization], projects,
  });
}

const refusal = (status: number, code: string, extra: Record<string, unknown> = {}) => Object.assign(new HttpError(status, 'refused'), { code, ...extra });

const upload = (slug: string, name: string): ProblemUpload => {
  const item = caseOf(slug, name);
  return {
    problem: item, revision: revisionOf(item, 1), created: true,
    compilation: { id: 'c1', compilation_digest: 'sha256-c', compiler_digest: 'sha256-k', ir_digest: 'sha256-i', binding_space: '4', created_at: '2026-04-02T00:00:00Z', current: true },
  };
};

const file = () => new File([new Uint8Array([80, 75, 3, 4])], 'analisis-de-latencia.bim.zip', { type: 'application/vnd.bim+zip' });

describe('Problem list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    problems.list.mockResolvedValue({ problems: [checkout, draft], total: 2, limit: 200, offset: 0 });
    problems.revisions.mockImplementation(async (_org: string, slug: string) => (slug === 'flujo-checkout' ? [revisionOf(checkout, 1), revisionOf(checkout, 2)] : []));
  });

  it('lists the organization’s problems with their versions, what is ready to run and where each one leads', async () => {
    renderList();

    expect(await screen.findByRole('heading', { level: 1, name: 'Problems' })).toBeInTheDocument();
    expect(problems.list).toHaveBeenCalledWith('isa-demo', { limit: 200 });
    const list = await screen.findByRole('list', { name: 'Problems' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const first = within(rows[0]);
    expect(first.getByRole('link', { name: /Flujo de checkout/ })).toHaveAttribute('href', `${root}/problems/flujo-checkout`);
    expect(first.getByText('Ready to run')).toBeInTheDocument();
    expect(first.getByText('2 versions')).toBeInTheDocument();
    expect(first.getByText(/latest v2 · /)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sha256-|[0-9a-f]{12}/);
    expect(first.getByText('Payments with parallel stock and shipping.')).toBeInTheDocument();
    expect(first.getByRole('link', { name: 'Run latest' })).toHaveAttribute('href', '/app/isa-demo/runs/new?problem=flujo-checkout&revision=2');
    expect(first.getByRole('link', { name: 'New version' })).toHaveAttribute('href', `${root}/workbench?problem=flujo-checkout`);
    const second = within(rows[1]);
    expect(second.getByText('No version yet')).toBeInTheDocument();
    expect(second.getByText('0 versions')).toBeInTheDocument();
    expect(second.getByText('No description.')).toBeInTheDocument();
    expect(second.queryByRole('link', { name: 'Run latest' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Project sections' })).not.toBeInTheDocument();
  });

  it('offers the three ways to add a problem: upload, the Workbench and a template', async () => {
    renderList();
    await screen.findByRole('list', { name: 'Problems' });

    expect(screen.getByRole('button', { name: 'Upload BIM package' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Write one in the Workbench' })).toHaveAttribute('href', `${root}/workbench`);
    expect(screen.getByRole('link', { name: 'Start from a template' })).toHaveAttribute('href', `${root}/workbench?template=demo%2F01_simple_seq`);
  });

  it('runs in the organization even when it has no project', async () => {
    renderList(group, '', []);
    const list = await screen.findByRole('list', { name: 'Problems' });
    expect(within(list).getAllByRole('link', { name: 'Run latest' })[0]).toHaveAttribute('href', '/app/isa-demo/runs/new?problem=flujo-checkout&revision=2');
  });

  it('finds a problem by name or address and says when none matches', async () => {
    renderList();
    await screen.findByRole('list', { name: 'Problems' });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search problems' }), { target: { value: 'borr' } });
    expect(within(screen.getByRole('list', { name: 'Problems' })).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search problems' }), { target: { value: 'zzz' } });
    expect(screen.getByText('No problem matches “zzz”.')).toBeInTheDocument();
  });

  it('explains how to start when the organization has no problem', async () => {
    problems.list.mockResolvedValue({ problems: [], total: 0, limit: 200, offset: 0 });
    renderList();

    const guide = (await screen.findByRole('heading', { name: 'No problems yet' })).closest('section') as HTMLElement;
    expect(within(guide).getByRole('button', { name: 'Upload BIM package' })).toBeInTheDocument();
    expect(within(guide).getByRole('link', { name: 'Start from a template' })).toHaveAttribute('href', `${root}/workbench?template=demo%2F01_simple_seq`);
  });

  it('keeps the page and offers a retry when the list fails', async () => {
    problems.list.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderList();

    expect(await screen.findByText(/Problems couldn’t be loaded \(503 · unavailable\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Problems' })).toBeInTheDocument();
  });

  it('lets a VIEWER read and compare but not upload, edit, run or delete', async () => {
    renderList(viewing);
    const list = await screen.findByRole('list', { name: 'Problems' });

    expect(screen.getByRole('note')).toHaveTextContent('You can open and compare problems here; uploading and editing need MEMBER.');
    expect(screen.queryByRole('button', { name: 'Upload BIM package' })).not.toBeInTheDocument();
    expect(within(list).queryByRole('link', { name: 'New version' })).not.toBeInTheDocument();
    expect(within(list).queryByRole('link', { name: 'Run latest' })).not.toBeInTheDocument();
    expect(within(list).queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
  });

  describe('upload', () => {
    async function openDialog() {
      renderList();
      await screen.findByRole('list', { name: 'Problems' });
      fireEvent.click(screen.getByRole('button', { name: 'Upload BIM package' }));
      return screen.findByRole('dialog', { name: 'Upload a BIM package' });
    }

    it('names the problem after the file, uploads it and opens the new problem', async () => {
      problems.create.mockResolvedValue(upload('analisis-de-latencia', 'analisis-de-latencia'));
      const dialog = await openDialog();

      fireEvent.change(within(dialog).getByLabelText('BIM package'), { target: { files: [file()] } });
      expect(within(dialog).getByLabelText('Name')).toHaveValue('analisis-de-latencia');
      expect(within(dialog).getByLabelText('Address')).toHaveValue('analisis-de-latencia');
      fireEvent.change(within(dialog).getByLabelText(/Description/), { target: { value: 'Edge pools' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Upload problem' }));

      await waitFor(() => expect(problems.create).toHaveBeenCalledWith('isa-demo', expect.any(File), { slug: 'analisis-de-latencia', name: 'analisis-de-latencia', description: 'Edge pools' }));
      // The problem page is another route: the list is left for it.
      expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    });

    it('does not send without a file', async () => {
      const dialog = await openDialog();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Upload problem' }));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose the .bim.zip package to upload.');
      expect(problems.create).not.toHaveBeenCalled();
    });

    it('lists where a refused package is wrong (422), and keeps the dialog open', async () => {
      problems.create.mockRejectedValue(refusal(422, 'invalid_instance', { diagnostics: [{ code: 'missing_role', message: 'The application is missing.', resource: 'instance.json' }] }));
      const dialog = await openDialog();
      fireEvent.change(within(dialog).getByLabelText('BIM package'), { target: { files: [file()] } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Upload problem' }));

      const alert = await within(dialog).findByRole('alert');
      expect(alert).toHaveTextContent('The package was read and refused (422 · invalid_instance), so nothing was created.');
      expect(within(alert).getByRole('list', { name: 'What the compiler found' })).toHaveTextContent('instance.json The application is missing.');
      expect(where()).toBe(`${root}/problems?create=problem`);
    });

    it.each([
      [refusal(409, 'slug_conflict'), 'That address is already used by another problem in this organization (409 · slug_conflict). Pick another one.'],
      [new QuotaError('quota_exceeded', 'full', { limit_id: 'maxProblems', limit: 3 }), 'Your plan has no room for this (402 · quota_exceeded)'],
      [refusal(413, 'payload_too_large'), 'The package is larger than you can upload (413 · payload_too_large), so nothing was created.'],
    ])('says why nothing was created (%#)', async (caught, text) => {
      problems.create.mockRejectedValue(caught);
      const dialog = await openDialog();
      fireEvent.change(within(dialog).getByLabelText('BIM package'), { target: { files: [file()] } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Upload problem' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(text);
    });
  });

  describe('the dialog in the address', () => {
    it('is open when the address holds create=problem, over the list', async () => {
      renderList(group, '?create=problem');

      expect(await screen.findByRole('dialog', { name: 'Upload a BIM package' })).toBeInTheDocument();
      expect(screen.getByRole('heading', { level: 1, name: 'Problems' })).toBeInTheDocument();
    });

    it('closes by replacing the entry, so Back does not open the dialog again', async () => {
      renderList();
      await screen.findByRole('list', { name: 'Problems' });
      const opener = screen.getByRole('button', { name: 'Upload BIM package' });
      opener.focus();
      fireEvent.click(opener);
      const dialog = await screen.findByRole('dialog', { name: 'Upload a BIM package' });
      expect(where()).toBe(`${root}/problems?create=problem`);

      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Upload BIM package' })).toHaveFocus();

      fireEvent.click(screen.getByRole('button', { name: 'Browser back' }));
      await waitFor(() => expect(where()).toBe(`${root}/problems`));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('gives a VIEWER no dialog when the address asks for one', async () => {
      renderList(viewing, '?create=problem');

      await screen.findByRole('list', { name: 'Problems' });
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(problems.create).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('deletes a problem once its address is typed', async () => {
      problems.list.mockResolvedValueOnce({ problems: [checkout, draft], total: 2, limit: 200, offset: 0 }).mockResolvedValue({ problems: [checkout], total: 1, limit: 200, offset: 0 });
      problems.remove.mockResolvedValue(undefined);
      renderList(admin);
      const list = await screen.findByRole('list', { name: 'Problems' });

      fireEvent.click(within(list).getByRole('button', { name: 'Delete Borrador' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete Borrador?' });
      const confirm = within(dialog).getByRole('button', { name: 'Delete problem' });
      expect(confirm).toBeDisabled();
      fireEvent.change(within(dialog).getByLabelText('Type borrador to confirm'), { target: { value: 'borrador' } });
      fireEvent.click(confirm);

      await waitFor(() => expect(problems.remove).toHaveBeenCalledWith('qos-lab', 'borrador'));
      expect(await screen.findByText('Problem “Borrador” deleted.')).toBeInTheDocument();
      await waitFor(() => expect(within(screen.getByRole('list', { name: 'Problems' })).getAllByRole('listitem')).toHaveLength(1));
    });

    it('says a problem that runs used is kept (409 problem_has_runs)', async () => {
      problems.remove.mockRejectedValue(refusal(409, 'problem_has_runs'));
      renderList(admin);
      const list = await screen.findByRole('list', { name: 'Problems' });

      fireEvent.click(within(list).getByRole('button', { name: 'Delete Flujo de checkout' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete Flujo de checkout?' });
      fireEvent.change(within(dialog).getByLabelText('Type flujo-checkout to confirm'), { target: { value: 'flujo-checkout' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete problem' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Runs or studies name a version of this problem, so it can’t be deleted (409 · problem_has_runs).');
    });

    it('is not offered to a MEMBER', async () => {
      renderList();
      const list = await screen.findByRole('list', { name: 'Problems' });
      expect(within(list).queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
    });
  });

  it('shows the organization gate when the address names an organization the account is not in', async () => {
    renderProjectScreen(<CaseList />, { path: '/app/:org/problems', url: '/app/elsewhere/problems', organizations: [group] });
    expect(await screen.findByRole('heading', { name: 'Organization not available' })).toBeInTheDocument();
  });
});
