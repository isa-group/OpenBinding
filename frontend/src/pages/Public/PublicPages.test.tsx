import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError, type PackageValidationOutcome } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { zipStore } from '../../utils/bimZip';
import { WorkbenchPage } from './PublicPages';

const api = vi.hoisted(() => ({ getBimExamples: vi.fn(), getBimExamplePackage: vi.fn(), validatePackage: vi.fn() }));
const platform = vi.hoisted(() => ({ organizations: vi.fn(), projects: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));
vi.mock('../../api/platform', () => ({ platformApi: platform }));

const D = (seed: string) => `sha256-${seed.repeat(8)}`;

const files = {
  'instance.json': {
    kind: 'Instance',
    metadata: { name: 'checkout' },
    spec: { profile: 'qos-binding/v1', resources: { application: { application: 'application.json' }, candidateCatalog: { catalog: 'candidates.json' } } },
  },
  'application.json': {
    kind: 'Application',
    spec: {
      tasks: { t1: 'service/auth', t2: 'service/stock', t3: 'service/pay' },
      features: { latency: { unit: 'ms' } },
      workflow: { sequence: [{ task: { resource: 'application', id: 't1' } }, { task: { resource: 'application', id: 't2' } }, { task: { resource: 'application', id: 't3' } }] },
    },
  },
  'candidates.json': {
    kind: 'CandidateCatalog',
    spec: { candidates: { a: { provides: 'service/auth', features: { latency: 10 } }, b: { provides: 'service/stock', features: { latency: 20 } }, c: { provides: 'service/pay', features: { latency: 7 } } } },
  },
};

function packageBytes(): Uint8Array {
  return zipStore(Object.fromEntries(Object.entries(files).map(([path, value]) => [path, JSON.stringify(value)])));
}

function asFile(bytes: Uint8Array, name = 'checkout.bim.zip'): File {
  const file = new File([bytes.slice().buffer], name, { type: 'application/zip' });
  // The environment's File may predate Blob.arrayBuffer.
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer });
  return file;
}

const valid: PackageValidationOutcome = {
  valid: true,
  result: { valid: true, instanceDigest: D('a1b2c3d4'), packageDigest: D('b2c3d4e5'), irDigest: D('c3d4e5f6'), fileDigests: { 'candidates.json': D('11223344') }, resourceDigests: {}, diagnostics: [] },
};

const invalid: PackageValidationOutcome = {
  valid: false,
  refusal: {
    status: 422,
    code: 'invalid_request',
    message: 'The package is invalid.',
    diagnostics: [{
      code: 'missing_metric',
      resource: 'candidateCatalog',
      pointer: '/spec/candidates/1/features/latency',
      message: 'Candidate 2 does not declare latency, required by the optimization.',
      fix: 'Add a finite value in ms.',
    }],
  },
};

const lucia: UserProfile = { id: 'u', username: 'lucia', email: 'l@example.test', role: 'user', is_active: true, plan: 'RESEARCH', created_at: '2026-01-01T00:00:00Z' };

function renderPage(path = '/workbench', user: UserProfile | null = null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}>
        <WorkbenchPage />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

async function choose(file: File) {
  fireEvent.change(screen.getByLabelText('Package file'), { target: { files: [file] } });
  await screen.findByText(file.name);
}

describe('public workbench', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getBimExamples.mockResolvedValue(['demo/01_simple_seq', 'demo/02_parallel', 'placement/01_small_placement', 'literature/zhang']);
    api.validatePackage.mockResolvedValue(valid);
  });

  it('invites a visitor to choose a package, shows the limits and asks them to log in to run', async () => {
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Workbench' })).toBeInTheDocument();
    expect(screen.getByLabelText('Package limits')).toHaveTextContent('≤ 16 MiB compressed');
    expect(screen.getByLabelText('Package limits')).toHaveTextContent('≤ 64 MiB expanded');
    expect(screen.getByLabelText('Package limits')).toHaveTextContent('≤ 256 entries');
    expect(screen.getByText('No package yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in to run' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/register');
    expect(screen.getByRole('link', { name: 'Browse official examples' })).toHaveAttribute('href', '/examples');
    expect(screen.getByRole('navigation', { name: 'Language sections' })).toHaveTextContent('Workbench');
    expect(await screen.findByRole('button', { name: /demo\/01_simple_seq/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Official example package/ })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Validate package' })).not.toBeInTheDocument();
  });

  it('validates an uploaded package: verdict, digests, files and tables', async () => {
    const bytes = packageBytes();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    await choose(asFile(bytes));
    expect(screen.getByText(/\.bim\.zip$/, { selector: 'small' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Validate package' }));

    expect(await screen.findByText('Valid package')).toBeInTheDocument();
    expect(api.validatePackage).toHaveBeenCalledTimes(1);
    expect(api.validatePackage.mock.calls[0][0]).toEqual(bytes);
    expect(screen.getByText('checkout.bim.zip · profile qos-binding/v1 · 3 tasks')).toBeInTheDocument();
    const digests = document.querySelector('.workbench-digests') as HTMLElement;
    expect(digests).toHaveTextContent('Instance digest');
    expect(digests).toHaveTextContent('sha256-a1b2…c3d4');
    fireEvent.click(within(digests).getByRole('button', { name: 'Copy ir digest' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(D('c3d4e5f6')));

    expect(screen.getByRole('tab', { name: 'Structure' })).toHaveAttribute('aria-selected', 'true');
    const filesCard = screen.getByRole('region', { name: 'Package files' });
    expect(filesCard).toHaveTextContent('candidates.json');
    expect(filesCard).toHaveTextContent('Candidate catalog');
    expect(filesCard).toHaveTextContent('sha256-1122…3344');
    const workflow = screen.getByRole('region', { name: 'Workflow' });
    expect(workflow).toHaveTextContent('SEQUENCE');
    expect(workflow).toHaveTextContent('Binding space ≈ 100.0 combinations');
    const tasks = screen.getByRole('region', { name: 'Choices per task' });
    expect(within(tasks).getByRole('row', { name: /t1 service\/auth 1 latency 10–10 ms/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Diagnostics (0)' }));
    expect(screen.getByText('No diagnostics. Every resource passed validation.')).toBeInTheDocument();
  });

  it('turns diagnostics into grouped, located problems that lead back to the file', async () => {
    api.validatePackage.mockResolvedValue(invalid);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    await choose(asFile(packageBytes()));
    fireEvent.click(screen.getByRole('button', { name: 'Validate package' }));

    expect(await screen.findByText('Not valid · 1 error')).toBeInTheDocument();
    expect(screen.getByText('422 invalid_request. Each diagnostic points at the resource and location to fix.')).toBeInTheDocument();
    expect(screen.queryByText('Instance digest')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Diagnostics (1)' })).toHaveAttribute('aria-selected', 'true');
    const group = screen.getByRole('region', { name: 'Problems in Candidate catalog · candidates.json' });
    expect(group).toHaveTextContent('ERROR');
    expect(group).toHaveTextContent('missing_metric');
    expect(group).toHaveTextContent('candidates › item 2 › features › latency');
    expect(group).toHaveTextContent('Candidate 2 does not declare latency, required by the optimization.');
    expect(group).toHaveTextContent('Fix: Add a finite value in ms.');
    fireEvent.click(within(group).getByRole('button', { name: 'Copy location' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('candidates.json /spec/candidates/1/features/latency'));

    fireEvent.click(within(group).getByRole('button', { name: 'Show in package' }));
    expect(screen.getByRole('tab', { name: 'Structure' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/The package did not validate/)).toBeInTheDocument();
    await waitFor(() => expect(document.getElementById('wb-file-candidates.json')).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: '1 problem' }));
    expect(screen.getByRole('tab', { name: 'Diagnostics (1)' })).toHaveAttribute('aria-selected', 'true');
  });

  it('explains a package that is too large (413)', async () => {
    api.validatePackage.mockRejectedValue(new HttpError(413, 'too large'));
    renderPage();
    await choose(asFile(packageBytes()));
    fireEvent.click(screen.getByRole('button', { name: 'Validate package' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The package is too large (413 · payload_too_large)');
    expect(alert).toHaveTextContent('up to 16 MiB compressed, 64 MiB expanded and 256 entries');
    expect(alert).toHaveTextContent('your plan sets its own payload ceiling');
  });

  it('asks to wait on a rate limit (429) and keeps the file for another try', async () => {
    const limited = new HttpError(429, 'slow down');
    limited.retryAfter = 5;
    api.validatePackage.mockRejectedValueOnce(limited);
    renderPage();
    await choose(asFile(packageBytes()));
    fireEvent.click(screen.getByRole('button', { name: 'Validate package' }));

    expect(await screen.findByText('Too many validations right now (429).')).toBeInTheDocument();
    expect(screen.getByText(/Try again in 5 s\. Your file is still selected\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Valid package')).toBeInTheDocument();
    expect(api.validatePackage).toHaveBeenCalledTimes(2);
  });

  it('reports a gateway failure and offers a retry', async () => {
    api.validatePackage.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    renderPage();
    await choose(asFile(packageBytes()));
    fireEvent.click(screen.getByRole('button', { name: 'Validate package' }));

    expect(await screen.findByText('Validation is unavailable right now (HTTP 503)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Valid package')).toBeInTheDocument();
  });

  it('does not upload a file that is not a readable package', async () => {
    renderPage();
    await choose(asFile(new TextEncoder().encode('this is not a zip archive at all'), 'notes.bim.zip'));
    fireEvent.click(screen.getByRole('button', { name: 'Validate package' }));

    expect(await screen.findByText('This file can’t be read as a BIM package')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('not a complete ZIP archive');
    expect(api.validatePackage).not.toHaveBeenCalled();
  });

  it('opens an official example from the address and validates it', async () => {
    api.getBimExamplePackage.mockResolvedValue(packageBytes().slice().buffer);
    renderPage('/workbench?example=demo%2F01_simple_seq');

    expect(await screen.findByText('Valid package')).toBeInTheDocument();
    expect(api.getBimExamplePackage).toHaveBeenCalledWith('demo/01_simple_seq');
    expect(screen.getByText('01_simple_seq.bim.zip')).toBeInTheDocument();
    expect(api.validatePackage).toHaveBeenCalledTimes(1);
  });

  it('says so when an example from the address cannot be loaded', async () => {
    api.getBimExamplePackage.mockRejectedValue(new HttpError(422, 'invalid_example'));
    renderPage('/workbench?example=demo%2Fbroken');
    expect(await screen.findByText(/This example package is corrupt \(422 · invalid_example\)/)).toBeInTheDocument();
    expect(screen.getByText('No package yet')).toBeInTheDocument();
  });

  it('removes the selected file', async () => {
    renderPage();
    await choose(asFile(packageBytes()));
    expect(screen.getByText('Ready to validate')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove file' }));
    expect(screen.getByText('No package yet')).toBeInTheDocument();
    expect(screen.queryByText('checkout.bim.zip')).not.toBeInTheDocument();
  });

  it('offers a signed-in account the project actions instead of the login prompt', async () => {
    platform.organizations.mockResolvedValue([{ id: 'o', slug: 'isa-demo', name: 'ISA Demo Group' }]);
    platform.projects.mockResolvedValue([{ id: 'p', slug: 'qos', name: 'QoS Benchmarks' }]);
    api.getBimExamplePackage.mockResolvedValue(packageBytes().slice().buffer);
    renderPage('/workbench?example=demo%2F01_simple_seq', lucia);

    expect(await screen.findByText('Signed in as lucia')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Log in to run' })).not.toBeInTheDocument();
    await screen.findByText('Valid package');
    fireEvent.click(screen.getByRole('button', { name: 'Save to a project' }));
    expect(await screen.findByRole('link', { name: 'ISA Demo Group / QoS Benchmarks' })).toHaveAttribute('href', '/app/isa-demo/qos/workbench?example=demo%2F01_simple_seq');
  });
});
