import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, renderProjectScreen } from '../Project/testKit';
import { LibDraft } from './LibDraft';
import { templateFor, updateAt, type JsonObject } from './contentModel';
import { bpmnContent, catalogContent, draftOf, itemOf, rulesContent, versionOf } from './fixtures';

const lib = vi.hoisted(() => ({ list: vi.fn(), versions: vi.fn(), drafts: vi.fn(), saveDraft: vi.fn(), seal: vi.fn() }));
vi.mock('../../api/libraryItems', () => ({ libraryItemsApi: lib }));

const group = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const viewing = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'VIEWER' });
const catalog = itemOf('providers-eu', 'CandidateCatalog', 'Proveedores UE');
const rules = itemOf('sla-hard', 'ConstraintSet', 'SLA hard');
const v2 = versionOf(catalog, '2');
const v3 = versionOf(catalog, '3', { public: true });
const root = '/app/isa-demo/library/providers-eu';
const draftUrl = `${root}/drafts/draft-4`;
const LATENCY = ['spec', 'candidates', 'fastpay', 'features', 'latency_ms'];

const refusal = (status: number, code: string, message = 'refused') => Object.assign(new HttpError(status, message), { code });
const server = () => draftOf('draft-4', 4, catalogContent(), { based_on_id: v3.id });
const withLatency = (value: number) => updateAt(catalogContent() as JsonObject, LATENCY, value);

function renderDraft(item = catalog, organization = group, url = draftUrl) {
  lib.list.mockResolvedValue([item, rules]);
  return renderProjectScreen(<LibDraft />, { path: '/app/:org/library/:artifact/drafts/:draft', url, organizations: [organization], projects: [] });
}

const latency = () => screen.getByLabelText('latency_ms for fastpay');

describe('Draft editor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lib.drafts.mockResolvedValue([server()]);
    lib.versions.mockImplementation(async (id: string) => (id === catalog.id ? [v3, v2] : id === rules.id ? [versionOf(rules, '1')] : []));
  });

  it('shows a candidate catalog as a table per capability, with its status and checks', async () => {
    renderDraft();

    expect(await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' })).toBeInTheDocument();
    expect(screen.getByText('Based on version 3. Edits stay in this draft until you seal a new version.')).toBeInTheDocument();
    const payment = screen.getByRole('table', { name: 'Candidates for service/payment' });
    expect(within(payment).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Candidate', 'Provider', 'latency_ms', 'cost_eur', 'availability', 'Remove']);
    expect(within(payment).getAllByRole('row')).toHaveLength(1 + 2);
    expect(latency()).toHaveValue('95');
    expect(screen.getByLabelText('Provider of fastpay')).toHaveValue('fastpay');
    expect(screen.getByRole('table', { name: 'Candidates for service/stock' })).toBeInTheDocument();
    const status = screen.getByText('Draft revision 4').closest('[role="status"]') as HTMLElement;
    expect(status).toHaveTextContent('All changes saved');
    const checks = screen.getByRole('region', { name: 'Checks' });
    expect(within(checks).getByText('3 providers in 2 capabilities')).toBeInTheDocument();
    expect(within(checks).getByText('Every provider has the same qualities')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('has no raw editor: the source is read-only and behind a control', async () => {
    renderDraft();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

    expect(screen.queryByRole('textbox', { name: /json|source/i })).not.toBeInTheDocument();
    const source = screen.getByText('View source').closest('details') as HTMLElement;
    expect(within(source).getByLabelText('Source of the content').tagName).toBe('PRE');
    expect(within(source).getByLabelText('Source of the content')).toHaveTextContent('"latency_ms": 95');
  });

  it('saves with the revision it started from and moves to the next', async () => {
    lib.saveDraft.mockResolvedValue({ id: 'draft-4', revision: 5 });
    renderDraft();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

    fireEvent.change(latency(), { target: { value: '90' } });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByText('Draft revision 5')).toBeInTheDocument();
    expect(lib.saveDraft).toHaveBeenCalledWith(catalog.id, 'draft-4', { content: withLatency(90), media_type: 'application/json', contracts: [], dependencies: [] }, 4);
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
  });

  it('flags a half-typed number and a missing quality without touching the document', async () => {
    renderDraft();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

    fireEvent.change(latency(), { target: { value: '9x' } });
    expect(latency()).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
    fireEvent.change(latency(), { target: { value: '' } });
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Checks' })).getByText('1 provider is missing a quality')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(latency()).toHaveValue('95');
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
  });

  describe('ranges', () => {
    const mode = (candidate: string, quality: string, name: 'Value' | 'Range') => within(screen.getByRole('group', { name: `${quality} for ${candidate}: value or range` })).getByRole('button', { name });
    const end = (candidate: string, quality: string, side: 'min' | 'max') => screen.getByLabelText(`${quality} for ${candidate} ${side}`);

    it('mixes numbers and ranges in one column and saves each as the language writes it', async () => {
      lib.saveDraft.mockResolvedValue({ id: 'draft-4', revision: 5 });
      renderDraft();
      await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

      // A closed range, one open above, one open below and one with no information, next to the numbers that stay.
      fireEvent.click(mode('fastpay', 'latency_ms', 'Range'));
      fireEvent.change(end('fastpay', 'latency_ms', 'min'), { target: { value: '80' } });
      fireEvent.change(end('fastpay', 'latency_ms', 'max'), { target: { value: '120' } });
      fireEvent.click(mode('fastpay', 'availability', 'Range'));
      fireEvent.click(screen.getByLabelText('availability for fastpay: no upper limit'));
      fireEvent.click(mode('payco-eu', 'cost_eur', 'Range'));
      fireEvent.click(screen.getByLabelText('cost_eur for payco-eu: no lower limit'));
      fireEvent.change(end('payco-eu', 'cost_eur', 'max'), { target: { value: '0.03' } });
      fireEvent.click(mode('stockly-1', 'latency_ms', 'Range'));
      fireEvent.click(screen.getByLabelText('latency_ms for stockly-1: no lower limit'));
      fireEvent.click(screen.getByLabelText('latency_ms for stockly-1: no upper limit'));

      expect(screen.getByLabelText('latency_ms for payco-eu')).toHaveValue('180');
      expect(within(screen.getByRole('region', { name: 'Checks' })).getByText('4 qualities are ranges')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

      await screen.findByText('Draft revision 5');
      const sent = lib.saveDraft.mock.calls[0][2].content as { spec: { candidates: Record<string, { features: Record<string, unknown> }> } };
      expect(sent.spec.candidates.fastpay.features).toEqual({ latency_ms: { min: 80, max: 120 }, cost_eur: 0.034, availability: { min: 99.9, max: null } });
      expect(sent.spec.candidates['payco-eu'].features).toEqual({ latency_ms: 180, cost_eur: { min: null, max: 0.03 }, availability: 99.95 });
      expect(sent.spec.candidates['stockly-1'].features.latency_ms).toEqual({ min: null, max: null });
    });

    it('cannot save or seal while a range is not valid, and says why', async () => {
      renderDraft();
      await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

      fireEvent.click(mode('fastpay', 'latency_ms', 'Range'));
      fireEvent.change(end('fastpay', 'latency_ms', 'min'), { target: { value: '200' } });

      expect(screen.getAllByRole('alert').some((alert) => alert.textContent === 'Min can’t be greater than max.')).toBe(true);
      expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Seal version…' })).toBeDisabled();
      expect(within(screen.getByRole('region', { name: 'Checks' })).getByText(/1 range is not valid \(fastpay · latency_ms: Min can’t be greater than max\.\)/)).toBeInTheDocument();
      expect(screen.getByText('Fix the ranges to save or seal')).toBeInTheDocument();

      fireEvent.change(end('fastpay', 'latency_ms', 'min'), { target: { value: '60' } });
      expect(screen.getByRole('button', { name: 'Save draft' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Seal version…' })).toBeEnabled();
      expect(screen.queryByText('Fix the ranges to save or seal')).not.toBeInTheDocument();
    });

    it('blocks a range with an end still missing', async () => {
      renderDraft();
      await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

      fireEvent.click(mode('fastpay', 'latency_ms', 'Range'));
      fireEvent.change(end('fastpay', 'latency_ms', 'min'), { target: { value: '' } });

      expect(screen.getByRole('button', { name: 'Seal version…' })).toBeDisabled();
      fireEvent.click(screen.getByLabelText('latency_ms for fastpay: no lower limit'));
      expect(screen.getByRole('button', { name: 'Seal version…' })).toBeEnabled();
    });

    it('opens a draft that already has ranges in the range mode', async () => {
      lib.drafts.mockResolvedValue([draftOf('draft-4', 4, updateAt(catalogContent() as JsonObject, LATENCY, { min: null, max: 90 }), { based_on_id: v3.id })]);
      renderDraft();
      await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

      expect(mode('fastpay', 'latency_ms', 'Range')).toHaveAttribute('aria-pressed', 'true');
      expect(end('fastpay', 'latency_ms', 'min')).toBeDisabled();
      expect(end('fastpay', 'latency_ms', 'max')).toHaveValue('90');
      expect(mode('fastpay', 'cost_eur', 'Value')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  it('adds a provider to a capability and removes it again', async () => {
    renderDraft();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

    fireEvent.click(within(screen.getByRole('region', { name: 'Capability service/payment' })).getByRole('button', { name: 'Add provider' }));
    expect(screen.getByLabelText('Candidate id of new-provider')).toHaveValue('new-provider');
    expect(within(screen.getByRole('region', { name: 'Checks' })).getByText('1 provider is missing a quality')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove new-provider' }));
    expect(screen.queryByLabelText('Candidate id of new-provider')).not.toBeInTheDocument();
  });

  it('starts a blank catalog by naming a capability', async () => {
    lib.drafts.mockResolvedValue([draftOf('draft-4', 1, templateFor('CandidateCatalog', 'providers-eu').content as Record<string, unknown>)]);
    renderDraft();

    expect(await screen.findByText(/^Blank draft\. Name a capability/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Checks' })).getByText('Add at least one provider')).toBeInTheDocument();
    // The blank draft can be saved as it is, but not sealed, and it says what is missing.
    expect(screen.getByRole('button', { name: 'Seal version…' })).toBeDisabled();
    expect(screen.getByText('Finish the draft to seal it')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('New capability'), { target: { value: 'service/payment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add capability' }));
    const capability = screen.getByRole('region', { name: 'Capability service/payment' });
    expect(within(capability).getByText('No providers yet. Add the providers that can do this job, with their measured qualities.')).toBeInTheDocument();
    fireEvent.click(within(capability).getByRole('button', { name: 'Add provider' }));
    expect(screen.getByLabelText('Provider of new-provider')).toBeInTheDocument();
  });

  it('declares the provider that is typed and the feature a new quality is bound to, and can then be sealed', async () => {
    lib.drafts.mockResolvedValue([draftOf('draft-4', 1, templateFor('CandidateCatalog', 'providers-eu').content as Record<string, unknown>)]);
    lib.saveDraft.mockResolvedValue({ id: 'draft-4', revision: 2 });
    renderDraft();
    await screen.findByText(/^Blank draft\. Name a capability/);

    fireEvent.change(screen.getByLabelText('New capability'), { target: { value: 'service/payment' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add capability' }));
    fireEvent.change(screen.getByLabelText('New quality'), { target: { value: 'latency_ms' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add quality' }));
    fireEvent.click(within(screen.getByRole('region', { name: 'Capability service/payment' })).getByRole('button', { name: 'Add provider' }));
    fireEvent.change(screen.getByLabelText('Provider of new-provider'), { target: { value: 'acme' } });
    fireEvent.change(screen.getByLabelText('latency_ms for new-provider'), { target: { value: '40' } });

    expect(screen.getByRole('button', { name: 'Seal version…' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft revision 2');
    expect(lib.saveDraft.mock.calls[0][2].content).toEqual({
      apiVersion: 'qos-binding/v1',
      kind: 'CandidateCatalog',
      metadata: { name: 'providers-eu' },
      spec: {
        featureBindings: { latency_ms: { resource: 'application', id: 'latency_ms' } },
        candidates: { 'new-provider': { provides: 'service/payment', features: { latency_ms: 40 }, provider: { resource: 'catalog', id: 'acme' } } },
        providers: { acme: {} },
      },
    });
  });

  it('gives a rule that should hold the penalty the schema asks for, takes it from one that must hold, and reminds that the goal lists it', async () => {
    lib.drafts.mockResolvedValue([draftOf('draft-r1', 1, rulesContent())]);
    renderDraft(rules, group, '/app/isa-demo/library/sla-hard/drafts/draft-r1');
    await screen.findByRole('heading', { level: 1, name: 'SLA hard · draft' });
    const checks = screen.getByRole('region', { name: 'Checks' });

    fireEvent.change(screen.getByLabelText('Kind of sla-latency'), { target: { value: 'soft' } });
    expect(screen.getByLabelText('Penalty of sla-latency')).toHaveValue('1');
    expect(screen.getByLabelText('Kind of sla-latency')).toHaveValue('soft');
    expect(within(checks).getByText(/Every soft rule also needs an entry under penalties/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Kind of sla-availability'), { target: { value: 'hard' } });
    expect(screen.getByLabelText('Penalty of sla-availability')).toBeDisabled();
    expect(screen.getByLabelText('Penalty of sla-availability')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Kind of sla-latency'), { target: { value: 'hard' } });
    expect(within(checks).queryByText(/entry under penalties/)).not.toBeInTheDocument();
  });

  it('compares the two copies when someone saved first, and keeps mine on top of theirs', async () => {
    lib.drafts.mockResolvedValueOnce([server()]).mockResolvedValue([draftOf('draft-4', 5, withLatency(90) as Record<string, unknown>, { based_on_id: v3.id })]);
    lib.saveDraft.mockRejectedValueOnce(refusal(409, 'draft_conflict')).mockResolvedValue({ id: 'draft-4', revision: 6 });
    renderDraft();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

    fireEvent.change(latency(), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    const conflict = await screen.findByRole('alert');
    expect(conflict).toHaveTextContent('Someone saved this draft while you were editing (409 · draft conflict)');
    const row = within(conflict).getByRole('row', { name: /candidates · fastpay · features · latency_ms/ });
    expect(within(row).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['99', '90']);
    expect(within(conflict).getByRole('columnheader', { name: 'Saved by someone else · revision 5' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Seal version…' })).toBeDisabled();

    fireEvent.click(within(conflict).getByRole('button', { name: 'Keep mine on top of theirs' }));
    expect(await screen.findByText('Draft revision 6')).toBeInTheDocument();
    expect(lib.saveDraft).toHaveBeenLastCalledWith(catalog.id, 'draft-4', { content: withLatency(99), media_type: 'application/json', contracts: [], dependencies: [] }, 5);
    expect(screen.queryByText(/Someone saved this draft/)).not.toBeInTheDocument();
    expect(latency()).toHaveValue('99');
  });

  it('takes the other copy when asked', async () => {
    lib.drafts.mockResolvedValueOnce([server()]).mockResolvedValue([draftOf('draft-4', 5, withLatency(90) as Record<string, unknown>, { based_on_id: v3.id })]);
    lib.saveDraft.mockRejectedValueOnce(refusal(409, 'draft_conflict'));
    renderDraft();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

    fireEvent.change(latency(), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use theirs' }));

    expect(latency()).toHaveValue('90');
    expect(screen.getByText('Draft revision 5')).toBeInTheDocument();
    expect(screen.getByText('All changes saved')).toBeInTheDocument();
    expect(lib.saveDraft).toHaveBeenCalledTimes(1);
  });

  it('seals into a new version and says so', async () => {
    lib.seal.mockResolvedValue(versionOf(catalog, '4'));
    renderDraft();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

    fireEvent.click(screen.getByRole('button', { name: 'Seal version…' }));
    const dialog = screen.getByRole('dialog', { name: 'Seal a new version' });
    expect(within(dialog).getAllByRole('listitem').map((line) => line.textContent)).toEqual([
      '3 providers in 2 capabilities, and their qualities', 'The language qos-binding/v1', 'Everything in version 3 that you didn’t change',
    ]);
    fireEvent.change(within(dialog).getByLabelText('Version label (optional)'), { target: { value: '4' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Seal version' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Version 4 sealed' })).toBeInTheDocument();
    expect(lib.seal).toHaveBeenCalledWith(catalog.id, 'draft-4', 4, '4');
    expect(lib.saveDraft).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Open the version' })).toHaveAttribute('href', `${root}/versions/4`);
    expect(screen.getByRole('link', { name: 'Back to Proveedores UE' })).toHaveAttribute('href', root);
  });

  it('saves pending changes first, then seals the revision it saved', async () => {
    lib.saveDraft.mockResolvedValue({ id: 'draft-4', revision: 5 });
    lib.seal.mockResolvedValue(versionOf(catalog, '4'));
    renderDraft();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

    fireEvent.change(latency(), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Seal version…' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Seal a new version' })).getByRole('button', { name: 'Seal version' }));

    await screen.findByRole('heading', { level: 1, name: 'Version 4 sealed' });
    expect(lib.seal).toHaveBeenCalledWith(catalog.id, 'draft-4', 5, undefined);
    expect(lib.saveDraft.mock.invocationCallOrder[0]).toBeLessThan(lib.seal.mock.invocationCallOrder[0]);
  });

  it('keeps the dialog open when the version label is taken, and shows the server’s verdict on invalid content', async () => {
    lib.seal.mockRejectedValueOnce(refusal(409, 'version_conflict')).mockRejectedValueOnce(refusal(422, 'resource_contract', 'Select exactly one installed Dialect for this resource.'));
    renderDraft();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

    fireEvent.click(screen.getByRole('button', { name: 'Seal version…' }));
    const dialog = screen.getByRole('dialog', { name: 'Seal a new version' });
    fireEvent.change(within(dialog).getByLabelText('Version label (optional)'), { target: { value: '3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Seal version' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Version 3 already exists (409 · version_conflict). Choose another label.');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Seal version' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('Fix the checks first (422 · resource_contract). Select exactly one installed Dialect for this resource.'));
    expect(within(screen.getByRole('region', { name: 'Checks' })).getByText('The server rejected the content (422): Select exactly one installed Dialect for this resource.')).toBeInTheDocument();
  });

  it('turns a conflict at seal time into the comparison', async () => {
    lib.seal.mockRejectedValue(refusal(409, 'draft_conflict'));
    lib.drafts.mockResolvedValueOnce([server()]).mockResolvedValue([draftOf('draft-4', 5, withLatency(90) as Record<string, unknown>)]);
    renderDraft();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

    fireEvent.click(screen.getByRole('button', { name: 'Seal version…' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Seal a new version' })).getByRole('button', { name: 'Seal version' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Someone saved this draft while you were editing');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('goes read-only when the key cannot write', async () => {
    lib.saveDraft.mockRejectedValue(refusal(403, 'forbidden'));
    renderDraft();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

    fireEvent.change(latency(), { target: { value: '90' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(await screen.findByText('This API key can’t write library items (403), so the editor is read-only.')).toBeInTheDocument();
    expect(latency()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Seal version…' })).toBeDisabled();
  });

  it('is read-only for a VIEWER whose role can read the draft', async () => {
    renderDraft(catalog, viewing);

    expect(await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('You’re a VIEWER. Drafts are read-only for your role; editing needs MEMBER.');
    expect(latency()).toBeDisabled();
    for (const button of screen.getAllByRole('button', { name: 'Add provider' })) expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Seal version…' })).toBeDisabled();
    expect(screen.queryByText('Add a dependency')).not.toBeInTheDocument();
  });

  it('says that drafts are for members when the gateway will not show them', async () => {
    lib.drafts.mockRejectedValue(refusal(403, 'forbidden'));
    renderDraft(catalog, viewing);

    expect(await screen.findByText('Drafts are for members')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Proveedores UE' })).toHaveAttribute('href', root);
  });

  it('says the draft is not there when it was sealed or never existed', async () => {
    lib.drafts.mockResolvedValue([]);
    renderDraft();

    expect(await screen.findByRole('heading', { name: 'Draft not found' })).toBeInTheDocument();
    expect(screen.getByText(/It was sealed, discarded or never existed/)).toBeInTheDocument();
  });

  it('edits any other kind field by field, adding and removing fields', async () => {
    const app = itemOf('checkout-app', 'Application', 'Checkout app');
    lib.drafts.mockResolvedValue([draftOf('draft-4', 2, { apiVersion: 'qos-binding/v1', kind: 'Application', metadata: { name: 'checkout-app' }, spec: { tasks: { authenticate: 'auth' }, features: {} } })]);
    lib.saveDraft.mockResolvedValue({ id: 'draft-4', revision: 3 });
    renderDraft(app, group, '/app/isa-demo/library/checkout-app/drafts/draft-4');
    await screen.findByRole('heading', { level: 1, name: 'Checkout app · draft' });

    expect(screen.getByLabelText(/^Language version/)).toBeDisabled();
    fireEvent.change(screen.getByLabelText('authenticate'), { target: { value: 'identity' } });
    const tasks = screen.getByRole('group', { name: /^Tasks/ });
    fireEvent.change(within(tasks).getByLabelText('New field name'), { target: { value: 'notify' } });
    fireEvent.click(within(tasks).getByRole('button', { name: 'Add field' }));
    expect(screen.getByLabelText('notify')).toHaveValue('');
    fireEvent.change(within(tasks).getByLabelText('New field name'), { target: { value: 'notify' } });
    fireEvent.click(within(tasks).getByRole('button', { name: 'Add field' }));
    expect(within(tasks).getByRole('alert')).toHaveTextContent('There is already a field called “notify”.');
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    await screen.findByText('Draft revision 3');
    expect(lib.saveDraft).toHaveBeenCalledWith(
      app.id,
      'draft-4',
      { content: { apiVersion: 'qos-binding/v1', kind: 'Application', metadata: { name: 'checkout-app' }, spec: { tasks: { authenticate: 'identity', notify: '' }, features: {} } }, media_type: 'application/json', contracts: [], dependencies: [] },
      2,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove notify field' }));
    expect(screen.queryByLabelText('notify')).not.toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  });

  it('describes a workflow file instead of opening it', async () => {
    const flow = itemOf('checkout-flow', 'BPMN', 'Checkout flow');
    lib.drafts.mockResolvedValue([draftOf('draft-4', 1, bpmnContent, { payload: { content: bpmnContent, media_type: 'application/vnd.omg.bpmn+xml', contracts: [], dependencies: [] } })]);
    renderDraft(flow, group, '/app/isa-demo/library/checkout-flow/drafts/draft-4');

    const file = await screen.findByRole('region', { name: 'File' });
    expect(within(file).getByText('Tasks').parentElement).toHaveTextContent('Tasks2');
    expect(within(file).getByText('XML · definitions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace file…' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('adds an exact dependency from the library and saves it with the draft', async () => {
    lib.saveDraft.mockResolvedValue({ id: 'draft-4', revision: 5 });
    renderDraft();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · draft' });

    const picker = screen.getByRole('group', { name: 'Add a dependency' });
    await waitFor(() => expect(within(picker).getByRole('option', { name: 'SLA hard · Rules' })).toBeInTheDocument());
    fireEvent.change(within(picker).getByLabelText('Library item'), { target: { value: rules.id } });
    await waitFor(() => expect(within(picker).getByRole('option', { name: 'Version 1 · Members only' })).toBeInTheDocument());
    fireEvent.change(within(picker).getByLabelText('Exact version'), { target: { value: `${rules.id}-v1` } });
    fireEvent.click(within(picker).getByRole('button', { name: 'Add version' }));

    const dependencies = screen.getByRole('list', { name: 'Exact dependencies' });
    expect(within(dependencies).getByText('sla-hard')).toBeInTheDocument();
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Draft revision 5');
    expect(lib.saveDraft.mock.calls[0][2].dependencies).toEqual([versionOf(rules, '1').ref]);
  });
});
