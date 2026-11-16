import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import type { PublicCompositionList as PublicList } from '../../modules/core/api/types';
import { PublicCompositionList } from './PublicCompositionList';

const api = vi.hoisted(() => ({ publicList: vi.fn() }));

vi.mock('../../entities/composition/api', () => ({ compositionsApi: api }));

type Row = PublicList['compositions'][number];

/** How many compositions the page asks for at a time. */
const PUBLIC_PAGE_SIZE = 24;

function rowOf(org: string, slug: string, name: string, over: Partial<Row> = {}): Row {
  return {
    organization: { slug: org, name: org === 'lab-other' ? 'Other Lab' : 'ISA Demo Group' },
    slug,
    name,
    description: '',
    kind: 'application',
    latest_version: {
      label: '1.0.0',
      ordinal: 1,
      values_status: 'declared',
      verified: false,
      created_at: '2026-09-01T00:00:00Z',
    },
    version_count: 1,
    updated_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

const fleet = rowOf('lab-other', 'fleet-routing', 'Fleet routing', {
  kind: 'workflow',
  description: 'Plans the delivery routes of a fleet.',
  version_count: 2,
  updated_at: '2026-09-30T14:00:00Z',
  latest_version: {
    label: '1.1.0',
    ordinal: 2,
    values_status: 'verified',
    verified: true,
    created_at: '2026-09-30T14:00:00Z',
  },
});
const stale = rowOf('lab-other', 'stale-routing', 'Stale routing', {
  latest_version: {
    label: '2.0.0',
    ordinal: 3,
    values_status: 'verified',
    verified: false,
    created_at: '2026-09-01T00:00:00Z',
  },
  version_count: 3,
});
const orderDesk = rowOf('isa-demo', 'order-desk', 'Order desk');

const answer = (compositions: Row[], total = compositions.length, offset = 0): PublicList => ({
  compositions,
  total,
  limit: PUBLIC_PAGE_SIZE,
  offset,
});

function Where() {
  const where = useLocation();
  return <output data-testid="where">{where.pathname + where.search}</output>;
}

const where = () => screen.getByTestId('where').textContent;

function renderList(url = '/compositions') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route
          path="/compositions"
          element={
            <>
              <PublicCompositionList />
              <Where />
            </>
          }
        />
        <Route path="/c/:org/:composition" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
}

const cards = () =>
  within(screen.getByRole('region', { name: 'Public compositions' })).getAllByRole('article');

describe('Public compositions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.publicList.mockResolvedValue(answer([orderDesk, fleet, stale]));
  });

  it('lists every organization’s public compositions as cards that open their public page', async () => {
    renderList();

    expect(
      screen.getByRole('heading', { level: 1, name: 'Public compositions' })
    ).toBeInTheDocument();
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(api.publicList).toHaveBeenCalledWith({
      kind: undefined,
      q: undefined,
      limit: PUBLIC_PAGE_SIZE,
      offset: 0,
    });
    expect(screen.getByText('3 compositions')).toBeInTheDocument();

    const card = within(cards()[1]);
    expect(card.getByRole('heading', { level: 2, name: 'Fleet routing' })).toBeInTheDocument();
    expect(card.getByRole('link', { name: 'Fleet routing' })).toHaveAttribute(
      'href',
      '/c/lab-other/fleet-routing'
    );
    expect(card.getByText('Workflow · Other Lab')).toBeInTheDocument();
    expect(card.getByText('Plans the delivery routes of a fleet.')).toBeInTheDocument();
    expect(card.getByText('1.1.0')).toBeInTheDocument();
    expect(card.getByText(/of 2/)).toBeInTheDocument();
    expect(card.getByText('Verified')).toBeInTheDocument();
    expect(card.getByText('Sep 30, 2026')).toBeInTheDocument();
    // The value status of each latest version, from what the gateway stored: declared, verified, or linked and not verified.
    expect(within(cards()[0]).getByText('Declared')).toBeInTheDocument();
    expect(within(cards()[2]).getByText('Unverified')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();

    fireEvent.click(card.getByRole('link', { name: 'Fleet routing' }));
    expect(where()).toBe('/c/lab-other/fleet-routing');
  });

  it('says when nothing is public yet, and when nothing matches the filters', async () => {
    api.publicList.mockResolvedValue(answer([]));
    const { unmount } = renderList();
    expect(await screen.findByText('No public compositions yet')).toBeInTheDocument();
    unmount();

    renderList('/compositions?kind=system&q=desk');
    expect(await screen.findByText('No public composition matches')).toBeInTheDocument();
    expect(
      screen.getByText('Nothing public has the kind System and “desk” in its name or address.')
    ).toBeInTheDocument();
  });

  it('filters by kind and by text through the address, back to the first page', async () => {
    renderList('/compositions?page=2');
    await waitFor(() =>
      expect(api.publicList).toHaveBeenCalledWith({
        kind: undefined,
        q: undefined,
        limit: PUBLIC_PAGE_SIZE,
        offset: PUBLIC_PAGE_SIZE,
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    await waitFor(() => expect(where()).toBe('/compositions?kind=workflow'));
    await waitFor(() =>
      expect(api.publicList).toHaveBeenLastCalledWith({
        kind: 'workflow',
        q: undefined,
        limit: PUBLIC_PAGE_SIZE,
        offset: 0,
      })
    );
    expect(screen.getByRole('button', { name: 'Workflow' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    fireEvent.change(screen.getByLabelText('Search public compositions'), {
      target: { value: ' fleet ' },
    });
    await waitFor(() => expect(where()).toBe('/compositions?kind=workflow&q=fleet'));
    await waitFor(() =>
      expect(api.publicList).toHaveBeenLastCalledWith({
        kind: 'workflow',
        q: 'fleet',
        limit: PUBLIC_PAGE_SIZE,
        offset: 0,
      })
    );

    fireEvent.click(screen.getByRole('button', { name: 'All kinds' }));
    await waitFor(() => expect(where()).toBe('/compositions?q=fleet'));
  });

  it('pages through the compositions, the page in the address', async () => {
    api.publicList.mockImplementation(async ({ offset }: { offset: number }) =>
      answer([offset === 0 ? fleet : orderDesk], PUBLIC_PAGE_SIZE + 1, offset)
    );
    renderList();

    const paging = await screen.findByRole('navigation', { name: 'Pages' });
    expect(within(paging).getByText('Page 1 of 2')).toBeInTheDocument();
    expect(within(paging).queryByRole('link', { name: 'Previous' })).toBeNull();
    fireEvent.click(within(paging).getByRole('link', { name: 'Next' }));

    await waitFor(() => expect(where()).toBe('/compositions?page=2'));
    expect(api.publicList).toHaveBeenLastCalledWith({
      kind: undefined,
      q: undefined,
      limit: PUBLIC_PAGE_SIZE,
      offset: PUBLIC_PAGE_SIZE,
    });
    expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument();
    await waitFor(() => expect(within(cards()[0]).getByText('Order desk')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Previous' })).toHaveAttribute('href', '/compositions');
    expect(screen.queryByRole('link', { name: 'Next' })).toBeNull();
  });

  it('says a page past the last one lists nothing, and leads back to the first', async () => {
    api.publicList.mockResolvedValue(answer([], 3, PUBLIC_PAGE_SIZE * 4));
    renderList('/compositions?page=5');
    expect(await screen.findByText('Nothing on this page')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'First page' })).toHaveAttribute(
      'href',
      '/compositions'
    );
  });

  it('says when the list could not be read, and reads it again on Retry', async () => {
    api.publicList.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    renderList();
    expect(await screen.findByText(/Public compositions couldn’t be loaded/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(cards()).toHaveLength(3));
  });
});
