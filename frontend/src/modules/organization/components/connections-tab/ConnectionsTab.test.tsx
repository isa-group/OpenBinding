import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../core/api/http';
import ConnectionsTab from '.';
import { scopesText } from './scopes';

const api = vi.hoisted(() => ({ list: vi.fn(), putSphere: vi.fn(), removeSphere: vi.fn() }));
vi.mock('../../api/connectionsApi', () => ({ useConnectionsApi: () => api }));

const GOOD = `sk-${'a1'.repeat(32)}`;
const CONNECTED = {
  kind: 'sphere' as const,
  status: 'active' as const,
  username: 'sphere-lab',
  keyHint: 'a1a1',
  scopes: [
    { organizationId: 'x'.repeat(24), scope: 'MANAGEMENT' },
    { organizationId: 'y'.repeat(24), scope: 'MANAGEMENT' },
    { organizationId: 'z'.repeat(24), scope: 'VIEW' },
  ],
  validatedAt: '2026-11-18T10:00:00Z',
  expiresAt: null,
};

describe('ConnectionsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers a write-only key field, never filled, when the organization is not connected', async () => {
    api.list.mockResolvedValue([]);
    render(<ConnectionsTab org="isa-demo" />);
    const field = await screen.findByLabelText('SPHERE API key');
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'off');
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    fireEvent.change(field, { target: { value: 'sk-short' } });
    expect(
      screen.getByText('A SPHERE key is sk- followed by 64 hexadecimal characters.')
    ).toBeInTheDocument();
  });

  it('says SPHERE’s refusal in its own words and keeps the form', async () => {
    api.list.mockResolvedValue([]);
    api.putSphere.mockRejectedValue(
      Object.assign(new HttpError(422, 'The API key is not valid.'), {
        code: 'sphere_key_rejected',
      })
    );
    render(<ConnectionsTab org="isa-demo" />);
    fireEvent.change(await screen.findByLabelText('SPHERE API key'), { target: { value: GOOD } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(
      await screen.findByText('SPHERE refused the key: The API key is not valid.')
    ).toBeInTheDocument();
    expect(api.putSphere).toHaveBeenCalledWith('isa-demo', GOOD, null);
  });

  it('says whose key is connected and what it may act in, with only its hint', async () => {
    api.list.mockResolvedValue([CONNECTED]);
    render(<ConnectionsTab org="isa-demo" />);
    expect(await screen.findByText('sphere-lab')).toBeInTheDocument();
    expect(
      screen.getByText('MANAGEMENT on 2 organizations and VIEW on 1 organization')
    ).toBeInTheDocument();
    expect(screen.getByText('…a1a1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace the key' })).toBeInTheDocument();
    expect(screen.queryByLabelText('SPHERE API key')).toBeNull();
  });

  it('asks to replace a key SPHERE refused', async () => {
    api.list.mockResolvedValue([{ ...CONNECTED, status: 'invalid' }]);
    render(<ConnectionsTab org="isa-demo" />);
    expect(await screen.findByText('Refused by SPHERE')).toBeInTheDocument();
    expect(screen.getByText(/Replace it to read private pricings again/)).toBeInTheDocument();
  });

  it('replaces the key in a dialog, sending back the revision the last write answered', async () => {
    api.list.mockResolvedValue([]);
    api.putSphere.mockResolvedValue({ connection: CONNECTED, etag: '"c1"' });
    render(<ConnectionsTab org="isa-demo" />);
    fireEvent.change(await screen.findByLabelText('SPHERE API key'), { target: { value: GOOD } });
    api.list.mockResolvedValue([CONNECTED]);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Replace the key' }));
    const dialog = screen.getByRole('dialog', { name: 'Replace the SPHERE key' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const field = screen.getAllByLabelText('SPHERE API key').at(-1)!;
    expect(field).toHaveValue('');
    fireEvent.change(field, { target: { value: `sk-${'b2'.repeat(32)}` } });
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
    await waitFor(() =>
      expect(api.putSphere).toHaveBeenLastCalledWith('isa-demo', `sk-${'b2'.repeat(32)}`, '"c1"')
    );
  });

  it('words the scopes SPHERE reported, or that it reported none', () => {
    expect(scopesText(null)).toBe('SPHERE did not say which organizations the key may act in');
    expect(scopesText([])).toBe('No SPHERE organization');
  });
});
