import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, renderOrgScreen } from '../../features/workspace/testKit';
import type { CompositionView } from '../../shared/api/types';
import { CompositionList } from './CompositionList';

const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));

vi.mock('../../entities/composition/api', () => ({ compositionsApi: api }));

const member = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const viewer = org('read-lab', { name: 'Read Lab', effective_role: 'VIEWER' });

function compositionOf(
  slug: string,
  name: string,
  over: Partial<CompositionView> = {}
): CompositionView {
  return {
    id: `composition-${slug}`,
    slug,
    name,
    description: '',
    kind: 'application',
    archived: false,
    visibility: 'private',
    organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' },
    created_by_id: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    version_count: 0,
    latest_version: null,
    ...over,
  };
}

const orderDesk = compositionOf('order-desk', 'Order desk', {
  visibility: 'public',
  version_count: 3,
  latest_version: {
    id: 'v3',
    ordinal: 3,
    label: '1.2.0',
    values_status: 'declared',
    verified: false,
    created_at: '2026-10-01T00:00:00Z',
  },
});
const fleet = compositionOf('fleet-routing', 'Fleet routing', {
  kind: 'workflow',
  version_count: 2,
  latest_version: {
    id: 'v2',
    ordinal: 2,
    label: '1.1.0',
    values_status: 'verified',
    verified: true,
    created_at: '2026-09-20T00:00:00Z',
  },
});
const empty = compositionOf('draft', 'Draft');
const stale = compositionOf('legacy-intake', 'Legacy intake', {
  kind: 'pipeline',
  version_count: 1,
  latest_version: {
    id: 'v1',
    ordinal: 1,
    label: '1.0.0',
    values_status: 'verified',
    verified: false,
    created_at: '2026-09-02T00:00:00Z',
  },
});

const page = (compositions: CompositionView[]) => ({
  compositions,
  total: compositions.length,
  limit: 200,
  offset: 0,
});

function Where() {
  const where = useLocation();
  return <output data-testid="where">{where.pathname + where.search}</output>;
}

const where = () => screen.getByTestId('where').textContent;

function renderList(organization = member, search = '') {
  return renderOrgScreen(
    <>
      <CompositionList />
      <Where />
    </>,
    {
      path: '/app/:org/compositions',
      url: `/app/${organization.slug}/compositions${search}`,
      organizations: [organization],
    }
  );
}

describe('Composition list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.list.mockResolvedValue(page([orderDesk, fleet, empty]));
  });

  it('lists the compositions with their kind, latest version, values, visibility and versions', async () => {
    renderList();

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Compositions' })
    ).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledWith('isa-demo', {
      kind: undefined,
      archived: false,
      q: undefined,
      sort: 'updated',
      limit: 200,
    });
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const first = within(rows[0]);
    expect(first.getByRole('link', { name: 'Order desk' })).toHaveAttribute(
      'href',
      '/app/isa-demo/compositions/order-desk'
    );
    expect(first.getByText('Application')).toBeInTheDocument();
    expect(first.getByText('1.2.0')).toBeInTheDocument();
    expect(first.getByText('Declared')).toBeInTheDocument();
    expect(first.getByText('Public')).toBeInTheDocument();
    expect(first.getByText('3')).toBeInTheDocument();
    const second = within(rows[1]);
    expect(second.getByText('Workflow')).toBeInTheDocument();
    expect(second.getByText('Verified')).toBeInTheDocument();
    expect(second.getByText('Private')).toBeInTheDocument();
    expect(within(rows[2]).getByText('No version yet')).toBeInTheDocument();
  });

  it('shows the value status of each latest version: verified, declared or unverified, and none without a version', async () => {
    api.list.mockResolvedValue(page([fleet, orderDesk, stale, empty]));
    renderList();

    const rows = within(await screen.findByRole('table'))
      .getAllByRole('row')
      .slice(1);
    const values = rows.map(row => within(row).getAllByRole('cell')[2]);
    expect(values.map(cell => cell.textContent)).toEqual([
      'Verified',
      'Declared',
      'Unverified',
      '—',
    ]);
    // A linked version its current evaluation no longer verifies says so; it is not shown as verified.
    expect(within(rows[2]).queryByText('Verified')).toBeNull();
  });

  it('filters by kind and state through the address, and asks the gateway for them', async () => {
    renderList();
    await screen.findByRole('table');

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Kind' })).getByRole('button', { name: 'Workflow' })
    );
    await waitFor(() => expect(where()).toBe('/app/isa-demo/compositions?kind=workflow'));
    await waitFor(() =>
      expect(api.list).toHaveBeenLastCalledWith(
        'isa-demo',
        expect.objectContaining({ kind: 'workflow', archived: false })
      )
    );
    expect(
      within(screen.getByRole('group', { name: 'Kind' })).getByRole('button', { name: 'Workflow' })
    ).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(
      within(screen.getByRole('group', { name: 'State' })).getByRole('button', { name: 'Archived' })
    );
    await waitFor(() =>
      expect(where()).toBe('/app/isa-demo/compositions?kind=workflow&archived=true')
    );
    await waitFor(() =>
      expect(api.list).toHaveBeenLastCalledWith(
        'isa-demo',
        expect.objectContaining({ kind: 'workflow', archived: true })
      )
    );
  });

  it('searches by text after typing stops', async () => {
    renderList();
    await screen.findByRole('table');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search compositions' }), {
      target: { value: 'desk' },
    });
    await waitFor(() => expect(where()).toBe('/app/isa-demo/compositions?q=desk'));
    await waitFor(() =>
      expect(api.list).toHaveBeenLastCalledWith('isa-demo', expect.objectContaining({ q: 'desk' }))
    );
  });

  it('invites a member to start the first composition when there is none', async () => {
    api.list.mockResolvedValue(page([]));
    renderList();

    expect(await screen.findByText('No compositions yet')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'New composition' }).at(-1)!);
    await waitFor(() => expect(where()).toBe('/app/isa-demo/compositions?create=composition'));
    expect(screen.getByRole('dialog', { name: 'New composition' })).toBeInTheDocument();
  });

  it('says nothing matches when the filters leave nothing', async () => {
    api.list.mockResolvedValue(page([]));
    renderList(member, '?kind=system');

    expect(await screen.findByText('No composition matches')).toBeInTheDocument();
    expect(screen.getByText(/the kind System/)).toBeInTheDocument();
    expect(screen.queryByText('No compositions yet')).toBeNull();
  });

  it('lets a viewer read, and offers no creation even at the dialog address', async () => {
    api.list.mockResolvedValue(page([]));
    renderList(viewer, '?create=composition');

    expect(await screen.findByText('No compositions yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New composition' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('note')).toHaveTextContent(
      'creating them and sealing versions need MEMBER'
    );
  });

  it('creates a composition and opens it, saying it has no version yet', async () => {
    api.create.mockResolvedValue(compositionOf('order-flow', 'Order flow', { kind: 'pipeline' }));
    renderList(member, '?create=composition');

    const dialog = await screen.findByRole('dialog', { name: 'New composition' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Order flow' } });
    expect(within(dialog).getByLabelText('Address')).toHaveValue('order-flow');
    fireEvent.change(within(dialog).getByLabelText('Kind'), { target: { value: 'pipeline' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create composition' }));

    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith('isa-demo', {
        slug: 'order-flow',
        name: 'Order flow',
        kind: 'pipeline',
        description: '',
      })
    );
    // The composition page is another screen: the list's route no longer matches.
    expect(await screen.findByText('elsewhere')).toBeInTheDocument();
  });

  it('says beside the address when it is taken, and creates nothing', async () => {
    api.create.mockRejectedValue(
      Object.assign(new HttpError(409, 'That composition slug is in use in this organization.'), {
        code: 'slug_conflict',
      })
    );
    renderList(member, '?create=composition');

    const dialog = await screen.findByRole('dialog', { name: 'New composition' });
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Order desk' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create composition' }));

    expect(
      await within(dialog).findByText(
        'order-desk is in use in ISA Demo Group. Choose another address.'
      )
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Address')).toHaveAttribute('aria-invalid', 'true');
    expect(where()).toBe('/app/isa-demo/compositions?create=composition');
  });

  it('reports a list the gateway would not give', async () => {
    api.list.mockRejectedValue(new HttpError(503, 'unavailable'));
    renderList();

    expect(await screen.findByText(/Compositions couldn’t be loaded/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
