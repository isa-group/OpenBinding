import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaError, type UserProfile } from '../../api/auth';
import { HttpError } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import {
  EDGE_SOLVER, ENGINE_DOCUMENT, OPENAPI_DOCUMENT, PROTOCOL_DIGEST, QOS_PROFILE, REGISTRATION_MANIFEST, REPORT_FAILED, digestOf, reportOf, usageOf,
} from '../Engines/fixtures';
import { RegisterEngine } from './RegisterEngine';

const api = vi.hoisted(() => ({
  getProfiles: vi.fn(),
  getBimProfile: vi.fn(),
  createEngine: vi.fn(),
  createEngineRegistration: vi.fn(),
  setEngineRegistrationCredential: vi.fn(),
  activateEngineRegistration: vi.fn(),
  getEngineRegistrationReport: vi.fn(),
  getEngineRegistration: vi.fn(),
  requestEngineRegistrationPublication: vi.fn(),
  getOwnUsage: vi.fn(),
  listEngineRegistrations: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

const alice: UserProfile = {
  id: 'alice-id', username: 'alice', email: 'alice@example.test', role: 'user', plan: 'RESEARCH', is_active: true, created_at: '2026-01-01T00:00:00Z',
};

// The first render of a file is slow on a busy machine.
configure({ asyncUtilTimeout: 5000 });

const ENGINE_DIGEST = digestOf('aa');
const REGISTRATION_DIGEST = digestOf('cc');
const SECRET = 'secret-token';

const engineRevision = { namespace: 'alice', name: 'my-engine', version: '1.0.0', digest: ENGINE_DIGEST, status: 'private' as const };
const registrationRevision = { namespace: 'alice', name: 'my-engine-deployment', version: '1.0.0', digest: REGISTRATION_DIGEST, status: 'private' as const, active: false };

const contract = { ...OPENAPI_DOCUMENT };

function renderPage(entry = '/app/engines/new') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthContext.Provider value={{ user: alice, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}>
        <RegisterEngine />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

function refusal(status: number, code: string, diagnostics: unknown[] = []): HttpError {
  const error = new HttpError(status, code);
  error.code = code;
  error.diagnostics = diagnostics;
  return error;
}

async function createEngineRevision() {
  fireEvent.click(await screen.findByRole('button', { name: 'Create engine revision' }));
  await screen.findByText('✓ Engine revision created · private');
}

async function fillDeployment(document: unknown = contract) {
  fireEvent.click(screen.getByRole('button', { name: 'Next: deployment' }));
  await screen.findByRole('heading', { name: '2 · Where it runs' });
  fireEvent.change(screen.getByLabelText('Endpoint address'), { target: { value: 'https://solver.example' } });
  fireEvent.change(screen.getByLabelText('Deployment OpenAPI JSON'), { target: { value: JSON.stringify(document) } });
}

async function createRegistration() {
  fireEvent.click(screen.getByRole('button', { name: 'Create registration' }));
  await screen.findByText('✓ Registration created · inactive');
}

describe('eng-register · the registration wizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getProfiles.mockResolvedValue([QOS_PROFILE]);
    api.getBimProfile.mockResolvedValue({ id: 'qos-binding/v1', output: QOS_PROFILE.output, protocol: 'bim-engine/v1', protocolDigest: PROTOCOL_DIGEST, digest: QOS_PROFILE.digest });
    api.getOwnUsage.mockResolvedValue(usageOf('RESEARCH', 1, 3));
    api.listEngineRegistrations.mockResolvedValue([EDGE_SOLVER]);
    api.createEngine.mockResolvedValue(engineRevision);
    api.createEngineRegistration.mockResolvedValue(registrationRevision);
    api.setEngineRegistrationCredential.mockImplementation(async (ref: object) => ref);
    api.activateEngineRegistration.mockImplementation(async (ref: object) => ({ ...ref, active: true }));
    api.getEngineRegistrationReport.mockImplementation(async (ref: object) => reportOf({ ...(ref as typeof registrationRevision), active: true }));
    api.requestEngineRegistrationPublication.mockImplementation(async (ref: object) => ({ ...ref, status: 'pending_review' }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens on step 1 of 4, with the other steps locked, and creates nothing', async () => {
    renderPage();
    // The page shows a placeholder heading while it loads; the steps only exist once it has.
    const steps = await screen.findByRole('list', { name: 'Steps' });
    expect(screen.getByRole('heading', { level: 1, name: 'Register a private engine' })).toBeInTheDocument();
    expect(within(steps).getAllByRole('listitem')).toHaveLength(4);
    expect(within(steps).getByRole('button', { name: /Engine/ })).toHaveAttribute('aria-current', 'step');
    expect(within(steps).getByRole('button', { name: /Deployment/ })).toBeDisabled();
    expect(api.createEngine).not.toHaveBeenCalled();
  });

  it('shows the plan’s room for federated engines', async () => {
    renderPage();
    expect(await screen.findByText('1 of 3 used')).toBeInTheDocument();
    expect(await screen.findByRole('progressbar', { name: 'Federated engines used' })).toHaveAttribute('aria-valuenow', '1');
  });

  it('fixes the namespace to the account’s', async () => {
    renderPage();
    expect(await screen.findByText('yours')).toBeInTheDocument();
    expect(screen.getByText(/^alice\s*$/)).toBeInTheDocument();
  });

  it('builds the engine from fields, in the account’s namespace, with the profile’s mandatory dimensions named', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'edge-router' } });
    fireEvent.change(screen.getByLabelText('Algorithm'), { target: { value: 'Tabu search' } });
    fireEvent.click(screen.getByRole('button', { name: /Interval values \(ranges\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Pareto front' }));
    await createEngineRevision();

    expect(api.createEngine).toHaveBeenCalledOnce();
    const manifest = api.createEngine.mock.calls[0][0];
    expect(manifest.metadata).toEqual({ namespace: 'alice', name: 'edge-router', version: '1.0.0' });
    const [mode] = manifest.spec.modes;
    expect(mode).toMatchObject({ id: 'default', profile: 'qos-binding/v1', algorithm: 'Tabu search', ir: { apiVersion: 'bim/v1', kind: 'BindingProblem' } });
    expect(mode.capabilities.featureValues).toEqual({ selector: 'only', values: ['scalar', 'interval'] });
    expect(mode.capabilities.scalarizations.values.map((item: { id: string }) => item.id)).toEqual(['weighted-sum', 'pareto-front']);
    expect(mode.capabilities.placement).toEqual({ selector: 'all' });
    expect(screen.getByText('Engine revision created. It’s private and can’t be edited.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeDisabled();
  });

  it('keeps the form from creating anything while a field is wrong, and says which', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Version'), { target: { value: '0.1.0' } });
    expect(screen.getByText('Use three numbers like 1.0.0, starting at 1.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create engine revision' })).toBeDisabled();
    expect(screen.getByText('Fix the highlighted fields first (1).')).toBeInTheDocument();
    expect(api.createEngine).not.toHaveBeenCalled();
  });

  it('registers the deployment, stores a bearer credential apart from the manifest and activates it after a conformance check', async () => {
    renderPage();
    await createEngineRevision();
    await fillDeployment();
    fireEvent.click(screen.getByRole('radio', { name: /Bearer token/ }));
    expect(await screen.findByText('Matches')).toBeInTheDocument();
    await createRegistration();

    expect(api.createEngineRegistration).toHaveBeenCalledWith(expect.objectContaining({
      apiVersion: 'bim/v1',
      kind: 'EngineRegistration',
      metadata: { namespace: 'alice', name: 'my-engine-deployment', version: '1.0.0' },
      spec: expect.objectContaining({
        engine: { namespace: 'alice', name: 'my-engine', version: '1.0.0', digest: ENGINE_DIGEST },
        endpoint: 'https://solver.example',
        protocol: { id: 'bim-engine/v1', mediaType: 'application/json', digest: PROTOCOL_DIGEST },
        auth: { scheme: 'bearer' },
        openapi: expect.objectContaining({ openapi: '3.1.0', 'x-bim-protocol-digest': PROTOCOL_DIGEST }),
      }),
    }));

    fireEvent.click(screen.getByRole('button', { name: 'Next: credential' }));
    const token = await screen.findByLabelText('Token');
    expect(token).toHaveAttribute('type', 'password');
    fireEvent.change(token, { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Save credential' }));

    await waitFor(() => expect(api.setEngineRegistrationCredential).toHaveBeenCalledWith(expect.objectContaining({ digest: REGISTRATION_DIGEST }), SECRET));
    expect(await screen.findByText('Stored encrypted. It will never be shown again.')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
    expect(JSON.stringify(api.createEngineRegistration.mock.calls)).not.toContain(SECRET);
    expect(JSON.stringify(api.createEngine.mock.calls)).not.toContain(SECRET);

    fireEvent.click(screen.getByRole('button', { name: 'Next: verify' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check conformance and activate' }));

    expect(await screen.findByText('my-engine-deployment 1.0.0 is active')).toBeInTheDocument();
    expect(api.activateEngineRegistration).toHaveBeenCalledWith(expect.objectContaining({ digest: REGISTRATION_DIGEST }));
    expect(screen.getByText('Sample problem solved')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open registration' })).toHaveAttribute('href', expect.stringContaining('/app/engines/registrations/my-engine-deployment?'));
    expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  });

  it('skips the credential step for an open endpoint and can ask for publication once active', async () => {
    renderPage();
    await createEngineRevision();
    await fillDeployment();
    await createRegistration();
    fireEvent.click(screen.getByRole('button', { name: 'Next: verify' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check conformance and activate' }));
    await screen.findByText('my-engine-deployment 1.0.0 is active');
    expect(api.setEngineRegistrationCredential).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Request publication' }));
    expect(await screen.findByText('Waiting for review')).toBeInTheDocument();
    expect(api.requestEngineRegistrationPublication).toHaveBeenCalledOnce();
  });

  it('shows the checks that failed when the deployment does not conform, and lets the person check again', async () => {
    api.activateEngineRegistration.mockRejectedValueOnce(refusal(409, 'conformance_failed', REPORT_FAILED.checks));
    renderPage();
    await createEngineRevision();
    await fillDeployment();
    await createRegistration();
    fireEvent.click(screen.getByRole('button', { name: 'Next: verify' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Check conformance and activate' }));

    expect(await screen.findByText('Your deployment didn’t pass (409 · conformance_failed)')).toBeInTheDocument();
    expect(screen.getByText('engine did not solve the deterministic conformance problem')).toBeInTheDocument();
    expect(screen.getByText('Conformance check')).toBeInTheDocument();
    expect(screen.queryByText(/is active/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('my-engine-deployment 1.0.0 is active')).toBeInTheDocument();
  });

  it('does not create a registration until the contract passes every check', async () => {
    renderPage();
    await createEngineRevision();
    await fillDeployment({ openapi: '3.0.3', paths: {} });
    const checks = screen.getByRole('list', { name: 'What we read from the contract' });
    expect(within(checks).getByText('3.0.3')).toBeInTheDocument();
    expect(within(checks).getAllByText(/\(fails\)/).length).toBeGreaterThanOrEqual(3);
    expect(screen.getByRole('button', { name: 'Create registration' })).toBeDisabled();
    expect(screen.getByText('The contract doesn’t pass every check.')).toBeInTheDocument();
    expect(api.createEngineRegistration).not.toHaveBeenCalled();
  });

  it('refuses a contract that pins another edition of the protocol, even if the page’s copy said otherwise', async () => {
    api.getBimProfile.mockResolvedValue({ id: 'qos-binding/v1', output: QOS_PROFILE.output, protocol: 'bim-engine/v1', protocolDigest: digestOf('99'), digest: QOS_PROFILE.digest });
    renderPage();
    await createEngineRevision();
    await fillDeployment();
    fireEvent.click(screen.getByRole('button', { name: 'Create registration' }));
    expect(await screen.findByText('The registration was refused')).toBeInTheDocument();
    expect(screen.getByText(/does not pin this gateway’s bim-engine\/v1 digest/)).toBeInTheDocument();
    expect(api.createEngineRegistration).not.toHaveBeenCalled();
  });

  it('says the plan is full (402) and links to the usage', async () => {
    api.createEngineRegistration.mockRejectedValueOnce(new QuotaError('quota_exceeded', 'limit', { limit_id: 'federatedEngines', limit: 3, used: 3 }));
    renderPage();
    await createEngineRevision();
    await fillDeployment();
    fireEvent.click(screen.getByRole('button', { name: 'Create registration' }));
    expect(await screen.findByText('Engine limit reached (402)')).toBeInTheDocument();
    expect(screen.getByText(/You’ve used 3 of 3/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'See your usage' })).toHaveAttribute('href', '/app/account/usage');
    expect(screen.getByRole('button', { name: 'Create registration' })).toBeEnabled();
  });

  it('shows where the gateway says the engine manifest is wrong (422)', async () => {
    api.createEngine.mockRejectedValueOnce(refusal(422, 'invalid_engine', [{ code: 'capability_dimension_missing', pointer: '/spec/modes/0/capabilities', message: 'mode must explicitly select capability dimension \'x\'' }]));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Create engine revision' }));
    expect(await screen.findByText('The engine manifest was refused (422 · invalid_engine)')).toBeInTheDocument();
    expect(screen.getByText(/\/spec\/modes\/0\/capabilities: mode must explicitly select/)).toBeInTheDocument();
    expect(screen.queryByText('✓ Engine revision created · private')).not.toBeInTheDocument();
  });

  it('explains a refused credential and does not keep what was typed', async () => {
    api.setEngineRegistrationCredential.mockRejectedValueOnce(refusal(422, 'invalid_credential'));
    renderPage();
    await createEngineRevision();
    await fillDeployment();
    fireEvent.click(screen.getByRole('radio', { name: /Username and password/ }));
    await createRegistration();
    fireEvent.click(screen.getByRole('button', { name: 'Next: credential' }));
    fireEvent.change(await screen.findByLabelText('Username and password (user:password)'), { target: { value: 'ana:hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save credential' }));
    expect(await screen.findByText('That credential was refused (422 · invalid_credential)')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('ana:hunter2')).not.toBeInTheDocument();
  });

  it('can keep the engine revision alone, with no deployment', async () => {
    renderPage();
    await createEngineRevision();
    fireEvent.click(screen.getByRole('button', { name: 'Keep the engine only' }));
    expect(await screen.findByText('my-engine 1.0.0 is saved')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register a deployment for it' })).toBeInTheDocument();
    expect(api.createEngineRegistration).not.toHaveBeenCalled();
  });

  it('starts the form from a manifest file and still uses the account’s namespace', async () => {
    renderPage();
    const document = structuredClone(ENGINE_DOCUMENT) as { metadata: Record<string, string> };
    document.metadata = { namespace: 'somebody-else', name: 'imported', version: '1.3.0' };
    fireEvent.change(await screen.findByLabelText('Engine manifest JSON'), { target: { value: JSON.stringify(document) } });
    fireEvent.click(screen.getByRole('button', { name: 'Load into the form' }));
    expect(await screen.findByDisplayValue('imported')).toBeInTheDocument();
    expect(screen.getByDisplayValue('tabu-search')).toBeInTheDocument();
    await createEngineRevision();
    const manifest = api.createEngine.mock.calls[0][0];
    expect(manifest.metadata.namespace).toBe('alice');
    expect(manifest.spec.modes[0].capabilities.featureValues).toEqual({ selector: 'only', values: ['scalar', 'interval'] });
  });

  it('refuses text that is not an engine manifest', async () => {
    renderPage();
    fireEvent.change(await screen.findByLabelText('Engine manifest JSON'), { target: { value: '{"spec":{}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load into the form' }));
    expect(await screen.findByText('That is not a bim/v1 Engine manifest: it needs a spec with modes.')).toBeInTheDocument();
  });

  it('opens from an existing registration to register it again under the next version', async () => {
    api.getEngineRegistrationReport.mockResolvedValue(reportOf(EDGE_SOLVER));
    api.getEngineRegistration.mockResolvedValue(REGISTRATION_MANIFEST);
    renderPage(`/app/engines/new?from=edge-solver&namespace=${EDGE_SOLVER.namespace}&version=${EDGE_SOLVER.version}&digest=${EDGE_SOLVER.digest}`);
    expect(await screen.findByDisplayValue('edge-solver')).toBeInTheDocument();
    expect(screen.getByLabelText('Version')).toHaveValue('0.3.2');
    expect(screen.getByDisplayValue('tabu-search')).toBeInTheDocument();
  });

  it('starts from scratch, and says so, when the registration to copy cannot be read', async () => {
    api.getEngineRegistrationReport.mockRejectedValue(refusal(404, 'not_found'));
    renderPage(`/app/engines/new?from=gone&namespace=x&version=1.0.0&digest=${digestOf('11')}`);
    expect(await screen.findByText('The registration to copy couldn’t be read')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('my-engine')).toBeInTheDocument();
  });

  it('works with the standard vocabulary when the gateway’s profiles cannot be read', async () => {
    api.getProfiles.mockRejectedValue(refusal(503, 'accounts_unavailable'));
    renderPage();
    expect(await screen.findByText(/uses the standard qos-binding\/v1 vocabulary/)).toBeInTheDocument();
    await createEngineRevision();
    expect(api.createEngine).toHaveBeenCalledOnce();
  });
});
