import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../../api/client';
import {
  memberOf,
  problemGateway,
  problemOf,
  renderProblemPage,
  versionOf,
} from '../../../../test/problemPage';
import ProblemCardPage from '../../pages/card';

const problems = vi.hoisted(() => ({ compilation: vi.fn(), ir: vi.fn(), remove: vi.fn() }));

vi.mock('../../../../api/problems', () => ({ problemsApi: problems }));

const member = memberOf('member-lab', 'MEMBER', 'Member Lab');
const viewer = memberOf('read-lab', 'VIEWER', 'Read Lab');
const admin = memberOf('qos-lab', 'ADMIN', 'QoS Lab');
const checkout = problemOf('flujo-checkout', 'Flujo de checkout', {
  description: 'Payments with parallel stock and shipping.',
});
const root = (org: string) => `/v1/organizations/${org}/problems/flujo-checkout`;

function renderSettings(organization = member, extra = {}) {
  const gateway = problemGateway(organization.slug, checkout, [versionOf(checkout, 1)], extra);
  renderProblemPage(<ProblemCardPage />, {
    url: `/problems/${organization.slug}/flujo-checkout/settings`,
    organizations: [organization],
    gateway,
  });
  return gateway;
}

describe('Settings tab of the problem page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    problems.compilation.mockRejectedValue(
      Object.assign(new HttpError(503, 'down'), { code: 'x' })
    );
  });

  it('holds the name and the description, and saves both with the gateway at the revision it read', async () => {
    const gateway = renderSettings(member, {
      [`PATCH ${root('member-lab')}`]: {
        body: { ...checkout, name: 'Checkout flow' },
        headers: { ETag: 'W/"2"' },
      },
    });

    const name = await screen.findByLabelText('Name');
    expect(name).toHaveValue('Flujo de checkout');
    expect(screen.getByLabelText('Description')).toHaveValue(
      'Payments with parallel stock and shipping.'
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    fireEvent.change(name, { target: { value: '  Checkout flow ' } });
    fireEvent.change(screen.getByLabelText('Description'), {
      target: { value: '  Catalog grown to eight candidates.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(gateway.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(true)
    );
    const [, init] = gateway.mock.calls.find(([, call]) => call?.method === 'PATCH')!;
    expect(JSON.parse(init.body)).toEqual({
      name: 'Checkout flow',
      description: 'Catalog grown to eight candidates.',
    });
    expect(init.headers['If-Match']).toBe('W/"1"');
    // The problem is read again once it is saved.
    await waitFor(() =>
      expect(
        gateway.mock.calls.filter(
          ([path, call]) => path === root('member-lab') && (call?.method ?? 'GET') === 'GET'
        )
      ).toHaveLength(2)
    );
  });

  it('keeps what was typed and says why when the gateway refuses', async () => {
    renderSettings(member, {
      [`PATCH ${root('member-lab')}`]: { status: 403, body: { code: 'forbidden', detail: 'No.' } },
    });

    fireEvent.change(await screen.findByLabelText('Description'), {
      target: { value: 'Another text' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'You need MEMBER in the organization to edit a problem (403 · forbidden). Nothing changed.'
    );
    expect(screen.getByLabelText('Description')).toHaveValue('Another text');
  });

  it('does not save a problem without a name', async () => {
    const gateway = renderSettings();

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: '   ' } });
    expect(screen.getByText('A problem needs a name.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(gateway.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('shows a VIEWER the name and the description, read-only', async () => {
    renderSettings(viewer);

    const name = await screen.findByLabelText('Name');
    expect(name).toBeDisabled();
    expect(screen.getByLabelText('Description')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(
      'New versions need MEMBER; deleting needs ADMIN.'
    );
    expect(screen.queryByRole('button', { name: 'Delete problem' })).not.toBeInTheDocument();
  });

  it('gives an ADMIN the danger zone, where the address typed deletes the problem', async () => {
    problems.remove.mockResolvedValue(undefined);
    renderSettings(admin);

    fireEvent.click(await screen.findByRole('button', { name: 'Delete problem' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete Flujo de checkout?' });
    const confirm = screen.getAllByRole('button', { name: 'Delete problem' }).at(-1)!;
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type flujo-checkout to confirm'), {
      target: { value: 'flujo-checkout' },
    });
    fireEvent.click(confirm);
    await waitFor(() => expect(problems.remove).toHaveBeenCalledWith('qos-lab', 'flujo-checkout'));
    expect(dialog).toBeDefined();
    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
  });
});
