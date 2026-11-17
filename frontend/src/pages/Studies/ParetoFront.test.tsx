import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import fmsDiff from '../../test/fixtures/core/fms.diff.json';
import { cellsFixture, frontsFixture } from '../../test/fixtures/studies';
import { ParetoFront } from './ParetoFront';
import { frontPointOf, frontTables, matchesSearch } from './frontModel';

const api = vi.hoisted(() => ({
  create: vi.fn(),
  derive: vi.fn(),
  get: vi.fn(),
  version: vi.fn(),
  content: vi.fn(),
  list: vi.fn(),
}));
const language = vi.hoisted(() => ({ diffDocuments: vi.fn() }));
vi.mock('../../modules/core/utils/composition/api', () => ({
  compositionsApi: api,
  languageApi: language,
}));

const cells = cellsFixture();
const fronts = frontsFixture();

const refused = (status: number, code: string, message = 'refused') =>
  Object.assign(new HttpError(status, message), { code });
const sealed = (slug: string) => ({
  version: { id: `${slug}-v1`, label: '1.0.0' },
  evaluation: {},
  derivation: {},
  diagnostics: [],
});

function renderFront(canDerive = true) {
  return render(
    <MemoryRouter>
      <ParetoFront
        org="isa-demo"
        orgName="ISA Demo Group"
        fronts={fronts}
        cells={cells}
        cellHref={id => `/cells/${id}`}
        canDerive={canDerive}
      />
    </MemoryRouter>
  );
}

const front = () => screen.getByRole('region', { name: 'Pareto front' });
const table = (version: number) =>
  within(front()).getByRole('region', { name: `Front of checkout-flow · version ${version}` });
const select = (label: string) =>
  fireEvent.click(within(front()).getByRole('checkbox', { name: `Select ${label}` }));
const dialog = () => screen.getByRole('dialog', { name: 'Derive compositions' });
const resultOf = (label: string) => within(dialog()).getByLabelText(`Result of ${label}`);

describe('the study front as tables', () => {
  it('numbers the points of a problem across its fronts, in the gateway’s order, and gives each a default address', () => {
    const tables = frontTables(fronts, cells);
    expect(tables.map(item => item.title)).toEqual([
      'checkout-flow · version 1',
      'checkout-flow · version 2',
    ]);
    expect(
      tables.flatMap(item => item.rows.map(row => `${row.label}:${row.cell?.ordinal}`))
    ).toEqual(['P1:0', 'P2:3', 'P3:4', 'P4:6']);
    const point = frontPointOf(tables[1].rows[0], tables[1].objectives);
    expect(point).toMatchObject({
      label: 'P3',
      run: cells[4].job_id,
      point: 0,
      slug: 'checkout-flow-p3',
      name: 'checkout-flow P3',
    });
    expect(point.detail).toBe(
      'checkout-flow version 2 · cell 4 · evolutionary · cost 0.104, latency 420'
    );
    expect(matchesSearch(tables[0].rows[1], tables[0].objectives, 'random 412')).toBe(true);
    expect(matchesSearch(tables[0].rows[1], tables[0].objectives, 'evolutionary')).toBe(false);
  });

  it('names a version’s fronts by their objectives when it has more than one', () => {
    const [first] = fronts;
    const tables = frontTables(
      [
        first,
        {
          ...first,
          objectives: ['cost'],
          points: [{ ...first.points[0], objectives: { cost: 0.112 } }],
        },
      ],
      cells
    );
    expect(tables.map(item => item.title)).toEqual([
      'checkout-flow · version 1 · Cost, Latency',
      'checkout-flow · version 1 · Cost',
    ]);
  });
});

describe('the Pareto front of a study run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.create.mockImplementation(async (_org: string, body: { slug: string; name: string }) => ({
      slug: body.slug,
      name: body.name,
      latest_version: null,
    }));
    api.derive.mockImplementation(async (_org: string, slug: string) => ({
      created: true,
      result: sealed(slug),
    }));
    api.content.mockImplementation(async (_org: string, slug: string) => `composition: ${slug}\n`);
    language.diffDocuments.mockResolvedValue(structuredClone(fmsDiff));
  });

  it('shows one table per front from the gateway, with each point’s cell, engine, seed and objectives', () => {
    renderFront();

    expect(
      within(front()).getByText('4 points · computed by the gateway · lower is better')
    ).toBeInTheDocument();
    const rows = within(table(1)).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent(/P1\s*#0\s*evolutionary\s*seed 1\s*0\.112\s*440\s*—/);
    expect(within(rows[2]).getByRole('link', { name: '#3' })).toHaveAttribute(
      'href',
      `/cells/${cells[3].id}`
    );
    expect(within(table(2)).getAllByRole('row')).toHaveLength(3);
  });

  it('searches, filters by engine and walks the focused point with Prev and Next', () => {
    renderFront();
    const focus = () => within(front()).getByRole('group', { name: 'Focused point' });

    expect(focus()).toHaveTextContent('P1 1 of 4');
    expect(within(focus()).getByRole('button', { name: 'Prev' })).toBeDisabled();
    fireEvent.click(within(focus()).getByRole('button', { name: 'Next' }));
    expect(focus()).toHaveTextContent('P2 2 of 4');
    expect(focus()).toHaveTextContent(
      'checkout-flow version 1 · cell 3 · random-search · seed 2 · solution 1 of its run'
    );
    expect(within(table(1)).getAllByRole('row')[2]).toHaveAttribute('aria-current', 'true');

    fireEvent.change(within(front()).getByRole('combobox', { name: 'Engine on the front' }), {
      target: { value: 'bim.builtin/evolutionary@1.0.0' },
    });
    expect(within(front()).getByText('Showing 2 of 4')).toBeInTheDocument();
    expect(focus()).toHaveTextContent('P1 1 of 2');
    fireEvent.change(within(front()).getByRole('searchbox', { name: 'Search the front' }), {
      target: { value: '0.104' },
    });
    expect(
      within(front()).queryByRole('region', { name: 'Front of checkout-flow · version 1' })
    ).not.toBeInTheDocument();
    expect(focus()).toHaveTextContent('P3');
    fireEvent.change(within(front()).getByRole('searchbox', { name: 'Search the front' }), {
      target: { value: 'nothing like it' },
    });
    expect(within(front()).getByText('No point matches this search.')).toBeInTheDocument();
  });

  it('derives one composition per selected point, one after another, reports a failure exactly and retries only it', async () => {
    api.derive.mockImplementation(async (_org: string, slug: string) => {
      if (slug === 'checkout-flow-p2')
        throw refused(503, 'toolchain_unavailable', 'The toolchain is not reachable.');
      return { created: true, result: sealed(slug) };
    });
    renderFront();
    select('P1');
    select('P2');
    select('P3');
    fireEvent.click(within(front()).getByRole('button', { name: 'Derive compositions' }));

    expect(within(dialog()).getByLabelText('Address of P1')).toHaveValue('checkout-flow-p1');
    expect(within(dialog()).getByLabelText('Address of P3')).toHaveValue('checkout-flow-p3');
    fireEvent.change(within(dialog()).getByLabelText('Address of P3'), {
      target: { value: 'fast-checkout' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Derive 3 compositions' }));

    await within(dialog()).findByText(/^2 of 3 points hold a composition\./);
    expect(within(dialog()).getByRole('status')).toHaveTextContent(
      '2 of 3 points hold a composition. 1 failed: P2 (checkout-flow-p2): The composition couldn’t be derived (503 · toolchain_unavailable): The toolchain is not reachable.'
    );
    expect(api.create.mock.calls.map(call => call[1].slug)).toEqual([
      'checkout-flow-p1',
      'checkout-flow-p2',
      'fast-checkout',
    ]);
    expect(api.derive.mock.calls.map(call => [call[1], call[2]])).toEqual([
      ['checkout-flow-p1', { run: cells[0].job_id, point: 0, version: '1.0.0', seal: true }],
      ['checkout-flow-p2', { run: cells[3].job_id, point: 0, version: '1.0.0', seal: true }],
      ['fast-checkout', { run: cells[4].job_id, point: 0, version: '1.0.0', seal: true }],
    ]);
    expect(resultOf('P1')).toHaveTextContent('Created; 1.0.0 sealed. Open checkout-flow-p1 1.0.0');
    expect(
      within(resultOf('P1')).getByRole('link', { name: 'Open checkout-flow-p1 1.0.0' })
    ).toHaveAttribute('href', '/compositions/isa-demo/checkout-flow-p1/versions?version=1.0.0');
    expect(within(dialog()).getByLabelText('Address of P1')).toBeDisabled();

    // The retry derives only P2, into the composition the batch already made for it.
    api.derive.mockImplementation(async (_org: string, slug: string) => ({
      created: true,
      result: sealed(slug),
    }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Retry 1 point' }));
    await within(dialog()).findByText('3 of 3 points hold a composition.');
    expect(api.create).toHaveBeenCalledTimes(3);
    expect(api.derive).toHaveBeenCalledTimes(4);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));

    expect(
      within(table(1)).getByRole('link', { name: 'checkout-flow-p1 1.0.0' })
    ).toBeInTheDocument();
    expect(within(table(2)).getByRole('link', { name: 'fast-checkout 1.0.0' })).toBeInTheDocument();
  });

  it('takes over an address only when its composition is empty or already holds the point', async () => {
    api.create.mockRejectedValue(refused(409, 'slug_conflict', 'That composition slug is in use.'));
    api.get.mockImplementation(async (_org: string, slug: string) => ({
      value: {
        slug,
        latest_version: slug === 'checkout-flow-p1' ? null : { id: `${slug}-v1`, label: '1.0.0' },
      },
      etag: null,
    }));
    api.version.mockImplementation(async (_org: string, slug: string) => ({
      derivation: {
        run: { id: slug === 'checkout-flow-p2' ? cells[3].job_id : 'another-run' },
        point: 0,
      },
    }));
    api.derive.mockImplementation(async (_org: string, slug: string) => ({
      created: slug === 'checkout-flow-p1',
      result: sealed(slug),
    }));
    renderFront();
    select('P1');
    select('P2');
    select('P3');
    fireEvent.click(within(front()).getByRole('button', { name: 'Derive compositions' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Derive 3 compositions' }));

    await within(dialog()).findByText(/^2 of 3 points hold a composition\./);
    expect(resultOf('P1')).toHaveTextContent(
      'Derived into the composition already at this address; 1.0.0 sealed.'
    );
    expect(resultOf('P2')).toHaveTextContent('1.0.0 already held this point.');
    expect(resultOf('P3')).toHaveTextContent(
      'checkout-flow-p3 is another composition’s address in this organization. Choose another address.'
    );
    expect(api.version).toHaveBeenCalledWith('isa-demo', 'checkout-flow-p2', '1.0.0');
    expect(api.derive.mock.calls.map(call => call[1])).toEqual([
      'checkout-flow-p1',
      'checkout-flow-p2',
    ]);

    // Another address for P3, and the retry creates it there.
    api.create.mockImplementation(async (_org: string, body: { slug: string }) => ({
      slug: body.slug,
      latest_version: null,
    }));
    fireEvent.change(within(dialog()).getByLabelText('Address of P3'), {
      target: { value: 'checkout-flow-p3b' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Retry 1 point' }));
    await within(dialog()).findByText('3 of 3 points hold a composition.');
    expect(api.derive.mock.calls.at(-1)?.[1]).toBe('checkout-flow-p3b');
  });

  it('refuses addresses that are not slugs or that two points share, before deriving anything', () => {
    renderFront();
    select('P1');
    select('P2');
    fireEvent.click(within(front()).getByRole('button', { name: 'Derive compositions' }));
    fireEvent.change(within(dialog()).getByLabelText('Address of P2'), {
      target: { value: 'checkout-flow-p1' },
    });
    fireEvent.change(within(dialog()).getByLabelText('Address of P1'), {
      target: { value: 'Not A Slug' },
    });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Derive 2 compositions' }));

    expect(
      within(dialog()).getByText('Lowercase letters, numbers and hyphens, at most 64.')
    ).toBeInTheDocument();
    fireEvent.change(within(dialog()).getByLabelText('Address of P1'), {
      target: { value: 'checkout-flow-p1' },
    });
    expect(within(dialog()).getAllByText('Another point has checkout-flow-p1 too.')).toHaveLength(
      2
    );
    expect(api.create).not.toHaveBeenCalled();
  });

  it('compares two derived points through the gateway’s document diff', async () => {
    renderFront();
    expect(within(front()).getByRole('button', { name: 'Compare two' })).toBeDisabled();
    select('P1');
    select('P4');
    expect(
      within(front()).getByText('Both points need a composition to be compared: derive them first.')
    ).toBeInTheDocument();
    fireEvent.click(within(front()).getByRole('button', { name: 'Derive compositions' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Derive 2 compositions' }));
    await within(dialog()).findByText('2 of 2 points hold a composition.');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));

    fireEvent.click(within(front()).getByRole('button', { name: 'Compare two' }));
    const compare = screen.getByRole('dialog', { name: 'Compare two points' });
    expect(compare).toHaveTextContent(
      'P1 · checkout-flow-p1 1.0.0 compared with P4 · checkout-flow-p4 1.0.0'
    );
    const binding = await within(compare).findByRole('region', { name: /^Binding/ });
    expect(within(binding).getByRole('button', { name: /T1/ })).toHaveTextContent('Changed');
    expect(api.content).toHaveBeenCalledWith('isa-demo', 'checkout-flow-p1', 'checkout-flow-p1-v1');
    expect(api.content).toHaveBeenCalledWith('isa-demo', 'checkout-flow-p4', 'checkout-flow-p4-v1');
    expect(language.diffDocuments).toHaveBeenCalledWith(
      'composition: checkout-flow-p1\n',
      'composition: checkout-flow-p4\n'
    );

    fireEvent.click(
      within(compare).getByRole('button', { name: 'Show the two texts line by line' })
    );
    expect(within(compare).getByRole('button', { name: 'Hide the two texts' })).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });

  it('says when the two compositions cannot be compared, and retries', async () => {
    language.diffDocuments.mockRejectedValueOnce(refused(429, 'rate_limited'));
    renderFront();
    select('P1');
    select('P2');
    fireEvent.click(within(front()).getByRole('button', { name: 'Derive compositions' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Derive 2 compositions' }));
    await within(dialog()).findByText('2 of 2 points hold a composition.');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Done' }));
    fireEvent.click(within(front()).getByRole('button', { name: 'Compare two' }));

    const compare = screen.getByRole('dialog', { name: 'Compare two points' });
    expect(
      await within(compare).findByText(
        'The two compositions couldn’t be compared (429 · rate_limited).'
      )
    ).toBeInTheDocument();
    fireEvent.click(within(compare).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(within(compare).getByRole('region', { name: /^Binding/ })).toBeInTheDocument()
    );
  });

  it('lets a viewer read the front and compare nothing it has not derived', () => {
    renderFront(false);
    expect(
      within(front()).queryByRole('button', { name: 'Derive compositions' })
    ).not.toBeInTheDocument();
    expect(
      within(front()).getByText('Read-only: deriving compositions needs MEMBER in ISA Demo Group.')
    ).toBeInTheDocument();
    expect(
      within(front()).queryByRole('button', { name: 'Derive this point' })
    ).not.toBeInTheDocument();
  });
});
