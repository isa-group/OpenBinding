import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RegisterEngine } from './RegisterEngine';

const ENGINE_DIGEST = `sha256-${'a'.repeat(64)}`;
const PROTOCOL_DIGEST = `sha256-${'b'.repeat(64)}`;
const REGISTRATION_DIGEST = `sha256-${'c'.repeat(64)}`;

const api = vi.hoisted(() => ({
  createEngine: vi.fn(),
  getBimProfile: vi.fn(),
  createEngineRegistration: vi.fn(),
  setEngineRegistrationCredential: vi.fn(),
}));

const auth = vi.hoisted(() => ({
  user: {
    id: 'alice-id',
    username: 'alice',
    email: 'alice@example.test',
    role: 'user',
    plan: 'free',
    is_active: true,
    created_at: '2026-01-01T00:00:00Z',
  },
}));

vi.mock('../../api/client', () => ({ apiClient: api }));
vi.mock('../../contexts/auth', () => ({ useAuth: () => auth }));

function deploymentOpenApi(): string {
  return JSON.stringify({
    openapi: '3.1.0',
    info: { title: 'Test deployment', version: '1.0.0' },
    'x-bim-protocol': 'bim-engine/v1',
    'x-bim-protocol-digest': PROTOCOL_DIGEST,
    paths: { '/internal/v1/binding-problems': { post: {} } },
  });
}

describe('Engine and EngineRegistration authoring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.createEngine.mockResolvedValue({
      namespace: 'alice',
      name: 'my-engine',
      version: '1.0.0',
      digest: ENGINE_DIGEST,
      status: 'private',
    });
    api.getBimProfile.mockResolvedValue({
      id: 'qos-binding/v1',
      output: { apiVersion: 'bim/v1', kind: 'BindingProblem', schemaDigest: ENGINE_DIGEST },
      protocol: 'bim-engine/v1',
      protocolDigest: PROTOCOL_DIGEST,
      digest: ENGINE_DIGEST,
    });
    api.createEngineRegistration.mockResolvedValue({
      namespace: 'alice',
      name: 'my-engine-deployment',
      version: '1.0.0',
      digest: REGISTRATION_DIGEST,
      status: 'private',
      active: false,
    });
    api.setEngineRegistrationCredential.mockImplementation(async (ref) => ref);
  });

  it('uses the exact Engine revision pins in the deployment manifest', async () => {
    api.createEngine.mockResolvedValueOnce({
      namespace: 'alice',
      name: 'my-engine',
      version: '1.0.0',
      digest: ENGINE_DIGEST,
      status: 'private',
    });
    render(<MemoryRouter><RegisterEngine /></MemoryRouter>);
    const editor = screen.getByLabelText('Engine manifest JSON') as HTMLTextAreaElement;
    const authored = JSON.parse(editor.value);
    authored.metadata.namespace = 'somebody-else';
    fireEvent.change(editor, { target: { value: JSON.stringify(authored) } });
    fireEvent.change(screen.getByLabelText(/HTTPS endpoint/i), {
      target: { value: 'https://solver.example' },
    });
    fireEvent.change(screen.getByLabelText('Deployment OpenAPI JSON'), {
      target: { value: deploymentOpenApi() },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save private Engine and deployment' }));

    await waitFor(() => expect(api.createEngineRegistration).toHaveBeenCalledOnce());
    expect(api.createEngine).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ namespace: 'alice' }),
      spec: expect.objectContaining({
        modes: expect.arrayContaining([
          expect.objectContaining({
            capabilities: expect.objectContaining({
              objectiveTypes: { selector: 'all' },
            }),
          }),
        ]),
      }),
    }));
    expect(api.createEngineRegistration).toHaveBeenCalledWith(expect.objectContaining({
      apiVersion: 'bim/v1',
      kind: 'EngineRegistration',
      metadata: { namespace: 'alice', name: 'my-engine-deployment', version: '1.0.0' },
      spec: expect.objectContaining({
        engine: {
          namespace: 'alice',
          name: 'my-engine',
          version: '1.0.0',
          digest: ENGINE_DIGEST,
        },
        protocol: {
          id: 'bim-engine/v1',
          mediaType: 'application/json',
          digest: PROTOCOL_DIGEST,
        },
        openapi: expect.objectContaining({
          openapi: '3.1.0',
          'x-bim-protocol-digest': PROTOCOL_DIGEST,
        }),
      }),
    }));
    expect(await screen.findByRole('heading', { name: 'alice/my-engine' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'EngineRegistration' })).toBeInTheDocument();
    expect(screen.getByText(REGISTRATION_DIGEST)).toBeInTheDocument();
  });

  it('validates the complete deployment before persisting the Engine', async () => {
    render(<MemoryRouter><RegisterEngine /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(/HTTPS endpoint/i), {
      target: { value: 'https://solver.example' },
    });
    fireEvent.change(screen.getByLabelText('Deployment OpenAPI JSON'), {
      target: { value: '{"openapi":"3.0.3"}' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Save private Engine and deployment' }));

    expect(await screen.findByText('The deployment OpenAPI document must declare openapi: 3.1.0.')).toBeInTheDocument();
    expect(api.getBimProfile).not.toHaveBeenCalled();
    expect(api.createEngine).not.toHaveBeenCalled();
    expect(api.createEngineRegistration).not.toHaveBeenCalled();
  });

  it('accepts an OpenAPI file and stores bearer credentials outside the manifest', async () => {
    render(<MemoryRouter><RegisterEngine /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText(/HTTPS endpoint/i), {
      target: { value: 'https://solver.example' },
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'bearer' } });
    fireEvent.change(screen.getByLabelText(/Credential/), { target: { value: 'secret-token' } });
    const file = new File([deploymentOpenApi()], 'openapi.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: vi.fn().mockResolvedValue(deploymentOpenApi()) });
    fireEvent.change(screen.getByLabelText(/Deployment OpenAPI 3.1 JSON/), {
      target: { files: [file] },
    });
    await waitFor(() => expect(screen.getByLabelText('Deployment OpenAPI JSON')).toHaveValue(deploymentOpenApi()));

    fireEvent.click(screen.getByRole('button', { name: 'Save private Engine and deployment' }));

    await waitFor(() => expect(api.setEngineRegistrationCredential).toHaveBeenCalledWith(
      expect.objectContaining({ digest: REGISTRATION_DIGEST }),
      'secret-token',
    ));
    const submitted = api.createEngineRegistration.mock.calls[0][0];
    expect(JSON.stringify(submitted)).not.toContain('secret-token');
  });
});
