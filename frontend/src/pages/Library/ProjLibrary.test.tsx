import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { ProjLibrary } from './ProjLibrary';
import { itemOf, versionOf } from './fixtures';

const platform = vi.hoisted(() => ({ project: vi.fn(), publicProjects: vi.fn() }));
const lib = vi.hoisted(() => ({ projectItems: vi.fn(), versions: vi.fn(), list: vi.fn(), associate: vi.fn(), dissociate: vi.fn() }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/libraryItems', () => ({ libraryItemsApi: lib }));

const group = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const viewing = org('read-lab', { id: 'org-isa-demo', name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const catalog = itemOf('providers-eu', 'CandidateCatalog', 'Proveedores UE');
const rules = itemOf('sla-hard', 'ConstraintSet', 'SLA hard');
const external = itemOf('catalogo-externo', 'CandidateCatalog', 'Catálogo externo', { id: 'item-ext', organization_id: 'org-other', namespace: 'org-other' });
const root = '/app/isa-demo/qos-benchmarks';

const refusal = (status: number, code: string) => Object.assign(new HttpError(status, 'refused'), { code });

function renderLibrary(organization = group) {
  const slug = organization.slug;
  return renderProjectScreen(<ProjLibrary />, { path: '/app/:org/:project/library', url: `/app/${slug}/qos-benchmarks/library`, organizations: [organization] });
}

describe('Project library', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    lib.projectItems.mockResolvedValue([catalog, external]);
    lib.versions.mockImplementation(async (id: string) => (id === catalog.id ? [versionOf(catalog, '2'), versionOf(catalog, '3')] : []));
    lib.list.mockResolvedValue([catalog, rules, external]);
  });

  it('lists what the project uses, where each item comes from and the way around the library', async () => {
    renderLibrary();

    const list = await screen.findByRole('list', { name: 'Library items used here' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    const own = within(rows[0]);
    expect(own.getByRole('link', { name: 'Proveedores UE' })).toHaveAttribute('href', '/app/isa-demo/library/providers-eu');
    expect(own.getByText('Candidate catalog')).toBeInTheDocument();
    expect(await own.findByText('latest v3')).toBeInTheDocument();
    expect(own.getByText('Own · ISA Demo Group')).toBeInTheDocument();
    expect(own.getByRole('button', { name: 'Remove Proveedores UE from this project' })).toBeInTheDocument();
    const other = within(rows[1]);
    expect(other.getByRole('link', { name: 'Catálogo externo' })).toHaveAttribute('href', '/app/isa-demo/library/item-ext');
    expect(other.getByText('Published by another organization')).toBeInTheDocument();
    expect(await other.findByText('no version')).toBeInTheDocument();

    expect(screen.getByRole('heading', { level: 1, name: 'Library used here' })).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
    const sections = screen.getByRole('navigation', { name: 'Library sections' });
    expect(within(sections).getByText('Library used here')).toHaveAttribute('aria-current', 'page');
    expect(within(sections).getByRole('link', { name: 'Collections' })).toHaveAttribute('href', `${root}/collections`);
    expect(within(sections).getByRole('link', { name: 'Project resources (older view)' })).toHaveAttribute('href', `${root}/resources`);
    expect(within(sections).getByRole('link', { name: 'Organization library' })).toHaveAttribute('href', '/app/isa-demo/library');
    expect(within(sections).getByRole('link', { name: 'Workbench' })).toHaveAttribute('href', `${root}/workbench`);
    expect(screen.getByRole('note')).toHaveTextContent('Removing an item from this list doesn’t delete it or any of its versions');
  });

  it('removes an item from the project and leaves the item alone', async () => {
    lib.dissociate.mockResolvedValue(undefined);
    renderLibrary();
    const list = await screen.findByRole('list', { name: 'Library items used here' });

    lib.projectItems.mockResolvedValue([external]);
    fireEvent.click(within(list).getByRole('button', { name: 'Remove Proveedores UE from this project' }));

    expect(await screen.findByText('“Proveedores UE” removed from this project. Its versions are untouched.')).toBeInTheDocument();
    expect(lib.dissociate).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', catalog.id);
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Library items used here' })).getAllByRole('listitem')).toHaveLength(1));
  });

  it('adds an item from the library, leaving out what is already here', async () => {
    lib.associate.mockResolvedValue({ project_id: qos.id, artifact_id: rules.id });
    renderLibrary();
    await screen.findByRole('list', { name: 'Library items used here' });

    fireEvent.click(screen.getByRole('button', { name: 'Add from library' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add from library' });
    expect(await within(dialog).findByRole('button', { name: 'Add SLA hard' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add Proveedores UE' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Add Catálogo externo' })).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Search'), { target: { value: 'zzz' } });
    expect(within(dialog).getByText('Nothing matches.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Search'), { target: { value: 'sla' } });
    lib.projectItems.mockResolvedValue([catalog, external, rules]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add SLA hard' }));

    expect(await screen.findByText('SLA hard added.')).toBeInTheDocument();
    expect(lib.associate).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', rules.id);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Library items used here' })).getAllByRole('listitem')).toHaveLength(3));
  });

  it('offers published items of other organizations and says why a private one is refused', async () => {
    lib.projectItems.mockResolvedValue([catalog]);
    lib.associate.mockRejectedValue(refusal(422, 'private_dependency'));
    renderLibrary();
    await screen.findByRole('list', { name: 'Library items used here' });

    fireEvent.click(screen.getByRole('button', { name: 'Add from library' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add from library' });
    const foreign = await within(dialog).findByRole('list', { name: 'Published by other organizations' });
    expect(within(foreign).getByText(/Other organization · published/)).toBeInTheDocument();
    fireEvent.click(within(foreign).getByRole('button', { name: 'Add Catálogo externo' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('“Catálogo externo” belongs to another organization and isn’t published (422 · private_dependency). Ask its owners to publish a version first.');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says that nothing is associated yet and points to the library', async () => {
    lib.projectItems.mockResolvedValue([]);
    renderLibrary();

    expect(await screen.findByText('Nothing associated yet')).toBeInTheDocument();
    expect(screen.getByText('Add the catalogs, workflows and settings this project uses so they’re one click away.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Browse the library' })).toHaveAttribute('href', '/app/isa-demo/library');
  });

  it('gives a VIEWER the list with no controls', async () => {
    renderLibrary(viewing);

    await screen.findByRole('list', { name: 'Library items used here' });
    expect(screen.queryByRole('button', { name: 'Add from library' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    expect(screen.getAllByRole('note').some((note) => /You’re a VIEWER/.test(note.textContent ?? ''))).toBe(true);
  });

  it('keeps the page and offers a retry when the list fails, and explains a forbidden key', async () => {
    lib.projectItems.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderLibrary();

    expect(await screen.findByText('The project’s library couldn’t be loaded (503 · unavailable).')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Library items used here' })).toBeInTheDocument();
  });

  it('says a forbidden key cannot read the project’s library', async () => {
    lib.projectItems.mockRejectedValue(refusal(403, 'forbidden'));
    renderLibrary();

    expect(await screen.findByText('This account or API key can’t read this project’s library (403 · forbidden).')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('reads a project that is not there like one the account is not in', async () => {
    platform.project.mockRejectedValue(refusal(404, 'not_found'));
    renderLibrary();

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(lib.projectItems).not.toHaveBeenCalled();
  });
});
