import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { resourceOf, resourceRevisionOf } from '../../test/fixtures/resources';
import { ProjResourceDetail } from './ProjResourceDetail';

const platform = vi.hoisted(() => ({
  project: vi.fn(), publicProjects: vi.fn(), resource: vi.fn(), resourceRevisions: vi.fn(), createResourceRevision: vi.fn(), updateResource: vi.fn(), deleteResource: vi.fn(),
}));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));

const admin = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'ADMIN' });
const member = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const viewer = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const root = '/app/isa-demo/qos-benchmarks';

const probes = resourceOf('probes', 'Probe set', { kind: 'Dataset' });
const r1 = resourceRevisionOf(probes, 1, { title: 'Latency probes', samples: 3 });
const r2 = resourceRevisionOf(probes, 2, { title: 'Latency probes', samples: 5 });
const r3 = resourceRevisionOf(probes, 3, { title: 'Latency probes v2', samples: 5 });
const refusal = (status: number, code?: string, text = 'refused') => Object.assign(new HttpError(status, text), code ? { code } : {});

function renderDetail(organization = member, slug = 'probes') {
  return renderProjectScreen(<ProjResourceDetail />, { path: '/app/:org/:project/resources/:resource', url: `${root}/resources/${slug}`, organizations: [organization] });
}

async function opened(name = 'New revision') {
  await screen.findByRole('list', { name: 'Revisions' });
  fireEvent.click(screen.getByRole('button', { name }));
  return screen.findByRole('form', { name: /revision/i });
}

describe('Project resource detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.resource.mockResolvedValue(probes);
    platform.resourceRevisions.mockResolvedValue([r1, r2]);
  });

  it('shows what the resource is and its sealed revisions, newest first', async () => {
    renderDetail();

    expect(await screen.findByRole('heading', { level: 1, name: 'Probe set' })).toBeInTheDocument();
    expect(screen.getByText('Dataset')).toBeInTheDocument();
    expect(screen.getByText('Project view of the library item Probe set.')).toBeInTheDocument();
    expect(platform.resource).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'probes');
    const list = await screen.findByRole('list', { name: 'Revisions' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]).getByText('Revision 2')).toBeInTheDocument();
    expect(within(items[0]).getByText('Latest')).toBeInTheDocument();
    expect(within(items[0]).getByText(/Library version 2/)).toBeInTheDocument();
    expect(within(items[0]).getByRole('button', { name: 'Copy revision 2 fingerprint' })).toBeInTheDocument();
    expect(within(items[1]).getByText('Revision 1')).toBeInTheDocument();
    expect(within(items[1]).queryByText('Latest')).not.toBeInTheDocument();
  });

  it('links to the library item and back to all resources', async () => {
    renderDetail();
    await screen.findByRole('list', { name: 'Revisions' });

    expect(screen.getByRole('link', { name: 'Open in library' })).toHaveAttribute('href', '/app/isa-demo/library/resource-probes');
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Resources' })).toHaveAttribute('href', `${root}/resources`);
    expect(within(crumbs).getByText('Probe set')).toHaveAttribute('aria-current', 'page');
    expect(within(screen.getByRole('navigation', { name: 'Project sections' })).getByRole('link', { name: 'Library' })).toHaveAttribute('aria-current', 'page');
  });

  it('opens what a revision holds as fields, with the source behind a control', async () => {
    renderDetail();
    await screen.findByRole('list', { name: 'Revisions' });

    fireEvent.click(screen.getByRole('button', { name: 'Show what revision 2 holds' }));

    expect(await screen.findByRole('button', { name: 'Hide what revision 2 holds' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Latency probes')).toBeInTheDocument();
    expect(screen.getByText('View source')).toBeInTheDocument();
    expect(screen.queryByLabelText('Source of the content')).not.toBeVisible();
  });

  it('adds a revision from the latest one and says it was sealed', async () => {
    platform.resourceRevisions.mockResolvedValueOnce([r1, r2]).mockResolvedValue([r1, r2, r3]);
    platform.createResourceRevision.mockResolvedValue(r3);
    renderDetail();
    const form = within(await opened());

    expect(screen.getByRole('heading', { name: 'New revision · change what differs from revision 2' })).toBeInTheDocument();
    expect(form.getByLabelText('title')).toHaveValue('Latency probes');
    expect(form.getByRole('button', { name: 'Save revision' })).toBeDisabled();
    expect(form.getByText('Nothing differs from revision 2 yet.')).toBeInTheDocument();
    fireEvent.change(form.getByLabelText('title'), { target: { value: 'Latency probes v2' } });
    expect(form.getByRole('button', { name: 'Save revision' })).toBeEnabled();
    fireEvent.click(form.getByRole('button', { name: 'Save revision' }));

    expect(await screen.findByText('Revision 3 saved and sealed.')).toBeInTheDocument();
    expect(platform.createResourceRevision).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'probes', { title: 'Latency probes v2', samples: 5 });
    expect(screen.queryByRole('form', { name: /revision/i })).not.toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Revisions' })).getAllByRole('listitem')).toHaveLength(3));
  });

  it('says so when the content is already a revision, instead of claiming a new one', async () => {
    platform.createResourceRevision.mockResolvedValue(r1);
    renderDetail();
    const form = within(await opened());

    fireEvent.change(form.getByLabelText('title'), { target: { value: 'Latency probes' } });
    fireEvent.change(form.getByLabelText('samples'), { target: { value: '3' } });
    fireEvent.click(form.getByRole('button', { name: 'Save revision' }));

    expect(await screen.findByText('That content is already revision 1; nothing new was added.')).toBeInTheDocument();
  });

  it('starts the first revision from an empty document when there is none', async () => {
    platform.resourceRevisions.mockResolvedValue([]);
    platform.createResourceRevision.mockResolvedValue(r1);
    renderDetail();
    expect(await screen.findByText('No revisions yet')).toBeInTheDocument();
    expect(screen.getByText('Add the first revision to give this resource content.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'New revision' }));
    const form = within(await screen.findByRole('form', { name: /revision/i }));
    expect(screen.getByRole('heading', { name: 'First revision · fill in what this resource holds' })).toBeInTheDocument();
    fireEvent.change(form.getByLabelText('New field name'), { target: { value: 'title' } });
    fireEvent.click(form.getByRole('button', { name: 'Add field' }));
    fireEvent.change(form.getByLabelText('title'), { target: { value: 'Latency probes' } });
    fireEvent.click(form.getByRole('button', { name: 'Save revision' }));

    await waitFor(() => expect(platform.createResourceRevision).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'probes', { title: 'Latency probes' }));
    expect(await screen.findByText('Revision 1 saved and sealed.')).toBeInTheDocument();
  });

  it('keeps the form and says what was refused when the content is invalid (422)', async () => {
    platform.createResourceRevision.mockRejectedValue(refusal(422, undefined, 'Unprocessable Entity'));
    renderDetail();
    const form = within(await opened());

    fireEvent.change(form.getByLabelText('title'), { target: { value: 'Other' } });
    fireEvent.click(form.getByRole('button', { name: 'Save revision' }));

    expect(await form.findByRole('alert')).toHaveTextContent('The gateway refused this content (422). Nothing was saved.');
    expect(form.getByLabelText('title')).toHaveValue('Other');
  });

  it('says a revision cannot be added when the resource has gone (404)', async () => {
    platform.createResourceRevision.mockRejectedValue(refusal(404, 'not_found'));
    renderDetail();
    const form = within(await opened());

    fireEvent.change(form.getByLabelText('title'), { target: { value: 'Other' } });
    fireEvent.click(form.getByRole('button', { name: 'Save revision' }));

    expect(await form.findByRole('alert')).toHaveTextContent('The resource no longer exists in this project (404 · not_found). Nothing was saved.');
  });

  it('edits the details of the resource', async () => {
    platform.updateResource.mockResolvedValue({ ...probes, name: 'Probe set 2' });
    renderDetail();
    await screen.findByRole('list', { name: 'Revisions' });

    fireEvent.click(screen.getByRole('button', { name: 'Edit details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit resource' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Probe set 2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('Details saved.')).toBeInTheDocument();
    expect(platform.updateResource).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'probes', { name: 'Probe set 2', description: '', kind: 'Dataset' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('deletes the resource for an ADMIN and goes back to the list', async () => {
    platform.deleteResource.mockResolvedValue(undefined);
    renderDetail(admin);
    await screen.findByRole('list', { name: 'Revisions' });

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Probe set?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete resource' }));

    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
    expect(platform.deleteResource).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'probes');
  });

  it('gives a MEMBER the editing and no delete', async () => {
    renderDetail(member);
    await screen.findByRole('list', { name: 'Revisions' });

    expect(screen.getByRole('button', { name: 'New revision' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit details' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('gives a VIEWER the revisions to read and nothing that writes', async () => {
    renderDetail(viewer);
    await screen.findByRole('list', { name: 'Revisions' });

    expect(screen.queryByRole('button', { name: 'New revision' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit details' })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('You’re a VIEWER. You can read every revision; adding one needs MEMBER.');
    expect(screen.getByRole('button', { name: 'Show what revision 1 holds' })).toBeInTheDocument();
  });

  it('says a resource that is not in the project is not there (404)', async () => {
    platform.resource.mockRejectedValue(refusal(404, 'not_found'));
    renderDetail(member, 'ghost');

    expect(await screen.findByRole('heading', { name: 'Resource not found' })).toBeInTheDocument();
    expect(screen.getByText('This resource doesn’t exist in QoS Benchmarks (404 · not_found).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All resources' })).toHaveAttribute('href', `${root}/resources`);
  });

  it('keeps the header and offers a retry when the revisions cannot be read', async () => {
    platform.resourceRevisions.mockRejectedValueOnce(refusal(409, 'content_integrity'));
    renderDetail();

    expect(await screen.findByText('The stored content of a revision can’t be read (409 · content_integrity).')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Probe set' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New revision' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('list', { name: 'Revisions' })).toBeInTheDocument();
  });

  it('offers a retry when the resource itself fails to load', async () => {
    platform.resource.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderDetail();

    expect(await screen.findByText('The resource couldn’t be loaded (503 · unavailable).')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Probe set' })).toBeInTheDocument();
  });

  it('reads a project that is not there like one the account is not in', async () => {
    platform.project.mockRejectedValue(refusal(404, 'not_found'));
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(platform.resource).not.toHaveBeenCalled();
  });
});
