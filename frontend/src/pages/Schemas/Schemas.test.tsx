import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Schemas } from './Schemas';

const api = vi.hoisted(() => ({ getBimSchema: vi.fn() }));

vi.mock('../../api/client', () => ({ apiClient: api }));

describe('BIM v1 schema catalogue', () => {
  const renderSchemas = () => render(<MemoryRouter><Schemas /></MemoryRouter>);

  beforeEach(() => {
    vi.clearAllMocks();
    api.getBimSchema.mockImplementation(async (kind: string) => (
      kind === 'engine-contract'
        ? { protocol: 'bim-engine/v1', digest: `sha256-${'f'.repeat(64)}`, openapi: {} }
        : { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `https://bim.dev/${kind}` }
    ));
  });

  it('loads modular resource and manifest schemas by their real kind', async () => {
    renderSchemas();
    await waitFor(() => expect(api.getBimSchema).toHaveBeenCalledWith('Instance'));

    fireEvent.change(screen.getByLabelText('BIM v1 contract'), {
      target: { value: 'EngineRegistration' },
    });

    await waitFor(() => expect(api.getBimSchema).toHaveBeenCalledWith('EngineRegistration'));
    expect(screen.getByRole('heading', { name: 'EngineRegistration' })).toBeInTheDocument();
    expect(screen.getByText(/pinned to one exact Engine/i)).toBeInTheDocument();
  });

  it('exposes the pinned engine protocol as a distinct contract', async () => {
    renderSchemas();
    fireEvent.change(screen.getByLabelText('BIM v1 contract'), {
      target: { value: 'engine-contract' },
    });

    expect(await screen.findByText('bim-engine/v1')).toBeInTheDocument();
    expect(api.getBimSchema).toHaveBeenCalledWith('engine-contract');
  });
});
