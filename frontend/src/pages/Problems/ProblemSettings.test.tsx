import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { caseOf, org, renderOrgScreen, revisionOf } from '../../features/workspace/testKit';
import { ProblemDetail } from './ProblemDetail';

const problems = vi.hoisted(() => ({ get: vi.fn(), revisions: vi.fn(), update: vi.fn(), remove: vi.fn(), compilation: vi.fn(), ir: vi.fn() }));

vi.mock('../../api/problems', () => ({ problemsApi: problems }));

const member = org('member-lab', { name: 'Member Lab', effective_role: 'MEMBER' });
const viewer = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const checkout = caseOf('flujo-checkout', 'Flujo de checkout', { description: 'Payments with parallel stock and shipping.' });

const refusal = (status: number, code = 'refused') => Object.assign(new HttpError(status, 'refused'), { code });

function renderSettings(organization = member) {
  return renderOrgScreen(<ProblemDetail />, {
    path: '/app/:org/problems/:case/:tab?', url: `/app/${organization.slug}/problems/flujo-checkout/settings`, organizations: [organization],
  });
}

describe('Settings tab of the problem page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    problems.get.mockResolvedValue(checkout);
    problems.revisions.mockResolvedValue([revisionOf(checkout, 1)]);
    problems.compilation.mockRejectedValue(refusal(503));
  });

  it('holds the name and the description, and saves both with the gateway', async () => {
    problems.update.mockResolvedValue({ ...checkout, name: 'Checkout flow', description: 'Catalog grown to eight candidates.' });
    renderSettings();

    const name = await screen.findByLabelText('Name');
    expect(name).toHaveValue('Flujo de checkout');
    expect(screen.getByLabelText('Description')).toHaveValue('Payments with parallel stock and shipping.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(name, { target: { value: '  Checkout flow ' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '  Catalog grown to eight candidates.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(problems.update).toHaveBeenCalledWith('member-lab', 'flujo-checkout', { name: 'Checkout flow', description: 'Catalog grown to eight candidates.' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    await waitFor(() => expect(problems.get).toHaveBeenCalledTimes(2));
  });

  it('keeps what was typed and says why when the gateway refuses', async () => {
    problems.update.mockRejectedValue(refusal(403, 'forbidden'));
    renderSettings();

    fireEvent.change(await screen.findByLabelText('Description'), { target: { value: 'Another text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('You need MEMBER in the organization to edit a problem (403 · forbidden). Nothing changed.');
    expect(screen.getByLabelText('Description')).toHaveValue('Another text');
  });

  it('does not save a problem without a name', async () => {
    renderSettings();

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: '   ' } });
    expect(screen.getByText('A problem needs a name.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(problems.update).not.toHaveBeenCalled();
  });

  it('shows a VIEWER the name and the description, read-only', async () => {
    renderSettings(viewer);

    const name = await screen.findByLabelText('Name');
    expect(name).toBeDisabled();
    expect(screen.getByLabelText('Description')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent('New versions need MEMBER; deleting needs ADMIN.');
    expect(screen.queryByRole('button', { name: 'Delete problem' })).not.toBeInTheDocument();
  });
});
