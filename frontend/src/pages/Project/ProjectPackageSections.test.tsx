import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { saveBytes } from './download';
import { CASE_DIGESTS, BODY_MARKER, samplePackage } from './packageFixture';
import { ProjectSettings } from './ProjectSettings';
import { caseOf, ensureSubtleCrypto, org, project, renderProjectScreen, revisionOf, usageWithProjects } from './testKit';

const api = vi.hoisted(() => ({ getOwnUsage: vi.fn(), getPricingCatalog: vi.fn() }));
const platform = vi.hoisted(() => ({
  project: vi.fn(), exportPackage: vi.fn(), importPackage: vi.fn(), cases: vi.fn(), revisions: vi.fn(), studies: vi.fn(), studyRuns: vi.fn(),
  artifacts: vi.fn(),
}));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('./download', () => ({ saveBytes: vi.fn() }));

beforeAll(ensureSubtleCrypto);

const group = org('isa-demo', { name: 'ISA Demo Group' });
const viewing = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const flujo = caseOf('flujo', 'Flujo de checkout');

const refusal = (status: number, code: string, message = 'refused') => Object.assign(new HttpError(status, message), { code });

function renderSettings(slug = 'isa-demo') {
  return renderProjectScreen(<ProjectSettings />, {
    path: '/app/:org/:project/settings/:section?', url: `/app/${slug}/qos-benchmarks/settings`, organizations: [group, viewing],
  });
}

async function chooseJson(pkg: Record<string, unknown>, name = 'qos.openbinding.json') {
  const file = new File([JSON.stringify(pkg)], name, { type: 'application/json' });
  const input = await screen.findByLabelText('Package file');
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

const importCard = () => screen.getByRole('region', { name: 'Import package' });

describe('Export package and Import package in the General section of the project settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.cases.mockResolvedValue([flujo]);
    platform.revisions.mockResolvedValue([revisionOf(flujo, 1), revisionOf(flujo, 2)]);
    platform.studies.mockResolvedValue([]);
    platform.studyRuns.mockResolvedValue([]);
    platform.artifacts.mockResolvedValue([]);
    platform.exportPackage.mockResolvedValue(new TextEncoder().encode(BODY_MARKER).buffer);
    platform.importPackage.mockResolvedValue({ imported: { cases: 1, caseRevisions: 2 }, packageDigest: 'sha256-x' });
    api.getOwnUsage.mockResolvedValue(usageWithProjects());
    api.getPricingCatalog.mockResolvedValue({});
  });

  it('holds both sections for someone who may change the project', async () => {
    renderSettings();

    expect(await screen.findByRole('heading', { level: 2, name: 'Export package' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Import package' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Portable package' })).not.toBeInTheDocument();
  });

  it('shows neither to someone who may not change the project, and a visitor gets the neutral gate', async () => {
    platform.project.mockResolvedValue({ ...qos, organization_id: viewing.id });
    const viewer = renderSettings('read-lab');

    await screen.findByRole('heading', { level: 1, name: 'Project settings' });
    expect(screen.queryByRole('heading', { name: 'Export package' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Import package' })).not.toBeInTheDocument();
    viewer.unmount();

    platform.project.mockResolvedValue({ ...qos, organization_id: 'org-open', created_by_id: null, access: 'public_read', effective_role: null });
    renderSettings('open-lab');

    expect(await screen.findByRole('heading', { name: 'Members only' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Export package' })).not.toBeInTheDocument();
    expect(platform.exportPackage).not.toHaveBeenCalled();
  });

  describe('export', () => {
    it('asks for the ZIP by default, downloads it and never shows its content', async () => {
      renderSettings();
      fireEvent.click(await screen.findByRole('button', { name: 'Export package' }));

      await waitFor(() => expect(platform.exportPackage).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'zip'));
      await waitFor(() => expect(saveBytes).toHaveBeenCalledWith(expect.anything(), 'qos-benchmarks.openbinding.zip', 'application/zip'));
      expect(await screen.findByText('Downloaded qos-benchmarks.openbinding.zip.')).toBeInTheDocument();
      expect(document.body.textContent).not.toContain(BODY_MARKER);
    });

    it('downloads the file of the chosen format', async () => {
      renderSettings();
      const format = await screen.findByRole('combobox', { name: 'Format' });
      expect(format).toHaveValue('zip');
      fireEvent.change(format, { target: { value: 'json' } });
      fireEvent.click(screen.getByRole('button', { name: 'Export package' }));

      await waitFor(() => expect(platform.exportPackage).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'json'));
      await waitFor(() => expect(saveBytes).toHaveBeenCalledWith(expect.anything(), 'qos-benchmarks.openbinding.json', 'application/json'));
      expect(await screen.findByText('Downloaded qos-benchmarks.openbinding.json.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Export again' })).toBeInTheDocument();
    });

    it('says why an export failed', async () => {
      platform.exportPackage.mockRejectedValue(refusal(403, 'forbidden'));
      renderSettings();
      fireEvent.click(await screen.findByRole('button', { name: 'Export package' }));

      expect(await screen.findByText('Your credential can’t read this project (403 · forbidden), so nothing was exported.')).toBeInTheDocument();
      expect(saveBytes).not.toHaveBeenCalled();
    });
  });

  describe('import', () => {
    it('states the ceiling of the plan', async () => {
      renderSettings();

      expect(await screen.findByText('ZIP, JSON or YAML package · up to 128 MiB on your plan')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Choose package' })).toBeEnabled();
    });

    it('checks the fingerprints on this device, shows the report, and imports only after confirming', async () => {
      platform.cases.mockResolvedValue([]);
      renderSettings();
      const file = await chooseJson(await samplePackage());

      const report = await screen.findByRole('list', { name: 'Import verification report' });
      expect(within(importCard()).getByText('2 verified')).toBeInTheDocument();
      expect(within(importCard()).getByText('0 already here · reused')).toBeInTheDocument();
      expect(within(importCard()).getByText('2 new')).toBeInTheDocument();
      expect(report.textContent).not.toMatch(/sha256-|[0-9a-f]{12}/);
      const rows = within(report).getAllByRole('listitem');
      expect(rows).toHaveLength(4);
      expect(within(rows[0]).getByText('Package manifest')).toBeInTheDocument();
      expect(within(rows[1]).getByText('Flujo de checkout · version 1')).toBeInTheDocument();
      expect(within(rows[1]).getByText('Will be added')).toBeInTheDocument();
      expect(within(rows[3]).getByText('Verified')).toBeInTheDocument();
      expect(platform.importPackage).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain(BODY_MARKER);

      fireEvent.click(screen.getByRole('button', { name: 'Import into QoS Benchmarks' }));

      await waitFor(() => expect(platform.importPackage).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', file, 'json'));
      const done = await screen.findByText('Import complete');
      expect(done.parentElement).toHaveTextContent('3 items added (1 problems, 2 problem versions).');
      expect(screen.getByRole('link', { name: 'Back to the project' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks');
    });

    it('recognises what is already in the project and reuses it', async () => {
      platform.revisions.mockResolvedValue([revisionOf(flujo, 1, { digest: CASE_DIGESTS[0] }), revisionOf(flujo, 2, { digest: CASE_DIGESTS[1] })]);
      renderSettings();
      await chooseJson(await samplePackage());

      expect(await screen.findByText('2 already here · reused')).toBeInTheDocument();
      expect(within(importCard()).getAllByText('Already here')).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: 'Import into QoS Benchmarks' }));
      expect(await screen.findByText(/2 matched what was already here\./)).toBeInTheDocument();
    });

    it('refuses a package whose fingerprint does not match, and sends nothing', async () => {
      renderSettings();
      await chooseJson(await samplePackage({ tamperAfterSealing: true }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Fingerprint doesn’t match');
      expect(alert).toHaveTextContent('The file was changed or damaged after export; nothing was imported.');
      expect(platform.importPackage).not.toHaveBeenCalled();
      fireEvent.click(within(alert).getByRole('button', { name: 'Choose another package' }));
      expect(await screen.findByText('Drop a package here')).toBeInTheDocument();
    });

    it('refuses a name already used with different content', async () => {
      platform.revisions.mockResolvedValue([revisionOf(flujo, 1, { digest: CASE_DIGESTS[0] }), revisionOf(flujo, 2, { digest: `sha256-${'9'.repeat(64)}` })]);
      renderSettings();
      await chooseJson(await samplePackage());

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Name already used with different content');
      expect(alert).toHaveTextContent('“Flujo de checkout · version 2” exists in this project with a different fingerprint.');
      expect(platform.importPackage).not.toHaveBeenCalled();
    });

    it('refuses a file bigger than the ceiling before sending it', async () => {
      renderSettings();
      const file = new File(['{}'], 'huge.json', { type: 'application/json' });
      Object.defineProperty(file, 'size', { value: 200 * 1024 * 1024 });
      fireEvent.change(await screen.findByLabelText('Package file'), { target: { files: [file] } });

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Package too large');
      expect(alert).toHaveTextContent('Nothing was sent.');
      expect(platform.importPackage).not.toHaveBeenCalled();
    });

    it('leaves a YAML package to the gateway and says so', async () => {
      renderSettings();
      const file = new File(['apiVersion: openbinding.dev/package/v1\n'], 'qos.openbinding.yaml', { type: 'application/yaml' });
      fireEvent.change(await screen.findByLabelText('Package file'), { target: { files: [file] } });

      expect(await screen.findByText(/This page can’t open this package/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Import into QoS Benchmarks' }));
      await waitFor(() => expect(platform.importPackage).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', file, 'yaml'));
    });

    it('leaves a ZIP this page cannot open to the gateway, which receives it as a ZIP', async () => {
      renderSettings();
      const file = new File([new Uint8Array([0x50, 0x4b, 0x05, 0x06])], 'qos.openbinding.zip', { type: 'application/zip' });
      fireEvent.change(await screen.findByLabelText('Package file'), { target: { files: [file] } });

      fireEvent.click(await screen.findByRole('button', { name: 'Import into QoS Benchmarks' }));
      await waitFor(() => expect(platform.importPackage).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', file, 'zip'));
    });

    describe('when the gateway refuses', () => {
      async function importAndRefuse(error: unknown) {
        platform.importPackage.mockRejectedValue(error);
        renderSettings();
        await chooseJson(await samplePackage());
        fireEvent.click(await screen.findByRole('button', { name: 'Import into QoS Benchmarks' }));
        return screen.findByRole('alert');
      }

      it('409: unpublished items from another organization', async () => {
        const alert = await importAndRefuse(refusal(409, 'private_dependency'));
        expect(alert).toHaveTextContent('Unpublished items from another organization (409 · private_dependency)');
      });

      it('409: an identity collision', async () => {
        const alert = await importAndRefuse(refusal(409, 'case_identity_conflict'));
        expect(alert).toHaveTextContent('Name already used with different content (409 · case_identity_conflict)');
      });

      it('409: an engine or compilation this deployment does not have', async () => {
        const alert = await importAndRefuse(refusal(409, 'toolchain_mismatch'));
        expect(alert).toHaveTextContent('Engine revision not available here (409 · toolchain_mismatch)');
      });

      it('422: a fingerprint the gateway recomputed', async () => {
        const alert = await importAndRefuse(refusal(422, 'checksum_mismatch', 'An artifact digest or size does not match its content.'));
        expect(alert).toHaveTextContent('Fingerprint doesn’t match (422 · checksum_mismatch)');
        expect(alert).toHaveTextContent('An artifact digest or size does not match its content.');
      });

      it('413: too large for the plan', async () => {
        const alert = await importAndRefuse(refusal(413, 'package_too_large'));
        expect(alert).toHaveTextContent('Package too large (413 · package_too_large)');
      });

      it('403: a key without permission turns importing off, and export still works', async () => {
        const alert = await importAndRefuse(refusal(403, 'forbidden'));
        expect(alert).toHaveTextContent('This account or API key can’t import (403 · forbidden)');
        fireEvent.click(within(alert).getByRole('button', { name: 'Choose another package' }));

        expect(await within(importCard()).findByRole('note')).toHaveTextContent('This account or API key can’t write projects and artifacts (403), so importing is off. Export still works.');
        expect(screen.getByRole('button', { name: 'Choose package' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Export package' })).toBeEnabled();
      });
    });
  });
});
