import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { LibArtifact } from './LibArtifact';
import { templateFor } from './contentModel';
import { catalogContent, draftOf, itemOf, versionOf } from './fixtures';

const lib = vi.hoisted(() => ({
  list: vi.fn(), item: vi.fn(), versions: vi.fn(), drafts: vi.fn(), rename: vi.fn(), createDraft: vi.fn(), content: vi.fn(), associate: vi.fn(), projectItems: vi.fn(),
}));
vi.mock('../../api/libraryItems', () => ({ libraryItemsApi: lib }));

const group = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const viewing = org('read-lab', { id: 'org-isa-demo', name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const checkout = project('checkout-privado', { name: 'Checkout (privado)' });
const catalog = itemOf('providers-eu', 'CandidateCatalog', 'Proveedores UE');
const v2 = versionOf(catalog, '2');
const v3 = versionOf(catalog, '3', { public: true });
const root = '/app/isa-demo/library/providers-eu';

const refusal = (status: number, code: string) => Object.assign(new HttpError(status, 'refused'), { code });

function renderItem(organization = group, url = root) {
  const slug = organization.slug === 'read-lab' ? 'read-lab' : 'isa-demo';
  return renderProjectScreen(<LibArtifact />, {
    path: '/app/:org/library/:artifact',
    url: url.replace('/isa-demo/', `/${slug}/`),
    organizations: [organization],
    projects: [qos, checkout],
  });
}

describe('Library item', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lib.list.mockResolvedValue([catalog]);
    lib.item.mockResolvedValue(catalog);
    lib.versions.mockResolvedValue([v3, v2]);
    lib.drafts.mockResolvedValue([draftOf('draft-4', 4, catalogContent(), { based_on_id: v3.id })]);
    lib.projectItems.mockImplementation(async (_org: string, slug: string) => (slug === 'qos-benchmarks' ? [catalog] : []));
  });

  it('shows who it is and its sealed versions, newest first', async () => {
    renderItem();

    expect(await screen.findByRole('heading', { level: 1, name: 'Proveedores UE' })).toBeInTheDocument();
    expect(screen.getByText('Candidate catalog')).toBeInTheDocument();
    expect(screen.getByText(/owned by ISA Demo Group/)).toHaveTextContent('providers-eu · owned by ISA Demo Group');
    const versions = await screen.findByRole('list', { name: 'Versions' });
    const rows = within(versions).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('link', { name: 'Version 3' })).toHaveAttribute('href', `${root}/versions/3`);
    expect(within(rows[0]).getByText('Published · public')).toBeInTheDocument();
    expect(within(rows[1]).getByRole('link', { name: 'Version 2' })).toHaveAttribute('href', `${root}/versions/2`);
    expect(within(rows[1]).getByText('Members only')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Home/ISA Demo Group/Library/Proveedores UE');
  });

  it('says that no version has been sealed yet', async () => {
    lib.versions.mockResolvedValue([]);
    renderItem();

    expect(await screen.findByText('No version has been sealed yet. Seal a draft to create version 1.')).toBeInTheDocument();
  });

  it('lists the open drafts with where they started and the way to the editor', async () => {
    renderItem();
    await screen.findByRole('list', { name: 'Versions' });

    fireEvent.click(screen.getByRole('tab', { name: /^Drafts/ }));
    const drafts = await screen.findByRole('list', { name: 'Open drafts' });
    const link = within(drafts).getByRole('link');
    expect(link).toHaveAttribute('href', `${root}/drafts/draft-4`);
    expect(link).toHaveTextContent('Draft · revision 4');
    expect(link).toHaveTextContent('Based on version 3');
    expect(link).toHaveTextContent('Open editor');
  });

  it('renames in place and leaves the fixed name alone', async () => {
    lib.rename.mockResolvedValue({ ...catalog, display_name: 'Proveedores Europa' });
    renderItem();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE' });

    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Proveedores Europa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Display name saved. The fixed name and all versions are unchanged.')).toBeInTheDocument();
    expect(lib.rename).toHaveBeenCalledWith(catalog.id, 'Proveedores Europa');
  });

  it('starts a draft from a sealed version, keeping its content and links', async () => {
    lib.content.mockResolvedValue(JSON.stringify(catalogContent()));
    lib.createDraft.mockResolvedValue(draftOf('draft-9', 1, catalogContent(), { based_on_id: v3.id }));
    renderItem();
    await screen.findByRole('list', { name: 'Versions' });

    fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
    expect(screen.getByLabelText('Start from')).toHaveValue(v3.id);
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(await screen.findByText('Draft created from version 3.')).toBeInTheDocument();
    expect(lib.content).toHaveBeenCalledWith(catalog.id, v3.id);
    expect(lib.createDraft).toHaveBeenCalledWith(catalog.id, { content: catalogContent(), media_type: 'application/json', contracts: [], dependencies: [] }, v3.id);
    expect(screen.getByRole('link', { name: 'Open the editor' })).toHaveAttribute('href', `${root}/drafts/draft-9`);
    expect(screen.getByRole('tab', { name: /^Drafts/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('starts a blank draft shaped for its kind', async () => {
    lib.createDraft.mockResolvedValue(draftOf('draft-10', 1, {}));
    renderItem();
    await screen.findByRole('list', { name: 'Versions' });

    fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
    fireEvent.change(screen.getByLabelText('Start from'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(await screen.findByText('Draft created.')).toBeInTheDocument();
    expect(lib.createDraft).toHaveBeenCalledWith(
      catalog.id,
      { content: templateFor('CandidateCatalog', 'providers-eu').content, media_type: 'application/json', contracts: [], dependencies: [] },
      null,
    );
  });

  it('shows the gateway’s refusal when a draft cannot be made', async () => {
    lib.content.mockResolvedValue(JSON.stringify(catalogContent()));
    lib.createDraft.mockRejectedValue(refusal(403, 'forbidden'));
    renderItem();
    await screen.findByRole('list', { name: 'Versions' });

    fireEvent.click(screen.getByRole('button', { name: 'New draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText(/Drafts need MEMBER in the owning organization \(403 · forbidden\)\. No draft was made\./)).toBeInTheDocument();
  });

  it('gives a VIEWER the versions to read and nothing that writes', async () => {
    renderItem(viewing);

    await screen.findByRole('list', { name: 'Versions' });
    expect(screen.queryByRole('button', { name: 'Rename' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New draft' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use in a project' })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('You’re a VIEWER.');
    fireEvent.click(screen.getByRole('tab', { name: /^Drafts/ }));
    expect(screen.getByText('Open drafts are visible to MEMBER and above in the owning organization.')).toBeInTheDocument();
    expect(lib.drafts).not.toHaveBeenCalled();
  });

  it('says why a private item of another organization is refused when it is added to a project', async () => {
    lib.associate.mockRejectedValue(refusal(422, 'private_dependency'));
    renderItem();
    await screen.findByRole('list', { name: 'Versions' });

    fireEvent.click(screen.getByRole('button', { name: 'Use in a project' }));
    const dialog = await screen.findByRole('dialog', { name: 'Use in a project' });
    await waitFor(() => expect(within(dialog).getByLabelText('Project')).toHaveValue('checkout-privado'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to project' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('“Proveedores UE” belongs to another organization and isn’t published (422 · private_dependency).');
  });

  it('adds the item to a project that does not have it yet', async () => {
    lib.associate.mockResolvedValue({ project_id: 'p', artifact_id: catalog.id });
    renderItem();
    await screen.findByRole('list', { name: 'Versions' });

    fireEvent.click(screen.getByRole('button', { name: 'Use in a project' }));
    const dialog = await screen.findByRole('dialog', { name: 'Use in a project' });
    // The project that already has it is not offered.
    await waitFor(() => expect(within(dialog).getByLabelText('Project')).toHaveValue('checkout-privado'));
    expect(within(dialog).queryByRole('option', { name: 'QoS Benchmarks' })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add to project' }));

    expect(await screen.findByText('“Proveedores UE” added to Checkout (privado).')).toBeInTheDocument();
    expect(lib.associate).toHaveBeenCalledWith('isa-demo', 'checkout-privado', catalog.id);
    expect(screen.getByRole('link', { name: 'Open its library' })).toHaveAttribute('href', '/app/isa-demo/checkout-privado/library');
  });

  it('shows which projects use it', async () => {
    renderItem();
    await screen.findByRole('list', { name: 'Versions' });

    fireEvent.click(screen.getByRole('tab', { name: /^Projects/ }));
    expect(await screen.findByRole('link', { name: /QoS Benchmarks/ })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/library');
    expect(screen.getByRole('button', { name: 'Add to another project' })).toBeInTheDocument();
  });

  it('shows what each sealed version depends on', async () => {
    const rules = itemOf('sla-hard', 'ConstraintSet');
    lib.versions.mockResolvedValue([versionOf(catalog, '2'), {
      ...v3, manifest: { ...v3.manifest, dependencies: [versionOf(rules, '1').ref] },
    }]);
    renderItem();
    await screen.findByRole('list', { name: 'Versions' });

    fireEvent.click(screen.getByRole('tab', { name: /^Dependencies/ }));
    const card = await screen.findByRole('region', { name: 'It depends on' });
    expect(within(card).getByText('sla-hard')).toBeInTheDocument();
    expect(within(card).getByText('v3')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Used by' })).toBeInTheDocument();
  });

  it('opens by id too, as the case screens link to it', async () => {
    renderItem(group, `/app/isa-demo/library/${catalog.id}`);

    expect(await screen.findByRole('heading', { level: 1, name: 'Proveedores UE' })).toBeInTheDocument();
    expect(lib.item).toHaveBeenCalledWith(catalog.id);
    expect(lib.list).not.toHaveBeenCalled();
  });

  it('reads a missing item and one that cannot be read the same way', async () => {
    lib.list.mockResolvedValue([]);
    renderItem();

    expect(await screen.findByRole('heading', { name: 'Library item not found' })).toBeInTheDocument();
    expect(screen.getByText('It doesn’t exist or you can’t read it (404).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the library' })).toHaveAttribute('href', '/app/isa-demo/library');
  });

  it('offers a retry when the item cannot be loaded for another reason', async () => {
    lib.list.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderItem();

    expect(await screen.findByText('The item couldn’t be loaded (503 · unavailable).')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Proveedores UE' })).toBeInTheDocument();
  });

  it('shows the neutral message to someone outside the organization', async () => {
    renderProjectScreen(<LibArtifact />, { path: '/app/:org/library/:artifact', url: '/app/ghost/library/providers-eu', organizations: [group], projects: [] });
    expect(await screen.findByRole('heading', { name: 'Organization not available' })).toBeInTheDocument();
    expect(lib.list).not.toHaveBeenCalled();
  });
});
