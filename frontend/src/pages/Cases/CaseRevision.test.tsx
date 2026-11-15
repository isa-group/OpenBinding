import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { caseOf, org, project, renderProjectScreen, revisionOf } from '../../features/workspace/testKit';
import { CaseDetail } from './CaseDetail';
import { digestOf, irDocument } from './fixtures';

const problems = vi.hoisted(() => ({ get: vi.fn(), revisions: vi.fn(), revision: vi.fn(), compilation: vi.fn(), ir: vi.fn() }));

vi.mock('../../api/problems', () => ({ problemsApi: problems }));

const group = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const viewing = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const checkout = caseOf('flujo-checkout', 'Flujo de checkout');
const r1 = revisionOf(checkout, 1);
const r2 = revisionOf(checkout, 2, { package_size: 48_213 });
const root = '/app/isa-demo';

const refusal = (status: number, code = 'refused') => Object.assign(new HttpError(status, 'refused'), { code });
const compilationOf = (revision: string) => ({
  id: `compilation-${revision}`, revision_id: `rev-${revision}`, compilation_digest: digestOf('9'), compiler_digest: digestOf('8'), ir_digest: digestOf('c'),
  binding_space: '4096', created_at: '2026-08-20T10:05:00Z', current: true, toolchain: {},
  analysis: { tasks: 4, candidates: 20, constraints: 2, placement: false, bindingSpace: '4096' }, resources: {}, compatible_modes: [],
});
const irOf = (document: Record<string, unknown> = irDocument()) => ({ id: 'compilation-2', ir_digest: digestOf('c'), ir: document, source_map: {} });

/** The Overview tab of the problem page, showing the version named by the query. */
function renderRevision(revision = '2', organization = group) {
  return renderProjectScreen(<CaseDetail />, {
    path: '/app/:org/problems/:case/:tab?', url: `${root}/problems/flujo-checkout?version=${revision}`, organizations: [organization], projects: [qos],
  });
}

describe('Overview tab of the problem page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    problems.get.mockResolvedValue(checkout);
    problems.revisions.mockResolvedValue([r1, r2]);
    problems.compilation.mockImplementation(async (_org: string, _problem: string, revision: number | string) => compilationOf(String(revision)));
    problems.ir.mockResolvedValue(irOf());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
  });

  it('opens with the problem, the version, its seal and what it identifies', async () => {
    renderRevision();

    expect(await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' })).toBeInTheDocument();
    expect(screen.getByLabelText('Version')).toHaveValue('2');
    expect(screen.getAllByText('Sealed')).toHaveLength(2);
    const identity = screen.getByRole('region', { name: 'Identity' });
    expect(within(identity).getByRole('button', { name: 'Copy version 2 fingerprint' })).toHaveTextContent('Copy digest');
    expect(identity.textContent).not.toMatch(/sha256-|[0-9a-f]{12}/);
    expect(await within(identity).findByText('qos-binding/v1', { exact: false })).toBeInTheDocument();
    expect(within(identity).getByRole('link', { name: 'Open source' })).toHaveAttribute('href', `${root}/problems/flujo-checkout/source?version=2`);
    expect(identity).toHaveTextContent('47.1 KiB');
    expect(problems.ir).toHaveBeenCalledWith('isa-demo', 'flujo-checkout', 2, 'compilation-2');
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Problems' })).toHaveAttribute('href', `${root}/problems`);
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
    expect(screen.getByText(/not declared in this version \(no pools, network or events\)/)).toBeInTheDocument();
  });

  it('summarizes a declared placement', async () => {
    const document = irDocument() as { spec: Record<string, unknown> };
    document.spec.placement = [{ resource: 'p', pools: { edge: { kind: 'node', capacity: { cpu: 8 }, properties: {} } }, demands: [{}], network: [], events: {}, transitions: [] }];
    problems.ir.mockResolvedValue(irOf(document));
    renderRevision();

    const placement = await screen.findByRole('region', { name: 'Placement' });
    expect(placement).toHaveTextContent('edge (node)');
    expect(placement).toHaveTextContent('cpu 8');
    expect(placement).toHaveTextContent('1 demand · 0 network links');
  });

  it('has no section of library resources: a version is a self-contained package', async () => {
    renderRevision();

    await screen.findByRole('region', { name: 'How the service works' });
    expect(screen.queryByRole('region', { name: 'Resources it’s built from' })).not.toBeInTheDocument();
  });

  it('copies the exact reference', async () => {
    renderRevision();

    fireEvent.click(await screen.findByRole('button', { name: 'Copy exact reference' }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(`flujo-checkout@2 ${r2.package_digest}`));
    expect(await screen.findByRole('button', { name: 'Reference copied' })).toBeInTheDocument();
  });

  it('offers to run and add to a study the version on show, and to jump to another version', async () => {
    renderRevision();

    await screen.findByRole('heading', { level: 1, name: 'Flujo de checkout' });
    expect(screen.getByRole('link', { name: 'Run this version' })).toHaveAttribute('href', `${root}/runs/new?problem=flujo-checkout&revision=2`);
    expect(screen.getByRole('link', { name: 'Add to study' })).toHaveAttribute('href', `${root}/studies/new?case=flujo-checkout&revision=2`);
    const select = screen.getByLabelText('Version');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['Version 2 · latest', 'Version 1']);
    fireEvent.change(select, { target: { value: '1' } });
    await waitFor(() => expect(screen.getByLabelText('Version')).toHaveValue('1'));
    expect(screen.getByRole('link', { name: 'Run this version' })).toHaveAttribute('href', `${root}/runs/new?problem=flujo-checkout&revision=1`);
  });

  it('says the installed toolchain refuses a stored package, and keeps the identity', async () => {
    problems.compilation.mockRejectedValue(refusal(422, 'revision_not_recompilable'));
    renderRevision();

    expect(await screen.findByText(/The compiled form couldn’t be read \(422 · revision_not_recompilable\)/)).toHaveTextContent('The installed toolchain refuses this package; it stays as evidence.');
    expect(screen.queryByRole('region', { name: 'Providers, rules and goal' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Identity' })).toBeInTheDocument();
  });

  it('says the compiled form could not be read when the gateway does not answer, and offers a retry', async () => {
    problems.compilation.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderRevision();

    expect(await screen.findByText(/The compiled form couldn’t be read \(503 · unavailable\)/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Flujo de checkout' })).toBeInTheDocument();
  });

  it('answers a missing version in neutral words', async () => {
    problems.revision.mockRejectedValue(refusal(404, 'not_found'));
    renderRevision('9');

    expect(await screen.findByRole('heading', { name: 'This version doesn’t exist (404)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See all versions' })).toHaveAttribute('href', `${root}/problems/flujo-checkout/versions`);
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

  it('answers a missing problem with the missing problem, whatever version the address names', async () => {
    problems.get.mockRejectedValue(refusal(404, 'not_found'));
    renderRevision();

    expect(await screen.findByRole('heading', { name: 'No problem with this address in ISA Demo Group (404)' })).toBeInTheDocument();
  });
});
