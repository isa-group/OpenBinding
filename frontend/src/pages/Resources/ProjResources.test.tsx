import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { resourceOf, resourceRevisionOf } from './fixtures';
import { ProjResources } from './ProjResources';

const platform = vi.hoisted(() => ({
  project: vi.fn(), publicProjects: vi.fn(), resources: vi.fn(), resourceRevisions: vi.fn(), createResource: vi.fn(), deleteResource: vi.fn(),
}));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const admin = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'ADMIN' });
const member = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const viewer = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const root = '/app/isa-demo/qos-benchmarks';

const weights = resourceOf('weights', 'Weights', { kind: 'Dataset' });
const goal = resourceOf('goal', 'Weighted goal', { kind: 'Optimization' });
const notes = resourceOf('notes', 'Notes');
const refusal = (status: number, code?: string) => Object.assign(new HttpError(status, 'refused'), code ? { code } : {});

function renderResources(organization = member) {
  return renderProjectScreen(<ProjResources />, { path: '/app/:org/:project/resources', url: `${root}/resources`, organizations: [organization] });
}

describe('Project resources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.resources.mockResolvedValue([weights, goal, notes]);
    platform.resourceRevisions.mockImplementation(async (_org: string, _project: string, slug: string) => {
      if (slug === 'weights') return [resourceRevisionOf(weights, 1), resourceRevisionOf(weights, 2)];
      if (slug === 'goal') return [resourceRevisionOf(goal, 1)];
      return [];
    });
  });

  it('lists the resources with their kind and latest revision, each linking to its page', async () => {
    renderResources();

    const table = within(await screen.findByRole('region', { name: 'Project resources' }));
    expect(table.getAllByRole('row')).toHaveLength(4);
    const row = (name: RegExp) => within(table.getByRole('row', { name }));
    expect(row(/Weights/).getByRole('link', { name: 'Weights' })).toHaveAttribute('href', `${root}/resources/weights`);
    expect(row(/Weights/).getByText('Dataset')).toBeInTheDocument();
    expect(row(/Weights/).getByText('revision 2')).toBeInTheDocument();
    expect(row(/Weighted goal/).getByText('Goal')).toBeInTheDocument();
    expect(row(/Weighted goal/).getByText('revision 1')).toBeInTheDocument();
    expect(row(/Notes/).getByText('Resource')).toBeInTheDocument();
    expect(row(/Notes/).getByText('none yet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Project resources' })).toBeInTheDocument();
    expect(screen.getByText('The older per-project view of resources, kept for tools that use packages. Each one is backed by a library item.')).toBeInTheDocument();
  });

  it('frames the page inside the library and recommends the library itself', async () => {
    renderResources();
    await screen.findByRole('region', { name: 'Project resources' });

    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
    const sections = screen.getByRole('navigation', { name: 'Library sections' });
    expect(within(sections).getByText('Project resources (older view)')).toHaveAttribute('aria-current', 'page');
    expect(within(sections).getByRole('link', { name: 'Collections' })).toHaveAttribute('href', `${root}/collections`);
    const note = screen.getAllByRole('note').find((item) => /Recommended/.test(item.textContent ?? ''));
    expect(note).toHaveTextContent('Recommended: manage workflows, catalogs, rules and goals in the library, where drafts, versions and publishing live.');
    expect(within(note as HTMLElement).getByRole('link', { name: 'Open the library' })).toHaveAttribute('href', '/app/isa-demo/library');
  });

  it('shows a dash for a resource whose revisions cannot be read, never a made-up zero', async () => {
    platform.resourceRevisions.mockImplementation(async (_org: string, _project: string, slug: string) => {
      if (slug === 'notes') throw refusal(409, 'content_integrity');
      return [];
    });
    renderResources();

    const table = within(await screen.findByRole('region', { name: 'Project resources' }));
    expect(within(table.getByRole('row', { name: /Notes/ })).getByText('—')).toBeInTheDocument();
    expect(within(table.getByRole('row', { name: /Weights/ })).getByText('none yet')).toBeInTheDocument();
  });

  it('says that no project resources is normal and points to the library', async () => {
    platform.resources.mockResolvedValue([]);
    renderResources();

    expect(await screen.findByText('No project resources')).toBeInTheDocument();
    expect(screen.getByText('That’s normal for new projects: use the library instead.')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open the library' })).toHaveLength(2);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('creates a resource and points to the first revision', async () => {
    platform.createResource.mockResolvedValue(resourceOf('search-weights', 'Search weights', { kind: 'Dataset' }));
    renderResources();
    await screen.findByRole('region', { name: 'Project resources' });

    fireEvent.click(screen.getByRole('button', { name: 'New resource' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project resource' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Search weights' } });
    expect(within(dialog).getByLabelText('Address')).toHaveValue('search-weights');
    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: 'Dataset' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await screen.findByText('Resource “Search weights” created.')).toBeInTheDocument();
    expect(platform.createResource).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', { slug: 'search-weights', name: 'Search weights', description: '', kind: 'Dataset' });
    expect(screen.getByRole('link', { name: 'Add its first revision' })).toHaveAttribute('href', `${root}/resources/search-weights`);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(platform.resources).toHaveBeenCalledTimes(2));
  });

  it('keeps the dialog open when the address is taken (409)', async () => {
    platform.createResource.mockRejectedValue(refusal(409, 'slug_conflict'));
    renderResources();
    await screen.findByRole('region', { name: 'Project resources' });

    fireEvent.click(screen.getByRole('button', { name: 'New resource' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project resource' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Weights' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('That address is already used by another item in this organization (409 · slug_conflict).');
    expect(screen.getByRole('dialog', { name: 'New project resource' })).toBeInTheDocument();
  });

  it('says what the gateway refused when the content is invalid (422)', async () => {
    platform.createResource.mockRejectedValue(refusal(422));
    renderResources();
    await screen.findByRole('region', { name: 'Project resources' });

    fireEvent.click(screen.getByRole('button', { name: 'New resource' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project resource' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Weights again' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Use lowercase letters, numbers and hyphens for the address (422), and give it a name.');
  });

  it('refuses an address that is not valid before asking the gateway', async () => {
    renderResources();
    await screen.findByRole('region', { name: 'Project resources' });

    fireEvent.click(screen.getByRole('button', { name: 'New resource' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project resource' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Weights' } });
    fireEvent.change(within(dialog).getByLabelText('Address'), { target: { value: 'Bad Address!' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Give it a name and a valid address: lowercase letters, numbers and hyphens.');
    expect(platform.createResource).not.toHaveBeenCalled();
  });

  it('sends a kind the library owns to the library instead of creating a resource nobody would see', async () => {
    renderResources();
    await screen.findByRole('region', { name: 'Project resources' });

    fireEvent.click(screen.getByRole('button', { name: 'New resource' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project resource' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Providers' } });
    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: '__other' } });
    fireEvent.change(within(dialog).getByLabelText('Kind name'), { target: { value: 'CandidateCatalog' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('CandidateCatalog items live in the library, where they have drafts and sealed versions. Create it there.');
    expect(platform.createResource).not.toHaveBeenCalled();
  });

  it('deletes a resource for an ADMIN after asking, and says the library versions stay', async () => {
    platform.deleteResource.mockResolvedValue(undefined);
    renderResources(admin);
    await screen.findByRole('region', { name: 'Project resources' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Weights' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Weights?' });
    expect(dialog).toHaveTextContent('Its versions stay in the library');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete resource' }));

    expect(await screen.findByText('“Weights” deleted from this project. Library versions stay.')).toBeInTheDocument();
    expect(platform.deleteResource).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'weights');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says why a deletion was refused and keeps the dialog', async () => {
    platform.deleteResource.mockRejectedValue(refusal(403));
    renderResources(admin);
    await screen.findByRole('region', { name: 'Project resources' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete Notes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Notes?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete resource' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('You need ADMIN in the organization to delete a resource (403). Nothing was deleted.');
  });

  it('gives a MEMBER the creation and no delete', async () => {
    renderResources(member);
    await screen.findByRole('region', { name: 'Project resources' });

    expect(screen.getByRole('button', { name: 'New resource' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
  });

  it('gives a VIEWER the list with no controls', async () => {
    renderResources(viewer);
    await screen.findByRole('region', { name: 'Project resources' });

    expect(screen.queryByRole('button', { name: 'New resource' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
    expect(screen.getAllByRole('note').some((note) => /You’re a VIEWER/.test(note.textContent ?? ''))).toBe(true);
  });

  it('keeps the page and offers a retry when the list fails', async () => {
    platform.resources.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderResources();

    expect(await screen.findByText('The resources couldn’t be loaded (503 · unavailable).')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Project resources' })).toBeInTheDocument();
  });

  it('says a forbidden key cannot read the resources, with no retry', async () => {
    platform.resources.mockRejectedValue(refusal(403, 'forbidden'));
    renderResources();

    expect(await screen.findByText('This account or API key can’t read this project’s resources (403 · forbidden).')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('reads a project that is not there like one the account is not in', async () => {
    platform.project.mockRejectedValue(refusal(404, 'not_found'));
    renderResources();

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(platform.resources).not.toHaveBeenCalled();
  });
});
