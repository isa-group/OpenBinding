import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError, type EngineRegistrationRevision } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { EngRegistrationDetail } from './EngRegistrationDetail';
import {
  EDGE_SOLVER, EDGE_SOLVER_OLD, REGISTRATION_MANIFEST, REPORT_FAILED, REPORT_PENDING, SHARED_SOLVER, reportOf,
} from '../../test/fixtures/engines';
import { registrationHref } from './registrationModel';

const api = vi.hoisted(() => ({
  listEngineRegistrations: vi.fn(),
  getEngineRegistrationReport: vi.fn(),
  getEngineRegistration: vi.fn(),
  activateEngineRegistration: vi.fn(),
  deactivateEngineRegistration: vi.fn(),
  requestEngineRegistrationPublication: vi.fn(),
  deleteEngineRegistration: vi.fn(),
  setEngineRegistrationCredential: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

const lucia: UserProfile = {
  id: 'lucia-id', username: 'alex.rivera', email: 'lucia@example.test', role: 'user', plan: 'RESEARCH', is_active: true, created_at: '2026-01-01T00:00:00Z',
};

// The first render of a file is slow on a busy machine.
configure({ asyncUtilTimeout: 5000 });

const SECRET = 'rotated-token-9';
const KNOWN = [EDGE_SOLVER, EDGE_SOLVER_OLD, SHARED_SOLVER];

/** What the gateway knows of a registration: the identity in the address names it, its state is the gateway’s. */
const stateOf = (ref: EngineRegistrationRevision): EngineRegistrationRevision => (
  KNOWN.find((item) => item.name === ref.name && item.version === ref.version) ?? { ...ref, status: 'private', active: true }
);

function refusal(status: number, code: string, diagnostics: unknown[] = []): HttpError {
  const error = new HttpError(status, code);
  error.code = code;
  error.diagnostics = diagnostics;
  return error;
}

function renderDetail(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthContext.Provider value={{ user: lucia, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}>
        <Routes>
          <Route path="/app/engines/registrations/:name" element={<EngRegistrationDetail />} />
        </Routes>
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

const open = (registration: EngineRegistrationRevision, hash = '') => renderDetail(`${registrationHref(registration)}${hash}`);

describe('eng-registration-detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listEngineRegistrations.mockResolvedValue([EDGE_SOLVER, EDGE_SOLVER_OLD, SHARED_SOLVER]);
    api.getEngineRegistrationReport.mockImplementation(async (ref: EngineRegistrationRevision) => reportOf(stateOf(ref)));
    api.getEngineRegistration.mockResolvedValue(REGISTRATION_MANIFEST);
    api.activateEngineRegistration.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, active: true }));
    api.deactivateEngineRegistration.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, active: false }));
    api.requestEngineRegistrationPublication.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, status: 'pending_review' }));
    api.deleteEngineRegistration.mockResolvedValue(undefined);
    api.setEngineRegistrationCredential.mockImplementation(async (ref: EngineRegistrationRevision) => ({ ...ref, active: false }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('names the exact registration, its use and its publication, and what its owner can do', async () => {
    open(EDGE_SOLVER);
    expect(await screen.findByRole('heading', { level: 1, name: 'edge-solver' })).toBeInTheDocument();
    expect(screen.getByText('Your deployment of the edge-solver engine. Only you can use it.')).toBeInTheDocument();
    const identity = screen.getByRole('region', { name: 'Exact identity' });
    expect(within(identity).getByText('alex.rivera')).toBeInTheDocument();
    expect(within(identity).getByText('0.3.1')).toBeInTheDocument();
    expect(within(identity).getByText(/sha256-e5f6…e5f6/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deactivate' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Edit as a new version' })).toHaveAttribute('href', expect.stringContaining('/app/engines/new?from=edge-solver'));
    expect(screen.getByRole('button', { name: 'Launch a job with it' })).toBeInTheDocument();
    expect(api.getEngineRegistrationReport).toHaveBeenCalledWith(expect.objectContaining({ name: 'edge-solver', version: '0.3.1' }));
  });

  it('places the registration on its way to publication', async () => {
    open(EDGE_SOLVER);
    await screen.findByRole('heading', { level: 1, name: 'edge-solver' });
    const publication = screen.getByRole('list', { name: 'Publication' });
    expect(publication.querySelector('[aria-current="step"]')).toHaveTextContent('Private');
    expect(within(publication).getByText(/Waiting for review/)).not.toHaveAttribute('aria-current');
    expect(screen.getByText('A rejected request returns to Private')).toBeInTheDocument();
  });

  it('shows the last verification as checks, not as a report', async () => {
    open(EDGE_SOLVER);
    const card = (await screen.findByRole('heading', { name: 'Last verification' })).closest('section') as HTMLElement;
    expect(within(card).getByText('Verified')).toBeInTheDocument();
    expect(within(card).getByText('Contract matches bim-engine/v1')).toBeInTheDocument();
    expect(within(card).getByText('Health path answered')).toBeInTheDocument();
    expect(within(card).getByText('Sample problem solved')).toBeInTheDocument();
    expect(within(card).getByText(/Protocol bim-engine\/v1 · fingerprint sha256-c3d4…c3d4/)).toBeInTheDocument();
    expect(within(card).getAllByText('Passed')).toHaveLength(3);
  });

  it('reads the deployment and the engine manifest as fields, with feature ranges and the source folded away', async () => {
    open(EDGE_SOLVER);
    await screen.findByRole('heading', { level: 1, name: 'edge-solver' });
    const deployment = screen.getByRole('region', { name: 'Deployment' });
    expect(within(deployment).getByText('https://edge.example.org')).toBeInTheDocument();
    expect(within(deployment).getByText('Bearer token (stored encrypted)')).toBeInTheDocument();
    expect(within(deployment).getByRole('list', { name: 'Paths on the deployment' })).toHaveTextContent('Solve/internal/v1/binding-problems');

    const mode = screen.getByRole('region', { name: 'Mode tabu' });
    expect(within(mode).getByRole('list', { name: 'Capabilities of mode tabu' })).toHaveTextContent('Placement');
    const features = within(mode).getByRole('region', { name: 'Feature values of mode tabu' });
    expect(features).toHaveTextContent('IntervalRanges, min–max · accepted');
    expect(features).toHaveTextContent('ScalarSingle numbers · accepted');
    expect(features).toHaveTextContent('An interval includes open ranges: a range with an end null (no lower or no upper limit, such as ≤ 200 or ≥ 100) counts as an interval');
    expect(within(mode).getByRole('region', { name: 'Options of mode tabu' })).toHaveTextContent('1 – 3,600,000');
    expect(within(mode).getByText('pareto-front')).toBeInTheDocument();

    // The document is not on the page until the Source tab is asked for.
    expect(screen.queryByRole('region', { name: 'Engine manifest source' })).not.toBeInTheDocument();
  });

  // [utest->req~frontend-engines-manifest-source-tab~1]
  it('offers the manifest document on a Source tab beside the readable Manifest tab', async () => {
    open(EDGE_SOLVER);
    await screen.findByRole('heading', { level: 1, name: 'edge-solver' });
    const manifestTab = screen.getByRole('tab', { name: 'Manifest' });
    const sourceTab = screen.getByRole('tab', { name: 'Source' });
    expect(manifestTab).toHaveAttribute('aria-selected', 'true');
    expect(sourceTab).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('region', { name: 'Mode tabu' })).toBeInTheDocument();
    expect(screen.queryByText('View source')).not.toBeInTheDocument();

    fireEvent.click(sourceTab);
    expect(sourceTab).toHaveAttribute('aria-selected', 'true');
    const source = screen.getByRole('region', { name: 'Engine manifest source' });
    expect(source).toHaveTextContent('"kind": "Engine"');
    expect(within(source).getByRole('button', { name: 'Copy Engine manifest source' })).toBeInTheDocument();
    expect(within(source).getByRole('button', { name: 'Download Engine manifest source' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Mode tabu' })).not.toBeInTheDocument();

    fireEvent.click(manifestTab);
    expect(screen.getByRole('region', { name: 'Mode tabu' })).toBeInTheDocument();
  });

  // [utest->req~frontend-engines-manifest-source-tab~1]
  it('keeps the document on the Source tab when the manifest cannot be read as an Engine', async () => {
    api.getEngineRegistrationReport.mockImplementation(async (ref: EngineRegistrationRevision) => (
      { ...reportOf(stateOf(ref)), engine: { unexpected: 'shape' } }
    ));
    open(EDGE_SOLVER);
    await screen.findByRole('heading', { level: 1, name: 'edge-solver' });
    expect(await screen.findByText(/couldn’t be read as a bim\/v1 Engine/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Source' }));
    expect(screen.getByRole('region', { name: 'Engine manifest source' })).toHaveTextContent('"unexpected": "shape"');
  });

  it('lists the other revisions under the same name, each one a link to its own page', async () => {
    open(EDGE_SOLVER);
    const table = await screen.findByRole('region', { name: 'Other revisions of this registration' });
    const row = within(table).getByRole('row', { name: /0\.2\.0/ });
    expect(within(row).getByText('Published')).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Open edge-solver 0.2.0' })).toHaveAttribute('href', expect.stringContaining('/app/engines/registrations/edge-solver?namespace=alex.rivera&version=0.2.0'));
    expect(within(table).queryByText('0.3.1')).not.toBeInTheDocument();
  });

  it('answers the same “not found” whether the registration is missing or belongs to someone else', async () => {
    api.getEngineRegistrationReport.mockRejectedValue(refusal(404, 'not_found'));
    const first = open(EDGE_SOLVER);
    expect(await screen.findByText('Not found')).toBeInTheDocument();
    expect(screen.getByText(/Private registrations only open for their owner; everyone else, administrators included, gets this same answer\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to My engines' })).toHaveAttribute('href', '/app/engines/registrations');
    expect(screen.queryByRole('heading', { level: 1, name: 'edge-solver' })).not.toBeInTheDocument();
    first.unmount();

    api.getEngineRegistrationReport.mockRejectedValue(refusal(403, 'forbidden'));
    open(EDGE_SOLVER);
    expect(await screen.findByText('Not found')).toBeInTheDocument();
  });

  it('asks to log in again when the session ended (401) and offers a retry for other failures', async () => {
    api.getEngineRegistrationReport.mockRejectedValueOnce(refusal(401, 'unauthorized'));
    const first = open(EDGE_SOLVER);
    expect(await screen.findByText('Your session ended')).toBeInTheDocument();
    first.unmount();

    api.getEngineRegistrationReport.mockRejectedValueOnce(refusal(503, 'accounts_unavailable'));
    open(EDGE_SOLVER);
    expect(await screen.findByText(/The registration couldn’t be loaded \(HTTP 503\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'edge-solver' })).toBeInTheDocument();
  });

  it('reads a published registration of someone else as read-only', async () => {
    open(SHARED_SOLVER);
    expect(await screen.findByRole('heading', { level: 1, name: 'shared-solver' })).toBeInTheDocument();
    expect(screen.getByText('Published by priya.nair. You can pick it when launching a job.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Credential' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Delete this registration' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Publication' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Launch a job with it' })).toBeInTheDocument();
  });

  it('deactivates, and activates again with a new check', async () => {
    open(EDGE_SOLVER);
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }));
    expect(await screen.findByText('Deactivated. You can’t pick it for new jobs until you activate it again.')).toBeInTheDocument();
    expect(api.deactivateEngineRegistration).toHaveBeenCalledWith(expect.objectContaining({ name: 'edge-solver' }));
  });

  it('checks again, and shows the checks that failed when the deployment no longer conforms', async () => {
    api.activateEngineRegistration.mockRejectedValueOnce(refusal(409, 'conformance_failed', REPORT_FAILED.checks));
    open(EDGE_SOLVER);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Your deployment didn’t pass (409 · conformance_failed)')).toBeInTheDocument();
    const card = screen.getByRole('heading', { name: 'Last verification' }).closest('section') as HTMLElement;
    // The banner says it failed, and so does the one check that did.
    expect(within(card).getAllByText('Failed')).toHaveLength(2);
    expect(within(card).getByText('engine did not solve the deterministic conformance problem')).toBeInTheDocument();
    expect(within(card).getAllByText('Passed')).toHaveLength(2);
    // The registration was read again, since a refused activation leaves it inactive.
    await waitFor(() => expect(api.getEngineRegistrationReport.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it('shows a registration that has never been checked as such', async () => {
    api.getEngineRegistrationReport.mockImplementation(async (ref: EngineRegistrationRevision) => reportOf({ ...stateOf(ref), active: false }, REPORT_PENDING));
    open(EDGE_SOLVER);
    await screen.findByRole('heading', { level: 1, name: 'edge-solver' });
    expect(screen.getByText('Not checked yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
  });

  it('replaces the credential without ever showing, keeping or returning the secret', async () => {
    open(EDGE_SOLVER);
    expect(await screen.findByText(/The credential is stored encrypted\. Nobody can read it back/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Replace credential' }));
    const field = screen.getByLabelText('New token');
    expect(field).toHaveAttribute('type', 'password');
    expect(screen.getByText(/private and inactive until it passes its check again/)).toBeInTheDocument();
    fireEvent.change(field, { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new credential' }));

    expect(await screen.findByText(/Credential replaced\. The old one is no longer used/)).toBeInTheDocument();
    expect(api.setEngineRegistrationCredential).toHaveBeenCalledWith(expect.objectContaining({ name: 'edge-solver' }), SECRET);
    expect(screen.queryByDisplayValue(SECRET)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('opens the credential form from a #credential link', async () => {
    open(EDGE_SOLVER, '#credential');
    expect(await screen.findByLabelText('New token')).toBeInTheDocument();
  });

  it('explains a refused credential (422) and keeps the form closed on success only', async () => {
    api.setEngineRegistrationCredential.mockRejectedValueOnce(refusal(422, 'invalid_credential'));
    open(EDGE_SOLVER, '#credential');
    fireEvent.change(await screen.findByLabelText('New token'), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Save new credential' }));
    expect(await screen.findByText('That credential was refused (422 · invalid_credential)')).toBeInTheDocument();
    expect(screen.getByLabelText('New token')).toHaveValue('');
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it('does not offer to change the credential of a published registration, and says why', async () => {
    api.getEngineRegistrationReport.mockImplementation(async (ref: EngineRegistrationRevision) => reportOf({ ...stateOf(ref), status: 'published' }));
    open({ ...EDGE_SOLVER, status: 'published' });
    expect(await screen.findByText('Published registrations can’t be changed. Register a new version to use another credential.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace credential' })).toBeDisabled();
    expect(screen.getByText('Published. Everyone can pick it when launching a job. It can no longer be changed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request publication' })).not.toBeInTheDocument();
  });

  it('asks before requesting publication, and refuses while it is inactive', async () => {
    open(EDGE_SOLVER);
    fireEvent.click(await screen.findByRole('button', { name: 'Request publication' }));
    const dialog = screen.getByRole('dialog', { name: 'Request publication of edge-solver?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request publication' }));
    expect(await screen.findByText('Publication requested. An administrator will review it.')).toBeInTheDocument();
    expect(api.requestEngineRegistrationPublication).toHaveBeenCalledOnce();
  });

  it('says the 409 when publication is refused because the registration is inactive', async () => {
    api.requestEngineRegistrationPublication.mockRejectedValueOnce(refusal(409, 'registration_inactive'));
    open(EDGE_SOLVER);
    fireEvent.click(await screen.findByRole('button', { name: 'Request publication' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Request publication' }));
    expect(await screen.findByText('It’s inactive (409 · registration_inactive)')).toBeInTheDocument();
  });

  it('deletes after the name is typed, and then says the registration is gone', async () => {
    open(EDGE_SOLVER);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog', { name: 'Delete edge-solver 0.3.1?' });
    const confirm = within(dialog).getByRole('button', { name: 'Delete registration' });
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'edge-solver' } });
    fireEvent.click(confirm);
    expect(await screen.findByText('This registration was deleted')).toBeInTheDocument();
    expect(api.deleteEngineRegistration).toHaveBeenCalledWith(expect.objectContaining({ name: 'edge-solver' }));
    expect(screen.getByRole('link', { name: 'Register an engine' })).toHaveAttribute('href', '/app/engines/new');
  });

  it('finds the registration by its name alone when only one revision of it is visible', async () => {
    api.listEngineRegistrations.mockResolvedValue([SHARED_SOLVER]);
    renderDetail('/app/engines/registrations/shared-solver');
    expect(await screen.findByRole('heading', { level: 1, name: 'shared-solver' })).toBeInTheDocument();
    expect(api.getEngineRegistrationReport).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'priya.nair', version: '2.0.0' }));
  });

  it('asks which revision when a name alone is not enough, and says nothing exists for a name that does not', async () => {
    const chooser = renderDetail('/app/engines/registrations/edge-solver');
    expect(await screen.findByRole('heading', { name: 'Which revision of edge-solver?' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /alex\.rivera\/edge-solver@/ })).toHaveLength(2);
    chooser.unmount();

    renderDetail('/app/engines/registrations/ghost');
    expect(await screen.findByText('Not found')).toBeInTheDocument();
  });
});
