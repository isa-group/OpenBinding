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

const upload = async (container: HTMLElement, name = 'desk.yaml') => {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('no file input');
  const file = new File(['syntaxVersion: "1.0"\n'], name, { type: 'application/yaml' });
  fireEvent.change(input, { target: { files: [file] } });
  await screen.findByText(name);
  fireEvent.click(screen.getByRole('button', { name: 'Upload composition' }));
};

describe('/compositions/new', () => {
  it('preselects the organization of `?org=`, and writes a composition in the standalone editor there', async () => {
    renderModule(<CreateCompositionPage />, { tree, entry: '/compositions/new?org=acme' });
    expect(await screen.findByRole('link', { name: 'Back to organization' })).toHaveAttribute(
      'href',
      '/orgs/acme/compositions'
    );
    // Publishing needs ADMIN: a MEMBER's composition starts private.
    expect(screen.getByRole('radio', { name: 'Public' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Write it in the editor' })).toHaveAttribute(
      'href',
      '/editor?org=acme'
    );
  });

  it('creates the composition from a file and seals its first version', async () => {
    language.parse.mockResolvedValue({ document: { composition: 'desk', kind: 'workflow' } });
    api.create.mockResolvedValue({});
    api.seal.mockResolvedValue({ created: true, result: { version: { label: '1.0.0' } } });
    const { container } = renderModule(<CreateCompositionPage />, {
      tree,
      entry: '/compositions/new?org=acme',
      routes: { '/compositions/:org/:composition': <p>card</p> },
    });
    fireEvent.change(await screen.findByLabelText('Composition name'), {
      target: { value: 'Order desk' },
    });
    await upload(container);
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith('acme', {
        slug: 'order-desk',
        name: 'Order desk',
        kind: 'workflow',
        description: '',
      })
    );
    await waitFor(() => expect(addressNow()).toBe('/compositions/acme/order-desk'));
  });

  it('says a taken name in words', async () => {
    language.parse.mockResolvedValue({ document: { composition: 'desk', kind: 'workflow' } });
    api.create.mockRejectedValue(
      Object.assign(new HttpError(409, 'Conflict'), { code: 'slug_conflict' })
    );
    const { container } = renderModule(<CreateCompositionPage />, {
      tree,
      entry: '/compositions/new?org=acme',
    });
    fireEvent.change(await screen.findByLabelText('Composition name'), {
      target: { value: 'Order desk' },
    });
    await upload(container);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'order-desk is in use in Acme. Choose another name.'
    );
    expect(api.seal).not.toHaveBeenCalled();
  });

  it('asks for the organization first', async () => {
    const { container } = renderModule(<CreateCompositionPage />, {
      tree,
      entry: '/compositions/new',
    });
    fireEvent.change(await screen.findByLabelText('Composition name'), { target: { value: 'X' } });
    expect(screen.getByRole('link', { name: 'Write it in the editor' })).toHaveAttribute(
      'href',
      '/editor'
    );
    await upload(container);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Choose the organization the composition belongs to.'
    );
    expect(api.create).not.toHaveBeenCalled();
  });
});
