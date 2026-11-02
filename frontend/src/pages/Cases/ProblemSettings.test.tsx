import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { caseOf, org, project, renderProjectScreen, revisionOf } from '../Project/testKit';
import { CaseDetail } from './CaseDetail';

const platform = vi.hoisted(() => ({ project: vi.fn(), case: vi.fn(), revisions: vi.fn(), deleteCase: vi.fn() }));
const cases = vi.hoisted(() => ({ updateCase: vi.fn() }));

vi.mock('../../api/platform', async () => ({ ...await vi.importActual<typeof import('../../api/platform')>('../../api/platform'), platformApi: platform }));
vi.mock('../../api/cases', () => ({ casesApi: cases }));

const member = org('member-lab', { name: 'Member Lab', effective_role: 'MEMBER' });
const viewer = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });
const qos = project('qos-benchmarks', { name: 'QoS Benchmarks' });
const checkout = caseOf('flujo-checkout', 'Flujo de checkout', { description: 'Payments with parallel stock and shipping.' });

const refusal = (status: number, code = 'refused') => Object.assign(new HttpError(status, 'refused'), { code });

function renderSettings(organization = member) {
  return renderProjectScreen(<CaseDetail />, {
    path: '/app/:org/:project/problems/:case/:tab?', url: `/app/${organization.slug}/qos-benchmarks/problems/flujo-checkout/settings`, organizations: [organization],
  });
}

// [utest->req~frontend-nav-problem-page~1]
describe('Settings tab of the problem page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.project.mockResolvedValue(qos);
    platform.case.mockResolvedValue(checkout);
    platform.revisions.mockResolvedValue([revisionOf(checkout, 1)]);
  });

  it('holds the name and the description, and saves both with the gateway', async () => {
    cases.updateCase.mockResolvedValue({ ...checkout, name: 'Checkout flow', description: 'Catalog grown to eight candidates.' });
    renderSettings();

    const name = await screen.findByLabelText('Name');
    expect(name).toHaveValue('Flujo de checkout');
    expect(screen.getByLabelText('Description')).toHaveValue('Payments with parallel stock and shipping.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(name, { target: { value: '  Checkout flow ' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '  Catalog grown to eight candidates.  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(cases.updateCase).toHaveBeenCalledWith('member-lab', 'qos-benchmarks', 'flujo-checkout', { name: 'Checkout flow', description: 'Catalog grown to eight candidates.' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    await waitFor(() => expect(platform.case).toHaveBeenCalledTimes(2));
  });

  it('keeps what was typed and says why when the gateway refuses', async () => {
    cases.updateCase.mockRejectedValue(refusal(403, 'forbidden'));
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
    expect(cases.updateCase).not.toHaveBeenCalled();
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
