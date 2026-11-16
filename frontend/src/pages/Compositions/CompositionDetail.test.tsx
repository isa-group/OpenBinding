import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError } from '../../api/client';
import { org, renderOrgScreen } from '../../features/workspace/testKit';
import type { CompositionVersionView, CompositionView } from '../../shared/api/types';
import fmsFacts from '../../test/fixtures/core/fms.facts.json';
import fmsVersion from '../../test/fixtures/core/fms.version.json';
import { CompositionDetail } from './CompositionDetail';

const api = vi.hoisted(() => ({ get: vi.fn(), allVersions: vi.fn(), version: vi.fn(), content: vi.fn(), update: vi.fn(), fork: vi.fn() }));

vi.mock('../../entities/composition/api', () => ({ compositionsApi: api }));

const factsApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../entities/problem/facts', () => ({ problemFactsApi: factsApi }));

const platform = vi.hoisted(() => ({ organizations: vi.fn() }));

vi.mock('../../api/platform', async (importOriginal) => ({ ...(await importOriginal<object>()), platformApi: platform }));

const group = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const partner = org('partner-lab', { name: 'Partner Lab', effective_role: 'VIEWER' });

const composition: CompositionView = {
  id: 'composition-fleet', slug: 'fleet-routing', name: 'Fleet routing', description: 'Routes the fleet.', kind: 'application',
  archived: false, visibility: 'public', organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' },
  created_by_id: null, created_at: '2026-09-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', version_count: 3,
  latest_version: { id: 'v3', ordinal: 3, label: '1.2.0', values_status: 'verified', verified: true, created_at: '2026-10-01T00:00:00Z' },
};

/** One version of the fleet routing composition, from the gateway's fixture, under another id, label and ordinal. */
function versionOf(id: string, label: string, ordinal: number, over: Partial<CompositionVersionView> = {}): CompositionVersionView {
  const version = structuredClone(fmsVersion) as CompositionVersionView;
  return { ...version, id, label, ordinal, document: { ...version.document, version: label }, ...over };
}

const v1 = versionOf('v1', '1.0.0', 1);
const v2 = versionOf('v2', '1.1.0', 2, { derivation: { source: 'run', run: { id: 'a1b2c3d4-0000-4000-8000-000000000001' }, point: 3, revision: { id: 'rev-1', revision: 1 } } });
const v3 = versionOf('v3', '1.2.0', 3, {
  forked_from: {
    droppedProblem: false, compositionId: 'composition-source', versionId: 'version-source', label: '2.0.0', name: 'Fleet base', slug: 'fleet-base',
    organization: { id: 'org-partner-lab', name: 'partner-lab', displayName: 'Partner Lab' },
  },
});
const versions = [v3, v2, v1];

function Where() {
  const where = useLocation();
  return <output data-testid="where">{where.pathname + where.search}</output>;
}

const where = () => screen.getByTestId('where').textContent;

function renderDetail(url = '/app/isa-demo/compositions/fleet-routing') {
  return renderOrgScreen(<><CompositionDetail /><Where /></>, {
    path: '/app/:org/compositions/:composition/:tab?', url, organizations: [group, partner],
  });
}

describe('Composition page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockImplementation(async (org: string) => {
      if (org === 'isa-demo') return { value: composition, etag: 'W/"7"' };
      throw Object.assign(new HttpError(404, 'Composition not found.'), { code: 'not_found' });
    });
    platform.organizations.mockResolvedValue([group, partner]);
    api.allVersions.mockResolvedValue(versions);
    api.version.mockImplementation(async (_org: string, _slug: string, id: string) => versions.find((version) => version.id === id));
    factsApi.get.mockResolvedValue(fmsFacts);
  });

  it('shows the composition, its badges and the latest version in its Overview', async () => {
    renderDetail();

    expect(await screen.findByRole('heading', { level: 1, name: 'Fleet routing' })).toBeInTheDocument();
    expect(api.allVersions).toHaveBeenCalledWith('isa-demo', 'fleet-routing', { order: 'newest' });
    for (const badge of ['Application', 'Public']) expect(screen.getByText(badge)).toBeInTheDocument();
    expect(screen.getByText(/^Updated /)).toBeInTheDocument();
    const select = screen.getByRole('combobox', { name: 'Version' });
    expect(select).toHaveValue('v3');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['1.2.0 · latest', '1.1.0', '1.0.0']);
    await waitFor(() => expect(api.version).toHaveBeenCalledWith('isa-demo', 'fleet-routing', 'v3', { document: true }));
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('region', { name: 'Values' })).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    // The header names the composition: the catalog leaves its identity out.
    expect(screen.queryByRole('heading', { level: 2, name: 'Fleet routing' })).toBeNull();
  });

  it('draws the providers, the workflow and the linked problem’s candidates, read from the compilation the values were evaluated on', async () => {
    renderDetail();

    const providers = await screen.findByRole('region', { name: 'Providers' });
    expect(await within(providers).findByRole('heading', { level: 3, name: 'amazon 2 tasks' })).toBeInTheDocument();
    expect(factsApi.get).toHaveBeenCalledWith('isa-demo', fmsVersion.problem.problem.slug, fmsVersion.problem.revision.revision, fmsVersion.evaluations[0].compilation.id);
    expect(screen.getByRole('region', { name: 'Upstream plans' })).toHaveTextContent('No candidate names the SPHERE plan it comes from.');
    expect(within(screen.getByRole('region', { name: 'Workflow' })).getByRole('group', { name: 'The workflow of Fleet routing' })).toBeInTheDocument();
    const candidates = screen.getByRole('region', { name: 'Problem candidates' });
    expect(within(candidates).getByRole('row', { name: /^cand_t1_aws/ })).toHaveAttribute('aria-current', 'true');
  });

  it('keeps the rest of the Overview when the candidates cannot be read, and reads them again on request', async () => {
    factsApi.get.mockRejectedValueOnce(new HttpError(503, 'unavailable'));
    renderDetail();

    expect(await screen.findByText(/^The candidates of the linked problem couldn’t be loaded \(503/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Workflow' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Problem candidates' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('region', { name: 'Problem candidates' })).toBeInTheDocument();
  });

  it('offers a member to show the version’s choice on the candidates of the problem version it links, and in the problem editor', async () => {
    renderDetail('/app/isa-demo/compositions/fleet-routing?version=1.0.0');

    const show = await screen.findByRole('link', { name: 'Show on the problem' });
    expect(show).toHaveAttribute(
      'href',
      `/app/isa-demo/problems/${fmsVersion.problem.problem.slug}/candidates?version=${fmsVersion.problem.revision.revision}&composition=fleet-routing&compositionVersion=1.0.0`,
    );
    expect(screen.getByRole('link', { name: 'Open on its problem in the editor' })).toHaveAttribute(
      'href',
      `/app/isa-demo/problem-editor?problem=${fmsVersion.problem.problem.slug}&revision=${fmsVersion.problem.revision.revision}&composition=fleet-routing&compositionVersion=1.0.0`,
    );
  });

  it('reads no candidates for a declared version', async () => {
    const declared = versionOf('v3', '1.2.0', 3, { problem: null, values_status: 'declared' });
    api.allVersions.mockResolvedValue([declared]);
    api.version.mockResolvedValue(declared);
    renderDetail();

    expect(await screen.findByRole('region', { name: 'Workflow' })).toBeInTheDocument();
    expect(factsApi.get).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Problem candidates' })).toBeNull();
    expect(screen.queryByText(/candidates of the linked problem/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Show on the problem' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open on its problem in the editor' })).toBeNull();
  });

  it('says where a forked version comes from, linking a private source in one of the account’s organizations', async () => {
    renderDetail();

    const lineage = await screen.findByRole('list', { name: 'Lineage' });
    expect(lineage).toHaveTextContent('Forked from Partner Lab / Fleet base 2.0.0.');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('partner-lab', 'fleet-base'));
    expect(within(lineage).getByRole('link', { name: 'Partner Lab / Fleet base' })).toHaveAttribute('href', '/app/partner-lab/compositions/fleet-base?version=2.0.0');
  });

  it('links a fork’s source to its public page while it is public', async () => {
    const source = { ...composition, slug: 'fleet-base', visibility: 'public' as const };
    api.get.mockImplementation(async (org: string) => ({ value: org === 'isa-demo' ? composition : source, etag: null }));
    renderDetail();

    const lineage = await screen.findByRole('list', { name: 'Lineage' });
    await waitFor(() => expect(within(lineage).getByRole('link', { name: 'Partner Lab / Fleet base' })).toHaveAttribute('href', '/c/partner-lab/fleet-base?version=2.0.0'));
  });

  it('names no source it was not given', async () => {
    const hidden = versionOf('v3', '1.2.0', 3, {
      forked_from: { droppedProblem: true, compositionId: null, versionId: null, label: null, name: null, slug: null, organization: null },
    });
    api.allVersions.mockResolvedValue([hidden]);
    api.version.mockResolvedValue(hidden);
    renderDetail();

    expect(await screen.findByRole('list', { name: 'Lineage' })).toHaveTextContent('Forked from another composition, without its problem.');
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('forks the version shown into another organization', async () => {
    renderDetail('/app/isa-demo/compositions/fleet-routing?version=1.0.0');

    await waitFor(() => expect(api.version).toHaveBeenCalledWith('isa-demo', 'fleet-routing', 'v1', { document: true }));
    fireEvent.click(await screen.findByRole('button', { name: 'Fork' }));
    const dialog = screen.getByRole('dialog', { name: 'Fork this composition' });
    expect(dialog).toHaveTextContent('Create your own copy of Fleet routing at version 1.0.0');
    expect(await within(dialog).findByRole('radio', { name: 'ISA Demo Group' })).toBeDisabled();
  });

  it('shows Settings to a MEMBER, whose changes name the revision the page read', async () => {
    api.update.mockResolvedValue({ value: composition, etag: 'W/"8"' });
    renderDetail('/app/isa-demo/compositions/fleet-routing/settings');

    expect(await screen.findByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('switch', { name: 'Archived' }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('isa-demo', 'fleet-routing', { archived: true }, 'W/"7"'));
    expect(screen.queryByRole('button', { name: 'Make private' })).toBeNull();
  });

  it('has no Settings tab for a VIEWER, who may still fork', async () => {
    renderOrgScreen(<CompositionDetail />, {
      path: '/app/:org/compositions/:composition/:tab?', url: '/app/isa-demo/compositions/fleet-routing',
      organizations: [{ ...group, effective_role: 'VIEWER' }],
    });
    expect(await screen.findByRole('tab', { name: 'Versions' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Fork' })).toBeInTheDocument();
  });

  it('opens the version the address names, by label or ordinal, and changes it with the select', async () => {
    renderDetail('/app/isa-demo/compositions/fleet-routing?version=2');

    const select = await screen.findByRole('combobox', { name: 'Version' });
    expect(select).toHaveValue('v2');
    await waitFor(() => expect(api.version).toHaveBeenCalledWith('isa-demo', 'fleet-routing', 'v2', { document: true }));
    const lineage = await screen.findByRole('list', { name: 'Lineage' });
    expect(lineage).toHaveTextContent('Derived from run a1b2c3d4, point 3.');
    expect(within(lineage).getByRole('link', { name: 'run a1b2c3d4' })).toHaveAttribute('href', '/app/isa-demo/runs/a1b2c3d4-0000-4000-8000-000000000001');

    fireEvent.change(select, { target: { value: 'v1' } });
    await waitFor(() => expect(where()).toBe('/app/isa-demo/compositions/fleet-routing?version=1.0.0'));
    await waitFor(() => expect(api.version).toHaveBeenCalledWith('isa-demo', 'fleet-routing', 'v1', { document: true }));
  });

  it('falls back to the latest version when the address names one it does not list', async () => {
    renderDetail('/app/isa-demo/compositions/fleet-routing?version=9.9.9');

    expect(await screen.findByRole('combobox', { name: 'Version' })).toHaveValue('v3');
    expect(screen.queryByText(/doesn’t exist/)).toBeNull();
  });

  it('says there is no version yet for a new composition', async () => {
    api.get.mockResolvedValue({ value: { ...composition, version_count: 0, latest_version: null, visibility: 'private' }, etag: null });
    api.allVersions.mockResolvedValue([]);
    renderDetail();

    expect(await screen.findByText(/No version yet/)).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Version' })).toBeNull();
    expect(api.version).not.toHaveBeenCalled();
  });

  it('answers the same for a missing composition and one it may not read, never saying private', async () => {
    api.get.mockRejectedValue(Object.assign(new HttpError(404, 'Composition not found.'), { code: 'not_found' }));
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'No composition here, or you cannot see it' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All compositions' })).toHaveAttribute('href', '/app/isa-demo/compositions');
    expect(document.body.textContent).not.toMatch(/private/i);
  });

  it('offers a retry when the gateway does not answer', async () => {
    api.get.mockRejectedValue(new HttpError(503, 'unavailable'));
    renderDetail();

    expect(await screen.findByRole('heading', { name: /The composition couldn’t be loaded/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it.each(['overview', 'operations', 'nonsense'])('answers the tab %s it does not have with the page that does not exist', (tab) => {
    renderDetail(`/app/isa-demo/compositions/fleet-routing/${tab}`);

    expect(screen.getByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });
});
