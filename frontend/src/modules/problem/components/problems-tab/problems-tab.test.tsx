import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../../../api/auth';
import { HttpError } from '../../../../api/client';
import type { ProblemUpload } from '../../../../api/problems';
import type { OrgRole } from '../../../organization/api/organizationsApi';
import { addressNow, fakeGateway, renderModule, type Answer } from '../../../../test/moduleKit';
import { problemOf, versionOf } from '../../../../test/problemPage';
import ProblemsTab, { PER_PAGE } from '.';

const problems = vi.hoisted(() => ({ create: vi.fn(), remove: vi.fn() }));
vi.mock('../../../../api/problems', () => ({ problemsApi: problems }));

const ORG = { slug: 'isa-demo', name: 'ISA Demo Group' };
const LIST = '/v1/organizations/isa-demo/problems';
const COMPOSITIONS = '/v1/organizations/isa-demo/compositions';

const checkout = problemOf('flujo-checkout', 'Flujo de checkout', {
  description: 'Payments with parallel stock and shipping.',
  revision_count: 2,
  latest_revision: {
    id: 'case-flujo-checkout-r2',
    revision: 2,
    package_digest: `sha256-${'2'.repeat(64)}`,
    created_at: '2026-04-02T00:00:00Z',
    origin: 'editor',
  },
});
const draft = problemOf('borrador', 'Borrador', { created_at: '2026-03-01T00:00:00Z' });

const refusal = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new HttpError(status, 'refused'), { code, ...extra });

/** The gateway: the problems it lists (all of them unless `list` answers otherwise) and the organization's compositions. */
function gatewayOf(list: Answer = { body: { problems: [checkout, draft], total: 2 } }) {
  return fakeGateway({
    [`GET ${LIST}`]: list,
    [`GET ${COMPOSITIONS}`]: {
      body: {
        compositions: [
          { id: 'composition-fleet', slug: 'fleet-plan', name: 'Fleet plan' },
          { id: 'composition-desk', slug: 'order-desk', name: 'Order desk' },
        ],
        total: 2,
      },
    },
  });
}

function renderTab(
  role: OrgRole = 'MEMBER',
  entry = '/orgs/isa-demo/problems',
  gateway = gatewayOf()
) {
  renderModule(<ProblemsTab org={ORG} myRole={role} />, {
    gateway,
    entry,
    path: '/orgs/:org/:tab',
    routes: { '/problems/:org/:problem': <p>the problem page</p> },
  });
  return gateway;
}

const lastList = (gateway: ReturnType<typeof gatewayOf>) =>
  new URL(
    `http://x${gateway.mock.calls.filter(([path]) => String(path).startsWith(LIST)).at(-1)?.[0]}`
  ).searchParams;

describe("the organization's Problems tab", () => {
  beforeEach(() => vi.clearAllMocks());

  it('pages the problems on the gateway, each card saying whether it can run, where its latest version came from and how many it has', async () => {
    const gateway = renderTab();

    const card = await screen.findByRole('article', { name: 'Flujo de checkout' });
    expect(lastList(gateway).get('limit')).toBe(String(PER_PAGE));
    expect(lastList(gateway).get('offset')).toBe('0');
    expect(within(card).getByRole('link', { name: 'Flujo de checkout' })).toHaveAttribute(
      'href',
      '/problems/isa-demo/flujo-checkout'
    );
    expect(within(card).getByText('Ready to run')).toBeInTheDocument();
    expect(within(card).getByText('Problem editor')).toBeInTheDocument();
    expect(within(card).getByText(/2 versions · latest v2 · /)).toBeInTheDocument();
    expect(
      within(card).getByText('Payments with parallel stock and shipping.')
    ).toBeInTheDocument();
    const other = screen.getByRole('article', { name: 'Borrador' });
    expect(within(other).getByText('No version yet')).toBeInTheDocument();
    expect(within(other).getByText('0 versions · latest none yet')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sha256-|[0-9a-f]{12}/);
    // One list request: the rows carry their latest version and their count.
    expect(gateway.mock.calls.filter(([path]) => String(path).includes('/revisions'))).toEqual([]);
  });

  it('gives a MEMBER the kebab with Run latest and New version, but not Delete', async () => {
    renderTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Flujo de checkout' }));
    expect(
      screen.getByRole('menuitem', { name: 'Run the latest version of Flujo de checkout' })
    ).toHaveAttribute('href', '/app/isa-demo/runs/new?problem=flujo-checkout&revision=2');
    expect(
      screen.getByRole('menuitem', { name: 'New version of Flujo de checkout' })
    ).toHaveAttribute('href', '/problem-editor?org=isa-demo&problem=flujo-checkout');
    expect(screen.queryByRole('menuitem', { name: /Delete/ })).not.toBeInTheDocument();
    const other = screen.getByRole('article', { name: 'Borrador' });
    fireEvent.click(within(other).getByRole('button', { name: 'Actions for Borrador' }));
    expect(
      within(other).queryByRole('menuitem', { name: /Run the latest/ })
    ).not.toBeInTheDocument();
    expect(
      within(other).getByRole('menuitem', { name: 'New version of Borrador' })
    ).toBeInTheDocument();
  });

  it('offers the three ways to add a problem under New: upload, the problem editor and a template', async () => {
    renderTab();
    await screen.findByRole('article', { name: 'Flujo de checkout' });

    fireEvent.click(screen.getByRole('button', { name: /^New/ }));
    const menu = screen.getByRole('menu', { name: 'New problem' });
    expect(within(menu).getByRole('menuitem', { name: /Upload BIM package/ })).toBeInTheDocument();
    expect(
      within(menu).getByRole('menuitem', { name: /Write in the problem editor/ })
    ).toHaveAttribute('href', '/problem-editor?org=isa-demo');
    expect(within(menu).getByRole('menuitem', { name: /Start from a template/ })).toHaveAttribute(
      'href',
      '/problem-editor?org=isa-demo&template=demo%2F01_simple_seq'
    );
  });

  it('gives a VIEWER no New and no kebab', async () => {
    renderTab('VIEWER');

    await screen.findByRole('article', { name: 'Flujo de checkout' });
    expect(screen.queryByRole('button', { name: /^New/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Actions for/ })).not.toBeInTheDocument();
  });

  it('searches on the gateway after a pause, and says when nothing matches', async () => {
    const gateway = renderTab(
      'MEMBER',
      '/orgs/isa-demo/problems',
      gatewayOf(({ path }) => ({
        body: path.includes('q=zzz')
          ? { problems: [], total: 0 }
          : { problems: [checkout, draft], total: 2 },
      }))
    );
    await screen.findByRole('article', { name: 'Flujo de checkout' });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search problems' }), {
      target: { value: 'zzz' },
    });
    await waitFor(() => expect(addressNow()).toBe('/orgs/isa-demo/problems?q=zzz'));
    expect(await screen.findByText('No problem matches these filters.')).toBeInTheDocument();
    expect(lastList(gateway).get('q')).toBe('zzz');
    fireEvent.click(screen.getByRole('button', { name: 'Show every problem' }));
    await waitFor(() => expect(addressNow()).toBe('/orgs/isa-demo/problems'));
  });

  describe('filters', () => {
    it('narrows the problems by the origin of the latest version, on the gateway and in the address', async () => {
      const gateway = renderTab();
      await screen.findByRole('article', { name: 'Flujo de checkout' });

      fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
      const origins = screen.getByRole('group', { name: 'Origin of the latest version' });
      expect(
        within(origins)
          .getAllByRole('radio')
          .map(radio => radio.closest('label')?.textContent)
      ).toEqual(['All origins', 'Uploaded', 'Problem editor', 'QACOForge']);
      fireEvent.click(within(origins).getByRole('radio', { name: 'Problem editor' }));
      await waitFor(() => expect(addressNow()).toBe('/orgs/isa-demo/problems?origin=editor'));
      await waitFor(() => expect(lastList(gateway).get('origin')).toBe('editor'));
    });

    it('narrows the problems to the ones a composition links, and offers the organization’s compositions', async () => {
      const gateway = renderTab();
      await screen.findByRole('article', { name: 'Flujo de checkout' });

      fireEvent.click(screen.getByRole('button', { name: /Filters/ }));
      const select = screen.getByRole('combobox', { name: 'Linked by composition' });
      await waitFor(() =>
        expect(
          within(select)
            .getAllByRole('option')
            .map(option => option.textContent)
        ).toEqual(['Any composition', 'Fleet plan', 'Order desk'])
      );
      fireEvent.change(select, { target: { value: 'fleet-plan' } });
      await waitFor(() =>
        expect(addressNow()).toBe('/orgs/isa-demo/problems?composition=fleet-plan')
      );
      await waitFor(() => expect(lastList(gateway).get('composition')).toBe('fleet-plan'));
    });

    it('reads the filters from the address, and orders by the latest version when asked', async () => {
      const gateway = renderTab('MEMBER', '/orgs/isa-demo/problems?origin=upload&sort=recent');

      await screen.findByRole('article', { name: 'Flujo de checkout' });
      expect(lastList(gateway).get('origin')).toBe('upload');
      expect(
        screen.getAllByRole('article').map(article => article.getAttribute('aria-label'))
      ).toEqual(['Flujo de checkout', 'Borrador']);
      expect(screen.getByRole('button', { name: /Filters/ })).toHaveTextContent('2');
    });
  });

  it('explains how to start when the organization has no problem', async () => {
    renderTab('MEMBER', '/orgs/isa-demo/problems', gatewayOf({ body: { problems: [], total: 0 } }));

    expect(await screen.findByText('No problems yet')).toBeInTheDocument();
  });

  it('pages beyond ten problems', async () => {
    const gateway = renderTab(
      'MEMBER',
      '/orgs/isa-demo/problems',
      gatewayOf({ body: { problems: [checkout], total: 12 } })
    );
    await screen.findByRole('article', { name: 'Flujo de checkout' });

    fireEvent.click(screen.getByRole('button', { name: '2' }));
    await waitFor(() => expect(lastList(gateway).get('offset')).toBe('10'));
    expect(addressNow()).toBe('/orgs/isa-demo/problems?page=2');
  });

  it('says when the problems cannot be loaded, and retries', async () => {
    let calls = 0;
    renderTab(
      'MEMBER',
      '/orgs/isa-demo/problems',
      gatewayOf(() => {
        calls += 1;
        return calls === 1
          ? { status: 503, body: { code: 'unavailable', detail: 'Down.' } }
          : { body: { problems: [checkout], total: 1 } };
      })
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The problems could not be loaded.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('article', { name: 'Flujo de checkout' })).toBeInTheDocument();
  });

  describe('upload', () => {
    const file = () =>
      new File([new Uint8Array([80, 75, 3, 4])], 'analisis-de-latencia.bim.zip', {
        type: 'application/vnd.bim+zip',
      });
    const open = async () => {
      await screen.findByRole('article', { name: 'Flujo de checkout' });
      fireEvent.click(screen.getByRole('button', { name: /^New/ }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Upload BIM package/ }));
      return screen.findByRole('dialog', { name: 'Upload a BIM package' });
    };
    const created = (): ProblemUpload => {
      const item = problemOf('analisis-de-latencia', 'analisis-de-latencia');
      return {
        problem: item,
        revision: versionOf(item, 1),
        created: true,
        compilation: {
          id: 'c1',
          compilation_digest: 'sha256-c',
          compiler_digest: 'sha256-k',
          ir_digest: 'sha256-i',
          binding_space: '4',
          created_at: '2026-04-02T00:00:00Z',
          current: true,
        },
      };
    };

    it('names the problem after the file, uploads it in this organization and opens the new problem', async () => {
      problems.create.mockResolvedValue(created());
      renderTab();

      const dialog = await open();
      expect(within(dialog).getByText('ISA Demo Group')).toBeInTheDocument();
      fireEvent.change(within(dialog).getByLabelText('BIM package'), {
        target: { files: [file()] },
      });
      await waitFor(() =>
        expect(within(dialog).getByLabelText('Name')).toHaveValue('analisis-de-latencia')
      );
      expect(within(dialog).getByLabelText('Address')).toHaveValue('analisis-de-latencia');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Upload problem' }));

      await waitFor(() =>
        expect(problems.create).toHaveBeenCalledWith('isa-demo', expect.any(File), {
          slug: 'analisis-de-latencia',
          name: 'analisis-de-latencia',
          description: undefined,
          producer: 'openbinding-upload',
        })
      );
      expect(await screen.findByText('the problem page')).toBeInTheDocument();
      expect(addressNow()).toBe('/problems/isa-demo/analisis-de-latencia');
    });

    it('does not send without a file', async () => {
      renderTab();

      const dialog = await open();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Upload problem' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'Choose the .bim.zip package to upload.'
      );
      expect(problems.create).not.toHaveBeenCalled();
    });

    it('lists where a refused package is wrong (422), and keeps the dialog open', async () => {
      problems.create.mockRejectedValue(
        refusal(422, 'invalid_instance', {
          diagnostics: [
            {
              code: 'missing_role',
              message: 'The application is missing.',
              resource: 'instance.json',
            },
          ],
        })
      );
      renderTab();

      const dialog = await open();
      fireEvent.change(within(dialog).getByLabelText('BIM package'), {
        target: { files: [file()] },
      });
      await within(dialog).findByText('analisis-de-latencia.bim.zip');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Upload problem' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'The package was read and refused (422 · invalid_instance)'
      );
      expect(
        within(dialog).getByRole('list', { name: 'What the compiler found' })
      ).toHaveTextContent('The application is missing.');
    });

    it('says a full plan and a taken address in their own words', async () => {
      problems.create.mockRejectedValueOnce(new QuotaError('quota_exceeded', 'Full.'));
      renderTab();

      const dialog = await open();
      fireEvent.change(within(dialog).getByLabelText('BIM package'), {
        target: { files: [file()] },
      });
      await within(dialog).findByText('analisis-de-latencia.bim.zip');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Upload problem' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('Your plan has no room');

      problems.create.mockRejectedValueOnce(refusal(409, 'slug_conflict'));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Upload problem' }));
      await waitFor(() =>
        expect(within(dialog).getByRole('alert')).toHaveTextContent(
          'That address is already used by another problem in this organization'
        )
      );
    });
  });

  describe('delete', () => {
    it('lets an ADMIN delete a problem once its address is typed, and lists the problems again', async () => {
      problems.remove.mockResolvedValue(undefined);
      const gateway = renderTab('ADMIN');

      fireEvent.click(await screen.findByRole('button', { name: 'Actions for Flujo de checkout' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Flujo de checkout' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete Flujo de checkout?' });
      const confirm = within(dialog).getByRole('button', { name: 'Delete problem' });
      expect(confirm).toBeDisabled();
      fireEvent.change(within(dialog).getByLabelText('Type flujo-checkout to confirm'), {
        target: { value: 'flujo-checkout' },
      });
      fireEvent.click(confirm);

      await waitFor(() =>
        expect(problems.remove).toHaveBeenCalledWith('isa-demo', 'flujo-checkout')
      );
      expect(await screen.findByText('Problem “Flujo de checkout” deleted.')).toBeInTheDocument();
      await waitFor(() =>
        expect(gateway.mock.calls.filter(([path]) => String(path).startsWith(LIST))).toHaveLength(2)
      );
    });

    it('says a problem that runs used is kept (409 problem_has_runs)', async () => {
      problems.remove.mockRejectedValue(refusal(409, 'problem_has_runs'));
      renderTab('OWNER');

      fireEvent.click(await screen.findByRole('button', { name: 'Actions for Flujo de checkout' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Flujo de checkout' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete Flujo de checkout?' });
      fireEvent.change(within(dialog).getByLabelText('Type flujo-checkout to confirm'), {
        target: { value: 'flujo-checkout' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete problem' }));

      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'Runs or studies name a version of this problem, so it can’t be deleted (409 · problem_has_runs).'
      );
    });
  });
});
