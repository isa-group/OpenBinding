import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { LibList } from './LibList';
import { draftOf, itemOf, versionOf } from './fixtures';
import { templateFor } from './contentModel';

const lib = vi.hoisted(() => ({ list: vi.fn(), versions: vi.fn(), create: vi.fn(), createDraft: vi.fn(), projectItems: vi.fn() }));
vi.mock('../../api/libraryItems', () => ({ libraryItemsApi: lib }));

const group = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const viewing = org('read-lab', { id: 'org-isa-demo', name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });

const catalog = itemOf('providers-eu', 'CandidateCatalog', 'Proveedores UE');
const study = itemOf('engines-vs-seeds', 'Study', 'Engines × semillas');
const runs = itemOf('rs-60s', 'ExecutionConfiguration', 'Random Search 60 s');
const external = itemOf('catalogo-externo', 'CandidateCatalog', 'Catálogo externo', { id: 'item-ext', organization_id: 'org-other', namespace: 'org-other' });

const refusal = (status: number, code: string) => Object.assign(new HttpError(status, 'refused'), { code });

function renderList(organization = group, slug = organization.slug, search = '') {
  return renderProjectScreen(<LibList />, { path: '/app/:org/library', url: `/app/${slug}/library${search}`, organizations: [organization], projects: [qos] });
}

describe('Library list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lib.list.mockImplementation(async (_org: string, includePublic: boolean) => [catalog, study, runs, ...(includePublic ? [external] : [])]);
    lib.versions.mockImplementation(async (id: string) => {
      if (id === catalog.id) return [versionOf(catalog, '2'), versionOf(catalog, '3', { public: true })];
      if (id === study.id) return [versionOf(study, '1')];
      return [];
    });
    lib.projectItems.mockResolvedValue([catalog]);
  });

  it('lists the items with their kind, latest version, publication and where they are used', async () => {
    renderList();

    const table = await screen.findByRole('table', { name: 'Library items' });
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 3);
    const first = within(within(table).getByRole('row', { name: /Proveedores UE/ }));
    expect(first.getByRole('link', { name: 'Proveedores UE' })).toHaveAttribute('href', '/app/isa-demo/library/providers-eu');
    expect(first.getByText('providers-eu')).toBeInTheDocument();
    expect(first.getByText('Candidate catalog')).toBeInTheDocument();
    expect(await first.findByText('v3')).toBeInTheDocument();
    expect(first.getByText('Published · public')).toBeInTheDocument();
    expect(await first.findByText('QoS Benchmarks')).toBeInTheDocument();
    expect(first.getByRole('link', { name: 'Use in a project' })).toHaveAttribute('href', '/app/isa-demo/library/providers-eu?use=1');
    const second = within(within(table).getByRole('row', { name: /Engines/ }));
    expect(await second.findByText('v1')).toBeInTheDocument();
    expect(second.getByText('Members only')).toBeInTheDocument();
    expect(await within(within(table).getByRole('row', { name: /Random Search/ })).findByText('No version yet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Library' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Home/ISA Demo Group/Library');
  });

  it('narrows the list by name and by kind, and says when nothing matches', async () => {
    renderList();
    const table = await screen.findByRole('table', { name: 'Library items' });

    fireEvent.change(screen.getByLabelText('Search the library'), { target: { value: 'engines' } });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search the library'), { target: { value: '' } });

    const kinds = screen.getByRole('group', { name: 'Kind' });
    fireEvent.click(within(kinds).getByRole('button', { name: 'Run settings' }));
    expect(within(kinds).getByRole('button', { name: 'Run settings' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Search the library'), { target: { value: 'zzz' } });
    expect(screen.getByText('Nothing matches these filters.')).toBeInTheDocument();
  });

  it('adds the published items of other organizations on request, addressed by id', async () => {
    renderList();
    await screen.findByRole('table', { name: 'Library items' });
    fireEvent.click(screen.getByLabelText('Include public items from other organizations'));

    const row = await screen.findByRole('row', { name: /Catálogo externo/ });
    expect(lib.list).toHaveBeenLastCalledWith('isa-demo', true);
    expect(within(row).getByText('Another organization')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Catálogo externo' })).toHaveAttribute('href', '/app/isa-demo/library/item-ext');
  });

  it('explains how to start when the library is empty', async () => {
    lib.list.mockResolvedValue([]);
    renderList();

    const guide = await screen.findByRole('region', { name: 'The library is empty' });
    expect(within(guide).getByRole('button', { name: 'Create a candidate catalog' })).toBeInTheDocument();
    expect(within(guide).getByRole('link', { name: 'Import an example' })).toHaveAttribute('href', '/examples');
  });

  it('creates an item with its first draft and offers the editor', async () => {
    const created = itemOf('providers-us', 'CandidateCatalog', 'Proveedores US');
    lib.create.mockResolvedValue(created);
    lib.createDraft.mockResolvedValue(draftOf('draft-1', 1, templateFor('CandidateCatalog', 'providers-us').content as Record<string, unknown>));
    renderList();
    await screen.findByRole('table', { name: 'Library items' });

    fireEvent.click(screen.getByRole('button', { name: 'New library item' }));
    const dialog = screen.getByRole('dialog', { name: 'New library item' });
    fireEvent.change(within(dialog).getByLabelText('Name (fixed)'), { target: { value: 'Providers US' } });
    expect(within(dialog).getByLabelText('Name (fixed)')).toHaveValue('providers-us');
    fireEvent.change(within(dialog).getByLabelText('Display name'), { target: { value: 'Proveedores US' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Created “Proveedores US”. It starts with an empty draft; seal it when it’s ready.')).toBeInTheDocument();
    expect(lib.create).toHaveBeenCalledWith('isa-demo', { name: 'providers-us', display_name: 'Proveedores US', kind: 'CandidateCatalog' });
    expect(lib.createDraft).toHaveBeenCalledWith(created.id, {
      content: templateFor('CandidateCatalog', 'providers-us').content, media_type: 'application/json', contracts: [], dependencies: [],
    });
    expect(screen.getByRole('link', { name: 'Open the draft' })).toHaveAttribute('href', '/app/isa-demo/library/providers-us/drafts/draft-1');
    await waitFor(() => expect(lib.list).toHaveBeenCalledTimes(2));
  });

  it('keeps the dialog open with the 409 and the pricing 422', async () => {
    renderList();
    await screen.findByRole('table', { name: 'Library items' });
    fireEvent.click(screen.getByRole('button', { name: 'New library item' }));
    const dialog = screen.getByRole('dialog', { name: 'New library item' });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose a kind and give it a fixed name.');

    fireEvent.change(within(dialog).getByLabelText('Name (fixed)'), { target: { value: 'providers-eu' } });
    lib.create.mockRejectedValueOnce(refusal(409, 'artifact_exists'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText(/There’s already a Candidate catalog called “providers-eu” here \(409 · artifact_exists\)/)).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: '__other' } });
    fireEvent.change(within(dialog).getByLabelText('Kind name'), { target: { value: 'PricingDocument' } });
    lib.create.mockRejectedValueOnce(refusal(422, 'operational_pricing_only'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(await within(dialog).findByText(/Pricing documents can’t live in the library \(422 · operational_pricing_only\)/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'New library item' })).toBeInTheDocument();
    expect(lib.createDraft).not.toHaveBeenCalled();
  });

  it('gives a VIEWER the list and nothing that writes', async () => {
    renderList(viewing);

    await screen.findByRole('table', { name: 'Library items' });
    expect(screen.queryByRole('button', { name: 'New library item' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Use in a project' })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('You’re a VIEWER. You can browse the library and open any item; creating items needs MEMBER.');
  });

  it('says so when the key is limited to other organizations, and hides the list', async () => {
    lib.list.mockRejectedValue(refusal(403, 'api_key_boundary'));
    renderList();

    expect(await screen.findByText('This API key is limited to other organizations or kinds (403 · api_key_boundary), so this library can’t be listed with it.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Search the library')).not.toBeInTheDocument();
  });

  it('keeps the page and offers a retry when the list fails', async () => {
    lib.list.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderList();

    expect(await screen.findByText('The library couldn’t be loaded (503 · unavailable).')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('table', { name: 'Library items' })).toBeInTheDocument();
  });

  it('shows the same message for an organization that is missing and one the account is not in', async () => {
    renderList(group, 'ghost');
    expect(await screen.findByRole('heading', { name: 'Organization not available' })).toBeInTheDocument();
    expect(lib.list).not.toHaveBeenCalled();
  });
});
