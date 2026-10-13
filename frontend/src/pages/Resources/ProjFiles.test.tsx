import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import JSZip from 'jszip';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError } from '../../api/auth';
import { HttpError } from '../../api/client';
import { org, project, renderProjectScreen } from '../Project/testKit';
import { blobOf, digestOf, usageOf } from '../../test/fixtures/resources';
import { ProjFiles } from './ProjFiles';

const platform = vi.hoisted(() => ({
  project: vi.fn(), publicProjects: vi.fn(), artifacts: vi.fn(), uploadArtifact: vi.fn(), downloadArtifact: vi.fn(), deleteArtifact: vi.fn(),
}));
const client = vi.hoisted(() => ({ getOwnUsage: vi.fn() }));
const download = vi.hoisted(() => ({ saveBytes: vi.fn() }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: client }));
vi.mock('../Project/download', () => download);

const admin = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'ADMIN' });
const member = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const viewer = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'VIEWER' });
const sponsoredByOthers = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER', billing_sponsor_user_id: 'user-nora' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });

const archive = blobOf('a');
const results = blobOf('b', { media_type: 'text/csv', size_bytes: 18_432, public: true, created_at: '2026-09-30T09:00:00Z' });
const ARCHIVE = 'ZIP archive · sha256-aaaa…aaaa';
const refusal = (status: number, code: string) => Object.assign(new HttpError(status, 'refused'), { code });

function renderFiles(organization = member) {
  return renderProjectScreen(<ProjFiles />, { path: '/app/:org/:project/files', url: '/app/isa-demo/qos-benchmarks/files', organizations: [organization] });
}

/** The usage has arrived once the storage meter is there: the ceilings the screen quotes depend on it. */
async function settled() {
  await screen.findByRole('table');
  await screen.findByRole('meter', { name: 'Storage used' });
}

const csv = () => new File(['a,b\n1,2\n'], 'results.csv', { type: 'text/csv' });

describe('Project files', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.publicProjects.mockResolvedValue([]);
    platform.artifacts.mockResolvedValue([archive, results]);
    client.getOwnUsage.mockResolvedValue(usageOf());
  });

  it('lists the files with their type, size, fingerprint and who can read them', async () => {
    renderFiles();
    await settled();

    expect(screen.getByRole('heading', { level: 1, name: 'Files' })).toBeInTheDocument();
    expect(screen.getByText('Plain files stored by their fingerprint. Uploading the same file twice keeps one copy. Files aren’t library items.')).toBeInTheDocument();
    const table = within(screen.getByRole('region', { name: 'Files' }));
    expect(table.getAllByRole('row')).toHaveLength(3);
    const first = within(table.getByRole('row', { name: new RegExp(ARCHIVE) }));
    expect(first.getByText('ZIP archive', { selector: 'td' })).toBeInTheDocument();
    expect(first.getByText('47.1 KiB')).toHaveAttribute('title', '48,213 bytes');
    expect(first.getByRole('button', { name: `Copy fingerprint of ${ARCHIVE}` })).toHaveTextContent('sha256-aaaa…aaaa');
    expect(first.getByText(/Private to members/)).toBeInTheDocument();
    const second = within(table.getByRole('row', { name: /CSV · sha256-bbbb…bbbb/ }));
    expect(second.getByText('18 KiB')).toBeInTheDocument();
    expect(second.getByText(/Public by fingerprint/)).toBeInTheDocument();
    expect(within(screen.getByRole('navigation', { name: 'Project sections' })).getByRole('link', { name: 'Files' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Export or import a package' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks/package');
  });

  it('shows the sponsor’s storage against this project’s files', async () => {
    renderFiles();
    await settled();

    expect(screen.getByText('Storage · sponsored by you')).toBeInTheDocument();
    const meter = screen.getByRole('meter', { name: 'Storage used' });
    expect(meter).toHaveAttribute('aria-valuetext', '65.1 KiB of 5 GiB');
    expect(screen.getByText(/65\.1 KiB in this project; your allowance is 5 GiB across all your organizations\./)).toBeInTheDocument();
    expect(screen.getByText(/Doesn’t renew; frees up when files are deleted\./)).toBeInTheDocument();
  });

  it('says the sponsor’s allowance is not shown to someone who is not the sponsor', async () => {
    renderFiles(sponsoredByOthers);
    await screen.findByRole('table');

    expect(screen.getByText('Storage · sponsored by another account')).toBeInTheDocument();
    expect(await screen.findByText(/The sponsor’s allowance isn’t shown to you\./)).toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('uploads a file as a MEMBER and lists it with the name it had', async () => {
    platform.artifacts.mockResolvedValueOnce([]).mockResolvedValue([blobOf('c', { media_type: 'text/csv', size_bytes: 8 })]);
    platform.uploadArtifact.mockResolvedValue(blobOf('c', { media_type: 'text/csv', size_bytes: 8 }));
    renderFiles();
    await screen.findByText('No files yet');
    expect(screen.getByText('Drop files to upload')).toBeInTheDocument();
    expect(await screen.findByText('Up to 128 MiB each on the RESEARCH plan')).toBeInTheDocument();

    const file = csv();
    fireEvent.change(screen.getByLabelText('Files to upload'), { target: { files: [file] } });

    expect(await screen.findByText('Uploaded “results.csv”. Copy its fingerprint to reference it.')).toBeInTheDocument();
    expect(platform.uploadArtifact).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', file, false);
    const row = await screen.findByRole('row', { name: /results\.csv/ });
    expect(within(row).getByText(/Uploaded in this visit/)).toBeInTheDocument();
    expect(screen.queryByText('No files yet')).not.toBeInTheDocument();
  });

  it('can make an upload readable by anyone with the fingerprint', async () => {
    platform.uploadArtifact.mockResolvedValue(blobOf('c', { public: true }));
    renderFiles();
    await settled();

    fireEvent.click(screen.getByLabelText('Readable by anyone with the fingerprint'));
    fireEvent.change(screen.getByLabelText('Files to upload'), { target: { files: [csv()] } });

    await waitFor(() => expect(platform.uploadArtifact).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', expect.any(File), true));
  });

  it('tells a full storage (402) apart and points to the usage', async () => {
    platform.uploadArtifact.mockRejectedValue(new QuotaError('storage_quota_exceeded', 'The sponsor storage allowance would be exceeded.', { limit_id: 'storageBytes', limit: 5_368_709_120, used: 5_368_709_120 }));
    renderFiles();
    await settled();

    fireEvent.change(screen.getByLabelText('Files to upload'), { target: { files: [csv()] } });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No storage left for the sponsor (402 · storage_quota_exceeded). 5 GiB of 5 GiB used. This limit doesn’t renew; delete files or ask for more room. Nothing was stored.');
    expect(within(alert).getByRole('link', { name: 'See your plan' })).toHaveAttribute('href', '/app/account/usage');
  });

  it('says a file is too large for the plan (413) when the gateway refuses it', async () => {
    platform.uploadArtifact.mockRejectedValue(refusal(413, 'artifact_too_large'));
    renderFiles();
    await settled();

    fireEvent.change(screen.getByLabelText('Files to upload'), { target: { files: [csv()] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('That file is bigger than your plan allows per upload (128 MiB on the RESEARCH plan) (413 · artifact_too_large). Nothing was stored.');
  });

  it('does not send a file that is over the plan’s ceiling', async () => {
    renderFiles();
    await settled();
    const big = csv();
    Object.defineProperty(big, 'size', { value: 200 * 1024 * 1024 });

    fireEvent.change(screen.getByLabelText('Files to upload'), { target: { files: [big] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('“results.csv” is 200 MiB, more than your plan allows per upload (128 MiB on the RESEARCH plan). Nothing was stored.');
    expect(platform.uploadArtifact).not.toHaveBeenCalled();
  });

  it('turns read-only for a key that cannot write, and still lets files be downloaded', async () => {
    platform.uploadArtifact.mockRejectedValue(refusal(403, 'forbidden'));
    renderFiles();
    await settled();

    fireEvent.change(screen.getByLabelText('Files to upload'), { target: { files: [csv()] } });

    expect(await screen.findByText('This account or API key can’t write files (403 · forbidden). You can still list and download.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Files to upload')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Download ${ARCHIVE}` })).toBeEnabled();
  });

  it('downloads a file under a name made from its fingerprint', async () => {
    const bytes = new ArrayBuffer(8);
    platform.downloadArtifact.mockResolvedValue(bytes);
    renderFiles();
    await settled();

    fireEvent.click(screen.getByRole('button', { name: `Download ${ARCHIVE}` }));

    await waitFor(() => expect(download.saveBytes).toHaveBeenCalledWith(bytes, 'sha256-aaaaaaaaaaaa.zip', 'application/zip'));
    expect(platform.downloadArtifact).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', digestOf('a'));
    expect(await screen.findByRole('button', { name: `Download ${ARCHIVE}` })).toHaveTextContent('Downloaded');
  });

  it('copies a fingerprint', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderFiles();
    await settled();

    fireEvent.click(screen.getByRole('button', { name: `Copy fingerprint of ${ARCHIVE}` }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(digestOf('a')));
    expect(await screen.findByRole('button', { name: `Copy fingerprint of ${ARCHIVE}` })).toHaveTextContent('copied');
  });

  it('describes what is inside a ZIP without opening it', async () => {
    const zip = new JSZip();
    zip.file('package/manifest.json', '{}');
    zip.file('cases/checkout.json', '{}');
    platform.downloadArtifact.mockResolvedValue(await zip.generateAsync({ type: 'arraybuffer' }));
    renderFiles();
    await settled();

    fireEvent.click(screen.getByRole('button', { name: `Look inside ${ARCHIVE}` }));

    const dialog = await screen.findByRole('dialog', { name: `Inside ${ARCHIVE}` });
    const list = await within(dialog).findByRole('list', { name: 'Files in the archive' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('package/manifest.json')).toBeInTheDocument();
    expect(within(dialog).getByText('Files in an archive are described here, not opened. Download the archive to read them.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Look inside / })).toHaveLength(1);
  });

  it('deletes a file for an ADMIN after asking', async () => {
    platform.deleteArtifact.mockResolvedValue(undefined);
    renderFiles(admin);
    await settled();

    fireEvent.click(screen.getByRole('button', { name: `Delete ${ARCHIVE}` }));
    const dialog = await screen.findByRole('dialog', { name: `Delete ${ARCHIVE}?` });
    platform.artifacts.mockResolvedValue([results]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));

    expect(await screen.findByText(`“${ARCHIVE}” deleted.`)).toBeInTheDocument();
    expect(platform.deleteArtifact).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', digestOf('a'));
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Files' })).getAllByRole('row')).toHaveLength(2));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the dialog open and says why when a file cannot be deleted (409)', async () => {
    platform.deleteArtifact.mockRejectedValue(refusal(409, 'in_use'));
    renderFiles(admin);
    await settled();

    fireEvent.click(screen.getByRole('button', { name: `Delete ${ARCHIVE}` }));
    const dialog = await screen.findByRole('dialog', { name: `Delete ${ARCHIVE}?` });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(`“${ARCHIVE}” is used by a sealed version, so it can’t be deleted (409 · in_use).`);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('lists what still uses a file that cannot be deleted (409 blob_in_use)', async () => {
    platform.deleteArtifact.mockRejectedValue(Object.assign(refusal(409, 'blob_in_use'), {
      problem: { code: 'blob_in_use', detail: { code: 'blob_in_use', error: 'in use', references: [{ type: 'library_version', count: 2 }, { type: 'report', count: 1 }] } },
    }));
    renderFiles(admin);
    await settled();

    fireEvent.click(screen.getByRole('button', { name: `Delete ${ARCHIVE}` }));
    const dialog = await screen.findByRole('dialog', { name: `Delete ${ARCHIVE}?` });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete file' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(`“${ARCHIVE}” is used by 2 library versions and 1 report, so it can’t be deleted (409 · blob_in_use).`);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows a visitor of a public project the public files only: no storage, no upload, no delete, no package', async () => {
    platform.project.mockResolvedValue({ ...qos, organization_id: 'org-open', created_by_id: null, access: 'public_read', effective_role: null });
    platform.artifacts.mockResolvedValue([results]);
    renderProjectScreen(<ProjFiles />, { path: '/app/:org/:project/files', url: '/app/open-lab/qos-benchmarks/files', organizations: [member] });

    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getByText('You are viewing a public project (read-only).')).toBeInTheDocument();
    expect(screen.queryByText('Drop files to upload')).not.toBeInTheDocument();
    expect(screen.queryByRole('meter', { name: 'Storage used' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Storage · sponsored by/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Export or import a package' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Download / })).toBeInTheDocument();
    expect(screen.getByText('Only the files this project has made public are listed. Anyone can download them.')).toBeInTheDocument();
  });

  it('gives a MEMBER the upload and no delete', async () => {
    renderFiles(member);
    await settled();

    expect(screen.getByText('Drop files to upload')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
  });

  it('gives a VIEWER the list and the downloads only', async () => {
    renderFiles(viewer);
    await settled();

    expect(screen.queryByText('Drop files to upload')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Download ${ARCHIVE}` })).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('You’re a VIEWER. You can download files; uploading needs MEMBER and deleting needs ADMIN.');
  });

  it('explains an empty project', async () => {
    platform.artifacts.mockResolvedValue([]);
    renderFiles();

    expect(await screen.findByText('No files yet')).toBeInTheDocument();
    expect(screen.getByText(/Upload a result or a dataset\./)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('keeps the page and offers a retry when the list fails', async () => {
    platform.artifacts.mockRejectedValueOnce(refusal(503, 'unavailable'));
    renderFiles();

    expect(await screen.findByText('The files couldn’t be loaded (503 · unavailable).')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('says a forbidden key cannot list the files, with no retry', async () => {
    platform.artifacts.mockRejectedValue(refusal(403, 'forbidden'));
    renderFiles();

    expect(await screen.findByText('This account or API key can’t list this project’s files (403 · forbidden).')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('reads a project that is not there like one the account is not in', async () => {
    platform.project.mockRejectedValue(refusal(404, 'not_found'));
    renderFiles();

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(platform.artifacts).not.toHaveBeenCalled();
  });
});
