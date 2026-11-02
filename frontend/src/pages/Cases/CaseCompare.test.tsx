import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { caseOf, org, project, renderProjectScreen, revisionOf } from '../Project/testKit';
import { CaseDetail } from './CaseDetail';
import { digestOf, irDocument, refOf, revisionDocument } from './fixtures';

const platform = vi.hoisted(() => ({ project: vi.fn(), case: vi.fn(), revisions: vi.fn(), snapshot: vi.fn() }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const checkout = caseOf('flujo-checkout', 'Flujo de checkout');
const base: Array<[string, string, ReturnType<typeof refOf>]> = [
  ['application', 'checkout', refOf('checkout-app', '3', '1')],
  ['constraintSet', 'sla', refOf('sla-hard', '1', '4')],
  ['optimization', 'goal', refOf('weighted-cost-latency', '1', '5')],
];
const r1 = revisionOf(checkout, 1, { document: revisionDocument([...base, ['candidateCatalog', 'providers', refOf('providers-eu', '2', '2')]]), source_snapshot_id: 'snap-1' });
const r2 = revisionOf(checkout, 2, { document: revisionDocument([...base, ['candidateCatalog', 'providers', refOf('providers-eu', '3', '3')]]), source_snapshot_id: 'snap-2' });
const root = '/app/isa-demo/qos-benchmarks';

const refusal = (status: number, code = 'refused') => Object.assign(new HttpError(status, 'refused'), { code });
const snapshotOf = (id: string, pay: number) => ({
  id, ownerId: null, instanceDigest: digestOf('a'), packageDigest: digestOf('b'), archiveSize: 1, createdAt: null,
  ir: { id: `ir-${id}`, digest: digestOf('c'), document: irDocument(pay), sourceMap: null, compilerVersion: '1', createdAt: null },
});

/** The Versions tab of the problem page, which compares the pair named by `from` and `to`. */
function renderCompare(query = '') {
  return renderProjectScreen(<CaseDetail />, {
    path: '/app/:org/:project/cases/:case/:tab?', url: `${root}/cases/flujo-checkout/versions${query}`, organizations: [group],
  });
}

// [utest->req~frontend-nav-problem-page~1]
describe('Versions tab of the problem page: compare', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.case.mockResolvedValue(checkout);
    platform.revisions.mockResolvedValue([r1, r2]);
    platform.snapshot.mockImplementation(async (id: string) => snapshotOf(id, id === 'snap-1' ? 5 : 8));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  // [utest->req~frontend-nav-vocabulary-text~1]
  it('compares the previous version with the latest by default', async () => {
    renderCompare();

    expect(await screen.findByRole('heading', { level: 2, name: 'Compare versions' })).toBeInTheDocument();
    expect(screen.getByLabelText('From')).toHaveValue('1');
    expect(screen.getByLabelText('To')).toHaveValue('2');
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['What', 'Version 1', 'Version 2', 'Change']);
    const row = within(table).getByRole('row', { name: /Candidates for pay-card/ });
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['5', '8', 'Changed']);
    expect(within(table).getByRole('row', { name: /Workflow/ })).toHaveTextContent('Same');
    expect(screen.getByRole('link', { name: 'Open version 2' })).toHaveAttribute('href', `${root}/cases/flujo-checkout?version=2`);
  });

  it('shows the sealed document of each side of the pair', async () => {
    renderCompare('?from=1&to=2');

    await screen.findByRole('table');
    expect(screen.getByRole('region', { name: 'Version 1 document' })).toHaveTextContent('"kind": "Instance"');
    expect(screen.getByRole('region', { name: 'Version 2 document' })).toHaveTextContent('providers-eu');
  });

  it('counts the changes per category and narrows the table to one of them', async () => {
    renderCompare();
    await screen.findByRole('table');

    const summary = screen.getByRole('region', { name: 'Summary' });
    const counts = within(summary).getAllByRole('button').map((button) => button.textContent);
    expect(counts).toEqual([
      'All changes4changed', 'Resources1changed', 'Providers3changed', 'Tasks0no change', 'Rules0no change', 'Goal0no change',
    ]);
    expect(within(summary).getByRole('button', { name: /^All changes/ })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(summary).getByRole('button', { name: /^Providers/ }));
    expect(within(summary).getByRole('button', { name: /^Providers/ })).toHaveAttribute('aria-pressed', 'true');
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.every((row) => row.textContent?.includes('Candidates') || row.textContent?.includes('Providers in total'))).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it('shows how much bigger the second problem is', async () => {
    renderCompare();

    const section = await screen.findByRole('region', { name: 'Possible combinations' });
    expect(within(section).getByText('Version 1')).toBeInTheDocument();
    expect(await within(section).findByText('≈ 3.2× more combinations (10^0.5)')).toBeInTheDocument();
  });

  it('chooses the pair from the address and swaps it', async () => {
    renderCompare('?from=2&to=1');

    await screen.findByRole('table');
    expect(screen.getByLabelText('From')).toHaveValue('2');
    expect(screen.getByLabelText('To')).toHaveValue('1');
    expect(await screen.findByText('≈ 3.2× fewer combinations (10^0.5)')).toBeInTheDocument();
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

    expect(await screen.findByText('Both sides are the same version, so there’s nothing to compare. Choose two different versions.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('says when one of the versions does not exist (404)', async () => {
    renderCompare('?from=1&to=7');

    expect(await screen.findByRole('alert')).toHaveTextContent('One of these versions doesn’t exist (404). Pick another pair.');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByLabelText('From')).toBeInTheDocument();
  });

  // [utest->req~frontend-retire-composer-entry-points-repointed~1]
  it('asks a viewer for a second version without offering a new one', async () => {
    platform.revisions.mockResolvedValue([r1]);
    renderCompare();

    expect(await screen.findByRole('heading', { name: 'Comparing needs two versions' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /New version|Compose the first version/ })).toBeNull();
  });

  // [utest->req~frontend-retire-composer-entry-points-repointed~1]
  it('asks a member for a second version when the problem has only one', async () => {
    platform.revisions.mockResolvedValue([r1]);
    renderProjectScreen(<CaseDetail />, {
      path: '/app/:org/:project/cases/:case/:tab?', url: `${root}/cases/flujo-checkout/versions`, organizations: [org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' })],
    });

    const guide = (await screen.findByRole('heading', { name: 'Comparing needs two versions' })).closest('div') as HTMLElement;
    expect(within(guide).getByRole('link', { name: 'New version' })).toHaveAttribute('href', `${root}/workbench?case=flujo-checkout`);
  });

  it('compares only the library versions when a compiled form cannot be read', async () => {
    platform.snapshot.mockImplementation(async (id: string) => {
      if (id === 'snap-1') throw refusal(404, 'not_found');
      return snapshotOf(id, 8);
    });
    renderCompare();

    expect(await screen.findByText(/Providers, tasks, rules and goal are compared from the compiled snapshot of each version, and version 1 has none that can be read/)).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(4);
    expect(within(table).getByRole('row', { name: /Candidate catalog · providers/ })).toHaveTextContent('Changed');
    expect(screen.queryByRole('region', { name: 'Possible combinations' })).not.toBeInTheDocument();
  });

  it('answers a missing problem, and a failing gateway, in their own words', async () => {
    platform.case.mockRejectedValueOnce(refusal(404, 'not_found'));
    renderCompare();
    expect(await screen.findByRole('heading', { name: 'No problem with this address in QoS Benchmarks (404)' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Compare versions' })).toBeInTheDocument();
  });
});
