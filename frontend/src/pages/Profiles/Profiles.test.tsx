import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserProfile } from '../../api/auth';
import { HttpError, type BimDialect, type BimProfile, type RegisteredResource } from '../../api/client';
import { AuthContext } from '../../contexts/auth';
import { Profiles } from './Profiles';

const api = vi.hoisted(() => ({
  getProfiles: vi.fn(),
  getDialects: vi.fn(),
  getRegisteredResources: vi.fn(),
  getRegisteredResourceContent: vi.fn(),
}));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));

const DIGEST = `sha256-${'a1b2c3d4'.repeat(8)}`;
const adapter = { id: 'qos-binding-profile', version: '1.0.0', binaryDigest: DIGEST };

function profile(id: string, description: string): BimProfile {
  const output = { apiVersion: 'bim/v1', kind: 'BindingProblem', schemaDigest: DIGEST, engineProtocol: 'bim-engine/v1' };
  return {
    apiVersion: 'bim/v1',
    kind: 'Profile',
    metadata: { namespace: 'bim.builtin', name: id.split('/')[0], version: '1.0.0', description },
    spec: {
      deterministic: true,
      roles: {
        application: {
          resourceTypes: [
            { apiVersion: 'qos-binding/v1', kind: 'Application', minimum: 1, maximum: 1 },
            { apiVersion: 'qos-binding/v1', kind: 'RoutingOverlay', minimum: 0, maximum: 1 },
          ],
          extensionTypes: 'installed',
        },
        candidateCatalog: { resourceTypes: [{ apiVersion: 'qos-binding/v1', kind: 'CandidateCatalog', minimum: 1 }], extensionTypes: 'none' },
      },
      output,
      capabilityVocabulary: { dimensions: { workflowNodes: { values: ['sequence'], openValues: false }, irExtensions: { values: [], openValues: true } } },
      limitVocabulary: ['maxTasks', 'maxCandidates'],
      adapter,
    },
    id,
    digest: DIGEST,
    output,
    protocol: 'bim-engine/v1',
    protocolDigest: DIGEST,
  };
}

const dialect = (name: string, profiles: string[], kind: string): BimDialect => ({
  apiVersion: 'bim/v1',
  kind: 'Dialect',
  metadata: { namespace: 'bim.builtin', name, version: '1.2.0' },
  spec: {
    compatibleProfiles: profiles,
    resourceTypes: [{ apiVersion: 'qos-binding-placement/v1', kind, roles: ['application'], mediaType: 'application/json', schemaDigest: DIGEST }],
    extensionPoints: [],
    irFeatures: [{ dimension: 'irExtensions', value: 'qos-binding-placement/v1' }],
    adapter: { id: 'bim-placement', version: '1.0.0', binaryDigest: DIGEST },
  },
  digest: DIGEST,
});

const resource: RegisteredResource = {
  namespace: 'isa-demo', name: 'checkout-catalog', version: '2.0.0', digest: DIGEST, role: 'candidateCatalog',
  apiVersion: 'qos-binding/v1', kind: 'CandidateCatalog', dialect: 'qos-binding/v1', mediaType: 'application/json', status: 'published',
};

const lucia: UserProfile = { id: 'u', username: 'lucia', email: 'l@example.test', role: 'user', is_active: true, plan: 'BASIC', created_at: '2026-01-01T00:00:00Z' };

function renderPage(user: UserProfile | null = null) {
  return render(
    <MemoryRouter>
      <AuthContext.Provider value={{ user, loading: false, signIn: vi.fn(), register: vi.fn(), signOut: vi.fn(), refresh: vi.fn(), isAdmin: false }}>
        <Profiles />
      </AuthContext.Provider>
    </MemoryRouter>,
  );
}

describe('language: profiles, dialects and registered resources', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getProfiles.mockResolvedValue([profile('qos-binding/v1', 'Deterministic scalar-QoS binding'), profile('other-binding/v1', 'Another family')]);
    api.getDialects.mockResolvedValue([dialect('placement', ['qos-binding/v1'], 'Placement'), dialect('other-dialect', ['other-binding/v1'], 'Thing')]);
    api.getRegisteredResources.mockResolvedValue([resource]);
  });

  it('draws the chain from instance to engine and links each step', async () => {
    renderPage();
    const chain = screen.getByRole('region', { name: 'How the pieces connect' });
    const steps = within(chain).getAllByRole('link');
    expect(steps.map((step) => step.getAttribute('href'))).toEqual([
      '/language/schemas/Instance', '/language', '/language/schemas/Application', '/language/schemas/Dialect', '/language/schemas/BindingProblem', '/engines',
    ]);
    expect(within(chain).getByText('Instance')).toBeInTheDocument();
    expect(within(chain).getByText('Exact revision')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Language sections' })).toHaveTextContent('Profiles & dialects');
    await screen.findByRole('heading', { name: 'Profiles' });
  });

  it('lists the profiles with their roles and the dialects with their resource types', async () => {
    renderPage();
    const profiles = await screen.findByRole('region', { name: 'Profiles' });
    const row = within(profiles).getByRole('row', { name: /^qos-binding\/v1/ });
    expect(within(row).getByRole('link', { name: 'application' })).toHaveAttribute('href', '/language/schemas/Application');
    expect(within(row).getByText('workflowNodes')).toBeInTheDocument();
    expect(row).toHaveTextContent('qos-binding-profile@1.0.0');

    const dialects = screen.getByRole('region', { name: 'Dialects' });
    const placement = within(dialects).getByRole('row', { name: /^placement\/v1/ });
    expect(within(placement).getByRole('link', { name: 'Placement' })).toHaveAttribute('href', '/language/schemas/Placement');
    expect(placement).toHaveTextContent('irExtensions=qos-binding-placement/v1');
    expect(placement).toHaveTextContent('qos-binding/v1');
  });

  it('shows each profile contract with cardinalities, output, vocabularies and limits', async () => {
    renderPage();
    const contract = await screen.findByRole('article', { name: 'Contract of qos-binding/v1' });
    const roles = within(contract).getByRole('region', { name: 'Roles and cardinalities' });
    expect(roles).toHaveTextContent('Application exactly 1');
    expect(roles).toHaveTextContent('RoutingOverlay 0 or 1');
    expect(roles).toHaveTextContent('CandidateCatalog 1 or more');
    expect(within(contract).getByText('bim/v1 · BindingProblem')).toBeInTheDocument();
    expect(within(contract).getByText('irExtensions · open')).toBeInTheDocument();
    expect(within(contract).getByText('workflowNodes · closed')).toBeInTheDocument();
    expect(within(contract).getByText('maxCandidates')).toBeInTheDocument();
  });

  it('narrows profiles and dialects to the chosen profile', async () => {
    renderPage();
    const profiles = await screen.findByRole('region', { name: 'Profiles' });
    expect(within(profiles).getAllByRole('row')).toHaveLength(3);

    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'other-binding/v1' } });
    expect(within(screen.getByRole('region', { name: 'Profiles' })).getAllByRole('row')).toHaveLength(2);
    const dialects = screen.getByRole('region', { name: 'Dialects' });
    expect(within(dialects).getByText('other-dialect/v1')).toBeInTheDocument();
    expect(within(dialects).queryByText('placement/v1')).not.toBeInTheDocument();
  });

  it('offers the extensions page only to a signed-in account', async () => {
    const { unmount } = renderPage();
    await screen.findByRole('heading', { name: 'Profiles' });
    expect(screen.queryByRole('link', { name: 'Submit a dialect or resource' })).not.toBeInTheDocument();
    unmount();

    renderPage(lucia);
    expect(await screen.findByRole('link', { name: 'Submit a dialect or resource' })).toHaveAttribute('href', '/language/extensions');
  });

  it('copies the exact reference of a registered resource', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderPage();

    const table = await screen.findByRole('region', { name: 'Registered resources' });
    expect(within(table).getByText('isa-demo/checkout-catalog@2.0.0')).toBeInTheDocument();
    expect(within(table).getByText('CandidateCatalog · candidateCatalog')).toBeInTheDocument();
    expect(within(table).getByText('Published')).toBeInTheDocument();
    fireEvent.click(within(table).getByRole('button', { name: 'Copy reference of isa-demo/checkout-catalog@2.0.0' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`isa-demo/checkout-catalog@2.0.0#${DIGEST}`));
    expect(await within(table).findByText('Copied')).toBeInTheDocument();
  });

  it('downloads a resource by all four pins, and explains a 404', async () => {
    const createObjectURL = vi.fn(() => 'blob:resource');
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    api.getRegisteredResourceContent.mockResolvedValueOnce(new TextEncoder().encode('{}').buffer);
    renderPage();

    const download = await screen.findByRole('button', { name: 'Download isa-demo/checkout-catalog@2.0.0' });
    fireEvent.click(download);
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(api.getRegisteredResourceContent).toHaveBeenCalledWith(resource);
    expect(createObjectURL).toHaveBeenCalled();

    api.getRegisteredResourceContent.mockRejectedValueOnce(new HttpError(404, 'Not Found'));
    fireEvent.click(download);
    expect(await screen.findByText('Resource not found (404).')).toBeInTheDocument();
    expect(screen.getByText(/fetched by all four fields: namespace, name, version and digest/)).toBeInTheDocument();
    click.mockRestore();
  });

  it('says so when no resource has been published', async () => {
    api.getRegisteredResources.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('No published registered resources yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Read the authoring reference' })).toHaveAttribute('href', '/language/schemas/Application');
  });

  it('keeps the diagram when the catalog fails and reloads on Retry', async () => {
    api.getProfiles.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    renderPage();
    expect(await screen.findByText(/The language catalog couldn’t be loaded \(HTTP 503\)\. The diagram above still works\./)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'How the pieces connect' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Profiles' })).toBeInTheDocument();
  });

  it('reports a registered-resources failure on its own', async () => {
    api.getRegisteredResources.mockRejectedValueOnce(new HttpError(500, 'boom'));
    renderPage();
    expect(await screen.findByRole('region', { name: 'Profiles' })).toBeInTheDocument();
    expect(await screen.findByText('The registered resources couldn’t be loaded (HTTP 500).')).toBeInTheDocument();
  });
});
