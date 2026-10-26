import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { caseOf, org, project, renderProjectScreen, revisionOf } from '../Project/testKit';
import { CaseRevision } from './CaseRevision';
import { digestOf, irDocument, refOf, revisionDocument, versionOf } from './fixtures';

const platform = vi.hoisted(() => ({ project: vi.fn(), case: vi.fn(), revisions: vi.fn(), snapshot: vi.fn() }));
const cases = vi.hoisted(() => ({ revision: vi.fn(), resolveVersion: vi.fn() }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/cases', () => ({ casesApi: cases }));

const group = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const checkout = caseOf('flujo-checkout', 'Flujo de checkout');
const catalog3 = refOf('providers-eu', '3', '3');
const uses: Array<[string, string, ReturnType<typeof refOf>]> = [
  ['application', 'checkout', refOf('checkout-app', '3', '1')],
  ['candidateCatalog', 'providers', catalog3],
  ['constraintSet', 'sla', refOf('sla-hard', '1', '4')],
  ['optimization', 'goal', refOf('weighted-cost-latency', '1', '5')],
];
const r1 = revisionOf(checkout, 1, { document: revisionDocument(uses) });
const r2 = revisionOf(checkout, 2, { document: revisionDocument(uses), source_snapshot_id: 'snap-2' });
const root = '/app/isa-demo/qos-benchmarks';

const refusal = (status: number, code = 'refused') => Object.assign(new HttpError(status, 'refused'), { code });
const snapshotOf = (document: Record<string, unknown> | null = irDocument()) => ({
  id: 'snap-2', ownerId: null, instanceDigest: digestOf('a'), packageDigest: digestOf('b'), archiveSize: 48_213, createdAt: '2026-08-20T10:05:00Z',
  ir: document ? { id: 'ir', digest: digestOf('c'), document, sourceMap: null, compilerVersion: '1', createdAt: null } : null,
});

function renderRevision(revision = '2') {
  return renderProjectScreen(<CaseRevision />, {
    path: '/app/:org/:project/cases/:case/revisions/:revision', url: `${root}/cases/flujo-checkout/revisions/${revision}`, organizations: [group],
  });
}

describe('Case revision', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.case.mockResolvedValue(checkout);
    platform.revisions.mockResolvedValue([r1, r2]);
    platform.snapshot.mockResolvedValue(snapshotOf());
    cases.resolveVersion.mockImplementation(async (ref: ReturnType<typeof refOf>) => versionOf(ref, `artifact-${ref.name}`, { public: ref.name === 'providers-eu' }));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  it('opens with the case, the revision, its seal and what it identifies', async () => {
    renderRevision();

    expect(await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout · revision 2' })).toBeInTheDocument();
    expect(screen.getAllByText('Sealed')).toHaveLength(2);
    const identity = screen.getByRole('region', { name: 'Identity' });
    expect(within(identity).getByText('sha256-2222…2222')).toBeInTheDocument();
    expect(within(identity).getByText('qos-binding/v1', { exact: false })).toBeInTheDocument();
    const snapshot = await within(identity).findByRole('link', { name: 'Open snapshot' });
    expect(snapshot).toHaveAttribute('href', `${root}/snapshots/snap-2`);
    await waitFor(() => expect(identity).toHaveTextContent('47.1 KiB'));
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Flujo de checkout' })).toHaveAttribute('href', `${root}/cases/flujo-checkout`);
  });

  it('draws the workflow with its alternatives and says how many providers each task has', async () => {
    renderRevision();

    const section = await screen.findByRole('region', { name: 'How the service works' });
    const drawing = await within(section).findByRole('img', { name: /^Workflow: authenticate, then inventory and shipping in parallel/ });
    expect(within(drawing).getByText('70%')).toBeInTheDocument();
    expect(within(drawing).getByText('30%')).toBeInTheDocument();
    expect(within(drawing).getByText('8 candidates')).toBeInTheDocument();
    expect(within(drawing).getByText('local task · not bound')).toBeInTheDocument();
    expect(within(drawing).getByText('Parallel · all at once')).toBeInTheDocument();
    expect(within(drawing).getByText('One of · by probability')).toBeInTheDocument();
    expect(within(section).getByText(/Possible combinations ≈/)).toHaveTextContent('Possible combinations ≈ 103.3');
  });

  it('lists the providers of a task with their qualities and switches task', async () => {
    renderRevision();

    const providers = await screen.findByRole('region', { name: 'Candidates' });
    expect(within(providers).getByText(/4 providers can serve/)).toBeInTheDocument();
    const table = within(providers).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Provider', 'latency', 'cost']);
    expect(within(table).getByRole('row', { name: /auth-1/ }).textContent).toContain('40 ms');
    expect(within(table).getByRole('row', { name: /auth-1/ }).textContent).toContain('0.01–0.02 EUR');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 4);

    fireEvent.change(within(providers).getByLabelText('Task'), { target: { value: 'pay-card' } });
    expect(within(providers).getByText(/8 providers can serve/)).toBeInTheDocument();
    expect(within(within(providers).getByRole('table')).getAllByRole('row')).toHaveLength(1 + 8);
  });

  it('writes a candidate’s range as a range, open or not, with a bar for the stretch it covers', async () => {
    renderRevision();

    const providers = await screen.findByRole('region', { name: 'Candidates' });
    const table = within(providers).getByRole('table');
    const row = (name: RegExp) => within(table).getByRole('row', { name });
    // Number, closed range; open above, open below; no information, number.
    expect(row(/auth-1/).textContent).toContain('40 ms');
    expect(row(/auth-3/).textContent).toContain('≥ 100 ms');
    expect(row(/auth-3/).textContent).toContain('≤ 0.05 EUR');
    expect(row(/auth-4/).textContent).toContain('unbounded');
    expect(row(/auth-4/).textContent).toContain('0.04 EUR');
    expect(within(row(/auth-3/)).getByText('≥ 100 ms')).toHaveAttribute('title', '[100, +∞) ms');
    expect(within(row(/auth-3/)).getByText('≤ 0.05 EUR')).toHaveAttribute('title', '(−∞, 0.05] EUR');

    const bar = (name: RegExp, index: number) => row(name).querySelectorAll('.case-bar')[index];
    expect(bar(/auth-1/, 0)).not.toHaveClass('is-interval');
    expect(bar(/auth-1/, 1)).toHaveClass('is-interval');
    expect(bar(/auth-3/, 0).querySelector('i')).toHaveClass('is-open-high');
    expect(bar(/auth-3/, 0).querySelector('i')).not.toHaveClass('is-open-low');
    expect(bar(/auth-3/, 1).querySelector('i')).toHaveClass('is-open-low');
    expect(bar(/auth-4/, 0).querySelector('i')).toHaveClass('is-open-low', 'is-open-high');
    expect(bar(/auth-4/, 0)).toHaveAttribute('aria-hidden', 'true');
  });

  it('writes the rules as must and should, the goal as directions and the placement as not declared', async () => {
    renderRevision();

    const rules = await screen.findByRole('region', { name: 'Rules' });
    expect(within(rules).getByText('MUST')).toBeInTheDocument();
    expect(within(rules).getByText('SHOULD')).toBeInTheDocument();
    expect(within(rules).getByText(/features\.latency ≤ 600/)).toBeInTheDocument();
    expect(within(rules).getByText('sla-availability')).toBeInTheDocument();

    const goal = screen.getByRole('region', { name: 'Goal' });
    expect(within(goal).getByText('cost')).toBeInTheDocument();
    expect(within(goal).getAllByText('lower is better')).toHaveLength(1);
    expect(goal).toHaveTextContent('lower is better · scaled 0–1000');
    expect(goal).toHaveTextContent('Breaking a “should” rule costs');
    expect(goal).toHaveTextContent('weight 5');
    expect(screen.getByText(/not declared in this revision \(no pools, network or events\)/)).toBeInTheDocument();
  });

  it('summarizes a declared placement', async () => {
    const document = irDocument() as { spec: Record<string, unknown> };
    document.spec.placement = [{ resource: 'p', pools: { edge: { kind: 'node', capacity: { cpu: 8 }, properties: {} } }, demands: [{}], network: [], events: {}, transitions: [] }];
    platform.snapshot.mockResolvedValue(snapshotOf(document));
    renderRevision();

    const placement = await screen.findByRole('region', { name: 'Placement' });
    expect(placement).toHaveTextContent('edge (node)');
    expect(placement).toHaveTextContent('cpu 8');
    expect(placement).toHaveTextContent('1 demand · 0 network links');
  });

  // [utest->req~frontend-retire-library-entry-points-removed~1]
  it('names each resource by its exact version and says whether it is published, without a link to the library', async () => {
    renderRevision();

    const section = await screen.findByRole('region', { name: 'Resources it’s built from' });
    await waitFor(() => expect(section).toHaveTextContent('Published'));
    expect(section).toHaveTextContent('providers-eu v3');
    expect(section).toHaveTextContent('Not published');
    expect(section).not.toHaveTextContent('open in library');
    expect(within(section).queryAllByRole('link')).toEqual([]);
    expect(cases.resolveVersion).toHaveBeenCalledWith(catalog3);
  });

  it('copies the exact reference', async () => {
    renderRevision();

    fireEvent.click(await screen.findByRole('button', { name: 'Copy exact reference' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`flujo-checkout@2 ${r2.digest}`));
    expect(await screen.findByRole('button', { name: 'Reference copied' })).toBeInTheDocument();
  });

  it('offers to run, compare with the previous revision and add to a study, and to jump to another revision', async () => {
    renderRevision();

    await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout · revision 2' });
    expect(screen.getByRole('link', { name: 'Run this revision' })).toHaveAttribute('href', `${root}/jobs/new?case=flujo-checkout&revision=2`);
    expect(screen.getByRole('link', { name: 'Compare' })).toHaveAttribute('href', `${root}/cases/flujo-checkout/compare?from=1&to=2`);
    expect(screen.getByRole('link', { name: 'Add to study' })).toHaveAttribute('href', `${root}/studies/new?case=flujo-checkout&revision=2`);
    const select = screen.getByLabelText('Show revision');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Revision 2 · latest', 'Revision 1']);
    fireEvent.change(select, { target: { value: '1' } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout · revision 1' })).toBeInTheDocument();
  });

  it('says there is no compiled model when the revision has no snapshot, and keeps the resources', async () => {
    renderRevision('1');

    expect(await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout · revision 1' })).toBeInTheDocument();
    expect(await screen.findByText(/has no compiled snapshot, so there is no workflow to draw/)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Providers, rules and goal' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Resources it’s built from' })).toBeInTheDocument();
    expect(screen.getByText('None: this revision was sealed without one')).toBeInTheDocument();
  });

  it('warns that the model may be incomplete when the compiled form or a resource cannot be loaded', async () => {
    platform.snapshot.mockRejectedValue(refusal(503, 'unavailable'));
    cases.resolveVersion.mockRejectedValue(refusal(404, 'not_found'));
    renderRevision();

    const warning = await screen.findByText(/Some resources of this revision couldn’t be loaded right now, so the model below may be incomplete/);
    expect(warning).toHaveTextContent('The fingerprint and identity are still exact.');
    expect(await screen.findByText(/The compiled form couldn’t be read \(503 · unavailable\)/)).toBeInTheDocument();
    const section = screen.getByRole('region', { name: 'Resources it’s built from' });
    expect((await within(section).findAllByText(/Can’t be reached \(404 · not_found\)/)).length).toBe(4);
    expect(screen.getByRole('heading', { level: 1, name: 'Flujo de checkout · revision 2' })).toBeInTheDocument();
  });

  it('answers a missing revision in neutral words', async () => {
    cases.revision.mockRejectedValue(refusal(404, 'not_found'));
    renderRevision('9');

    expect(await screen.findByRole('heading', { name: 'This revision doesn’t exist (404)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all revisions' })).toHaveAttribute('href', `${root}/cases/flujo-checkout`);
    expect(cases.revision).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'flujo-checkout', '9');
  });

  it('finds a revision named by its fingerprint when it is not a number', async () => {
    cases.revision.mockResolvedValue(r1);
    renderRevision(r1.digest);

    expect(await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout · revision 1' })).toBeInTheDocument();
    expect(cases.revision).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'flujo-checkout', r1.digest);
  });

  it('is the same page for every member: a VIEWER sees the whole model', async () => {
    renderRevision();

    expect(await screen.findByRole('region', { name: 'Rules' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Run this revision' })).toBeInTheDocument();
  });

  it('answers a missing case like a missing revision’s parent', async () => {
    platform.case.mockRejectedValue(refusal(404, 'not_found'));
    renderRevision();

    expect(await screen.findByRole('heading', { name: 'This revision doesn’t exist (404)' })).toBeInTheDocument();
  });
});
