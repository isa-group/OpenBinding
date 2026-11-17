import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../../api/client';
import type { ProblemUpload } from '../../../../api/problems';
import type {
  CompositionVersionView,
  CompositionView,
  ProblemFacts,
} from '../../../core/api/types';
import type { Organization } from '../../../organization/api/organizationsApi';
import fmsFacts from '../../../../test/fixtures/core/fms.facts.json';
import fmsVersion from '../../../../test/fixtures/core/fms.version.json';
import { addressNow, type Answer } from '../../../../test/moduleKit';
import {
  memberOf,
  problemGateway,
  problemOf,
  renderProblemPage,
  versionOf,
} from '../../../../test/problemPage';
import ProblemCardPage from '.';
import { checkoutFacts, compiledDocument, digestOf } from '../../utils/fixtures';

const problems = vi.hoisted(() => ({
  revision: vi.fn(),
  compilation: vi.fn(),
  ir: vi.fn(),
  source: vi.fn(),
  remove: vi.fn(),
  createRevision: vi.fn(),
}));
const runs = vi.hoisted(() => ({ list: vi.fn() }));
const facts = vi.hoisted(() => ({ get: vi.fn() }));
const compositions = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), version: vi.fn() }));

vi.mock('../../../../api/problems', () => ({ problemsApi: problems }));
vi.mock('../../../core/utils/problem/facts', async actual => ({
  ...(await actual<typeof import('../../../core/utils/problem/facts')>()),
  problemFactsApi: facts,
}));
vi.mock('../../../core/utils/composition/api', () => ({ compositionsApi: compositions }));
vi.mock('../../../../api/runs', async () => ({
  ...(await vi.importActual<typeof import('../../../../api/runs')>('../../../../api/runs')),
  runsApi: runs,
}));

const owner = memberOf('isa-demo', 'OWNER', 'ISA Demo Group');
const member = memberOf('member-lab', 'MEMBER', 'Member Lab');
const viewer = memberOf('read-lab', 'VIEWER', 'Read Lab');
const admin = memberOf('qos-lab', 'ADMIN', 'QoS Lab');

const checkout = problemOf('flujo-checkout', 'Flujo de checkout', {
  description: 'Payments with parallel stock and shipping.',
});
const r1 = versionOf(checkout, 1);
const r2 = versionOf(checkout, 2, { origin: 'editor' });

const compilation = {
  id: 'compilation-2',
  revision_id: r2.id,
  compilation_digest: digestOf('9'),
  compiler_digest: digestOf('8'),
  ir_digest: digestOf('c'),
  binding_space: '4096',
  created_at: '2026-04-02T00:00:00Z',
  current: true,
  toolchain: {},
  analysis: { tasks: 3, candidates: 12, constraints: 2, placement: false, bindingSpace: '4096' },
  resources: {},
  compatible_modes: [],
};

const refusal = (status: number, code = 'refused') =>
  Object.assign(new HttpError(status, 'refused'), { code });

const page = (org: string, slug = 'flujo-checkout') => `/problems/${org}/${slug}`;
const apiRoot = (org: string, slug = 'flujo-checkout') =>
  `/v1/organizations/${org}/problems/${slug}`;

/** The page of `slug` in `organization` at `address` (a tab and a query), for an account in `organizations`. */
function renderPage(
  organization: Organization = owner,
  address = '',
  options: {
    problem?: ReturnType<typeof problemOf>;
    revisions?: ReturnType<typeof versionOf>[];
    extra?: Record<string, Answer>;
    organizations?: Organization[];
  } = {}
) {
  const problem = options.problem ?? checkout;
  const gateway = problemGateway(
    organization.slug,
    problem,
    options.revisions ?? [r1, r2],
    options.extra
  );
  renderProblemPage(<ProblemCardPage />, {
    url: `${page(organization.slug, problem.slug)}${address}`,
    organizations: options.organizations ?? [organization],
    gateway,
  });
  return gateway;
}

const tabNames = () =>
  within(screen.getByRole('navigation', { name: 'Problem sections' }))
    .getAllByRole('link')
    .map(link => link.textContent);

describe('Problem page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    problems.compilation.mockResolvedValue(compilation);
    problems.ir.mockResolvedValue({
      id: 'compilation-2',
      ir_digest: digestOf('c'),
      ir: compiledDocument(),
      source_map: {},
    });
    facts.get.mockResolvedValue(checkoutFacts());
    problems.revision.mockImplementation(
      async (_org: string, _problem: string, revision: string) => ({
        ...(String(revision) === '1' ? r1 : r2),
        document: { apiVersion: 'bim/v1', kind: 'Instance' },
        files: [],
        resource_digests: {},
        compilations: [],
      })
    );
    problems.source.mockRejectedValue(refusal(503, 'unavailable'));
    runs.list.mockResolvedValue({ runs: [], total: 0 });
    compositions.list.mockResolvedValue({ compositions: [], total: 0, limit: 200, offset: 0 });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('heads the page with SPHERE’s breadcrumb, the Sealed version with where it came from, the actions and the tiles', async () => {
    const gateway = renderPage();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' })
    ).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute(
      'href',
      '/orgs/isa-demo/problems'
    );
    expect(screen.getByText('Sealed', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText(/· Updated .* ago/)).toBeInTheDocument();
    expect(screen.getByText('Written in the problem editor')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New version' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Get problem/ })).toBeInTheDocument();
    expect(gateway).toHaveBeenCalledWith(apiRoot('isa-demo'), expect.anything());
    await waitFor(() =>
      expect(screen.getByText('Tasks', { selector: 'dt' }).nextElementSibling).toHaveTextContent(
        '3'
      )
    );
    expect(screen.getByText('Candidates', { selector: 'dt' }).nextElementSibling).toHaveTextContent(
      '12'
    );
    expect(
      screen.getByText('Combinations', { selector: 'dt' }).nextElementSibling
    ).toHaveTextContent('≈ 10^3.6');
    expect(screen.getByText('Versions', { selector: 'dt' }).nextElementSibling).toHaveTextContent(
      '2'
    );
  });

  it('serves the tabs Overview, Candidates, Versions, Runs, Compositions, Source and Settings, Overview first, showing the latest version', async () => {
    renderPage();

    await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
    expect(tabNames()).toEqual([
      'Overview',
      'Candidates',
      'Versions',
      'Runs',
      'Compositions',
      'Source',
      'Settings',
    ]);
    expect(screen.getByRole('link', { name: 'Overview' })).toHaveAttribute('aria-current', 'page');
    const version = screen.getByRole('combobox', { name: 'Version' });
    expect(version).toHaveValue('2');
    expect(
      within(version)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['Version 2 · latest', 'Version 1']);
    expect(await screen.findByRole('region', { name: 'Identity' })).toBeInTheDocument();
    await waitFor(() =>
      expect(problems.compilation).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', 2)
    );
  });

  it.each([
    ['/candidates', 'Candidates'],
    ['/versions', 'Versions'],
    ['/runs', 'Runs'],
    ['/compositions', 'Compositions'],
    ['/source', 'Source'],
    ['/settings', 'Settings'],
  ])('selects the tab named by the address %s', async (address, label) => {
    renderPage(owner, address);

    await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
    const tabs = screen.getByRole('navigation', { name: 'Problem sections' });
    expect(within(tabs).getByRole('link', { name: label })).toHaveAttribute('aria-current', 'page');
    expect(within(tabs).getByRole('link', { name: 'Overview' })).not.toHaveAttribute(
      'aria-current'
    );
  });

  it('moves between the tabs by address and keeps the version it shows', async () => {
    renderPage(owner, '?version=1');

    await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
    const tabs = screen.getByRole('navigation', { name: 'Problem sections' });
    fireEvent.click(within(tabs).getByRole('link', { name: 'Source' }));
    await waitFor(() => expect(addressNow()).toBe(`${page('isa-demo')}/source?version=1`));
    fireEvent.click(within(tabs).getByRole('link', { name: 'Overview' }));
    await waitFor(() => expect(addressNow()).toBe(`${page('isa-demo')}?version=1`));
  });

  it('changes the version shown with the select', async () => {
    renderPage();

    fireEvent.change(await screen.findByRole('combobox', { name: 'Version' }), {
      target: { value: '1' },
    });
    await waitFor(() => expect(addressNow()).toBe(`${page('isa-demo')}?version=1`));
    expect(screen.getByText('Uploaded as a BIM package')).toBeInTheDocument();
  });

  it('answers an unknown tab with Page not found, before reading the problem', async () => {
    const gateway = renderPage(owner, '/history');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(gateway).not.toHaveBeenCalled();
  });

  it('answers a missing version with Page not found', async () => {
    problems.revision.mockRejectedValue(refusal(404, 'not_found'));
    renderPage(owner, '?version=9');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(problems.revision).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', '9');
  });

  it('finds a version named by its package digest when the query is not a number', async () => {
    renderPage(owner, `?version=${r1.package_digest}`);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' })
    ).toBeInTheDocument();
    expect(problems.revision).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', r1.package_digest);
  });

  it('answers a problem of an organization the account is not in like a missing one, without asking for it', async () => {
    const gateway = renderPage(owner, '', { organizations: [member] });

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(gateway).not.toHaveBeenCalled();
  });

  describe('Candidates tab', () => {
    const fms = problemOf('fms', 'Fleet routing problem', { id: fmsVersion.problem.problem.id });
    const fms1 = versionOf(fms, 1);
    const fms2 = versionOf(fms, 2);
    const fleet = { name: 'Fleet plan', slug: 'fleet-plan' } as CompositionView;
    const chosen = () => structuredClone(fmsVersion) as CompositionVersionView;
    const t1 = () =>
      within(screen.getByRole('region', { name: 'Candidates of each task' })).getByRole('table', {
        name: /Task T1/,
      });
    const renderFms = (address: string) =>
      renderPage(owner, address, { problem: fms, revisions: [fms1, fms2] });

    beforeEach(() => {
      facts.get.mockResolvedValue(fmsFacts as ProblemFacts);
      compositions.get.mockResolvedValue({ value: fleet, etag: null });
      compositions.version.mockResolvedValue(chosen());
    });

    it('lists the candidates of each task in the explorer frame, nothing selected, narrowed by task and search', async () => {
      renderFms('/candidates?version=1');

      const table = await screen.findByRole('table', { name: /Task T1/ });
      expect(
        within(table)
          .getAllByRole('row')
          .slice(1)
          .every(row => !row.hasAttribute('aria-current'))
      ).toBe(true);
      expect(within(table).getAllByText(/^written in candidates\.json at /).length).toBeGreaterThan(
        0
      );
      expect(compositions.version).not.toHaveBeenCalled();

      fireEvent.change(screen.getByRole('combobox', { name: 'Task' }), {
        target: { value: 'T1' },
      });
      expect(screen.getAllByRole('table')).toHaveLength(1);
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), {
        target: { value: 'nothing-like-this' },
      });
      expect(screen.getByText('No candidate matches “nothing-like-this”.')).toBeInTheDocument();
    });

    it('highlights what a composition version chose, read on the compilation its values were evaluated on, with a link back', async () => {
      renderFms('/candidates?version=1&composition=fleet-plan&compositionVersion=1.0.0');

      expect(await screen.findByText(/chose are selected/)).toHaveTextContent(
        'The candidates Fleet plan 1.0.0 chose are selected'
      );
      expect(within(t1()).getByRole('row', { name: /^cand_t1_aws/ })).toHaveAttribute(
        'aria-current',
        'true'
      );
      expect(
        within(t1())
          .getAllByRole('row')
          .filter(row => row.getAttribute('aria-current') === 'true')
      ).toHaveLength(1);
      expect(screen.getByRole('link', { name: 'Back to Fleet plan 1.0.0' })).toHaveAttribute(
        'href',
        `/compositions/isa-demo/fleet-plan?version=1.0.0`
      );
      expect(compositions.version).toHaveBeenCalledWith('isa-demo', 'fleet-plan', '1.0.0');
      expect(facts.get).toHaveBeenCalledWith(
        'isa-demo',
        'fms',
        1,
        fmsVersion.evaluations[0].compilation.id
      );
    });

    it('leaves the highlight behind when another tab opens', async () => {
      renderFms('/candidates?version=1&composition=fleet-plan&compositionVersion=1.0.0');

      await screen.findByText(/chose are selected/);
      const tabs = screen.getByRole('navigation', { name: 'Problem sections' });
      fireEvent.click(within(tabs).getByRole('link', { name: 'Overview' }));
      await waitFor(() => expect(addressNow()).toBe(`${page('isa-demo', 'fms')}?version=1`));
    });

    it('sends to the problem version a composition version chose on', async () => {
      renderFms('/candidates?version=2&composition=fleet-plan&compositionVersion=1.0.0');

      expect(
        await screen.findByText(
          'Fleet plan 1.0.0 chose its candidates on version 1 of this problem.'
        )
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open version 1' })).toHaveAttribute(
        'href',
        `${page('isa-demo', 'fms')}/candidates?version=1&composition=fleet-plan&compositionVersion=1.0.0`
      );
      expect(
        within(t1())
          .getAllByRole('row')
          .filter(row => row.hasAttribute('aria-current'))
      ).toHaveLength(0);
    });

    it('says a composition version of another problem has nothing to highlight', async () => {
      const other = chosen();
      compositions.version.mockResolvedValue({
        ...other,
        problem: other.problem && {
          ...other.problem,
          problem: { id: 'case-other', slug: 'other', name: 'Other' },
        },
      });
      renderFms('/candidates?version=1&composition=fleet-plan&compositionVersion=1.0.0');

      expect(
        await screen.findByText(
          'Fleet plan 1.0.0 links no version of this problem, so it has nothing to highlight here.'
        )
      ).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Show without it' })).toHaveAttribute(
        'href',
        `${page('isa-demo', 'fms')}/candidates?version=1`
      );
    });

    it('says when the composition version cannot be read, and keeps the candidates', async () => {
      compositions.version.mockRejectedValue(refusal(404, 'not_found'));
      renderFms('/candidates?version=1&composition=fleet-plan&compositionVersion=9.9.9');

      expect(
        await screen.findByText(
          /The composition version 9\.9\.9 of fleet-plan couldn’t be loaded \(404/
        )
      ).toBeInTheDocument();
      expect(await screen.findByRole('table', { name: /Task T1/ })).toBeInTheDocument();
    });
  });

  describe('Compositions tab', () => {
    const fleet: CompositionView = {
      id: 'composition-fleet',
      slug: 'fleet-plan',
      name: 'Fleet plan',
      description: '',
      kind: 'workflow',
      archived: false,
      visibility: 'private',
      organization: { id: owner.id, slug: 'isa-demo', name: 'ISA Demo Group' },
      created_by_id: null,
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      version_count: 2,
      latest_version: {
        id: 'v2',
        ordinal: 2,
        label: '1.1.0',
        values_status: 'verified',
        verified: true,
        created_at: '2026-10-01T00:00:00Z',
      },
    };
    const latest = (): CompositionVersionView => {
      const version = structuredClone(fmsVersion) as CompositionVersionView;
      return {
        ...version,
        id: 'v2',
        label: '1.1.0',
        ordinal: 2,
        problem: version.problem && {
          ...version.problem,
          problem: { id: checkout.id, slug: 'flujo-checkout', name: 'Flujo de checkout' },
          revision: { id: r2.id, revision: 2 },
        },
      };
    };

    it('shows the compositions that link the problem as cards, with their latest values and where they show on the problem', async () => {
      compositions.list.mockResolvedValue({
        compositions: [fleet],
        total: 1,
        limit: 200,
        offset: 0,
      });
      compositions.version.mockResolvedValue(latest());
      renderPage(owner, '/compositions');

      const grid = await screen.findByRole('list', { name: 'Compositions that link this problem' });
      expect(compositions.list).toHaveBeenCalledWith('isa-demo', {
        problem: 'flujo-checkout',
        sort: 'name',
        limit: 200,
      });
      const card = within(grid).getByRole('article', { name: 'Fleet plan' });
      expect(within(card).getByRole('link', { name: 'Fleet plan' })).toHaveAttribute(
        'href',
        '/compositions/isa-demo/fleet-plan'
      );
      expect(within(card).getByText('v1.1.0')).toBeInTheDocument();
      const values = await within(grid).findByRole('list', { name: 'Values of Fleet plan 1.1.0' });
      expect(values).toHaveTextContent('cost 3,060 USD/month');
      expect(compositions.version).toHaveBeenCalledWith('isa-demo', 'fleet-plan', 'v2');
      expect(within(grid).getByRole('link', { name: 'version 2' })).toHaveAttribute(
        'href',
        `${page('isa-demo')}?version=2`
      );
      expect(
        within(grid).getByRole('link', { name: 'Show Fleet plan 1.1.0 on the problem' })
      ).toHaveAttribute(
        'href',
        `${page('isa-demo')}/candidates?version=2&composition=fleet-plan&compositionVersion=1.1.0`
      );
    });

    it('says when no composition links the problem', async () => {
      renderPage(owner, '/compositions');

      expect(await screen.findByText('No composition links this problem yet.')).toBeInTheDocument();
    });

    it('offers a retry when the compositions cannot be listed', async () => {
      compositions.list.mockRejectedValueOnce(refusal(503, 'unavailable'));
      renderPage(owner, '/compositions');

      expect(
        await screen.findByText(/The compositions couldn’t be loaded \(503 · unavailable\)/)
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByText('No composition links this problem yet.')).toBeInTheDocument();
    });
  });

  describe('roles', () => {
    it('gives a MEMBER a run, a new version (problem editor or upload) and a study, but not deleting', async () => {
      renderPage(member);

      await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
      expect(screen.getByRole('link', { name: 'Run this version' })).toHaveAttribute(
        'href',
        '/app/member-lab/runs/new?problem=flujo-checkout&revision=2'
      );
      expect(screen.getByRole('link', { name: 'Add to study' })).toHaveAttribute(
        'href',
        '/app/member-lab/studies/new?case=flujo-checkout&revision=2'
      );
      fireEvent.click(screen.getByRole('button', { name: 'New version' }));
      expect(screen.getByRole('menuitem', { name: /Problem editor/ })).toHaveAttribute(
        'href',
        '/app/member-lab/problem-editor?problem=flujo-checkout&revision=2'
      );
      expect(screen.getByRole('menuitem', { name: /Upload file/ })).toBeInTheDocument();
      const tabs = screen.getByRole('navigation', { name: 'Problem sections' });
      fireEvent.click(within(tabs).getByRole('link', { name: 'Settings' }));
      expect(await screen.findByLabelText('Name')).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Delete problem' })).not.toBeInTheDocument();
    });

    it('lets a VIEWER read and compare, and nothing else', async () => {
      renderPage(viewer);

      await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
      expect(screen.getByRole('note')).toHaveTextContent(
        'You can read and compare versions. New versions need MEMBER; deleting needs ADMIN.'
      );
      expect(screen.queryByRole('button', { name: 'New version' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Run this version' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Add to study' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Get problem/ })).toBeInTheDocument();
    });
  });

  describe('a new version', () => {
    const saved = (revision: number, created: boolean): ProblemUpload => ({
      problem: checkout,
      revision: versionOf(checkout, revision),
      created,
      compilation: { ...compilation, id: `compilation-${revision}` },
    });
    const file = () =>
      new File([new Uint8Array([80, 75, 3, 4])], 'next.bim.zip', {
        type: 'application/vnd.bim+zip',
      });
    const upload = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'New version' }));
      fireEvent.click(screen.getByRole('menuitem', { name: /Upload file/ }));
      const dialog = await screen.findByRole('dialog', {
        name: 'New version of Flujo de checkout',
      });
      fireEvent.change(within(dialog).getByLabelText('BIM package'), {
        target: { files: [file()] },
      });
      expect(await within(dialog).findByText('next.bim.zip')).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Upload version' }));
      return dialog;
    };

    it('uploads a package as the next version and shows it', async () => {
      problems.createRevision.mockResolvedValue(saved(3, true));
      let reads = 0;
      renderPage(member, '', {
        extra: {
          [`GET ${apiRoot('member-lab')}/revisions`]: () => {
            reads += 1;
            return {
              body: reads === 1 ? [r2, r1] : [versionOf(checkout, 3), r2, r1],
            };
          },
        },
      });

      await upload();
      await waitFor(() =>
        expect(problems.createRevision).toHaveBeenCalledWith(
          'member-lab',
          'flujo-checkout',
          expect.any(File),
          { producer: 'openbinding-upload' }
        )
      );
      await waitFor(() => expect(addressNow()).toBe(`${page('member-lab')}?version=3`));
      expect(await screen.findByRole('option', { name: 'Version 3 · latest' })).toBeInTheDocument();
      expect(await screen.findByText('Saved as version 3.')).toBeInTheDocument();
    });

    it('says when the package already is a version', async () => {
      problems.createRevision.mockResolvedValue(saved(2, false));
      renderPage(member);

      await upload();
      expect(await screen.findByText('Unchanged: this is version 2.')).toBeInTheDocument();
    });

    it('lists where a refused package is wrong (422), and keeps the dialog open', async () => {
      problems.createRevision.mockRejectedValue(
        Object.assign(refusal(422, 'invalid_instance'), {
          diagnostics: [{ code: 'missing_role', message: 'The application is missing.' }],
        })
      );
      renderPage(member);

      const dialog = await upload();
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        'The package was read and refused (422 · invalid_instance)'
      );
    });
  });

  describe('a problem without versions', () => {
    it('offers a MEMBER the upload instead of the version tabs', async () => {
      renderPage(member, '', { revisions: [] });

      const guide = await screen.findByRole('region', { name: 'No versions yet' });
      expect(within(guide).getByRole('button', { name: 'Upload a version' })).toBeInTheDocument();
      expect(screen.queryByRole('combobox', { name: 'Version' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Run this version' })).not.toBeInTheDocument();
    });

    it('does not offer a VIEWER a way to create the first version', async () => {
      renderPage(viewer, '', { revisions: [] });

      const guide = await screen.findByRole('region', { name: 'No versions yet' });
      expect(within(guide).queryByRole('button')).not.toBeInTheDocument();
    });
  });

  describe('Settings', () => {
    it('lets an ADMIN delete the problem with its versions, and goes back to the organization', async () => {
      problems.remove.mockResolvedValue(undefined);
      renderPage(admin, '/settings');

      fireEvent.click(await screen.findByRole('button', { name: 'Delete problem' }));
      const dialog = await screen.findByRole('dialog', { name: 'Delete Flujo de checkout?' });
      expect(
        within(dialog).getByText(/The problem and its versions disappear from QoS Lab/)
      ).toBeInTheDocument();
      fireEvent.change(within(dialog).getByLabelText('Type flujo-checkout to confirm'), {
        target: { value: 'flujo-checkout' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete problem' }));

      await waitFor(() =>
        expect(problems.remove).toHaveBeenCalledWith('qos-lab', 'flujo-checkout')
      );
      await waitFor(() => expect(addressNow()).toBe('/orgs/qos-lab/problems'));
    });

    it('keeps a problem that runs used (409 problem_has_runs)', async () => {
      problems.remove.mockRejectedValue(refusal(409, 'problem_has_runs'));
      renderPage(admin, '/settings');

      fireEvent.click(await screen.findByRole('button', { name: 'Delete problem' }));
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

  describe('when the problem cannot be read', () => {
    it('answers a missing problem with Page not found', async () => {
      renderPage(owner, '', {
        extra: {
          [`GET ${apiRoot('isa-demo')}`]: { status: 404, body: { code: 'not_found', detail: 'x' } },
        },
      });

      expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    });

    it('tells a failure of the gateway from a missing problem, and tries again', async () => {
      let attempts = 0;
      renderPage(owner, '', {
        extra: {
          [`GET ${apiRoot('isa-demo')}`]: () => {
            attempts += 1;
            return attempts === 1
              ? { status: 503, body: { code: 'unavailable', detail: 'Down.' } }
              : { body: checkout };
          },
        },
      });

      expect(await screen.findByRole('alert')).toHaveTextContent('The problem couldn’t be loaded.');
      expect(screen.getByText(/This says nothing about your access/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' })
      ).toBeInTheDocument();
    });
  });
});
