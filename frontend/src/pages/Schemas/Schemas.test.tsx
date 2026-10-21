import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BIM_SCHEMA_KINDS, HttpError } from '../../api/client';
import { Schemas } from './Schemas';

const api = vi.hoisted(() => ({ getBimSchema: vi.fn() }));

vi.mock('../../api/client', async () => ({ ...await vi.importActual<typeof import('../../api/client')>('../../api/client'), apiClient: api }));

const applicationSchema = {
  $id: 'https://bim.dev/application',
  required: ['spec'],
  properties: {
    apiVersion: { const: 'qos-binding/v1' },
    spec: {
      type: 'object',
      required: ['tasks', 'workflow'],
      properties: {
        tasks: { type: 'object', description: 'Task ids and the capability each needs', additionalProperties: { type: 'string' } },
        workflow: {
          type: 'object',
          properties: {
            kind: { enum: ['sequence', 'parallel', 'exclusive', 'repeat'] },
            count: { type: 'integer', minimum: 1, description: 'Repetitions' },
            latency: { type: 'number', unit: 'ms', description: 'Latency of the block' },
          },
        },
      },
    },
  },
};

const protocolSchema = {
  protocol: 'bim-engine/v1',
  digest: `sha256-${'f1e2d3c4'.repeat(8)}`,
  openapi: {
    paths: { '/internal/v1/binding-problems': { post: { summary: 'Solve a compiled problem' } } },
    components: { schemas: { Solution: { type: 'object', required: ['termination'], properties: { termination: { enum: ['OPTIMAL', 'FEASIBLE'] } } } } },
  },
};

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/language/schemas/:kind" element={<Schemas />} /></Routes>
    </MemoryRouter>,
  );
}

describe('schema reference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getBimSchema.mockImplementation(async (kind: string) => (kind === 'engine-contract' ? protocolSchema : applicationSchema));
  });

  it('opens the kind the menu links to, whatever the case of the address', async () => {
    renderAt('/language/schemas/application');

    expect(await screen.findByRole('heading', { level: 2, name: 'Application' })).toBeInTheDocument();
    expect(api.getBimSchema).toHaveBeenCalledWith('Application');
    expect(screen.getByRole('heading', { level: 1, name: 'Schemas' })).toBeInTheDocument();
    expect(screen.getByText(/Tasks, typed metrics and the native or externally represented workflow/)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Language sections' })).toHaveTextContent('Schemas');
  });

  it('lists every kind and marks the current one', async () => {
    renderAt('/language/schemas/Application');
    await screen.findByRole('tree', { name: 'Application fields' });
    const kinds = screen.getByRole('navigation', { name: 'Kinds' });
    expect(within(kinds).getAllByRole('link')).toHaveLength(BIM_SCHEMA_KINDS.length);
    expect(within(kinds).getByRole('link', { name: /^Application/ })).toHaveAttribute('aria-current', 'page');
    expect(within(kinds).getByRole('link', { name: /^CandidateCatalog/ })).toHaveAttribute('href', '/language/schemas/CandidateCatalog');
    expect(within(kinds).getByRole('link', { name: /^Engine protocol/ })).toHaveAttribute('href', '/language/schemas/engine-contract');

    fireEvent.change(within(kinds).getByRole('searchbox', { name: 'Filter kinds' }), { target: { value: 'engine' } });
    expect(within(kinds).getAllByRole('link').map((link) => link.textContent)).toEqual([
      expect.stringMatching(/^Engine/), expect.stringMatching(/^EngineRegistration/), expect.stringMatching(/^Engine protocol/),
    ]);
  });

  it('draws the fields as a tree with required marks, units, allowed values and limits, not as JSON', async () => {
    renderAt('/language/schemas/Application');
    const tree = await screen.findByRole('tree', { name: 'Application fields' });

    expect(within(tree).getAllByText('REQUIRED')).toHaveLength(3);
    expect(within(tree).getByText('ms')).toBeInTheDocument();
    for (const choice of ['sequence', 'parallel', 'exclusive', 'repeat']) expect(within(tree).getByText(choice)).toBeInTheDocument();
    expect(within(tree).getByText('at least 1')).toBeInTheDocument();
    expect(within(tree).getByText('Task ids and the capability each needs')).toBeInTheDocument();
    const count = within(tree).getByText('count');
    expect(count.closest('[role="treeitem"]')).toHaveAttribute('aria-level', '3');
    expect(screen.getByText('Schema identity').closest('div')).toHaveTextContent('https://bim.dev/application');
    expect(screen.getByText('Root fields').closest('div')).toHaveTextContent('2');
    expect(document.body.textContent).not.toContain('"properties"');
  });

  it('collapses, expands and toggles branches', async () => {
    renderAt('/language/schemas/Application');
    const tree = await screen.findByRole('tree', { name: 'Application fields' });
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(8);

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(2);
    fireEvent.click(within(tree).getByRole('button', { name: 'Expand spec' }));
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(4);
    expect(within(tree).getByRole('treeitem', { name: /spec/ })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(8);
  });

  it('finds a field and copies its path', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderAt('/language/schemas/Application');
    const tree = await screen.findByRole('tree', { name: 'Application fields' });

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a field' }), { target: { value: 'count' } });
    const items = within(tree).getAllByRole('treeitem');
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining('spec'), expect.stringContaining('workflow'), expect.stringContaining('count'),
    ]);
    fireEvent.click(within(items[2]).getByRole('button', { name: 'Copy path' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/spec/workflow/count'));
    expect(await within(tree).findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a field' }), { target: { value: 'zzz' } });
    expect(await screen.findByText('No field matches “zzz”.')).toBeInTheDocument();
  });

  it('answers 404 for an unknown kind and offers the valid ones', async () => {
    renderAt('/language/schemas/Placment');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Unknown kind “Placment” (404)');
    expect(alert).toHaveTextContent('There’s no schema with that name. Valid kinds:');
    expect(within(alert).getAllByRole('link')).toHaveLength(BIM_SCHEMA_KINDS.length);
    expect(within(alert).getByRole('link', { name: 'Placement' })).toHaveAttribute('href', '/language/schemas/Placement');
    expect(api.getBimSchema).not.toHaveBeenCalled();
  });

  it('reports a schema that cannot be loaded and retries', async () => {
    api.getBimSchema.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    renderAt('/language/schemas/Application');
    expect(await screen.findByText('The Application schema couldn’t be loaded (HTTP 503).')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('tree', { name: 'Application fields' })).toBeInTheDocument();
  });

  it('shows the engine protocol with its digest, schemas and calls', async () => {
    renderAt('/language/schemas/engine-contract');

    expect(await screen.findByRole('heading', { level: 2, name: 'engine-contract' })).toBeInTheDocument();
    expect(screen.getByText('Engine protocol', { selector: '.schemas-alias' })).toBeInTheDocument();
    expect(api.getBimSchema).toHaveBeenCalledWith('engine-contract');
    expect(screen.getAllByText('bim-engine/v1').length).toBeGreaterThan(0);
    expect(screen.getByText(protocolSchema.digest)).toBeInTheDocument();
    expect(screen.getByRole('tree', { name: 'engine-contract fields' })).toHaveTextContent('Solution');
    const calls = screen.getByRole('region', { name: 'Calls of the engine protocol' });
    expect(calls).toHaveTextContent('POST');
    expect(calls).toHaveTextContent('/internal/v1/binding-problems');
    expect(calls).toHaveTextContent('Solve a compiled problem');
  });

  it('keeps the exact document as a secondary download', async () => {
    const createObjectURL = vi.fn(() => 'blob:schema');
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    renderAt('/language/schemas/Application');

    await screen.findByRole('tree', { name: 'Application fields' });
    fireEvent.click(screen.getByRole('button', { name: /Download JSON/ }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('links a kind to a package that uses it and to the other language screens', async () => {
    renderAt('/language/schemas/Application');
    await screen.findByRole('tree', { name: 'Application fields' });
    expect(screen.getByRole('link', { name: /Validate a package that uses it/ })).toHaveAttribute('href', '/workbench?example=demo%2F02_parallel');
    expect(screen.getByRole('link', { name: 'Open examples' })).toHaveAttribute('href', '/examples');
    expect(screen.getByRole('link', { name: 'BindingProblem' })).toHaveAttribute('href', '/language/schemas/BindingProblem');
  });
});
