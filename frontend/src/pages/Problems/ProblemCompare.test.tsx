import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { caseOf, org, renderOrgScreen, revisionOf } from '../../features/workspace/testKit';
import { ProblemDetail } from './ProblemDetail';
import { checkoutFacts, digestOf } from './fixtures';

const problems = vi.hoisted(() => ({
  get: vi.fn(),
  revisions: vi.fn(),
  revision: vi.fn(),
  compilation: vi.fn(),
}));
const facts = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../api/problems', () => ({ problemsApi: problems }));
vi.mock('../../modules/core/utils/problem/facts', async actual => ({
  ...(await actual<typeof import('../../modules/core/utils/problem/facts')>()),
  problemFactsApi: facts,
}));

const group = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'VIEWER' });
const checkout = caseOf('flujo-checkout', 'Flujo de checkout');
const r1 = revisionOf(checkout, 1);
const r2 = revisionOf(checkout, 2);
const root = '/app/isa-demo';

const refusal = (status: number, code = 'refused') =>
  Object.assign(new HttpError(status, 'refused'), { code });
const compilationOf = (revision: string) => ({
  id: `compilation-${revision}`,
  revision_id: `rev-${revision}`,
  compilation_digest: digestOf('9'),
  compiler_digest: digestOf('8'),
  ir_digest: digestOf('c'),
  binding_space: '1',
  created_at: '2026-08-20T10:05:00Z',
  current: true,
  toolchain: {},
  analysis: { tasks: 1, candidates: 1, constraints: 0, placement: false, bindingSpace: '1' },
  resources: {},
  compatible_modes: [],
});

/** The Versions tab of the problem page, which compares the pair named by `from` and `to`. */
function renderCompare(query = '', organization = group) {
  return renderOrgScreen(<ProblemDetail />, {
    path: '/app/:org/problems/:case/:tab?',
    url: `${root}/problems/flujo-checkout/versions${query}`,
    organizations: [organization],
  });
}

describe('Versions tab of the problem page: compare', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    problems.get.mockResolvedValue(checkout);
    problems.revisions.mockResolvedValue([r1, r2]);
    problems.compilation.mockImplementation(
      async (_org: string, _problem: string, revision: string) => compilationOf(String(revision))
    );
    facts.get.mockImplementation(async (_org: string, _problem: string, revision: string) =>
      checkoutFacts(String(revision) === '1' ? 5 : 8)
    );
    problems.revision.mockImplementation(
      async (_org: string, _problem: string, revision: string) => ({
        ...(String(revision) === '1' ? r1 : r2),
        document: {
          apiVersion: 'bim/v1',
          kind: 'Instance',
          metadata: { name: `checkout-${revision}` },
        },
        files: [],
        resource_digests: {},
        compilations: [],
      })
    );
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it('compares the previous version with the latest by default', async () => {
    renderCompare();

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Compare versions' })
    ).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toHaveValue('1');
    expect(screen.getByLabelText('To')).toHaveValue('2');
    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(cell => cell.textContent)
    ).toEqual(['What', 'Version 1', 'Version 2', 'Change']);
    const row = within(table).getByRole('row', { name: /Candidates for pay-card/ });
    expect(
      within(row)
        .getAllByRole('cell')
        .map(cell => cell.textContent)
    ).toEqual(['5', '8', 'Changed']);
    expect(within(table).getByRole('row', { name: /Workflow/ })).toHaveTextContent('Same');
    expect(screen.getByRole('link', { name: 'Open version 2' })).toHaveAttribute(
      'href',
      `${root}/problems/flujo-checkout?version=2`
    );
  });

  it('shows the root document of each side of the pair', async () => {
    renderCompare('?from=1&to=2');

    await screen.findByRole('table');
    await waitFor(() =>
      expect(screen.getByRole('region', { name: 'Version 1 document' })).toHaveTextContent(
        'checkout-1'
      )
    );
    expect(screen.getByRole('region', { name: 'Version 2 document' })).toHaveTextContent(
      'checkout-2'
    );
  });

  it('counts the changes per category and narrows the table to one of them', async () => {
    renderCompare();
    await screen.findByRole('table');

    const summary = screen.getByRole('region', { name: 'Summary' });
    const counts = within(summary)
      .getAllByRole('button')
      .map(button => button.textContent);
    expect(counts).toEqual([
      'All changes3changed',
      'Providers3changed',
      'Tasks0no change',
      'Rules0no change',
      'Goal0no change',
    ]);
    expect(within(summary).getByRole('button', { name: /^All changes/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    fireEvent.click(within(summary).getByRole('button', { name: /^Providers/ }));
    expect(within(summary).getByRole('button', { name: /^Providers/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(
      rows.every(
        row =>
          row.textContent?.includes('Candidates') || row.textContent?.includes('Providers in total')
      )
    ).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it('prints both sizes side by side, as the gateway measured them', async () => {
    renderCompare();

    const section = await screen.findByRole('region', { name: 'Possible combinations' });
    expect(within(section).getByText('Version 1')).toBeInTheDocument();
    expect(await within(section).findByText('10^2.8 → 10^3.3')).toBeInTheDocument();
    expect(facts.get).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', '1', 'compilation-1');
  });

  it('chooses the pair from the address and swaps it', async () => {
    renderCompare('?from=2&to=1');

    await screen.findByRole('table');
    expect(screen.getByLabelText('From')).toHaveValue('2');
    expect(screen.getByLabelText('To')).toHaveValue('1');
    expect(await screen.findByText('10^3.3 → 10^2.8')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Swap versions' }));
    await waitFor(() => expect(screen.getByLabelText('From')).toHaveValue('1'));
    expect(screen.getByLabelText('To')).toHaveValue('2');
  });

  it('copies a one-line summary of the change', async () => {
    renderCompare();

    fireEvent.click(await screen.findByRole('button', { name: 'Copy summary' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1));
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(text).toContain('flujo-checkout v1 → v2:');
    expect(text).toContain('Candidates for pay-card 5 → 8');
    expect(await screen.findByRole('button', { name: 'Summary copied' })).toBeInTheDocument();
  });

  it('has nothing to compare when both sides are the same version', async () => {
    renderCompare('?from=2&to=2');

    expect(
      await screen.findByText(
        'Both sides are the same version, so there’s nothing to compare. Choose two different versions.'
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says when one of the versions does not exist (404)', async () => {
    renderCompare('?from=1&to=7');

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'One of these versions doesn’t exist (404). Pick another pair.'
    );
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByLabelText('From')).toBeInTheDocument();
  });

  it('asks a viewer for a second version without offering a new one', async () => {
    problems.revisions.mockResolvedValue([r1]);
    renderCompare();

    expect(
      await screen.findByRole('heading', { name: 'Comparing needs two versions' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /New version|Compose the first version/ })
    ).toBeNull();
  });

  it('asks a member for a second version when the problem has only one', async () => {
    problems.revisions.mockResolvedValue([r1]);
    renderCompare('', org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' }));

    const guide = (
      await screen.findByRole('heading', { name: 'Comparing needs two versions' })
    ).closest('div') as HTMLElement;
    expect(within(guide).getByRole('link', { name: 'New version' })).toHaveAttribute(
      'href',
      `${root}/problem-editor?problem=flujo-checkout`
    );
  });

  it('says what it cannot compare when a compiled form cannot be read', async () => {
    problems.compilation.mockImplementation(
      async (_org: string, _problem: string, revision: string) => {
        if (String(revision) === '1') throw refusal(422, 'revision_not_recompilable');
        return compilationOf(String(revision));
      }
    );
    renderCompare();

    expect(
      await screen.findByText(
        /Providers, tasks, rules and goal are compared from the compilation of each version, and version 1 has none that can be read\. The two packages differ\./
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Possible combinations' })).not.toBeInTheDocument();
  });

  it('answers a missing problem, and a failing gateway, in their own words', async () => {
    problems.get.mockRejectedValueOnce(refusal(404, 'not_found'));
    renderCompare();
    expect(
      await screen.findByRole('heading', {
        name: 'No problem with this address in ISA Demo Group (404)',
      })
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Compare versions' })
    ).toBeInTheDocument();
  });
});
