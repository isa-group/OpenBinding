import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { saveBytes } from './download';
import { CASE_DIGESTS, REPORT_MARKER, samplePackage } from './packageFixture';
import { ProjectPackage } from './ProjectPackage';
import { caseOf, ensureSubtleCrypto, org, project, renderProjectScreen, revisionOf, usageWithProjects } from './testKit';

const api = vi.hoisted(() => ({ getOwnUsage: vi.fn(), getPricingCatalog: vi.fn() }));
const platform = vi.hoisted(() => ({
  project: vi.fn(), exportPackage: vi.fn(), importPackage: vi.fn(), cases: vi.fn(), revisions: vi.fn(), studies: vi.fn(), studyRuns: vi.fn(),
  reports: vi.fn(), publications: vi.fn(), artifacts: vi.fn(), publicProjects: vi.fn(),
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

function renderPackage(slug = 'isa-demo') {
  return renderProjectScreen(<ProjectPackage />, {
    path: '/app/:org/:project/package', url: `/app/${slug}/qos-benchmarks/package`, organizations: [group, viewing],
  });
}

async function chooseJson(pkg: Record<string, unknown>, name = 'qos.openbinding.json') {
  const file = new File([JSON.stringify(pkg)], name, { type: 'application/json' });
  const input = await screen.findByLabelText('Package file');
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

const importCard = () => screen.getByRole('region', { name: 'Import' });

describe('Project package', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.cases.mockResolvedValue([flujo]);
    platform.revisions.mockResolvedValue([revisionOf(flujo, 1), revisionOf(flujo, 2)]);
    platform.studies.mockResolvedValue([]);
    platform.studyRuns.mockResolvedValue([]);
    platform.reports.mockResolvedValue([]);
    platform.publications.mockResolvedValue([]);
    platform.artifacts.mockResolvedValue([]);
    platform.publicProjects.mockResolvedValue([]);
    platform.exportPackage.mockResolvedValue(new TextEncoder().encode(REPORT_MARKER).buffer);
    platform.importPackage.mockResolvedValue({ imported: { cases: 1, caseRevisions: 2 }, packageDigest: 'sha256-x' });
    api.getOwnUsage.mockResolvedValue(usageWithProjects());
    api.getPricingCatalog.mockResolvedValue({});
  });

  it('frames the page and says what goes in and what stays behind', async () => {
    renderPackage();

    expect(await screen.findByRole('heading', { level: 1, name: 'Portable package' })).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(tabs).getByRole('link', { name: 'Package' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Package');
    expect(await screen.findByText('case with 2 sealed revisions')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What goes in' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What stays behind' })).toBeInTheDocument();
    expect(screen.getByText('People and roles')).toBeInTheDocument();
    expect(screen.getByText('Job history')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Known limits' })).toBeInTheDocument();
  });

  describe('export', () => {
    it('downloads the file of the chosen type and never shows its content', async () => {
      renderPackage();
      const formats = await screen.findByRole('group', { name: 'File type' });
      expect(within(formats).getByRole('radio', { name: /ZIP archive/ })).toBeChecked();
      fireEvent.click(within(formats).getByRole('radio', { name: /Single JSON file/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Export package' }));

      await waitFor(() => expect(platform.exportPackage).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', 'json'));
      await waitFor(() => expect(saveBytes).toHaveBeenCalledWith(expect.anything(), 'qos-benchmarks.openbinding.json', 'application/json'));
      expect(await screen.findByText('Downloaded qos-benchmarks.openbinding.json.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Export again' })).toBeInTheDocument();
      expect(document.body.textContent).not.toContain(REPORT_MARKER);
    });

    it('says why an export failed', async () => {
      platform.exportPackage.mockRejectedValue(refusal(403, 'forbidden'));
      renderPackage();
      fireEvent.click(await screen.findByRole('button', { name: 'Export package' }));

      expect(await screen.findByText('Your credential can’t read this project (403 · forbidden), so nothing was exported.')).toBeInTheDocument();
      expect(saveBytes).not.toHaveBeenCalled();
    });

    it('is open to a VIEWER', async () => {
      platform.project.mockResolvedValue({ ...qos, organization_id: viewing.id });
      renderPackage('read-lab');

      expect(await screen.findByRole('button', { name: 'Export package' })).toBeEnabled();
    });
  });

  describe('import', () => {
    it('states the ceiling of the plan', async () => {
      renderPackage();

      expect(await screen.findByText('ZIP, JSON or YAML package · up to 128 MiB on your plan')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Choose package' })).toBeEnabled();
    });

    it('checks the fingerprints on this device, shows the report, and imports only after confirming', async () => {
      platform.cases.mockResolvedValue([]);
      renderPackage();
      const file = await chooseJson(await samplePackage());

      const report = await screen.findByRole('list', { name: 'Import verification report' });
      expect(within(importCard()).getByText('3 verified')).toBeInTheDocument();
      expect(within(importCard()).getByText('0 already here · reused')).toBeInTheDocument();
      expect(within(importCard()).getByText('2 new')).toBeInTheDocument();
      const rows = within(report).getAllByRole('listitem');
      expect(rows).toHaveLength(5);
      expect(within(rows[0]).getByText('Package manifest')).toBeInTheDocument();
      expect(within(rows[1]).getByText('Flujo de checkout · revision 1')).toBeInTheDocument();
      expect(within(rows[1]).getByText('Will be added')).toBeInTheDocument();
      expect(within(rows[3]).getByText('Verified')).toBeInTheDocument();
      expect(platform.importPackage).not.toHaveBeenCalled();
      expect(document.body.textContent).not.toContain(REPORT_MARKER);

      fireEvent.click(screen.getByRole('button', { name: 'Import into QoS Benchmarks' }));

      await waitFor(() => expect(platform.importPackage).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', file, 'json'));
      const done = await screen.findByText('Import complete');
      expect(done.parentElement).toHaveTextContent('3 items added (1 cases, 2 case revisions).');
      expect(screen.getByRole('link', { name: 'Back to the project' })).toHaveAttribute('href', '/app/isa-demo/qos-benchmarks');
    });

    it('recognises what is already in the project and reuses it', async () => {
      platform.revisions.mockResolvedValue([revisionOf(flujo, 1, { digest: CASE_DIGESTS[0] }), revisionOf(flujo, 2, { digest: CASE_DIGESTS[1] })]);
      renderPackage();
      await chooseJson(await samplePackage());

      expect(await screen.findByText('2 already here · reused')).toBeInTheDocument();
      expect(within(importCard()).getAllByText('Already here')).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: 'Import into QoS Benchmarks' }));
      expect(await screen.findByText(/2 matched what was already here\./)).toBeInTheDocument();
    });

    it('refuses a package whose fingerprint does not match, and sends nothing', async () => {
      renderPackage();
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
      renderPackage();
      await chooseJson(await samplePackage());

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Name already used with different content');
      expect(alert).toHaveTextContent('“Flujo de checkout · revision 2” exists in this project with a different fingerprint.');
      expect(platform.importPackage).not.toHaveBeenCalled();
    });

    it('refuses a file bigger than the ceiling before sending it', async () => {
      renderPackage();
      const file = new File(['{}'], 'huge.json', { type: 'application/json' });
      Object.defineProperty(file, 'size', { value: 200 * 1024 * 1024 });
      fireEvent.change(await screen.findByLabelText('Package file'), { target: { files: [file] } });

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Package too large');
      expect(alert).toHaveTextContent('Nothing was sent.');
      expect(platform.importPackage).not.toHaveBeenCalled();
    });

    it('leaves a YAML package to the gateway and says so', async () => {
      renderPackage();
      const file = new File(['apiVersion: openbinding.dev/package/v1\n'], 'qos.openbinding.yaml', { type: 'application/yaml' });
      fireEvent.change(await screen.findByLabelText('Package file'), { target: { files: [file] } });

      expect(await screen.findByText(/A YAML package can’t be opened on this page/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Import into QoS Benchmarks' }));
      await waitFor(() => expect(platform.importPackage).toHaveBeenCalledWith('isa-demo', 'qos-benchmarks', file, 'yaml'));
    });

    describe('when the gateway refuses', () => {
      async function importAndRefuse(error: unknown) {
        platform.importPackage.mockRejectedValue(error);
        renderPackage();
        await chooseJson(await samplePackage());
        fireEvent.click(await screen.findByRole('button', { name: 'Import into QoS Benchmarks' }));
        return screen.findByRole('alert');
      }

      it('409: unpublished items from another organization', async () => {
        const alert = await importAndRefuse(refusal(409, 'unpublished_import'));
        expect(alert).toHaveTextContent('Unpublished items from another organization (409 · unpublished_import)');
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
        const alert = await importAndRefuse(refusal(422, 'checksum_mismatch', 'A report digest does not match its document.'));
        expect(alert).toHaveTextContent('Fingerprint doesn’t match (422 · checksum_mismatch)');
        expect(alert).toHaveTextContent('A report digest does not match its document.');
      });

      it('413: too large for the plan', async () => {
        const alert = await importAndRefuse(refusal(413, 'package_too_large'));
        expect(alert).toHaveTextContent('Package too large (413 · package_too_large)');
      });

      it('403: a key without permission turns importing off, and export still works', async () => {
        const alert = await importAndRefuse(refusal(403, 'forbidden'));
        expect(alert).toHaveTextContent('This account or API key can’t import (403 · forbidden)');
        fireEvent.click(within(alert).getByRole('button', { name: 'Choose another package' }));

        expect(await screen.findByRole('note')).toHaveTextContent('This account or API key can’t write projects and artifacts (403), so importing is off. Export still works.');
        expect(screen.getByRole('button', { name: 'Choose package' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Export package' })).toBeEnabled();
      });
    });
  });

  describe('as a VIEWER', () => {
    it('cannot import, is told why, and can still export', async () => {
      platform.project.mockResolvedValue({ ...qos, organization_id: viewing.id });
      renderPackage('read-lab');

      expect(await screen.findByRole('note')).toHaveTextContent('Importing needs MEMBER; you’re a VIEWER here. You can still export.');
      expect(screen.getByRole('button', { name: 'Choose package' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Export package' })).toBeEnabled();
    });
  });

  it('gives the neutral answer when the project is not there', async () => {
    platform.project.mockRejectedValue(refusal(404, 'not_found'));
    renderPackage();

    expect(await screen.findByRole('heading', { name: 'Project not found' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export package' })).not.toBeInTheDocument();
  });
});
