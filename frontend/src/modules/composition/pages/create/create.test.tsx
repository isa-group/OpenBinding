import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../../api/client';
import { addressNow, orgNode, renderModule } from '../../../../test/moduleKit';
import CreateCompositionPage from '.';

const api = vi.hoisted(() => ({ create: vi.fn(), seal: vi.fn(), get: vi.fn(), update: vi.fn() }));
const language = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('../../../core/utils/composition/api', () => ({
  compositionsApi: api,
  languageApi: language,
}));

beforeEach(() => vi.clearAllMocks());

const tree = [
  orgNode('acme', { name: 'Acme', effective_role: 'MEMBER' }),
  orgNode('beta', { name: 'Beta', effective_role: 'VIEWER' }),
];

describe('/compositions/new', () => {
  it('preselects the organization of `?org=`, and starts an empty composition in the editor', async () => {
    api.create.mockResolvedValue({});
    renderModule(<CreateCompositionPage />, {
      tree,
      entry: '/compositions/new?org=acme',
      routes: { '/compositions/:org/:composition/:tab': <p>editor</p> },
    });
    expect(await screen.findByRole('link', { name: 'Back to organization' })).toHaveAttribute(
      'href',
      '/orgs/acme/compositions'
    );
    fireEvent.change(screen.getByLabelText('Composition name'), {
      target: { value: 'Order desk' },
    });
    // Publishing needs ADMIN: a MEMBER's composition starts private.
    expect(screen.getByRole('radio', { name: 'Public' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Write it in the editor' }));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith('acme', {
        slug: 'order-desk',
        name: 'Order desk',
        kind: 'application',
        description: '',
      })
    );
    await waitFor(() => expect(addressNow()).toBe('/compositions/acme/order-desk/editor'));
  });

  it('says a taken name in words, and creates nothing else', async () => {
    api.create.mockRejectedValue(
      Object.assign(new HttpError(409, 'Conflict'), { code: 'slug_conflict' })
    );
    renderModule(<CreateCompositionPage />, { tree, entry: '/compositions/new?org=acme' });
    await screen.findByRole('link', { name: 'Back to organization' });
    fireEvent.change(screen.getByLabelText('Composition name'), {
      target: { value: 'Order desk' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Write it in the editor' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'order-desk is in use in Acme. Choose another name.'
    );
  });

  it('asks for the organization first', async () => {
    renderModule(<CreateCompositionPage />, { tree, entry: '/compositions/new' });
    fireEvent.change(await screen.findByLabelText('Composition name'), { target: { value: 'X' } });
    fireEvent.click(screen.getByRole('button', { name: 'Write it in the editor' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose the organization the composition belongs to.'
    );
    expect(api.create).not.toHaveBeenCalled();
  });
});
