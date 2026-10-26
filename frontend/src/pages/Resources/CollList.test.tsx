import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { caseItem, collectionOf, collectionRevisionOf, digestOf, resourceItem, usageOf } from '../../test/fixtures/resources';
import { CollList } from './CollList';

const platform = vi.hoisted(() => ({
  project: vi.fn(), publicProjects: vi.fn(), collections: vi.fn(), collectionRevisions: vi.fn(), createCollection: vi.fn(), deleteCollection: vi.fn(),
}));
const client = vi.hoisted(() => ({ getOwnUsage: vi.fn() }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: client }));

const admin = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'ADMIN' });
const member = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const viewer = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'VIEWER' });
const sponsoredByOthers = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER', billing_sponsor_user_id: 'user-nora' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const root = '/app/isa-demo/qos-benchmarks';

const checkout = collectionOf('referencias-checkout', 'Referencias checkout', { description: 'What a reviewer needs to reproduce the published comparison.' });
const empty = collectionOf('vacia', 'Vacía');
const checkoutRevision = collectionRevisionOf(checkout, 1, [caseItem('case-r1', digestOf('1')), caseItem('case-r2', digestOf('2')), resourceItem('weights', '1', digestOf('3'))]);
const refusal = (status: number, code?: string) => Object.assign(new HttpError(status, 'refused'), code ? { code } : {});

function renderList(organization = member) {
  return renderProjectScreen(<CollList />, { path: '/app/:org/:project/collections', url: `${root}/collections`, organizations: [organization] });
}

describe('Collections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.collections.mockResolvedValue([checkout, empty]);
    platform.collectionRevisions.mockImplementation(async (_org: string, _project: string, slug: string) => (slug === 'referencias-checkout' ? [checkoutRevision] : []));
    client.getOwnUsage.mockResolvedValue(usageOf());
  });

  it('lists the collections as cards with what they pin and their latest revision', async () => {
    renderList();

    const list = await screen.findByRole('list', { name: 'Collections' });
    const cards = within(list).getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByRole('link', { name: 'Referencias checkout' })).toHaveAttribute('href', `${root}/collections/referencias-checkout`);
    expect(within(cards[0]).getByText('What a reviewer needs to reproduce the published comparison.')).toBeInTheDocument();
    expect(within(cards[0]).getByText('2 case revisions')).toBeInTheDocument();
    expect(within(cards[0]).getByText('1 resource version')).toBeInTheDocument();
    expect(within(cards[0]).getByText('3 items · revision 1')).toBeInTheDocument();
    expect(within(cards[1]).getByText('No revision yet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Collections' })).toBeInTheDocument();
    // [utest->req~frontend-retire-library-entry-points-removed~1]
    expect(screen.queryByRole('navigation', { name: 'Library sections' })).toBeNull();
    expect(within(screen.getByRole('navigation', { name: 'Project sections' })).getByRole('link', { name: 'Collections' })).toHaveAttribute('aria-current', 'page');
    for (const link of screen.getAllByRole('link')) expect(link.getAttribute('href') ?? '').not.toMatch(/\/(library|resources)([/?#]|$)/);
  });

  it('shows the sponsor’s allowance of collections against the ones in this project', async () => {
    renderList();

    const meter = await screen.findByRole('meter', { name: 'Sponsor’s collections used' });
    expect(meter).toHaveAttribute('aria-valuetext', '2 of 50');
    expect(screen.getByText('2 in this project · allowance 50')).toBeInTheDocument();
  });

  it('says the sponsor’s allowance is not shown to someone who is not the sponsor', async () => {
    renderList(sponsoredByOthers);

    expect(await screen.findByText('2 collections in this project · the sponsor’s allowance isn’t shown to you')).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('explains what a collection is when there are none', async () => {
    platform.collections.mockResolvedValue([]);
    renderList();

    expect(await screen.findByText('No collections')).toBeInTheDocument();
    expect(screen.getByText(/Group the cases and resources you want to keep together, each pinned to an exact revision/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Collections' })).not.toBeInTheDocument();
  });

  it('creates a collection and points to its first items', async () => {
    platform.createCollection.mockResolvedValue(collectionOf('mi-lista', 'Mi lista'));
    renderList();
    await screen.findByRole('list', { name: 'Collections' });

    fireEvent.click(screen.getByRole('button', { name: 'New collection' }));
    const dialog = await screen.findByRole('dialog', { name: 'New collection' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Mi lista' } });
    expect(within(dialog).getByLabelText('Address')).toHaveValue('mi-lista');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Collection “Mi lista” created.')).toBeInTheDocument();
    expect(platform.createCollection).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', { slug: 'mi-lista', name: 'Mi lista', description: '' });
    expect(screen.getByRole('link', { name: 'Add its first items' })).toHaveAttribute('href', `${root}/collections/mi-lista`);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(platform.collections).toHaveBeenCalledTimes(2));
  });

  it('says the sponsor has no collections left (402) and keeps the dialog', async () => {
    platform.createCollection.mockRejectedValue(new QuotaError('sponsor_quota_exceeded', 'The sponsor allowance would be exceeded.', { limit_id: 'collections', limit: 50, used: 51 }));
    renderList();
    await screen.findByRole('list', { name: 'Collections' });

    fireEvent.click(screen.getByRole('button', { name: 'New collection' }));
    const dialog = await screen.findByRole('dialog', { name: 'New collection' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'One more' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('The sponsor has no collections left (402 · sponsor_quota_exceeded). 51 of 50 collections are used. Delete one you don’t need, or ask for more room. Nothing was created.');
  });

  it('says the address is taken (409)', async () => {
    platform.createCollection.mockRejectedValue(refusal(409, 'slug_conflict'));
    renderList();
    await screen.findByRole('list', { name: 'Collections' });

    fireEvent.click(screen.getByRole('button', { name: 'New collection' }));
    const dialog = await screen.findByRole('dialog', { name: 'New collection' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Referencias checkout' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That address is already used by another collection in this organization (409 · slug_conflict).');
  });

  it('asks for a name and a valid address before calling the gateway', async () => {
    renderList();
    await screen.findByRole('list', { name: 'Collections' });

    fireEvent.click(screen.getByRole('button', { name: 'New collection' }));
    const dialog = await screen.findByRole('dialog', { name: 'New collection' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Give it a name and a valid address: lowercase letters, numbers and hyphens.');
    expect(platform.createCollection).not.toHaveBeenCalled();
  });

  it('deletes a collection for an ADMIN after asking, and says what it leaves untouched', async () => {
    platform.deleteCollection.mockResolvedValue(undefined);
    renderList(admin);
    await screen.findByRole('list', { name: 'Collections' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Referencias checkout' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Referencias checkout?' });
    expect(dialog).toHaveTextContent('The cases and resources it pinned are not touched.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete collection' }));

    expect(await screen.findByText('Referencias checkout deleted. The things it pointed to are untouched.')).toBeInTheDocument();
    expect(platform.deleteCollection).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'referencias-checkout');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('gives a MEMBER the creation and no delete', async () => {
    renderList(member);
    await screen.findByRole('list', { name: 'Collections' });

    expect(screen.getByRole('button', { name: 'New collection' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
  });

  it('gives a VIEWER the cards with no controls', async () => {
    renderList(viewer);
    await screen.findByRole('list', { name: 'Collections' });

    expect(screen.queryByRole('button', { name: 'New collection' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('You’re a VIEWER. You can open collections and compare their revisions; creating and editing need MEMBER.');
  });

  it('keeps the page and offers a retry when the list fails', async () => {
    platform.collections.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderList();

    expect(await screen.findByText('The collections couldn’t be loaded (503 · unavailable).')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Collections' })).toBeInTheDocument();
  });

  it('says a forbidden key cannot read the collections, with no retry', async () => {
    platform.collections.mockRejectedValue(refusal(403, 'forbidden'));
    renderList();

    expect(await screen.findByText('This account or API key can’t read this project’s collections (403 · forbidden).')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('reads a project that is not there like one the account is not in', async () => {
    platform.project.mockRejectedValue(refusal(404, 'not_found'));
    renderList();

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(platform.collections).not.toHaveBeenCalled();
  });
});
