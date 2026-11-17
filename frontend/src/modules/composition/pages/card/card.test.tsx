import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../../../api/client';
import type { CompositionVersionView, CompositionView } from '../../../core/api/types';
import fmsVersion from '../../../../test/fixtures/core/fms.version.json';
import { addressNow, fakeGateway, orgNode } from '../../../../test/moduleKit';
import { renderCompositionPage } from '../../../../test/compositionPage';
import CompositionCardPage from '.';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  allVersions: vi.fn(),
  version: vi.fn(),
  content: vi.fn(),
}));
vi.mock('../../../core/utils/composition/api', () => ({ compositionsApi: api, languageApi: {} }));

const composition: CompositionView = {
  id: '6b0c7f9e-0000-4000-8000-000000000001',
  slug: 'fleet-routing',
  name: 'Fleet routing',
  description: 'Routes the fleet.',
  kind: 'workflow',
  archived: false,
  visibility: 'public',
  organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' },
  created_by_id: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  version_count: 2,
  latest_version: null,
};

const version = (id: string, label: string, ordinal: number): CompositionVersionView => {
  const base = structuredClone(fmsVersion) as CompositionVersionView;
  return {
    ...base,
    id,
    label,
    ordinal,
    created_at: '2026-09-10T11:00:00Z',
    document: { ...base.document, version: label },
  };
};

const v1 = version('v1', '1.0.0', 1);
const v2 = version('v2', '1.1.0', 2);

beforeEach(() => {
  vi.clearAllMocks();
  api.get.mockResolvedValue({ value: composition, etag: 'W/"3"' });
  api.allVersions.mockResolvedValue([v2, v1]);
  api.version.mockImplementation(async (_org: string, _slug: string, id: string) =>
    id === 'v1' ? v1 : v2
  );
});

describe('the composition card page', () => {
  it('heads a member’s page with SPHERE’s breadcrumb, version select, actions, tiles and tabs', async () => {
    const gateway = fakeGateway({
      'GET /v1/composition-follows/isa-demo/fleet-routing': { body: { following: false } },
    });
    renderCompositionPage(<CompositionCardPage />, {
      url: '/compositions/isa-demo/fleet-routing',
      organizations: [orgNode('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' })],
      gateway,
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Fleet routing' })
    ).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'ISA Demo Group' })).toHaveAttribute(
      'href',
      '/orgs/isa-demo/compositions'
    );
    expect(screen.getByRole('combobox', { name: 'Version' })).toHaveValue('v2');
    expect(screen.getByText(/· Updated .* ago/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New version' })).toBeInTheDocument();
    expect(screen.getByText('Versions', { selector: 'dt' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Follow' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
    const tabs = screen.getByRole('navigation', { name: 'Composition sections' });
    expect(within(tabs).getByRole('link', { name: 'Overview' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(within(tabs).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('opens the Get menu with the permanent link of the composition', async () => {
    renderCompositionPage(<CompositionCardPage />, {
      url: '/compositions/isa-demo/fleet-routing',
      organizations: [orgNode('isa-demo', { effective_role: 'VIEWER' })],
    });
    fireEvent.click(await screen.findByRole('button', { name: /Get composition/ }));
    expect(screen.getByRole('textbox', { name: 'Permanent composition link' })).toHaveValue(
      `${window.location.origin}/p/${composition.id}`
    );
    expect(screen.getByRole('menuitem', { name: /Download all versions/ })).toBeInTheDocument();
    // A VIEWER reads: no New version, and no Settings tab.
    expect(screen.queryByRole('button', { name: 'New version' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
  });

  it('shows a visitor the showcase, and sends a fork through the sign-in first', async () => {
    renderCompositionPage(<CompositionCardPage />, {
      url: '/compositions/isa-demo/fleet-routing?version=1.0.0',
      user: null,
    });
    expect(await screen.findByRole('region', { name: 'What it does' })).toHaveTextContent(
      'Routes the fleet.'
    );
    expect(screen.getByRole('combobox', { name: 'Version' })).toHaveValue('v1');
    expect(screen.queryByRole('button', { name: /Follow/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    await waitFor(() => expect(addressNow()).toBe('/authentication'));
  });

  it('is the in-place 404 for a composition that is missing or that the reader may not read', async () => {
    api.get.mockRejectedValue(new HttpError(404, 'Not Found'));
    renderCompositionPage(<CompositionCardPage />, {
      url: '/compositions/isa-demo/secret',
      user: null,
    });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('is the in-place 404 for a tab the page does not have', () => {
    renderCompositionPage(<CompositionCardPage />, {
      url: '/compositions/isa-demo/fleet-routing/nonsense',
    });
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
