import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { caseOf, org, project, renderProjectScreen, revisionOf } from '../Project/testKit';
import { CollDetail } from './CollDetail';
import { caseItem, collectionOf, collectionRevisionOf, digestOf, resourceItem, resourceOf, resourceRevisionOf } from '../../test/fixtures/resources';

const platform = vi.hoisted(() => ({
  project: vi.fn(), publicProjects: vi.fn(), collection: vi.fn(), collectionRevisions: vi.fn(), createCollectionRevision: vi.fn(), updateCollection: vi.fn(), deleteCollection: vi.fn(),
  cases: vi.fn(), revisions: vi.fn(), resources: vi.fn(), resourceRevisions: vi.fn(),
}));
const download = vi.hoisted(() => ({ saveBytes: vi.fn() }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../Project/download', () => download);

const admin = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'ADMIN' });
const member = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const viewer = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const root = '/app/isa-demo/qos-benchmarks';

const flujo = caseOf('flujo-checkout', 'Flujo de checkout');
const c1 = revisionOf(flujo, 1);
const c2 = revisionOf(flujo, 2);
const c3 = revisionOf(flujo, 3);
const weights = resourceOf('weights', 'Weights', { kind: 'Dataset' });
const w1 = resourceRevisionOf(weights, 1);

const checkout = collectionOf('referencias-checkout', 'Referencias checkout', { description: 'What a reviewer needs.' });
const libraryItem = resourceItem('library-catalog', '3', digestOf('c'));
const rev1 = collectionRevisionOf(checkout, 1, [caseItem(c1.id, c1.digest), resourceItem('weights', '1', digestOf('a'))]);
const rev2 = collectionRevisionOf(checkout, 2, [caseItem(c1.id, c1.digest), caseItem(c2.id, c2.digest), resourceItem('weights', '1', digestOf('a'))]);

const pinOf = (revision: typeof c1) => ({ target_kind: 'case', target_digest: revision.digest, target_ref: { caseRevisionId: revision.id } });
const weightsPin = { target_kind: 'resource', target_digest: w1.digest, target_ref: { resourceRevisionId: w1.id } };
const refusal = (status: number, code?: string, extra: Record<string, unknown> = {}) => Object.assign(new HttpError(status, 'refused'), code ? { code } : {}, extra);

function renderDetail(organization = member, slug = 'referencias-checkout') {
  return renderProjectScreen(<CollDetail />, { path: '/app/:org/:project/collections/:collection', url: `${root}/collections/${slug}`, organizations: [organization] });
}

async function items() {
  return screen.findByRole('list', { name: 'Items' });
}

const labels = (list: HTMLElement) => within(list).getAllByRole('listitem').map((item) => within(item).getByText(/ · revision \d$/).textContent);

describe('Collection detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.collection.mockResolvedValue(checkout);
    platform.collectionRevisions.mockResolvedValue([rev1, rev2]);
    platform.cases.mockResolvedValue([flujo]);
    platform.revisions.mockResolvedValue([c1, c2, c3]);
    platform.resources.mockResolvedValue([weights]);
    platform.resourceRevisions.mockResolvedValue([w1]);
  });

  it('shows the items of the latest revision in order, each with its type and fingerprint', async () => {
    renderDetail();

    expect(await screen.findByRole('heading', { level: 1, name: 'Referencias checkout' })).toBeInTheDocument();
    const list = await items();
    expect(screen.getByText('Revision 2 · 3 items · What a reviewer needs.')).toBeInTheDocument();
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByRole('link', { name: 'Flujo de checkout · revision 1' })).toHaveAttribute('href', `${root}/cases/flujo-checkout/revisions/1`);
    expect(within(rows[0]).getByText('Case')).toBeInTheDocument();
    expect(within(rows[0]).getByRole('button', { name: 'Copy fingerprint of Flujo de checkout · revision 1' })).toHaveTextContent('sha256-1111…1111');
    expect(within(rows[1]).getByRole('link', { name: 'Flujo de checkout · revision 2' })).toBeInTheDocument();
    // [utest->req~frontend-retire-library-no-link~1]
    expect(within(rows[2]).queryByRole('link')).toBeNull();
    expect(within(rows[2]).getByText('Weights · revision 1')).toBeInTheDocument();
    expect(within(rows[2]).getByText('Resource')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Start a study from this' })).toHaveAttribute('href', `${root}/studies/new?collection=referencias-checkout`);
    expect(platform.collection).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'referencias-checkout');
  });

  it('lists the revisions and sits in the Collections tab with a breadcrumb back to the collections', async () => {
    renderDetail();
    await items();

    expect(screen.getByRole('button', { name: 'Revision 2 · 3 items' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Revision 1 · 2 items' })).toHaveAttribute('aria-pressed', 'false');
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Collections' })).toHaveAttribute('href', `${root}/collections`);
    expect(within(screen.getByRole('navigation', { name: 'Project sections' })).getByRole('link', { name: 'Collections' })).toHaveAttribute('aria-current', 'page');
  });

  it('reorders the items and saves them as the next revision', async () => {
    const rev3 = collectionRevisionOf(checkout, 3, []);
    platform.collectionRevisions.mockResolvedValueOnce([rev1, rev2]).mockResolvedValue([rev1, rev2, rev3]);
    platform.createCollectionRevision.mockResolvedValue(rev3);
    renderDetail();
    const list = await items();
    expect(screen.getByRole('button', { name: 'Save as revision 3' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Flujo de checkout · revision 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Weights · revision 1 down' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Move Flujo de checkout · revision 2 up' }));

    expect(labels(list)).toEqual(['Flujo de checkout · revision 2', 'Flujo de checkout · revision 1', 'Weights · revision 1']);
    expect(screen.getByText('Unsaved changes to the list. Saving creates a new sealed revision; the previous one stays as it was.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save as revision 3' }));

    expect(await screen.findByText('Revision 3 saved and sealed.')).toBeInTheDocument();
    expect(platform.createCollectionRevision).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'referencias-checkout', [pinOf(c2), pinOf(c1), weightsPin]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Revision 3 · 0 items' })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.queryByText(/Unsaved changes/)).not.toBeInTheDocument();
  });

  it('adds an item from the project’s cases and resources, leaving out what is already there', async () => {
    const rev3 = collectionRevisionOf(checkout, 3, []);
    platform.createCollectionRevision.mockResolvedValue(rev3);
    renderDetail();
    await items();

    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an item' });
    const cases = await within(dialog).findByRole('list', { name: 'Cases' });
    expect(within(cases).getAllByRole('button')).toHaveLength(1);
    expect(within(dialog).queryByRole('button', { name: 'Add Flujo de checkout · revision 1' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('list', { name: 'Resources' })).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Search'), { target: { value: 'zzz' } });
    expect(within(dialog).getByText('Nothing matches.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Search'), { target: { value: 'revision 3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add Flujo de checkout · revision 3' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(within(await items()).getAllByRole('listitem')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Save as revision 3' }));

    await waitFor(() => expect(platform.createCollectionRevision).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'referencias-checkout', [pinOf(c1), pinOf(c2), weightsPin, pinOf(c3)]));
  });

  it('removes an item and saves the shorter list', async () => {
    platform.createCollectionRevision.mockResolvedValue(collectionRevisionOf(checkout, 3, []));
    renderDetail();
    const list = await items();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Weights · revision 1' }));

    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Save as revision 3' }));
    await waitFor(() => expect(platform.createCollectionRevision).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'referencias-checkout', [pinOf(c1), pinOf(c2)]));
  });

  it('starts the first revision of a collection that has none', async () => {
    platform.collectionRevisions.mockResolvedValue([]);
    platform.createCollectionRevision.mockResolvedValue(collectionRevisionOf(checkout, 1, []));
    renderDetail();

    expect(await screen.findByText('No items yet')).toBeInTheDocument();
    expect(screen.getByText('Add cases or resources to make the first revision.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as revision 1' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an item' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Add Weights · revision 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as revision 1' }));

    expect(await screen.findByText('Revision 1 saved and sealed.')).toBeInTheDocument();
    expect(platform.createCollectionRevision).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'referencias-checkout', [weightsPin]);
  });

  it('says a repeated item is refused (422) and keeps the list', async () => {
    platform.createCollectionRevision.mockRejectedValue(refusal(422, undefined, { problem: { code: 'validation_error', detail: 'Request validation failed', diagnostics: [{ code: 'value_error', message: 'Value error, a collection revision cannot repeat a target' }] } }));
    renderDetail();
    const list = await items();

    fireEvent.click(screen.getByRole('button', { name: 'Move Flujo de checkout · revision 2 up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as revision 3' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('An item appears twice (422): a revision can’t repeat a target. Remove the duplicate. Nothing was saved.');
    expect(labels(list)).toEqual(['Flujo de checkout · revision 2', 'Flujo de checkout · revision 1', 'Weights · revision 1']);
  });

  it('says an item whose fingerprint is no longer valid is refused (422)', async () => {
    platform.createCollectionRevision.mockRejectedValue(refusal(422, 'collection_target_mismatch'));
    renderDetail();
    await items();

    fireEvent.click(screen.getByRole('button', { name: 'Move Flujo de checkout · revision 2 up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as revision 3' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('An item’s fingerprint isn’t valid any more (422 · collection_target_mismatch): it doesn’t belong to this project or its content changed. Remove it and add it again from its page. Nothing was saved.');
  });

  it('does not claim a new revision when the list is one that already exists', async () => {
    platform.createCollectionRevision.mockResolvedValue(rev1);
    renderDetail();
    await items();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Flujo de checkout · revision 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as revision 3' }));

    expect(await screen.findByText('That exact list is already revision 1; the latest revision is still 2.')).toBeInTheDocument();
  });

  it('refuses to save when an item pinned from the library cannot be re-pinned here', async () => {
    platform.collectionRevisions.mockResolvedValue([collectionRevisionOf(checkout, 1, [caseItem(c1.id, c1.digest), libraryItem])]);
    renderDetail();
    const list = await items();
    expect(within(list).getByText('Pinned from the library · can’t be re-pinned here')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Move Flujo de checkout · revision 1 down' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as revision 2' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('1 item here was pinned from the library and can’t be re-pinned from this page: library-catalog · revision 3. Remove it to save, or edit this collection in the library.');
    expect(platform.createCollectionRevision).not.toHaveBeenCalled();
  });

  it('compares the latest revision with the one before it', async () => {
    renderDetail();
    await items();

    fireEvent.click(screen.getByRole('button', { name: 'Compare revisions' }));

    const panel = await screen.findByRole('region', { name: 'Revision 2 vs revision 1' });
    const changes = within(panel).getByRole('list', { name: 'Differences' });
    expect(within(changes).getAllByRole('listitem')).toHaveLength(1);
    expect(within(changes).getByText('Added')).toBeInTheDocument();
    expect(within(changes).getByText('Flujo de checkout · revision 2')).toBeInTheDocument();
    fireEvent.change(within(panel).getByLabelText('From'), { target: { value: '2' } });
    expect(await within(panel).findByText('No differences.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide comparison' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('compares the unsaved list with the latest revision, naming what moved', async () => {
    renderDetail();
    await items();
    fireEvent.click(screen.getByRole('button', { name: 'Compare revisions' }));

    fireEvent.click(screen.getByRole('button', { name: 'Move Flujo de checkout · revision 2 up' }));

    const panel = await screen.findByRole('region', { name: 'Your changes vs revision 2' });
    const rows = within(within(panel).getByRole('list', { name: 'Differences' })).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('MovedFlujo de checkout · revision 2 · position 2 → 1');
    expect(rows[1]).toHaveTextContent('MovedFlujo de checkout · revision 1 · position 1 → 2');
  });

  it('says there is nothing to compare with a single revision', async () => {
    platform.collectionRevisions.mockResolvedValue([rev1]);
    renderDetail();
    await items();

    fireEvent.click(screen.getByRole('button', { name: 'Compare revisions' }));

    expect(await screen.findByRole('region', { name: 'Only one revision so far' })).toBeInTheDocument();
    expect(screen.getByText('Save a second revision to compare them.')).toBeInTheDocument();
  });

  it('reads an earlier revision without editing it, and can start from it', async () => {
    renderDetail();
    const list = await items();

    fireEvent.click(screen.getByRole('button', { name: 'Revision 1 · 2 items' }));

    expect(await screen.findByText('You’re reading revision 1, not the latest. It never changes.')).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /^Move / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add item' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Start from this revision' }));

    expect(screen.getByText(/Unsaved changes to the list/)).toBeInTheDocument();
    expect(screen.queryByText(/You’re reading revision 1/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as revision 3' })).toBeEnabled();
    expect(within(await items()).getAllByRole('listitem')).toHaveLength(2);
  });

  it('goes back to the latest revision from an earlier one', async () => {
    renderDetail();
    await items();
    fireEvent.click(screen.getByRole('button', { name: 'Revision 1 · 2 items' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Back to the latest' }));

    expect(screen.queryByText(/You’re reading revision 1/)).not.toBeInTheDocument();
    expect(within(await items()).getAllByRole('listitem')).toHaveLength(3);
  });

  it('renames the collection and its description', async () => {
    platform.updateCollection.mockResolvedValue({ ...checkout, name: 'Referencias' });
    renderDetail();
    await items();

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const form = within(screen.getByRole('form', { name: 'Rename the collection' }));
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'Referencias' } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Name saved.')).toBeInTheDocument();
    expect(platform.updateCollection).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'referencias-checkout', { name: 'Referencias', description: 'What a reviewer needs.' });
    expect(screen.queryByRole('form', { name: 'Rename the collection' })).not.toBeInTheDocument();
  });

  it('keeps the rename form when the gateway refuses the text', async () => {
    platform.updateCollection.mockRejectedValue(refusal(422));
    renderDetail();
    await items();

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const form = within(screen.getByRole('form', { name: 'Rename the collection' }));
    fireEvent.change(form.getByLabelText('Name'), { target: { value: 'x' } });
    fireEvent.click(form.getByRole('button', { name: 'Save' }));

    expect(await form.findByRole('alert')).toHaveTextContent('The gateway refused that text (422). A name has 1 to 160 characters and a description up to 2,000. Nothing changed.');
  });

  it('exports the manifest of the revision on show', async () => {
    renderDetail();
    await items();

    fireEvent.click(screen.getByRole('button', { name: 'Export manifest' }));

    expect(download.saveBytes).toHaveBeenCalledWith(expect.anything(), 'collection-referencias-checkout-r2.json', 'application/json');
  });

  it('deletes the collection for an ADMIN and goes back to the list', async () => {
    platform.deleteCollection.mockResolvedValue(undefined);
    renderDetail(admin);
    await items();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Referencias checkout?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete collection' }));

    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    expect(platform.deleteCollection).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'referencias-checkout');
  });

  it('gives a MEMBER the editing and no delete', async () => {
    renderDetail(member);
    await items();

    expect(screen.getByRole('button', { name: 'Add item' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('gives a VIEWER the items, the revisions and the comparison, and nothing that writes', async () => {
    renderDetail(viewer);
    await items();

    expect(screen.queryByRole('button', { name: 'Add item' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Save as revision/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Move / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compare revisions' })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('You’re a VIEWER. You can read every revision and compare them; adding, reordering and saving need MEMBER.');
  });

  it('shows what it can when the project’s cases and resources cannot be read', async () => {
    platform.cases.mockRejectedValue(refusal(503, 'unavailable'));
    platform.resources.mockRejectedValue(refusal(503, 'unavailable'));
    renderDetail();
    const list = await items();

    expect(within(list).getAllByText('Case revision case-flu', { selector: 'span' })).toHaveLength(2);
    expect(screen.getByText(/couldn’t be read, so some items show only their fingerprint/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add an item' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The project’s cases and resources couldn’t be read (503 · unavailable).');
  });

  it('says a collection that is not in the project is not there (404)', async () => {
    platform.collection.mockRejectedValue(refusal(404, 'not_found'));
    renderDetail(member, 'ghost');

    expect(await screen.findByRole('heading', { name: 'Collection not found' })).toBeInTheDocument();
    expect(screen.getByText('No collection with this address in QoS Benchmarks (404 · not_found).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All collections' })).toHaveAttribute('href', `${root}/collections`);
  });

  it('keeps the header and offers a retry when the revisions fail to load', async () => {
    platform.collectionRevisions.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderDetail();

    expect(await screen.findByText('The revisions couldn’t be loaded (503 · unavailable).')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Referencias checkout' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await items()).toBeInTheDocument();
  });

  it('offers a retry when the collection itself fails to load', async () => {
    platform.collection.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderDetail();

    expect(await screen.findByText('The collection couldn’t be loaded (503 · unavailable).')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Referencias checkout' })).toBeInTheDocument();
  });

  it('reads a project that is not there like one the account is not in', async () => {
    platform.project.mockRejectedValue(refusal(404, 'not_found'));
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(platform.collection).not.toHaveBeenCalled();
  });
});
