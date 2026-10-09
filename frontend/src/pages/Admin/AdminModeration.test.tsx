import { configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminModeration } from './AdminModeration';
import { LUCIA, MODERATION, PENDING_ENGINE } from './adminFixtures';
import { refusal, renderAdmin } from './adminTestUtils';

const api = vi.hoisted(() => ({
  adminModeration: vi.fn(),
  adminListEngineRegistrations: vi.fn(),
  getEngineRegistrationReport: vi.fn(),
  adminApproveEngineRegistration: vi.fn(),
  adminRejectEngineRegistration: vi.fn(),
  adminApproveExtension: vi.fn(),
}));

vi.mock('../../api/client', async () => ({
  ...await vi.importActual<typeof import('../../api/client')>('../../api/client'),
  apiClient: api,
}));

configure({ asyncUtilTimeout: 5000 });

const REPORT = {
  ...PENDING_ENGINE,
  openapiDigest: `sha256-${'b'.repeat(64)}`,
  openapi: { openapi: '3.1.0' },
  engine: { apiVersion: 'bim/v1', kind: 'Engine', metadata: { namespace: 'lucia-vega', name: 'edge-solver', version: '0.3.1' }, spec: { modes: [] } },
  report: { status: 'verified', checks: [{ id: 'openapi', status: 'passed' }, { id: 'health', status: 'passed' }] },
};

const request = () => screen.getByRole('listitem', { name: 'lucia-vega/edge-solver' });

describe('admin-moderation · what waits for a decision', { timeout: 30000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.adminModeration.mockResolvedValue(MODERATION);
    api.adminListEngineRegistrations.mockResolvedValue([PENDING_ENGINE]);
    api.getEngineRegistrationReport.mockResolvedValue(REPORT);
    api.adminApproveEngineRegistration.mockResolvedValue({ ...PENDING_ENGINE, status: 'published' });
    api.adminRejectEngineRegistration.mockResolvedValue({ ...PENDING_ENGINE, status: 'private' });
    api.adminApproveExtension.mockResolvedValue({ namespace: 'lucia-vega', name: 'edge-annotations', version: '1.0.0', digest: 'sha256-x', status: 'published' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts what waits and lists the publication requests with who asked', async () => {
    renderAdmin(<AdminModeration />);
    expect(screen.getByRole('heading', { level: 1, name: 'Moderation' })).toBeInTheDocument();
    const tiles = await screen.findByRole('list', { name: 'Waiting for review' });
    expect(within(within(tiles).getByText('Engine requests').closest('div')!).getByText('1')).toBeInTheDocument();
    expect(within(within(tiles).getByText('Dialects').closest('div')!).getByText('1')).toBeInTheDocument();
    expect(within(within(tiles).getByText('Engine revisions').closest('div')!).getByText('0')).toBeInTheDocument();
    expect(await screen.findByRole('listitem', { name: 'lucia-vega/edge-solver' })).toBeInTheDocument();
    expect(within(request()).getByText('Waiting for review')).toBeInTheDocument();
    expect(within(request()).getByText('0.3.1')).toBeInTheDocument();
    expect(within(request()).getByText('lucia-vega', { selector: 'strong' })).toBeInTheDocument();
    expect(api.adminListEngineRegistrations).toHaveBeenCalledWith();
    expect(screen.getByRole('navigation', { name: 'Administration' }).querySelector('[aria-current="page"]')).toHaveTextContent('Moderation');
  });

  it('shows the verification report as checks, fetched only when it is asked for', async () => {
    renderAdmin(<AdminModeration />);
    await screen.findByRole('listitem', { name: 'lucia-vega/edge-solver' });
    expect(api.getEngineRegistrationReport).not.toHaveBeenCalled();
    fireEvent.click(within(request()).getByRole('button', { name: 'Show verification report' }));
    expect(await screen.findByText('Contract matches bim-engine/v1')).toBeInTheDocument();
    expect(screen.getByText('Health path answered')).toBeInTheDocument();
    expect(screen.getByText('Verification report')).toBeInTheDocument();
    expect(api.getEngineRegistrationReport).toHaveBeenCalledOnce();
    fireEvent.click(within(request()).getByRole('button', { name: 'Hide verification report' }));
    expect(screen.queryByText('Contract matches bim-engine/v1')).not.toBeInTheDocument();
  });

  it('says so when the report cannot be read', async () => {
    api.getEngineRegistrationReport.mockRejectedValue(refusal(502));
    renderAdmin(<AdminModeration />);
    await screen.findByRole('listitem', { name: 'lucia-vega/edge-solver' });
    fireEvent.click(within(request()).getByRole('button', { name: 'Show verification report' }));
    expect(await screen.findByText(/couldn’t be read/)).toBeInTheDocument();
  });

  it('approves and publishes only after a confirmation, then reads the queue again', async () => {
    renderAdmin(<AdminModeration />);
    await screen.findByRole('listitem', { name: 'lucia-vega/edge-solver' });
    api.adminListEngineRegistrations.mockResolvedValue([]);
    fireEvent.click(within(request()).getByRole('button', { name: 'Approve and publish' }));
    const dialog = screen.getByRole('dialog', { name: 'Publish lucia-vega/edge-solver for everyone?' });
    expect(api.adminApproveEngineRegistration).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/can’t be changed or deleted by its owner/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve and publish' }));
    await waitFor(() => expect(api.adminApproveEngineRegistration).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'lucia-vega', name: 'edge-solver', version: '0.3.1' })));
    expect(await screen.findByText('Approved. lucia-vega/edge-solver@0.3.1 is published. Recorded in the audit log.')).toBeInTheDocument();
    expect(await screen.findByText('No engine is waiting for review')).toBeInTheDocument();
    await waitFor(() => expect(api.adminModeration).toHaveBeenCalledTimes(2));
  });

  it('rejects only after a confirmation, and says the API takes no reason', async () => {
    renderAdmin(<AdminModeration />);
    await screen.findByRole('listitem', { name: 'lucia-vega/edge-solver' });
    fireEvent.click(within(request()).getByRole('button', { name: 'Reject' }));
    const dialog = screen.getByRole('dialog', { name: 'Reject lucia-vega/edge-solver?' });
    expect(within(dialog).getByText(/goes back to being private to lucia-vega/)).toBeInTheDocument();
    expect(within(dialog).getByText(/The API takes no written reason/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.adminRejectEngineRegistration).not.toHaveBeenCalled();

    fireEvent.click(within(request()).getByRole('button', { name: 'Reject' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(api.adminRejectEngineRegistration).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Rejected\. The request left the queue and lucia-vega\/edge-solver@0\.3\.1 is private to lucia-vega again/)).toBeInTheDocument();
  });

  it('says a request was already decided (409) and reads the queue again', async () => {
    api.adminApproveEngineRegistration.mockRejectedValue(refusal(409, 'registration_not_pending', 'The registration is no longer pending review.'));
    renderAdmin(<AdminModeration />);
    await screen.findByRole('listitem', { name: 'lucia-vega/edge-solver' });
    fireEvent.click(within(request()).getByRole('button', { name: 'Approve and publish' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve and publish' }));
    expect(await screen.findByText('This can’t be decided now (409 · registration_not_pending)')).toBeInTheDocument();
    expect(screen.getByText(/Another administrator may have decided it first/)).toBeInTheDocument();
    await waitFor(() => expect(api.adminListEngineRegistrations).toHaveBeenCalledTimes(2));
  });

  it('tells a key without the moderation permission so, with no retry', async () => {
    api.adminListEngineRegistrations.mockRejectedValue(refusal(403, 'insufficient_api_key_permission'));
    renderAdmin(<AdminModeration />);
    expect(await screen.findByText('This key can’t moderate (403)')).toBeInTheDocument();
    expect(screen.getByText(/“moderate engines” \(engines:moderate\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('keeps a failure to load apart from an empty queue, and retries', async () => {
    api.adminListEngineRegistrations.mockRejectedValueOnce(refusal(503, 'accounts_unavailable'));
    renderAdmin(<AdminModeration />);
    expect(await screen.findByText('A service isn’t available right now (503 · accounts_unavailable)')).toBeInTheDocument();
    expect(screen.queryByText('No engine is waiting for review')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('listitem', { name: 'lucia-vega/edge-solver' })).toBeInTheDocument();
  });

  it('says when nothing is waiting', async () => {
    api.adminListEngineRegistrations.mockResolvedValue([]);
    api.adminModeration.mockResolvedValue({ engines: {}, dialects: {}, registrations: {} });
    renderAdmin(<AdminModeration />);
    expect(await screen.findByText('No engine is waiting for review')).toBeInTheDocument();
    expect(await screen.findByText(/No dialect is waiting for approval/)).toBeInTheDocument();
  });

  it('approves a dialect named by its exact revision, after a confirmation, and offers no reject', async () => {
    renderAdmin(<AdminModeration />);
    const form = await screen.findByRole('form', { name: 'Approve a dialect or resource' });
    expect(screen.getByText(/1 dialect revision waiting for approval/)).toBeInTheDocument();
    const approve = within(form).getByRole('button', { name: 'Approve…' });
    expect(approve).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('Namespace'), { target: { value: 'lucia-vega' } });
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'edge-annotations' } });
    fireEvent.change(within(form).getByLabelText('Version'), { target: { value: '1.0.0' } });
    expect(approve).toBeDisabled();
    fireEvent.change(within(form).getByLabelText('Revision (digest)'), { target: { value: 'sha256-abc' } });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    const dialog = screen.getByRole('dialog', { name: 'Approve dialect lucia-vega/edge-annotations@1.0.0?' });
    expect(api.adminApproveExtension).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Approve dialect' }));
    await waitFor(() => expect(api.adminApproveExtension).toHaveBeenCalledWith('dialect', { namespace: 'lucia-vega', name: 'edge-annotations', version: '1.0.0', revision: 'sha256-abc' }));
    expect(await screen.findByText('Dialect lucia-vega/edge-annotations@1.0.0 approved and published. Recorded in the audit log.')).toBeInTheDocument();
    expect(screen.getByText(/there is no reject action for them/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Language extensions' })).toHaveAttribute('href', '/app/language/extensions');
  });

  it('says why a resource cannot be approved', async () => {
    api.adminApproveExtension.mockRejectedValue(refusal(404, 'not_found', 'No such resource revision.'));
    renderAdmin(<AdminModeration />);
    const form = await screen.findByRole('form', { name: 'Approve a dialect or resource' });
    fireEvent.change(within(form).getByLabelText('Kind'), { target: { value: 'resource' } });
    for (const [label, value] of [['Namespace', 'lucia-vega'], ['Name', 'eu-edge-placement'], ['Version', '1.0.0'], ['Revision (digest)', 'sha256-abc']]) {
      fireEvent.change(within(form).getByLabelText(label), { target: { value } });
    }
    fireEvent.click(within(form).getByRole('button', { name: 'Approve…' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve resource' }));
    expect(await screen.findByText('Not found (404 · not_found)')).toBeInTheDocument();
    expect(api.adminApproveExtension).toHaveBeenCalledWith('resource', expect.objectContaining({ name: 'eu-edge-placement' }));
  });

  it('shows a person who is not an administrator nothing, and asks the gateway nothing', async () => {
    renderAdmin(<AdminModeration />, { user: LUCIA });
    expect(await screen.findByText('Not available (403)')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Moderation' })).not.toBeInTheDocument();
    expect(api.adminModeration).not.toHaveBeenCalled();
    expect(api.adminListEngineRegistrations).not.toHaveBeenCalled();
  });
});
