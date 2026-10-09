import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, renderProjectScreen } from '../Project/testKit';
import { LibVersion } from './LibVersion';
import { catalogContent, draftOf, itemOf, versionOf } from './fixtures';
import { exactReference } from './libraryModel';

const lib = vi.hoisted(() => ({ list: vi.fn(), item: vi.fn(), versions: vi.fn(), content: vi.fn(), resolve: vi.fn(), publish: vi.fn(), withdraw: vi.fn(), createDraft: vi.fn() }));
vi.mock('../../api/libraryItems', () => ({ libraryItemsApi: lib }));

const admin = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'ADMIN' });
const member = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const catalog = itemOf('providers-eu', 'CandidateCatalog', 'Proveedores UE');
const rules = itemOf('sla-hard', 'ConstraintSet', 'SLA hard');
const rulesV1 = versionOf(rules, '1');
const v2 = versionOf(catalog, '2');
const v3 = versionOf(catalog, '3', { manifest: { mediaType: 'application/json', contracts: [], dependencies: [rulesV1.ref], kind: 'CandidateCatalog' } });
const published = { ...v3, public: true };
const root = '/app/isa-demo/library/providers-eu';

const refusal = (status: number, code: string, message = 'refused') => Object.assign(new HttpError(status, message), { code });

function renderVersion(organization = admin, url = `${root}/versions/3`, organizations = [organization]) {
  return renderProjectScreen(<LibVersion />, { path: '/app/:org/library/:artifact/versions/:version', url, organizations, projects: [] });
}

const writeText = vi.fn().mockResolvedValue(undefined);

describe('Library version', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    lib.list.mockResolvedValue([catalog]);
    lib.item.mockResolvedValue(catalog);
    lib.versions.mockResolvedValue([v3, v2]);
    lib.content.mockResolvedValue(JSON.stringify(catalogContent()));
    lib.resolve.mockResolvedValue(rulesV1);
  });

  it('shows the exact reference, the content as tables and the actions of an ADMIN', async () => {
    renderVersion();

    expect(await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · version 3' })).toBeInTheDocument();
    expect(screen.getByText('Candidate catalog')).toBeInTheDocument();
    const reference = screen.getByRole('region', { name: 'Exact reference' });
    for (const label of ['Owner space', 'Name', 'Version', 'Version fingerprint', 'Content fingerprint']) expect(within(reference).getByText(label)).toBeInTheDocument();
    expect(within(reference).getByText('providers-eu')).toBeInTheDocument();
    expect(within(reference).getByRole('button', { name: 'Copy version fingerprint' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Candidates for service/payment' });
    expect(within(table).getByRole('row', { name: /fastpay/ })).toHaveTextContent('95');
    expect(screen.getByRole('button', { name: 'Publish…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New draft from this' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download content' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Version')).toHaveValue('3');
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Home/ISA Demo Group/Library/Proveedores UE/Version 3');
  });

  it('keeps the raw source behind a control', async () => {
    renderVersion();
    await screen.findByRole('table', { name: 'Candidates for service/payment' });

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(screen.getByText('View source').closest('details') as HTMLElement).getByLabelText('Source of the content')).toHaveTextContent('"fastpay"');
  });

  it('copies the exact reference', async () => {
    renderVersion();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · version 3' });

    fireEvent.click(screen.getByRole('button', { name: 'Copy exact reference' }));
    expect(await screen.findByRole('button', { name: 'Reference copied' })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(exactReference(v3));
  });

  it('lists what must be published first, with the way to fix each', async () => {
    renderVersion();

    const section = await screen.findByRole('heading', { name: 'Before it can be public' });
    const list = (section.closest('section') as HTMLElement).querySelector('ul') as HTMLElement;
    const items = await within(list).findAllByRole('listitem');
    await waitFor(() => expect(list).toHaveTextContent('Depends on a private item: sla-hard v1 isn’t published (422 · private dependency).'));
    expect(within(list).getByRole('link', { name: 'Open it' })).toHaveAttribute('href', `/app/isa-demo/library/${rules.id}/versions/1`);
    expect(list).toHaveTextContent('Cases that use it live in public projects: the server checks this when you publish.');
    expect(within(list).getByRole('link', { name: 'See where it’s used' })).toHaveAttribute('href', `${root}?tab=projects`);
    expect(items).toHaveLength(2);
    expect(lib.resolve).toHaveBeenCalledWith(rulesV1.ref);
  });

  it('publishes with a citation and then offers to withdraw', async () => {
    lib.publish.mockResolvedValue(published);
    renderVersion();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · version 3' });

    fireEvent.click(screen.getByRole('button', { name: 'Publish…' }));
    const dialog = screen.getByRole('dialog', { name: 'Publish version 3' });
    expect(within(dialog).getByLabelText('Citation title')).toHaveValue('Proveedores UE');
    fireEvent.change(within(dialog).getByLabelText('Citation title'), { target: { value: 'Catálogo de proveedores UE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Publish' }));

    expect(await screen.findByText('Published with its citation. Anyone can now read and verify this version.')).toBeInTheDocument();
    expect(lib.publish).toHaveBeenCalledWith(catalog.id, v3.id, { title: 'Catálogo de proveedores UE' });
    expect(screen.getByText('Published · public')).toBeInTheDocument();
    const cite = screen.getByRole('region', { name: 'Cite as' });
    expect(cite).toHaveTextContent('ISA Demo Group (2026). Catálogo de proveedores UE, version 3. OpenBinding candidate catalog');
    expect(screen.queryByRole('button', { name: 'Publish…' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Withdraw' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Before it can be public' })).not.toBeInTheDocument();
  });

  it('marks the check that failed when the gateway refuses a publication', async () => {
    lib.publish.mockRejectedValue(refusal(422, 'private_case_dependency', 'Publish every resource consumed by the referenced cases first.'));
    renderVersion();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · version 3' });

    fireEvent.click(screen.getByRole('button', { name: 'Publish…' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Publish version 3' })).getByRole('button', { name: 'Publish' }));

    expect(await screen.findByText('Can’t publish yet (422): see the checks below.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const item = screen.getByText(/Used by a case in a private project/).closest('li') as HTMLElement;
    expect(item).toHaveClass('is-fail');
    expect(item).toHaveTextContent('Publish every resource consumed by the referenced cases first.');
    expect(within(item).getByRole('link', { name: 'See where it’s used' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish…' })).toBeInTheDocument();
  });

  it('says a withdrawn edition cannot be published again', async () => {
    lib.publish.mockRejectedValue(refusal(409, 'publication_withdrawn'));
    renderVersion();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · version 3' });

    fireEvent.click(screen.getByRole('button', { name: 'Publish…' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Publish version 3' })).getByRole('button', { name: 'Publish' }));

    expect(await screen.findByText('This version was withdrawn (409 · publication_withdrawn) and can’t be published again. Seal a new version to supersede it.')).toBeInTheDocument();
    expect(screen.getByText('Withdrawn · not listed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish…' })).not.toBeInTheDocument();
  });

  it('withdraws after asking, and keeps references working', async () => {
    lib.versions.mockResolvedValue([published, v2]);
    lib.withdraw.mockResolvedValue({ ...published, withdrawn: true });
    renderVersion();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · version 3' });
    expect(screen.getByText('Published · public')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    const dialog = screen.getByRole('dialog', { name: 'Withdraw version 3?' });
    expect(dialog).toHaveTextContent('This can’t be undone');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));

    expect(await screen.findByText('Withdrawn: it’s no longer listed, but existing references still resolve.')).toBeInTheDocument();
    expect(lib.withdraw).toHaveBeenCalledWith(catalog.id, v3.id);
    expect(screen.getByText('Withdrawn · not listed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
  });

  it('keeps the withdraw dialog open when the gateway refuses', async () => {
    lib.versions.mockResolvedValue([published, v2]);
    lib.withdraw.mockRejectedValue(refusal(409, 'publication_withdrawn'));
    renderVersion();
    await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · version 3' });

    fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
    const dialog = screen.getByRole('dialog', { name: 'Withdraw version 3?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Withdraw' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('It was already withdrawn by someone else (409 · publication_withdrawn).');
  });

  it('does not show or serve content that no longer matches its fingerprint', async () => {
    lib.content.mockRejectedValue(refusal(409, 'version_integrity'));
    renderVersion();

    expect(await screen.findByText(/The stored content doesn’t match this version’s fingerprint \(409 · version integrity\)\. It isn’t shown or served until an administrator checks it\./)).toBeInTheDocument();
    expect(screen.getByText('The content isn’t shown because it no longer matches its fingerprint.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Exact reference' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download content' })).toBeDisabled();
    expect(screen.queryByRole('table', { name: 'Candidates for service/payment' })).not.toBeInTheDocument();
  });

  it('gives a MEMBER a draft from the version and no way to publish', async () => {
    lib.createDraft.mockResolvedValue(draftOf('draft-9', 1, catalogContent()));
    renderVersion(member);
    await screen.findByRole('table', { name: 'Candidates for service/payment' });

    expect(screen.queryByRole('button', { name: 'Publish…' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New draft from this' }));

    expect(await screen.findByText('Draft created from version 3.')).toBeInTheDocument();
    expect(lib.createDraft).toHaveBeenCalledWith(catalog.id, { content: catalogContent(), media_type: 'application/json', contracts: [], dependencies: [rulesV1.ref] }, v3.id);
    expect(screen.getByRole('link', { name: 'Open the editor' })).toHaveAttribute('href', `${root}/drafts/draft-9`);
  });

  it('downloads the content as a file', async () => {
    const create = vi.fn(() => 'blob:content');
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderVersion();
    await screen.findByRole('table', { name: 'Candidates for service/payment' });

    fireEvent.click(screen.getByRole('button', { name: 'Download content' }));
    expect(await screen.findByText('Downloaded providers-eu-3.json.')).toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });

  it('opens by the version’s id as well as its label, and moves between versions', async () => {
    renderVersion(admin, `${root}/versions/${v3.id}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · version 3' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Version'), { target: { value: '2' } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · version 2' })).toBeInTheDocument();
    expect(lib.content).toHaveBeenLastCalledWith(catalog.id, v2.id);
  });

  it('says when the version does not exist', async () => {
    renderVersion(admin, `${root}/versions/9`);

    expect(await screen.findByRole('heading', { name: 'Version not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the library' })).toHaveAttribute('href', '/app/isa-demo/library');
  });

  it('shows a published version to someone outside the organization, and only that', async () => {
    lib.versions.mockResolvedValue([published]);
    renderVersion(admin, `/app/other-org/library/${catalog.id}/versions/3`, []);

    expect(await screen.findByRole('heading', { level: 1, name: 'Proveedores UE · version 3' })).toBeInTheDocument();
    expect(screen.getByText('You’re seeing this because the version is published. Drafts and other versions stay with the organization that owns it.')).toBeInTheDocument();
    expect(lib.item).toHaveBeenCalledWith(catalog.id);
    expect(lib.list).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Version')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New draft from this' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Before it can be public' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Cite as' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download content' })).toBeInTheDocument();
  });

  it('does not show an unpublished version to someone outside the organization', async () => {
    lib.versions.mockResolvedValue([]);
    renderVersion(admin, `/app/other-org/library/${catalog.id}/versions/3`, []);

    expect(await screen.findByRole('heading', { name: 'Version not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Home' })).toHaveAttribute('href', '/app');
    expect(lib.content).not.toHaveBeenCalled();
  });

  it('cannot find an item by name from outside the organization', async () => {
    renderVersion(admin, `/app/other-org/library/providers-eu/versions/3`, []);

    expect(await screen.findByRole('heading', { name: 'Library item not found' })).toBeInTheDocument();
    expect(lib.list).not.toHaveBeenCalled();
  });
});
