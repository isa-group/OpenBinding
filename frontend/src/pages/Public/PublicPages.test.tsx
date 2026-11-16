import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import type { BimDiagnostic, BimRefusal, BimValidateResponse } from '../../api/bim';
import { HttpError } from '../../api/client';
import { AuthContext } from '../../modules/auth/hooks/useAuth';
import refusedPackage from '../../test/fixtures/core/refused.package.json';
import refusedBody from '../../test/fixtures/core/refused.validate.json';
import simpleSeq from '../../test/fixtures/core/simple-seq.validate.json';
import { zipStore } from '../../utils/bimZip';
import { WorkbenchPage } from './PublicPages';

const api = vi.hoisted(() => ({ templates: vi.fn(), template: vi.fn(), validate: vi.fn() }));
const platform = vi.hoisted(() => ({ organizations: vi.fn() }));

vi.mock('../../api/bim', () => ({ bimApi: api }));
vi.mock('../../api/platform', () => ({ platformApi: platform }));

// The gateway's own answers (dump_frontend_fixtures.py): a valid package with its facts, and a refused package with the files it checked.
const valid = simpleSeq as unknown as BimValidateResponse;
const refusedFiles = refusedPackage as Record<string, string>;
const refused: BimRefusal = {
  valid: false,
  status: 422,
  code: refusedBody.code,
  message: refusedBody.detail,
  diagnostics: refusedBody.diagnostics as BimDiagnostic[],
};

const files = {
  'instance.json': {
    kind: 'Instance',
    metadata: { name: 'checkout' },
    spec: {
      profile: 'qos-binding/v1',
      resources: {
        application: { application: 'application.json' },
        candidateCatalog: { catalog: 'candidates.json' },
      },
    },
  },
  'application.json': { kind: 'Application', spec: { tasks: { t1: 'service/auth' } } },
  'candidates.json': {
    kind: 'CandidateCatalog',
    spec: { candidates: { a: { provides: 'service/auth', features: { latency: 10 } } } },
  },
};

function packageBytes(): Uint8Array {
  return zipStore(
    Object.fromEntries(Object.entries(files).map(([path, value]) => [path, JSON.stringify(value)]))
  );
}

function asFile(bytes: Uint8Array, name = 'checkout.bim.zip'): File {
  const file = new File([bytes.slice().buffer], name, { type: 'application/zip' });
  // The environment's File may predate Blob.arrayBuffer.
  Object.defineProperty(file, 'arrayBuffer', { value: async () => bytes.slice().buffer });
  return file;
}

const lucia: UserProfile = {
  id: 'u',
  username: 'lucia',
  email: 'l@example.test',
  role: 'user',
  is_active: true,
  plan: 'RESEARCH',
  created_at: '2026-01-01T00:00:00Z',
};

function renderPage(path = '/workbench', user: UserProfile | null = null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthContext.Provider
        value={{
          user,
          loading: false,
          signIn: vi.fn(),
          register: vi.fn(),
          signOut: vi.fn(),
          refresh: vi.fn(),
          isAdmin: false,
          fetchWithInterceptor: vi.fn(),
        }}
      >
        <WorkbenchPage />
      </AuthContext.Provider>
    </MemoryRouter>
  );
}

async function choose(file: File) {
  fireEvent.change(screen.getByLabelText('Package file'), { target: { files: [file] } });
  await screen.findByText(file.name);
}

describe('public workbench', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.templates.mockResolvedValue([
      'demo/01_simple_seq',
      'demo/02_parallel',
      'placement/01_small_placement',
      'literature/zhang',
    ]);
    api.validate.mockResolvedValue(valid);
  });

  it('invites a visitor to choose a package, shows the limits and asks them to log in to run', async () => {
    renderPage();

    expect(screen.getByRole('heading', { level: 1, name: 'Workbench' })).toBeInTheDocument();
    expect(screen.getByLabelText('Package limits')).toHaveTextContent('≤ 16 MiB compressed');
    expect(screen.getByLabelText('Package limits')).toHaveTextContent('≤ 64 MiB expanded');
    expect(screen.getByLabelText('Package limits')).toHaveTextContent('≤ 256 entries');
    expect(screen.getByText('No package yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Log in to run' })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute(
      'href',
      '/register'
    );
    expect(screen.queryByRole('navigation', { name: 'Language sections' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /demo\/01_simple_seq/ })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Template package/ })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Validate package' })).not.toBeInTheDocument();
  });

  it('validates an uploaded package and draws what the gateway compiled: counts, workflow, candidates and rules', async () => {
    const bytes = packageBytes();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();
    await choose(asFile(bytes));
    expect(screen.getByText(/\.bim\.zip$/, { selector: 'small' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Validate package' }));

    expect(await screen.findByText('Valid package')).toBeInTheDocument();
    expect(api.validate).toHaveBeenCalledTimes(1);
    expect(api.validate.mock.calls[0][0]).toEqual(bytes);
    expect(api.validate.mock.calls[0][1]).toEqual({ include: ['facts'], acceptRefusal: true });
    expect(screen.getByText('checkout.bim.zip · 3 tasks')).toBeInTheDocument();
    const digests = document.querySelector('.workbench-digests') as HTMLElement;
    expect(digests).toHaveTextContent('Instance digest');
    fireEvent.click(within(digests).getByRole('button', { name: 'Copy ir digest' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(valid.irDigest));
    expect(document.body.textContent).not.toMatch(/sha256-|\b[0-9a-f]{12}/);

    const holds = screen.getByRole('region', { name: 'What the package holds' });
    expect(holds).toHaveTextContent('3tasks');
    expect(holds).toHaveTextContent('4candidates');
    expect(holds).toHaveTextContent('0rules');
    expect(
      within(holds).getByRole('status', { name: /Binding space size: 2 combinations/i })
    ).toBeInTheDocument();
    const workflow = screen.getByRole('group', { name: 'Workflow of the package' });
    for (const task of valid.facts!.tasks) expect(workflow).toHaveTextContent(task.id);
    const candidates = screen.getByRole('region', { name: 'Candidates' });
    expect(within(candidates).getByRole('row', { name: /c1a/ })).toHaveTextContent('10 ms');
    expect(within(candidates).queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Rules and objectives' })
    ).toBeInTheDocument();
    // A valid package without findings has no problems list.
    expect(screen.queryByRole('region', { name: 'Problems' })).not.toBeInTheDocument();
  });

  it('lists the warnings of a valid package beside its structure', async () => {
    api.validate.mockResolvedValue({
      ...valid,
      diagnostics: [
        {
          code: 'unused_feature',
          message: 'Feature cost is declared but never used.',
          resource: 'candidates.json',
        },
      ],
    });
    renderPage();
    await choose(asFile(packageBytes()));
    fireEvent.click(screen.getByRole('button', { name: 'Validate package' }));

    expect(await screen.findByText('Valid package')).toBeInTheDocument();
    const problems = screen.getByRole('region', { name: 'Problems' });
    expect(problems).toHaveTextContent('1 warning');
    expect(problems).toHaveTextContent('Feature cost is declared but never used.');
    expect(screen.getByRole('region', { name: 'Candidates' })).toBeInTheDocument();
  });

  it('places the findings of a refused package in its files and draws no structure', async () => {
    api.validate.mockResolvedValue(refused);
    renderPage();
    await choose(asFile(zipStore(refusedFiles)));
    fireEvent.click(screen.getByRole('button', { name: 'Validate package' }));

    expect(await screen.findByText(/^Not valid · \d+ errors$/)).toBeInTheDocument();
    expect(
      screen.getByText(/^422 invalid_instance\. Each problem names the file and the place to fix\./)
    ).toBeInTheDocument();
    expect(screen.queryByText('Instance digest')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('group', { name: 'Workflow of the package' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Candidates' })).not.toBeInTheDocument();

    const problems = screen.getByRole('region', { name: 'Problems' });
    // Grouped by file: the value out of its domain is placed on its line in candidates.json, the orphan task in the diagram.
    const groups = [...problems.querySelectorAll('.pp-group-name')].map(
      element => element.textContent
    );
    expect(groups).toEqual(expect.arrayContaining(['candidates.json', 'workflow.bpmn']));
    const domain = within(problems)
      .getByText('candidate feature value is above its declared domain')
      .closest('.pp-item') as HTMLElement;
    expect(domain).toHaveTextContent(/Line \d+, column \d+/);
    expect(domain).toHaveTextContent('/spec/candidates/auth-edge/features/latency');
    expect(
      within(problems).getByText("BPMN task 'orphan' has no Application task").closest('.pp-item')
    ).toHaveTextContent('Diagram element orphan');
    // Read-only: the public page has no file to open.
    expect(
      within(problems).queryByRole('button', { name: /declared domain/ })
    ).not.toBeInTheDocument();
  });

  it('says what the gateway said when it refuses a package without itemising why', async () => {
    api.validate.mockResolvedValue({
      valid: false,
      status: 422,
      code: 'invalid_request',
      message: 'The archive is not a BIM package.',
      diagnostics: [],
    } satisfies BimRefusal);
    renderPage();
    await choose(asFile(packageBytes()));
    fireEvent.click(screen.getByRole('button', { name: 'Validate package' }));

    expect(await screen.findByText('Not valid · 1 error')).toBeInTheDocument();
    expect(
      screen.getByText('422 invalid_request. The archive is not a BIM package.')
    ).toBeInTheDocument();
    const problems = screen.getByRole('region', { name: 'Problems' });
    expect(problems).toHaveTextContent('The archive is not a BIM package.');
    expect(problems).toHaveTextContent('Package');
  });

  it('explains a package that is too large (413)', async () => {
    api.validate.mockRejectedValue(new HttpError(413, 'too large'));
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
    api.validate.mockRejectedValueOnce(limited);
    renderPage();
    await choose(asFile(packageBytes()));
    fireEvent.click(screen.getByRole('button', { name: 'Validate package' }));

    expect(await screen.findByText('Too many validations right now (429).')).toBeInTheDocument();
    expect(
      screen.getByText(/Try again in 5 s\. Your file is still selected\./)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Valid package')).toBeInTheDocument();
    expect(api.validate).toHaveBeenCalledTimes(2);
  });

  it('reports a gateway failure and offers a retry', async () => {
    api.validate.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    renderPage();
    await choose(asFile(packageBytes()));
    fireEvent.click(screen.getByRole('button', { name: 'Validate package' }));

    expect(
      await screen.findByText('Validation is unavailable right now (HTTP 503)')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Valid package')).toBeInTheDocument();
  });

  it('does not upload a file that is not a readable package', async () => {
    renderPage();
    await choose(
      asFile(new TextEncoder().encode('this is not a zip archive at all'), 'notes.bim.zip')
    );
    fireEvent.click(screen.getByRole('button', { name: 'Validate package' }));

    expect(await screen.findByText('This file can’t be read as a BIM package')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('not a complete ZIP archive');
    expect(api.validate).not.toHaveBeenCalled();
  });

  it('opens an official example from the address and validates it', async () => {
    api.template.mockResolvedValue(packageBytes().slice().buffer);
    renderPage('/workbench?template=demo%2F01_simple_seq');

    expect(await screen.findByText('Valid package')).toBeInTheDocument();
    expect(api.template).toHaveBeenCalledWith('demo/01_simple_seq');
    expect(screen.getByText('01_simple_seq.bim.zip')).toBeInTheDocument();
    expect(api.validate).toHaveBeenCalledTimes(1);
  });

  it('says so when an example from the address cannot be loaded', async () => {
    api.template.mockRejectedValue(new HttpError(422, 'invalid_example'));
    renderPage('/workbench?template=demo%2Fbroken');
    expect(await screen.findByText(/This template package is corrupt \(422\)/)).toBeInTheDocument();
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

  it('offers a signed-in account the problem editor of one of its organizations instead of the login prompt', async () => {
    platform.organizations.mockResolvedValue([
      { id: 'o', slug: 'isa-demo', name: 'ISA Demo Group' },
    ]);
    api.template.mockResolvedValue(packageBytes().slice().buffer);
    renderPage('/workbench?template=demo%2F01_simple_seq', lucia);

    expect(await screen.findByText('Signed in as lucia')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Log in to run' })).not.toBeInTheDocument();
    await screen.findByText('Valid package');
    fireEvent.click(screen.getByRole('button', { name: 'Open in the problem editor' }));
    expect(await screen.findByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute(
      'href',
      '/app/isa-demo/problem-editor?template=demo%2F01_simple_seq'
    );
    expect(screen.queryByText(/An uploaded file isn’t carried across/)).not.toBeInTheDocument();
  });

  it('tells a signed-in account that an uploaded file is not carried into the editor', async () => {
    platform.organizations.mockResolvedValue([
      { id: 'o', slug: 'isa-demo', name: 'ISA Demo Group' },
    ]);
    renderPage('/workbench', lucia);
    await choose(asFile(packageBytes()));

    expect(
      screen.getByText(
        /An uploaded file isn’t carried across: upload it on the organization’s problem list/
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open in the problem editor' }));
    expect(await screen.findByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute(
      'href',
      '/app/isa-demo/problem-editor'
    );
  });
});
