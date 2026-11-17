import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../core/api/http';
import type { CompositionView, DeriveDraft, DeriveResult } from '../../../core/api/types';
import { readCompositionFragment } from '../../../core/utils/sphere/composition-fragment';
import { RESULT, S1 } from '../../../../test/fixtures/jobs';
import { DeriveCompositionDialog } from './DeriveCompositionDialog';
import type { DeriveSource } from './deriveModel';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  derive: vi.fn(),
  get: vi.fn(),
  version: vi.fn(),
}));
vi.mock('../../../core/utils/composition/api', () => ({ compositionsApi: api }));

const RUN = '00000000-0000-4000-8000-0000000000a1';

const composition = (slug: string, name: string, latest: string | null): CompositionView => ({
  id: `composition-${slug}`,
  slug,
  name,
  description: '',
  kind: 'workflow',
  archived: false,
  visibility: 'private',
  organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' },
  created_by_id: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  version_count: latest ? 3 : 0,
  latest_version: latest
    ? {
        id: `${slug}-v3`,
        ordinal: 3,
        label: latest,
        values_status: 'verified',
        verified: true,
        created_at: '2026-10-01T00:00:00Z',
      }
    : null,
});

const FLEET = composition('fleet-routing', 'Fleet routing', '1.2.0');

const CONTENT = [
  "syntaxVersion: '1.0'",
  'composition: fleet-plan',
  'version: 1.0.0',
  'kind: workflow',
  'problem:',
  '  ref: isa-demo/problems/checkout-flow@2',
  '  compilation: sha256-9',
  'workflow:',
  '  seq: [t1, t2, t3]',
  'binding:',
  '  t1:',
  '    candidate: c2',
  'values:',
  '  cost:',
  '    value: 7.0',
  '    unit: EUR',
  'evidence:',
  `  run: ${RUN}`,
  '  point: 1',
  '',
].join('\n');

const DRAFT: DeriveDraft = {
  content: CONTENT,
  document: { composition: 'fleet-plan', version: '1.0.0' },
  values: { cost: { value: 7, unit: 'EUR' }, latency: { value: 560, unit: 'ms' } },
  diagnostics: [
    {
      code: 'c2y_compilation_toolchain_changed',
      message: 'The run was compiled by another release, which reads the problem alike.',
      severity: 'info',
      path: 'problem.compilation',
      pointer: '/problem/compilation',
      span: { line: 7, column: 16, end_line: 7, end_column: 24 },
    },
  ],
};

const sealedAs = (label: string) =>
  ({
    version: { label },
    evaluation: {},
    derivation: {},
    diagnostics: [],
  }) as unknown as DeriveResult;

function Where() {
  const where = useLocation();
  return <output data-testid="where">{where.pathname + where.search + where.hash}</output>;
}

const where = () => screen.getByTestId('where').textContent ?? '';

function renderDialog(
  solutions: readonly unknown[] = RESULT.solutions,
  source: DeriveSource = { run: RUN, solutions }
) {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={[`/app/isa-demo/runs/${RUN}`]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <DeriveCompositionDialog org="isa-demo" source={source} onClose={onClose} />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
  return { onClose, dialog: screen.getByRole('dialog', { name: 'Derive a composition' }) };
}

/** A binding of checkout-flow@2, as the calculator or the configurator hands it over, into `composition` when given. */
const BOUND = { revision: 'checkout-flow@2', binding: { t1: 'c2', t2: 'catalog/c7' } };
const renderBinding = (composition?: CompositionView) =>
  renderDialog([], { ...BOUND, ...(composition ? { composition } : {}) });

const click = (scope: HTMLElement, name: string) =>
  fireEvent.click(within(scope).getByRole('button', { name }));
const refused = (
  status: number,
  code: string,
  message = 'refused',
  extra: Record<string, unknown> = {}
) => Object.assign(new HttpError(status, message), { code, ...extra });

/** Step 1 into a new composition named `name`, then step 2. */
async function intoNew(dialog: HTMLElement, name = 'Fleet plan') {
  await waitFor(() => expect(api.list).toHaveBeenCalled());
  fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: name } });
  click(dialog, 'Next');
  await within(dialog).findByLabelText('Version label');
}

describe('Deriving a composition from a run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue({ compositions: [FLEET], total: 1, limit: 200, offset: 0 });
    api.create.mockImplementation(async (_org: string, body: { slug: string; name: string }) =>
      composition(body.slug, body.name, null)
    );
    api.derive.mockImplementation(
      async (_org: string, _slug: string, body: { seal: boolean; version: string }) =>
        body.seal
          ? { created: true, result: sealedAs(body.version) }
          : { created: false, result: DRAFT }
    );
  });

  it('walks the three steps into a new composition: where, which solution and label, then the preview it seals', async () => {
    const { dialog } = renderDialog();
    expect(api.list).toHaveBeenCalledWith('isa-demo', {
      archived: false,
      sort: 'updated',
      limit: 200,
    });
    expect(
      within(dialog).getByRole('list', { name: 'Steps' }).querySelector('[aria-current="step"]')
    ).toHaveTextContent('Where');

    // Where: a new composition, its address taken from the name, and its kind.
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Fleet plan' } });
    expect(within(dialog).getByLabelText('Address')).toHaveValue('fleet-plan');
    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: 'workflow' } });
    click(dialog, 'Next');

    // What: the run's solutions as its result lists them, and the first label of a new composition.
    const table = await within(dialog).findByRole('region', { name: 'Solutions of the run' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map(cell => cell.textContent)
    ).toEqual(['Solution', 'cost', 'latency', 'Score']);
    expect(
      within(table)
        .getAllByRole('row')
        .slice(1)
        .map(row => row.textContent)
    ).toEqual(['Solution 19.54200.3, 0.4', 'Solution 275600.2, 0.55']);
    expect(within(dialog).getByLabelText('Version label')).toHaveValue('1.0.0');
    fireEvent.click(within(table).getByRole('radio', { name: 'Solution 2' }));
    expect(api.create).not.toHaveBeenCalled();
    click(dialog, 'Preview');

    // The composition is made when the preview is asked for; the preview is the document, its values and what deriving found.
    const source = await within(dialog).findByRole('region', { name: 'Derived composition.yaml' });
    expect(api.create).toHaveBeenCalledWith('isa-demo', {
      slug: 'fleet-plan',
      name: 'Fleet plan',
      kind: 'workflow',
      description: '',
    });
    expect(api.derive).toHaveBeenCalledWith('isa-demo', 'fleet-plan', {
      run: RUN,
      point: 1,
      version: '1.0.0',
      seal: false,
    });
    expect(source).toHaveTextContent('candidate: c2');
    expect(source).toHaveAttribute('data-language', 'yaml');
    expect(
      within(dialog).getByText(
        /Solution 2 as version 1\.0\.0 of fleet-plan\. Nothing is stored until you seal it\./
      )
    ).toBeInTheDocument();
    const values = within(dialog).getByRole('region', { name: 'Values' });
    expect(values).toHaveTextContent('These values will be verified: Verified');
    expect(
      within(values)
        .getAllByRole('definition')
        .map(item => item.textContent)
    ).toEqual(['7 EUR', '560 ms']);
    const findings = within(dialog).getByRole('region', { name: 'Findings' });
    expect(findings).toHaveTextContent('The run was compiled by another release');
    expect(findings).toHaveTextContent('Line 7, column 16');

    // Seal: the same request but `seal`, so the sealed bytes are the previewed ones; the new version opens in Versions.
    click(dialog, 'Seal 1.0.0');
    await waitFor(() =>
      expect(where()).toBe('/compositions/isa-demo/fleet-plan/versions?version=1.0.0')
    );
    expect(api.derive).toHaveBeenCalledTimes(2);
    expect(api.derive.mock.calls[1]).toEqual([
      'isa-demo',
      'fleet-plan',
      { ...api.derive.mock.calls[0][2], seal: true },
    ]);
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it('derives into a composition of the organization at the next minor of its latest label, and opens the preview as a draft', async () => {
    const { dialog } = renderDialog([S1]);
    await waitFor(() =>
      expect(
        within(dialog).getByRole('radio', { name: 'A composition of this organization' })
      ).toBeEnabled()
    );
    fireEvent.click(
      within(dialog).getByRole('radio', { name: 'A composition of this organization' })
    );
    expect(within(dialog).getByLabelText('Composition')).toHaveValue('fleet-routing');
    expect(
      within(dialog).getByRole('option', { name: 'Fleet routing (fleet-routing) · latest 1.2.0' })
    ).toBeInTheDocument();
    click(dialog, 'Next');

    // One solution: no table to choose from.
    expect(await within(dialog).findByText('The run’s solution is derived.')).toBeInTheDocument();
    expect(
      within(dialog).queryByRole('region', { name: 'Solutions of the run' })
    ).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('Version label')).toHaveValue('1.3.0');
    click(dialog, 'Preview');
    await within(dialog).findByRole('region', { name: 'Derived composition.yaml' });
    expect(api.create).not.toHaveBeenCalled();
    expect(api.derive).toHaveBeenCalledWith('isa-demo', 'fleet-routing', {
      run: RUN,
      point: 0,
      version: '1.3.0',
      seal: false,
    });

    click(dialog, 'Open as draft');
    await waitFor(() =>
      expect(where()).toMatch(/^\/editor\?source=isa-demo%2Ffleet-routing#composition=/)
    );
    expect(readCompositionFragment(where().slice(where().indexOf('#')))).toEqual({
      status: 'ok',
      yaml: CONTENT,
    });
    expect(api.derive).toHaveBeenCalledTimes(1);
  });

  it('keeps a label written by hand, refuses one that is not a version, and says when the bytes were already sealed', async () => {
    api.derive.mockImplementation(
      async (_org: string, _slug: string, body: { seal: boolean; version: string }) =>
        body.seal
          ? { created: false, result: sealedAs(body.version) }
          : { created: false, result: DRAFT }
    );
    const { dialog } = renderDialog();
    await intoNew(dialog);
    fireEvent.change(within(dialog).getByLabelText('Version label'), {
      target: { value: 'first' },
    });
    click(dialog, 'Preview');
    expect(
      await within(dialog).findByText('A label is a Semantic Versioning number, such as 1.0.0.')
    ).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
    expect(api.derive).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('Version label'), {
      target: { value: '0.1.0' },
    });
    click(dialog, 'Preview');
    await within(dialog).findByRole('region', { name: 'Derived composition.yaml' });
    click(dialog, 'Back');
    expect(within(dialog).getByLabelText('Version label')).toHaveValue('0.1.0');
    click(dialog, 'Preview');
    await within(dialog).findByRole('region', { name: 'Derived composition.yaml' });
    expect(api.create).toHaveBeenCalledTimes(1);
    click(dialog, 'Seal 0.1.0');
    await waitFor(() =>
      expect(where()).toBe('/compositions/isa-demo/fleet-plan/versions?version=0.1.0')
    );
  });

  it('says an address in use beside the address, and a label taken by another document beside the label', async () => {
    api.create.mockRejectedValueOnce(
      refused(409, 'slug_conflict', 'That composition slug is in use in this organization.')
    );
    const { dialog } = renderDialog();
    await intoNew(dialog, 'Fleet routing');
    click(dialog, 'Preview');
    expect(
      await within(dialog).findByText(
        'fleet-routing is in use in this organization. Choose another address.'
      )
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Address')).toHaveAttribute('aria-invalid', 'true');
    expect(api.derive).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('Address'), { target: { value: 'fleet-plan' } });
    click(dialog, 'Next');
    await within(dialog).findByLabelText('Version label');
    click(dialog, 'Preview');
    await within(dialog).findByRole('region', { name: 'Derived composition.yaml' });

    api.derive.mockRejectedValueOnce(
      refused(409, 'version_label_taken', 'Version 1.0.0 already holds another content.')
    );
    click(dialog, 'Seal 1.0.0');
    expect(
      await within(dialog).findByText('1.0.0 already holds another document. Choose another label.')
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Version label')).toHaveAttribute('aria-invalid', 'true');
    expect(where()).toBe(`/app/isa-demo/runs/${RUN}`);
  });

  it('lists the findings of a solution that cannot be derived, and says what a VIEWER, a gone run and a busy toolchain get', async () => {
    const { dialog } = renderDialog();
    await intoNew(dialog);
    api.derive.mockRejectedValueOnce(
      refused(422, 'derivation_invalid', 'The binding cannot be derived.', {
        diagnostics: [
          {
            code: 'c2y_run_point_invalid',
            message: 'The run has no solution 1 that is a binding.',
            pointer: '/point',
          },
        ],
      })
    );
    click(dialog, 'Preview');
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent(
      'This solution can’t be written as a composition (422 · derivation_invalid). The gateway found:'
    );
    expect(within(alert).getByRole('list', { name: 'What the gateway found' })).toHaveTextContent(
      'The run has no solution 1 that is a binding. /point c2y_run_point_invalid'
    );

    api.derive.mockRejectedValueOnce(refused(403, 'organization_forbidden'));
    click(dialog, 'Preview');
    expect(
      await within(dialog).findByText(
        'Deriving a composition needs MEMBER in this organization (403 · organization_forbidden).'
      )
    ).toBeInTheDocument();

    api.derive.mockRejectedValueOnce(refused(404, 'not_found'));
    click(dialog, 'Preview');
    expect(
      await within(dialog).findByText(
        'The run or the composition is not there any more, or you can’t read it (404 · not_found).'
      )
    ).toBeInTheDocument();

    api.derive.mockRejectedValueOnce(refused(429, 'composition_busy', 'busy', { retryAfter: 1 }));
    click(dialog, 'Preview');
    expect(
      await within(dialog).findByText(
        'The toolchain is busy (429 · composition_busy). Try again in 1 s.'
      )
    ).toBeInTheDocument();
    // The composition was made once, before the first refusal; each retry goes to it.
    expect(api.create).toHaveBeenCalledTimes(1);
    expect(api.derive.mock.calls.every(call => call[1] === 'fleet-plan')).toBe(true);

    click(dialog, 'Back');
    expect(within(dialog).getByLabelText('Composition')).toHaveValue('fleet-plan');
    expect(
      within(dialog).getByText('fleet-plan was created for this derivation.')
    ).toBeInTheDocument();
  });

  it('offers only a new composition when the organization has none, and closes on Cancel', async () => {
    api.list.mockResolvedValue({ compositions: [], total: 0, limit: 200, offset: 0 });
    const { dialog, onClose } = renderDialog();
    await waitFor(() => expect(api.list).toHaveBeenCalled());
    expect(
      within(dialog).getByRole('radio', { name: 'A composition of this organization' })
    ).toBeDisabled();
    click(dialog, 'Next');
    expect(within(dialog).getByText('Give the new composition a name.')).toBeInTheDocument();
    click(dialog, 'Cancel');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Deriving a composition from a binding of a problem version', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue({ compositions: [FLEET], total: 1, limit: 200, offset: 0 });
    api.create.mockImplementation(async (_org: string, body: { slug: string; name: string }) =>
      composition(body.slug, body.name, null)
    );
    api.derive.mockImplementation(
      async (_org: string, _slug: string, body: { seal: boolean; version: string }) =>
        body.seal
          ? { created: true, result: sealedAs(body.version) }
          : { created: false, result: DRAFT }
    );
  });

  it('starts at the label of the composition it is derived into, shows the binding, and seals the previewed request', async () => {
    const { dialog } = renderBinding(FLEET);

    expect(
      within(dialog).getByRole('list', { name: 'Steps' }).querySelector('[aria-current="step"]')
    ).toHaveTextContent('What');
    expect(dialog).toHaveTextContent('Into Fleet routing (fleet-routing).');
    const binding = within(dialog).getByRole('region', { name: 'Binding to derive' });
    expect(
      within(binding)
        .getAllByRole('row')
        .slice(1)
        .map(row => row.textContent)
    ).toEqual(['t1c2', 't2catalog/c7']);
    expect(binding).toHaveTextContent('On problem version checkout-flow@2.');
    expect(within(dialog).getByLabelText('Version label')).toHaveValue('1.3.0');

    click(dialog, 'Preview');
    await within(dialog).findByRole('region', { name: 'Derived composition.yaml' });
    expect(api.create).not.toHaveBeenCalled();
    expect(api.derive).toHaveBeenCalledWith('isa-demo', 'fleet-routing', {
      ...BOUND,
      version: '1.3.0',
      seal: false,
    });
    expect(
      within(dialog).getByText(/^The binding as version 1\.3\.0 of fleet-routing\./)
    ).toBeInTheDocument();

    click(dialog, 'Seal 1.3.0');
    await waitFor(() =>
      expect(where()).toBe('/compositions/isa-demo/fleet-routing/versions?version=1.3.0')
    );
    expect(api.derive.mock.calls[1]).toEqual([
      'isa-demo',
      'fleet-routing',
      { ...BOUND, version: '1.3.0', seal: true },
    ]);
  });

  it('can go into a new composition instead, and words the refusals for a binding', async () => {
    const { dialog } = renderBinding(FLEET);
    click(dialog, 'Back');
    fireEvent.click(within(dialog).getByRole('radio', { name: 'A new composition' }));
    await intoNew(dialog, 'Fleet plan');
    expect(within(dialog).getByLabelText('Version label')).toHaveValue('1.0.0');

    api.derive.mockRejectedValueOnce(
      refused(422, 'derivation_invalid', 'The binding cannot be derived.', {
        diagnostics: [
          {
            code: 'c2y_candidate_unknown',
            message: 'The problem has no candidate c9 for t1.',
            pointer: '/binding/t1',
          },
        ],
      })
    );
    click(dialog, 'Preview');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This binding can’t be written as a composition (422 · derivation_invalid). The gateway found:'
    );
    expect(api.derive).toHaveBeenCalledWith('isa-demo', 'fleet-plan', {
      ...BOUND,
      version: '1.0.0',
      seal: false,
    });

    api.derive.mockRejectedValueOnce(refused(404, 'not_found'));
    click(dialog, 'Preview');
    expect(
      await within(dialog).findByText(
        'The problem version or the composition is not there any more, or you can’t read it (404 · not_found).'
      )
    ).toBeInTheDocument();
  });

  it('starts at the first step when no composition is given', async () => {
    const { dialog } = renderBinding();
    expect(
      within(dialog).getByRole('list', { name: 'Steps' }).querySelector('[aria-current="step"]')
    ).toHaveTextContent('Where');
    await intoNew(dialog);
    expect(within(dialog).getByRole('region', { name: 'Binding to derive' })).toBeInTheDocument();
  });
});

describe('Deriving the points of a study front, one composition each', () => {
  const POINTS = [
    {
      key: 'k1',
      label: 'P1',
      detail: 'checkout-flow version 1 · cell 0',
      run: 'run-1',
      point: 0,
      slug: 'checkout-flow-p1',
      name: 'checkout-flow P1',
    },
    {
      key: 'k2',
      label: 'P2',
      detail: 'checkout-flow version 1 · cell 3',
      run: 'run-2',
      point: 2,
      slug: 'checkout-flow-p2',
      name: 'checkout-flow P2',
    },
  ];

  function renderBatch() {
    const onClose = vi.fn();
    const onDerived = vi.fn();
    render(
      <MemoryRouter>
        <DeriveCompositionDialog
          org="isa-demo"
          source={{ points: POINTS }}
          onClose={onClose}
          onDerived={onDerived}
        />
      </MemoryRouter>
    );
    return {
      onClose,
      onDerived,
      dialog: screen.getByRole('dialog', { name: 'Derive compositions' }),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    api.create.mockImplementation(async (_org: string, body: { slug: string; name: string }) =>
      composition(body.slug, body.name, null)
    );
    api.derive.mockImplementation(
      async (_org: string, slug: string, body: { version: string }) => ({
        created: true,
        result: { ...sealedAs(body.version), version: { id: `${slug}-v1`, label: body.version } },
      })
    );
  });

  it('creates each composition with the chosen kind, seals each point as 1.0.0 and reports each to the page', async () => {
    const { dialog, onDerived } = renderBatch();
    expect(api.list).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: 'workflow' } });
    click(dialog, 'Derive 2 compositions');

    await within(dialog).findByText('2 of 2 points hold a composition.');
    expect(api.create.mock.calls).toEqual([
      [
        'isa-demo',
        { slug: 'checkout-flow-p1', name: 'checkout-flow P1', kind: 'workflow', description: '' },
      ],
      [
        'isa-demo',
        { slug: 'checkout-flow-p2', name: 'checkout-flow P2', kind: 'workflow', description: '' },
      ],
    ]);
    expect(api.derive.mock.calls[1]).toEqual([
      'isa-demo',
      'checkout-flow-p2',
      { run: 'run-2', point: 2, version: '1.0.0', seal: true },
    ]);
    expect(onDerived).toHaveBeenCalledWith('k1', {
      slug: 'checkout-flow-p1',
      name: 'checkout-flow P1',
      version: { id: 'checkout-flow-p1-v1', label: '1.0.0' },
      created: true,
    });
    expect(onDerived).toHaveBeenCalledTimes(2);
    expect(within(dialog).queryByRole('button', { name: /^Retry/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeEnabled();
  });

  it('words each refusal on its own point and keeps going', async () => {
    api.create.mockRejectedValueOnce(refused(403, 'organization_forbidden'));
    api.derive.mockRejectedValueOnce(refused(409, 'version_label_taken'));
    const { dialog, onDerived } = renderBatch();
    click(dialog, 'Derive 2 compositions');

    await within(dialog).findByText(/^0 of 2 points hold a composition\. 2 failed:/);
    expect(within(dialog).getByLabelText('Result of P1')).toHaveTextContent(
      'Deriving a composition needs MEMBER in this organization (403 · organization_forbidden).'
    );
    expect(within(dialog).getByLabelText('Result of P2')).toHaveTextContent(
      '1.0.0 of checkout-flow-p2 already holds another document. Choose another address.'
    );
    expect(onDerived).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'Retry 2 points' })).toBeEnabled();
  });
});
