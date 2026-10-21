import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import type { Artifact, ArtifactRef } from '../../api/library';
import { HttpError } from '../../api/client';
import { caseOf, org, project, renderProjectScreen, revisionOf } from '../Project/testKit';
import { CaseComposer } from './CaseComposer';
import { digestOf, refOf, revisionDocument, sourceContents, versionOf } from './fixtures';

const platform = vi.hoisted(() => ({ project: vi.fn(), case: vi.fn(), revisions: vi.fn() }));
const cases = vi.hoisted(() => ({ resolveVersion: vi.fn(), createRevision: vi.fn(), analyseSnapshot: vi.fn() }));
const library = vi.hoisted(() => ({ list: vi.fn(), versions: vi.fn(), drafts: vi.fn(), content: vi.fn() }));
const client = vi.hoisted(() => ({ getProfiles: vi.fn(), getOwnUsage: vi.fn(), getPricingCatalog: vi.fn() }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/cases', () => ({ casesApi: cases }));
vi.mock('../../api/library', () => ({ libraryApi: library }));
vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: client }));

const member = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const viewer = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const checkout = caseOf('flujo-checkout', 'Flujo de checkout');

const app3 = refOf('checkout-app', '3', '1');
const catalog2 = refOf('providers-eu', '2', '2');
const catalog3 = refOf('providers-eu', '3', '3');
const rules1 = refOf('sla-hard', '1', '4');
const goal1 = refOf('weighted-cost-latency', '1', '5');
const r2 = revisionOf(checkout, 2, {
  document: revisionDocument([['application', 'checkout', app3], ['candidateCatalog', 'providers', catalog3], ['constraintSet', 'sla', rules1], ['optimization', 'goal', goal1]]),
  source_snapshot_id: 'snap-2',
});
const r3 = revisionOf(checkout, 3, { source_snapshot_id: 'snap-3' });

const ARTIFACT_OF: Record<string, string> = { 'checkout-app': 'art-app', 'providers-eu': 'art-cat', 'sla-hard': 'art-rules', 'weighted-cost-latency': 'art-goal' };
const CONTENT_OF: Record<string, unknown> = { 'art-app': sourceContents.application, 'art-cat': sourceContents.catalog, 'art-rules': sourceContents.rules, 'art-goal': sourceContents.goal };
const artifact = (id: string, name: string, kind: string, display = name): Artifact => ({
  id, organization_id: 'org-1', namespace: 'isa-demo', name, display_name: display, kind, description: '', labels: {}, archived: false,
});
const root = '/app/isa-demo/qos-benchmarks';

const refusal = (status: number, code: string, extra: Record<string, unknown> = {}) => Object.assign(new HttpError(status, 'refused'), { code }, extra);

function renderComposer(organization = member, query = '') {
  return renderProjectScreen(<CaseComposer />, {
    path: '/app/:org/:project/cases/:case/compose', url: `/app/${organization.slug}/qos-benchmarks/cases/flujo-checkout/compose${query}`, organizations: [organization],
  });
}

/** Wait until the four parts are filled from the latest revision and their versions are listed. */
async function settled() {
  await screen.findByRole('heading', { level: 1, name: 'New revision of Flujo de checkout' });
  const expected = [['Application', 'version-art-app-3'], ['Candidate catalog', 'version-art-cat-3'], ['Rules', 'version-art-rules-1'], ['Goal', 'version-art-goal-1']];
  for (const [label, version] of expected) await waitFor(() => expect(screen.getByLabelText(`${label}: version`)).toHaveValue(version));
  await waitFor(() => expect(screen.getByRole('meter')).not.toHaveAttribute('aria-valuenow', '0'));
}

describe('Case composer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.case.mockResolvedValue(checkout);
    platform.revisions.mockResolvedValue([revisionOf(checkout, 1), r2]);
    cases.resolveVersion.mockImplementation(async (ref: ArtifactRef) => versionOf(ref, ARTIFACT_OF[ref.name], { public: ref.name === 'providers-eu' }));
    cases.createRevision.mockResolvedValue(r3);
    cases.analyseSnapshot.mockResolvedValue({ valid: true });
    library.list.mockResolvedValue([
      artifact('art-app', 'checkout-app', 'Application', 'Checkout app'), artifact('art-cat', 'providers-eu', 'CandidateCatalog', 'Proveedores UE'),
      artifact('art-rules', 'sla-hard', 'ConstraintSet'), artifact('art-goal', 'weighted-cost-latency', 'Optimization'), artifact('art-study', 'engines', 'Study'),
    ]);
    const single: Record<string, ArtifactRef> = { 'art-app': app3, 'art-rules': rules1, 'art-goal': goal1 };
    library.versions.mockImplementation(async (id: string) => {
      if (id === 'art-cat') return [versionOf(catalog3, id, { public: true }), versionOf(catalog2, id), versionOf(refOf('providers-eu', '1', '9'), id, { withdrawn: true })];
      return single[id] ? [versionOf(single[id], id)] : [];
    });
    library.drafts.mockResolvedValue([]);
    library.content.mockImplementation(async (id: string) => JSON.stringify(CONTENT_OF[id] ?? {}));
    client.getProfiles.mockResolvedValue([{ id: 'qos-binding/v1', digest: digestOf('a') }]);
    client.getOwnUsage.mockResolvedValue({ plan: 'RESEARCH', capabilities: { maxInstanceComplexityLog10: 20 }, features: {}, contract_pending: false });
    client.getPricingCatalog.mockResolvedValue(null);
  });

  describe('the four parts', () => {
    it('looks up the exact versions of the latest revision and fills each part with them', async () => {
      cases.resolveVersion.mockImplementation(async (ref: ArtifactRef) => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return versionOf(ref, ARTIFACT_OF[ref.name], { public: ref.name === 'providers-eu' });
      });
      renderComposer();

      expect(await screen.findByText('Looking up the exact versions…')).toBeInTheDocument();
      await settled();
      expect(screen.getByLabelText('Application: library item')).toHaveValue('art-app');
      expect(screen.getByLabelText('Application: version')).toHaveValue('version-art-app-3');
      expect(screen.getByLabelText('Candidate catalog: version')).toHaveValue('version-art-cat-3');
      expect(screen.getByLabelText('Rules: version')).toHaveValue('version-art-rules-1');
      expect(screen.getByLabelText('Application: local name')).toHaveValue('checkout');
      expect(screen.getAllByText(/Version used by revision 2/)).toHaveLength(4);
      expect(cases.resolveVersion).toHaveBeenCalledTimes(4);
      expect(cases.resolveVersion).toHaveBeenCalledWith(catalog3);
      for (const label of ['Application', 'Candidate catalog', 'Rules', 'Goal']) {
        expect(screen.getByRole('region', { name: label })).toBeInTheDocument();
      }
      expect(screen.getAllByText('Required · exactly one')).toHaveLength(2);
      expect(screen.getByText('Required · one or more')).toBeInTheDocument();
      expect(screen.getByText('Optional')).toBeInTheDocument();
    });

    it('offers only the library items of the kind each part takes, and marks what cannot be pinned', async () => {
      library.drafts.mockImplementation(async (id: string) => (id === 'art-cat' ? [{ id: 'draft-4', revision: 4, payload: {}, based_on_id: null }] : []));
      renderComposer();
      await settled();

      const items = within(screen.getByLabelText('Candidate catalog: library item')).getAllByRole('option').map((option) => option.textContent);
      expect(items).toEqual(['Choose an item…', 'Proveedores UE · providers-eu']);
      await waitFor(() => expect(within(screen.getByLabelText('Candidate catalog: version')).getAllByRole('option')).toHaveLength(5));
      const versions = within(screen.getByLabelText('Candidate catalog: version')).getAllByRole('option');
      expect(versions.map((option) => option.textContent)).toEqual([
        'Choose a version…', 'providers-eu v3 · published', 'providers-eu v2 · not published', 'providers-eu v1 · withdrawn', 'draft 4 · can’t be pinned',
      ]);
      expect(versions[3]).toBeDisabled();
      expect(versions[4]).toBeDisabled();
    });

    it('lets a catalog be added next to the first and named on its own', async () => {
      renderComposer();
      await settled();

      fireEvent.click(screen.getByRole('button', { name: 'Add another candidate catalog' }));
      expect(screen.getByLabelText('Candidate catalog 1: version')).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('Candidate catalog 2: library item'), { target: { value: 'art-cat' } });
      expect(screen.getByLabelText('Candidate catalog 2: local name')).toHaveValue('providers-eu');
      await waitFor(() => expect(screen.getByLabelText('Candidate catalog 2: version')).toBeEnabled());
      fireEvent.change(screen.getByLabelText('Candidate catalog 2: version'), { target: { value: 'version-art-cat-2' } });
      expect(screen.getAllByText(/sha256-2222…2222/).length).toBeGreaterThan(0);
    });

    it('starts empty, with the required parts flagged, once cleared', async () => {
      renderComposer();
      await settled();

      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      expect(screen.getByText('Empty composition. Application, candidate catalog and goal are required; rules are optional.')).toBeInTheDocument();
      expect(screen.getByLabelText('Application: library item')).toHaveValue('');
      expect(screen.getAllByText('Nothing chosen')).toHaveLength(4);
      expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
      expect(screen.getByText('Pick an application and a candidate catalog to estimate it.')).toBeInTheDocument();
    });

    it('starts again from a chosen revision through the address', async () => {
      const r1 = revisionOf(checkout, 1, { document: revisionDocument([['application', 'checkout', app3], ['candidateCatalog', 'providers', catalog2], ['optimization', 'goal', goal1]]) });
      platform.revisions.mockResolvedValue([r1, r2]);
      renderComposer(member, '?from=1');
      await screen.findByRole('heading', { level: 1, name: 'New revision of Flujo de checkout' });

      await waitFor(() => expect(screen.getByLabelText('Candidate catalog: version')).toHaveValue('version-art-cat-2'));
      expect(screen.getByRole('button', { name: 'Start from revision 1' })).toBeInTheDocument();
    });
  });

  describe('the size of the problem', () => {
    it('measures the combinations of what is picked against the ceiling of the plan', async () => {
      renderComposer();
      await settled();

      const meter = screen.getByRole('meter', { name: 'Possible combinations against your plan' });
      expect(Number(meter.getAttribute('aria-valuenow'))).toBeCloseTo(Math.log10(8), 3);
      expect(meter).toHaveAttribute('aria-valuemax', '20');
      expect(meter.getAttribute('aria-valuetext')).toContain('your plan allows up to 10^20');
      const size = meter.closest('section') as HTMLElement;
      expect(size).toHaveTextContent('Your plan: up to 1020');
      expect(size).toHaveTextContent('Fits your plan.');
    });

    it('previews what the picked parts add up to', async () => {
      renderComposer();
      await settled();

      const preview = screen.getByRole('region', { name: 'Preview' });
      expect(within(preview).getByText('4 (3 get a provider)')).toBeInTheDocument();
      expect(within(preview).getByText('5')).toBeInTheDocument();
      expect(within(preview).getByText('1 must, 1 should')).toBeInTheDocument();
      expect(within(preview).getByText('2 criteria')).toBeInTheDocument();
      expect(within(preview).getByRole('link', { name: 'Full view of the current revision' })).toHaveAttribute('href', `${root}/cases/flujo-checkout/revisions/2`);
    });

    it('turns the meter over the line and says so when the problem is bigger than the plan allows', async () => {
      client.getOwnUsage.mockResolvedValue({ plan: 'BASIC', capabilities: { maxInstanceComplexityLog10: 0.5 }, features: {}, contract_pending: false });
      renderComposer();
      await settled();

      const size = screen.getByRole('meter').closest('section') as HTMLElement;
      expect(size).toHaveTextContent('Above your plan’s ceiling: you can create the revision, but running it will be refused (402).');
      expect(size.querySelector('.case-meter')).toHaveClass('is-over');

      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
      expect(await screen.findByText(/Valid, but too big to run on your plan \(402 instance complexity\)/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create revision' })).toBeEnabled();
    });

    it('says the plan has no ceiling when it does not', async () => {
      client.getOwnUsage.mockResolvedValue({ plan: 'PRO', capabilities: { maxInstanceComplexityLog10: null }, features: {}, contract_pending: false });
      renderComposer();
      await settled();

      expect(screen.getByRole('meter').closest('section')).toHaveTextContent('Your plan: no ceiling');
    });

    it('does not guess when the content of a picked version cannot be read', async () => {
      library.content.mockImplementation(async (id: string) => { if (id === 'art-cat') throw refusal(409, 'content_integrity'); return JSON.stringify(CONTENT_OF[id]); });
      renderComposer();
      await screen.findByRole('heading', { level: 1, name: 'New revision of Flujo de checkout' });

      expect(await screen.findByText('A picked version’s content couldn’t be read, so its size can’t be estimated.')).toBeInTheDocument();
      expect(screen.getByRole('meter')).toHaveAttribute('aria-valuenow', '0');
    });
  });

  describe('check and create', () => {
    it('validates the whole composition and then seals the revision', async () => {
      renderComposer();
      await settled();
      expect(screen.getByRole('button', { name: 'Create revision' })).toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
      expect(await screen.findByText('Everything fits together. Ready to create.')).toBeInTheDocument();
      expect(cases.resolveVersion).toHaveBeenCalledTimes(8);
      const create = screen.getByRole('button', { name: 'Create revision' });
      expect(create).toBeEnabled();
      fireEvent.click(create);

      await waitFor(() => expect(cases.createRevision).toHaveBeenCalledTimes(1));
      const [organization, projectSlug, caseSlug, document, uses] = cases.createRevision.mock.calls[0];
      expect([organization, projectSlug, caseSlug]).toEqual(['isa-demo', 'qos-benchmarks', 'flujo-checkout']);
      expect(document).toEqual({ apiVersion: 'bim/v1', kind: 'Instance', metadata: { name: 'flujo-checkout' }, spec: { profile: 'qos-binding/v1', resources: {} } });
      expect(uses).toEqual([
        { role: 'application', alias: 'checkout', artifact: app3, bindings: {} },
        { role: 'candidateCatalog', alias: 'providers', artifact: catalog3, bindings: {} },
        { role: 'constraintSet', alias: 'sla', artifact: rules1, bindings: {} },
        { role: 'optimization', alias: 'goal', artifact: goal1, bindings: {} },
      ]);
      expect(await screen.findByText('Revision 3 created and sealed')).toBeInTheDocument();
      expect(screen.getByText('Its fingerprint is sha256-3333…3333.')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open it' })).toHaveAttribute('href', `${root}/cases/flujo-checkout/revisions/3`);
      expect(screen.getByRole('link', { name: 'Run it' })).toHaveAttribute('href', `${root}/jobs/new?case=flujo-checkout&revision=3`);
      expect(screen.getByRole('link', { name: 'See revisions' })).toHaveAttribute('href', `${root}/cases/flujo-checkout`);
      await waitFor(() => expect(cases.analyseSnapshot).toHaveBeenCalledWith('snap-3'));
      await waitFor(() => expect(platform.revisions).toHaveBeenCalledTimes(2));
    });

    it('says nothing new was sealed when the same inputs already make a revision', async () => {
      cases.createRevision.mockResolvedValue(r2);
      renderComposer();
      await settled();

      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
      await screen.findByText('Everything fits together. Ready to create.');
      fireEvent.click(screen.getByRole('button', { name: 'Create revision' }));

      expect(await screen.findByText('These exact inputs already match revision 2')).toBeInTheDocument();
      expect(screen.getByText('Nothing new was sealed: a revision is identified by its inputs.')).toBeInTheDocument();
    });

    it('warns after sealing when the gateway finds the revision too big for the plan (402)', async () => {
      cases.analyseSnapshot.mockRejectedValue(new QuotaError('instance_complexity_too_large', 'too big'));
      renderComposer();
      await settled();

      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
      await screen.findByText('Everything fits together. Ready to create.');
      fireEvent.click(screen.getByRole('button', { name: 'Create revision' }));

      expect(await screen.findByText(/It is too big to run on your plan \(402 instance complexity\)/)).toBeInTheDocument();
    });

    it('flags the missing parts with a way to each (nothing is sent)', async () => {
      renderComposer();
      await settled();

      fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

      const alerts = await screen.findAllByRole('alert');
      expect(alerts.map((alert) => alert.querySelector('b')?.textContent)).toEqual(['Application is missing', 'Candidate catalog is missing', 'Goal is missing']);
      expect(screen.getByRole('button', { name: 'Create revision' })).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Choose goal' }));
      expect(screen.getByLabelText('Goal: library item')).toHaveFocus();
      expect(cases.createRevision).not.toHaveBeenCalled();
      expect(screen.getByRole('region', { name: 'Goal' })).toHaveClass('is-invalid');
    });

    it('asks for a version when an item is chosen without one, and for distinct local names', async () => {
      renderComposer();
      await settled();

      fireEvent.change(screen.getByLabelText('Application: version'), { target: { value: '' } });
      fireEvent.change(screen.getByLabelText('Goal: local name'), { target: { value: 'providers' } });
      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

      expect(await screen.findByText('Application: choose a version')).toBeInTheDocument();
      expect(screen.getByText('Local names must be unique')).toBeInTheDocument();
    });

    it('reports a version that cannot be reached (404) found while checking', async () => {
      renderComposer();
      await settled();
      cases.resolveVersion.mockRejectedValue(refusal(404, 'not_found'));

      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));

      const alerts = await screen.findAllByRole('alert');
      expect(alerts[0]).toHaveTextContent('A version can’t be reached (404 · not_found)');
      expect(alerts[0]).toHaveTextContent('checkout-app v3 isn’t visible to you any more, or never was.');
      expect(within(alerts[0]).getByRole('link', { name: 'Find another in the library' })).toHaveAttribute('href', '/app/isa-demo/library');
      expect(screen.getByRole('button', { name: 'Create revision' })).toBeDisabled();
    });

    it('keeps the choices and explains a dialect the deployment does not have (422)', async () => {
      cases.createRevision.mockRejectedValue(refusal(422, 'contract_mismatch'));
      renderComposer();
      await settled();
      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
      await screen.findByText('Everything fits together. Ready to create.');
      fireEvent.click(screen.getByRole('button', { name: 'Create revision' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('A dialect isn’t installed (422 · contract_mismatch)');
      expect(within(alert).getByRole('link', { name: 'See installed dialects' })).toHaveAttribute('href', '/language');
      expect(screen.getByLabelText('Application: version')).toHaveValue('version-art-app-3');
      expect(screen.getByRole('button', { name: 'Create revision' })).toBeEnabled();
    });

    it('lists the diagnostics of a composition the gateway refuses (422)', async () => {
      cases.createRevision.mockRejectedValue(refusal(422, 'invalid_resource', { diagnostics: [{ message: 'task pay has no candidates', path: '/spec/tasks/pay' }] }));
      renderComposer();
      await settled();
      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
      await screen.findByText('Everything fits together. Ready to create.');
      fireEvent.click(screen.getByRole('button', { name: 'Create revision' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('The composition was refused (422 · invalid_resource)');
      expect(within(alert).getByText('task pay has no candidates (/spec/tasks/pay)')).toBeInTheDocument();
    });

    it.each([
      [404, 'not_found', 'A version can’t be reached (404 · not_found)'],
      [409, 'version_integrity', 'A version failed its integrity check (409 · version_integrity)'],
      [403, 'forbidden', 'This credential can’t create revisions here (403 · forbidden)'],
      [503, 'unavailable', 'The revision couldn’t be created'],
    ])('explains a %i from the gateway when creating', async (status, code, title) => {
      cases.createRevision.mockRejectedValue(refusal(status, code));
      renderComposer();
      await settled();
      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
      await screen.findByText('Everything fits together. Ready to create.');
      fireEvent.click(screen.getByRole('button', { name: 'Create revision' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(title);
      expect(screen.queryByText(/created and sealed/)).not.toBeInTheDocument();
    });

    it('forgets the check as soon as anything is changed', async () => {
      renderComposer();
      await settled();
      fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
      await screen.findByText('Everything fits together. Ready to create.');

      fireEvent.change(screen.getByLabelText('Application: local name'), { target: { value: 'checkout-2' } });
      expect(screen.queryByText('Everything fits together. Ready to create.')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create revision' })).toBeDisabled();
    });
  });

  describe('who can compose', () => {
    it('shows a VIEWER the composition and nothing to change', async () => {
      renderComposer(viewer);
      await screen.findByRole('heading', { level: 1, name: 'New revision of Flujo de checkout' });
      await waitFor(() => expect(screen.getByLabelText('Application: library item')).toHaveValue('art-app'));

      expect(screen.getByRole('note')).toHaveTextContent('You’re a VIEWER. You can look at the composition, but creating revisions needs MEMBER.');
      expect(screen.getByLabelText('Application: library item')).toBeDisabled();
      expect(screen.getByLabelText('Application: local name')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Validate' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Create revision' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: /^Add another/ })).not.toBeInTheDocument();
    });

    it('says the library cannot be read with this credential (403) and keeps what the revision already holds', async () => {
      library.list.mockRejectedValue(refusal(403, 'forbidden'));
      renderComposer();
      await screen.findByRole('heading', { level: 1, name: 'New revision of Flujo de checkout' });

      expect(await screen.findByText(/This credential can’t read the library \(403 · forbidden\)/)).toBeInTheDocument();
      await waitFor(() => expect(screen.getByLabelText('Application: library item')).toHaveValue('art-app'));
    });
  });

  describe('when the case or its versions cannot be reached', () => {
    it('answers a missing case (404) with a way back', async () => {
      platform.case.mockRejectedValue(refusal(404, 'not_found'));
      renderComposer();

      expect(await screen.findByRole('heading', { name: 'No case with this address in QoS Benchmarks (404)' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'All cases' })).toHaveAttribute('href', `${root}/cases`);
    });

    it('lists the versions of the revision it could not look up and fills the rest', async () => {
      cases.resolveVersion.mockImplementation(async (ref: ArtifactRef) => {
        if (ref.name === 'sla-hard') throw refusal(404, 'not_found');
        return versionOf(ref, ARTIFACT_OF[ref.name], { public: false });
      });
      renderComposer();
      await screen.findByRole('heading', { level: 1, name: 'New revision of Flujo de checkout' });

      const alert = await screen.findByText(/sla-hard v1 isn’t visible to you any more, or never was\./);
      expect(alert.closest('[role="alert"]')).toHaveTextContent('A version can’t be reached (404 · not_found)');
      await waitFor(() => expect(screen.getByLabelText('Application: library item')).toHaveValue('art-app'));
      expect(screen.getByLabelText('Rules: library item')).toHaveValue('');
    });
  });
});
