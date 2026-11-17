import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../../api/client';
import type { Organization } from '../../../organization/api/organizationsApi';
import {
  memberOf,
  problemGateway,
  problemOf,
  renderProblemPage,
  versionOf,
} from '../../../../test/problemPage';
import ProblemCardPage from '../../pages/card';
import { checkoutFacts, digestOf } from '../../utils/fixtures';

const problems = vi.hoisted(() => ({
  revision: vi.fn(),
  compilation: vi.fn(),
}));
const facts = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../../../api/problems', () => ({ problemsApi: problems }));
vi.mock('../../../core/utils/problem/facts', async actual => ({
  ...(await actual<typeof import('../../../core/utils/problem/facts')>()),
  problemFactsApi: facts,
}));

const group = memberOf('isa-demo', 'MEMBER', 'ISA Demo Group');
const viewing = memberOf('isa-demo', 'VIEWER', 'ISA Demo Group');
const checkout = problemOf('flujo-checkout', 'Flujo de checkout');
const r1 = versionOf(checkout, 1);
const r2 = versionOf(checkout, 2, { package_size: 48_213 });
const root = '/problems/isa-demo';

const refusal = (status: number, code = 'refused') =>
  Object.assign(new HttpError(status, 'refused'), { code });
const compilationOf = (revision: string) => ({
  id: `compilation-${revision}`,
  revision_id: `rev-${revision}`,
  compilation_digest: digestOf('9'),
  compiler_digest: digestOf('8'),
  ir_digest: digestOf('c'),
  binding_space: '4096',
  created_at: '2026-08-20T10:05:00Z',
  current: true,
  toolchain: {},
  analysis: { tasks: 4, candidates: 20, constraints: 2, placement: false, bindingSpace: '4096' },
  resources: {
    app: {
      role: 'application',
      path: 'application.json',
      apiVersion: 'qos-binding/v1',
      kind: 'Application',
    },
  },
  compatible_modes: [],
});

/** The Overview tab of the problem page (or `tab`), showing the version named by the query. */
function renderRevision(
  revision = '2',
  organization: Organization = group,
  tab = '',
  extra: Parameters<typeof problemGateway>[3] = {}
) {
  return renderProblemPage(<ProblemCardPage />, {
    url: `${root}/flujo-checkout${tab}?version=${revision}`,
    organizations: [organization],
    gateway: problemGateway('isa-demo', checkout, [r1, r2], extra),
  });
}

describe('Overview tab of the problem page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    problems.compilation.mockImplementation(
      async (_org: string, _problem: string, revision: number | string) =>
        compilationOf(String(revision))
    );
    facts.get.mockResolvedValue(checkoutFacts());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('opens with the problem, the version, its seal and what it identifies', async () => {
    renderRevision();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' })
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Version')).toHaveValue('2');
    expect(screen.getAllByText('Sealed')).toHaveLength(2);
    expect(screen.getByText('Uploaded as a BIM package')).toBeInTheDocument();
    const identity = screen.getByRole('region', { name: 'Identity' });
    expect(identity.textContent).not.toMatch(/sha256-|[0-9a-f]{12}/);
    expect(await within(identity).findByText('qos-binding/v1')).toBeInTheDocument();
    expect(within(identity).getByRole('link', { name: 'Open source' })).toHaveAttribute(
      'href',
      `${root}/flujo-checkout/source?version=2`
    );
    expect(identity).toHaveTextContent('47.1 KiB');
    expect(facts.get).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', 2, 'compilation-2');
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute(
      'href',
      '/orgs/isa-demo/problems'
    );
    const tiles = await screen.findAllByRole('definition');
    expect(tiles.map(tile => tile.textContent)).toEqual(
      expect.arrayContaining(['4', '20', '≈ 10^3.6', '2'])
    );
  });

  it('draws the workflow from the facts, with its alternatives, and the size of the binding space', async () => {
    renderRevision();

    const section = await screen.findByRole('region', { name: 'How the service works' });
    const drawing = await within(section).findByRole('group', { name: 'Workflow' });
    expect(drawing).toHaveAccessibleDescription(
      /^Workflow: authenticate, then \(inventory and shipping in parallel\)/
    );
    const choice = within(drawing).getByRole('group', {
      name: 'Choice, 2 branches, probabilities 0.7, 0.3',
    });
    expect(within(choice).getByText('0.7')).toBeInTheDocument();
    expect(
      within(drawing).getByRole('group', { name: 'Parallel, 2 branches' })
    ).toBeInTheDocument();
    expect(within(drawing).getByText('local task · not bound')).toBeInTheDocument();
    expect(section).toHaveTextContent('possible combinations≈ 10^3.3');
  });

  it('lists the candidates of every task with their values on the Candidates tab, from the facts', async () => {
    renderRevision('2', group, '/candidates');

    const providers = await screen.findByRole('region', { name: 'Candidates of each task' });
    const table = within(providers).getByRole('table', {
      name: /Task authenticate · 4 candidates/,
    });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(cell => cell.textContent)
    ).toEqual(['Candidate', 'Provider', 'latency (ms)', 'cost (EUR)']);
    expect(within(table).getByRole('row', { name: /authenticate-1/ }).textContent).toContain(
      '40 ms'
    );
    expect(within(table).getByRole('row', { name: /authenticate-1/ }).textContent).toContain(
      '0.01–0.02 EUR'
    );
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 4);
    expect(
      within(
        within(providers).getByRole('table', { name: /Task pay-card · 8 candidates/ })
      ).getAllByRole('row')
    ).toHaveLength(1 + 8);
    expect(within(providers).getByText(/is a local task/)).toHaveTextContent(
      'notify is a local task: it gets no candidate.'
    );
  });

  it('writes a candidate’s range as a range, open or not, with a bar for the stretch it covers', async () => {
    renderRevision('2', group, '/candidates');

    const providers = await screen.findByRole('region', { name: 'Candidates of each task' });
    const table = within(providers).getByRole('table', { name: /Task authenticate/ });
    const row = (name: RegExp) => within(table).getByRole('row', { name });
    // Number, closed range; open above, open below; no information, number.
    expect(row(/authenticate-1/).textContent).toContain('40 ms');
    expect(row(/authenticate-3/).textContent).toContain('≥ 100 ms');
    expect(row(/authenticate-3/).textContent).toContain('≤ 0.05 EUR');
    expect(row(/authenticate-4/).textContent).toContain('unbounded');
    expect(row(/authenticate-4/).textContent).toContain('0.04 EUR');
    expect(within(row(/authenticate-3/)).getByText('≥ 100 ms')).toHaveAttribute(
      'title',
      '[100, +∞) ms'
    );
    expect(within(row(/authenticate-3/)).getByText('≤ 0.05 EUR')).toHaveAttribute(
      'title',
      '(−∞, 0.05] EUR'
    );

    const bar = (name: RegExp, index: number) =>
      row(name).querySelectorAll('span[aria-hidden="true"]:has(> i)')[index];
    expect(bar(/authenticate-1/, 0)).not.toHaveAttribute('data-cm-bar');
    expect(bar(/authenticate-1/, 1)).toHaveAttribute('data-cm-bar', 'interval');
    expect(bar(/authenticate-3/, 0).querySelector('i')).toHaveAttribute('data-open', 'high');
    expect(bar(/authenticate-3/, 1).querySelector('i')).toHaveAttribute('data-open', 'low');
    expect(bar(/authenticate-4/, 0).querySelector('i')).toHaveAttribute('data-open', 'both');
  });

  it('shows the rules and objectives and the placement as not declared, and leads to the candidates', async () => {
    renderRevision();

    const section = await screen.findByRole('region', { name: 'Rules and objectives' });
    expect(within(section).getByRole('region', { name: 'Rules' })).toHaveTextContent(
      'features.latency ≤ 600'
    );
    expect(within(section).getByRole('region', { name: 'Objectives' })).toHaveTextContent(
      'lower is better · scaled 0–1000'
    );
    expect(
      screen.getByText(/not declared in this version \(no pools, network or events\)/)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('region', { name: 'Candidates of each task' })
    ).not.toBeInTheDocument();
    for (const link of screen.getAllByRole('link', { name: 'Candidates' }))
      expect(link).toHaveAttribute('href', `${root}/flujo-checkout/candidates?version=2`);
  });

  it('says a declared placement is declared, from the compilation’s analysis', async () => {
    problems.compilation.mockImplementation(
      async (_org: string, _problem: string, revision: number | string) => ({
        ...compilationOf(String(revision)),
        analysis: {
          tasks: 4,
          candidates: 20,
          constraints: 2,
          placement: true,
          bindingSpace: '4096',
        },
      })
    );
    renderRevision();

    expect(
      await screen.findByText(/declared in this version \(pools, network or events\)/)
    ).toBeInTheDocument();
  });

  it('has no section of library resources: a version is a self-contained package', async () => {
    renderRevision();

    await screen.findByRole('region', { name: 'How the service works' });
    expect(
      screen.queryByRole('region', { name: 'Resources it’s built from' })
    ).not.toBeInTheDocument();
  });

  it('copies the exact reference from the Get problem menu', async () => {
    renderRevision();

    fireEvent.click(await screen.findByRole('button', { name: /Get problem/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy exact reference/ }));
    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        `flujo-checkout@2 ${r2.package_digest}`
      )
    );
    expect(await screen.findByRole('menuitem', { name: /Reference copied/ })).toBeInTheDocument();
  });

  it('offers to run and add to a study the version on show, and to jump to another version', async () => {
    renderRevision();

    await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
    expect(screen.getByRole('link', { name: 'Run this version' })).toHaveAttribute(
      'href',
      '/runs/new?org=isa-demo&problem=flujo-checkout&revision=2'
    );
    expect(screen.getByRole('link', { name: 'Add to study' })).toHaveAttribute(
      'href',
      '/studies/new?org=isa-demo&problem=flujo-checkout&revision=2'
    );
    const select = screen.getByLabelText('Version');
    expect(
      within(select)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['Version 2 · latest', 'Version 1']);
    fireEvent.change(select, { target: { value: '1' } });
    await waitFor(() => expect(screen.getByLabelText('Version')).toHaveValue('1'));
    expect(screen.getByRole('link', { name: 'Run this version' })).toHaveAttribute(
      'href',
      '/runs/new?org=isa-demo&problem=flujo-checkout&revision=1'
    );
  });

  it('says the installed toolchain refuses a stored package, and keeps the identity', async () => {
    problems.compilation.mockRejectedValue(refusal(422, 'revision_not_recompilable'));
    renderRevision();

    expect(
      await screen.findByText(
        /The compiled form couldn’t be read \(422 · revision_not_recompilable\)/
      )
    ).toHaveTextContent('The installed toolchain refuses this package; it stays as evidence.');
    expect(screen.queryByRole('region', { name: 'Rules and objectives' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Identity' })).toBeInTheDocument();
  });

  it('says the compiled form could not be read when the gateway does not answer, and offers a retry', async () => {
    problems.compilation.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderRevision();

    expect(
      await screen.findByText(/The compiled form couldn’t be read \(503 · unavailable\)/)
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Flujo de checkout' })
    ).toBeInTheDocument();
  });

  it('answers a missing version with the page that does not exist', async () => {
    problems.revision.mockRejectedValue(refusal(404, 'not_found'));
    renderRevision('9');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(problems.revision).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', '9');
  });

  it('finds a version named by its package digest when it is not a number', async () => {
    problems.revision.mockResolvedValue(r1);
    renderRevision(r1.package_digest);

    expect(await screen.findByLabelText('Version')).toHaveValue('1');
    expect(problems.revision).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', r1.package_digest);
  });

  it('is the same model for every member: a VIEWER sees it whole, without a run', async () => {
    renderRevision('2', viewing);

    expect(await screen.findByRole('region', { name: 'Rules' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Run this version' })).not.toBeInTheDocument();
  });

  it('answers a missing problem with the page that does not exist, whatever version the address names', async () => {
    renderRevision('2', group, '', {
      'GET /v1/organizations/isa-demo/problems/flujo-checkout': {
        status: 404,
        body: { code: 'not_found', detail: 'No.' },
      },
    });

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
