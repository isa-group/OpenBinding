import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { org } from '../../../../features/workspace/testKit';
import type {
  CompositionVersionDiff,
  CompositionVersionView,
  CompositionView,
} from '../../../core/api/types';
import fmsDiff from '../../../../test/fixtures/core/fms.diff.json';
import fmsFacts from '../../../../test/fixtures/core/fms.facts.json';
import fmsVersion from '../../../../test/fixtures/core/fms.version.json';
import CompositionCardPage from '../../pages/card';
import { renderCompositionPage } from '../../../../test/compositionPage';
import { fakeGateway } from '../../../../test/moduleKit';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  allVersions: vi.fn(),
  version: vi.fn(),
  content: vi.fn(),
  diff: vi.fn(),
  reevaluate: vi.fn(),
}));
vi.mock('../../../core/utils/composition/api', () => ({ compositionsApi: api, languageApi: {} }));
const factsApi = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../../core/utils/problem/facts', () => ({ problemFactsApi: factsApi }));
const problems = vi.hoisted(() => ({ revision: vi.fn() }));
vi.mock('../../../../api/problems', () => ({ problemsApi: problems }));
const download = vi.hoisted(() => ({ saveText: vi.fn() }));
vi.mock('../../utils/download', () => download);

const member = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'MEMBER' });
const viewer = org('isa-demo', { name: 'ISA Demo Group', effective_role: 'VIEWER' });

const composition: CompositionView = {
  id: 'composition-fleet',
  slug: 'fleet-routing',
  name: 'Fleet routing',
  description: '',
  kind: 'application',
  archived: false,
  visibility: 'private',
  organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA Demo Group' },
  created_by_id: null,
  created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  version_count: 3,
  latest_version: {
    id: 'v3',
    ordinal: 3,
    label: '1.2.0',
    values_status: 'verified',
    verified: true,
    created_at: '2026-10-01T00:00:00Z',
  },
};

const INSTALLED = 'sha256-installed';

function versionOf(
  id: string,
  label: string,
  ordinal: number,
  createdAt: string,
  over: Partial<CompositionVersionView> = {}
): CompositionVersionView {
  const version = structuredClone(fmsVersion) as CompositionVersionView;
  return {
    ...version,
    id,
    label,
    ordinal,
    created_at: createdAt,
    document: { ...version.document, version: label },
    ...over,
  };
}

/** The installed toolchain's compilation evaluated this one. */
const current = (version: CompositionVersionView): CompositionVersionView => ({
  ...version,
  current_evaluation: version.current_evaluation && {
    ...version.current_evaluation,
    compilation: version.current_evaluation.compilation && {
      ...version.current_evaluation.compilation,
      compilation_digest: INSTALLED,
    },
  },
});

const v1 = current(versionOf('v1', '1.0.0', 1, '2026-09-10T11:00:00Z'));
const v2 = versionOf('v2', '1.1.0', 2, '2026-09-25T15:45:00Z', {
  forked_from: {
    droppedProblem: false,
    compositionId: 'c-src',
    versionId: 'v-src',
    label: '2.0.0',
    name: 'Fleet base',
    slug: 'fleet-base',
    organization: { id: 'org-partner', name: 'partner-lab', displayName: 'Partner Lab' },
  },
});
const v3 = current(
  versionOf('v3', '1.2.0', 3, '2026-10-01T08:00:00Z', {
    derivation: {
      source: 'run',
      run: { id: 'a1b2c3d4-0000-4000-8000-000000000001' },
      point: 3,
      revision: { id: 'rev-1', revision: 1 },
    },
  })
);
const versions = [v3, v2, v1];

function Where() {
  const where = useLocation();
  return <output data-testid="where">{where.pathname + where.search}</output>;
}

const where = () => screen.getByTestId('where').textContent;

function renderVersions(
  url = '/compositions/isa-demo/fleet-routing/versions',
  organization = member
) {
  return renderCompositionPage(
    <>
      <CompositionCardPage />
      <Where />
    </>,
    { url, organizations: [organization] }
  );
}

const rowOf = (label: string) => screen.getByRole('listitem', { name: `Version ${label}` });

const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const writeText = vi.fn();

describe('the Versions tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.get.mockResolvedValue({ value: composition, etag: 'W/"7"' });
    api.allVersions.mockResolvedValue(versions);
    api.version.mockImplementation(async (_org: string, _slug: string, id: string) =>
      versions.find(version => version.id === id)
    );
    api.content.mockImplementation(
      async (_org: string, _slug: string, id: string) =>
        `version: ${versions.find(version => version.id === id)?.label}\nkind: application\n`
    );
    api.diff.mockResolvedValue(structuredClone(fmsDiff) as CompositionVersionDiff);
    factsApi.get.mockResolvedValue(fmsFacts);
    problems.revision.mockResolvedValue({
      compilations: [
        { id: 'old', compilation_digest: 'sha256-old', current: false },
        { id: 'new', compilation_digest: INSTALLED, current: true },
      ],
    });
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  afterEach(() => {
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('lists the versions newest first, with their values, status, problem and lineage', async () => {
    renderVersions();

    expect(await screen.findByRole('link', { name: 'Versions' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    const list = await screen.findByRole('list', { name: 'Versions of Fleet routing' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map(item => item.getAttribute('aria-label'))
    ).toEqual(['Version 1.2.0', 'Version 1.1.0', 'Version 1.0.0']);
    const latest = rowOf('1.2.0');
    expect(latest).toHaveTextContent('Latest');
    expect(latest).toHaveTextContent('cost 3,060 USD/month');
    expect(latest).toHaveTextContent('Verified');
    expect(
      within(latest).getByRole('link', {
        name: `${fmsVersion.problem.problem.slug}@${fmsVersion.problem.revision.revision}`,
      })
    ).toBeInTheDocument();
    expect(latest).toHaveTextContent('Derived from run a1b2c3d4, point 3');
    expect(latest).toHaveAttribute('aria-current', 'true');
    expect(within(latest).getByText('Current')).toBeInTheDocument();
    expect(rowOf('1.1.0')).toHaveTextContent(
      'Forked from Fleet base (version 2.0.0) · Partner Lab'
    );
    expect(
      within(rowOf('1.0.0')).queryByRole('button', { name: 'Compare with previous' })
    ).toBeNull();
    // Versions are immutable: no visibility and no delete per version.
    expect(within(list).queryByRole('button', { name: /delete|private|public/i })).toBeNull();
  });

  it('compares a version with the previous one, opens it in the editor, downloads it and copies its link', async () => {
    renderVersions();

    const row = await waitFor(() => rowOf('1.1.0'));
    expect(within(row).getByRole('link', { name: 'Open in editor' })).toHaveAttribute(
      'href',
      '/compositions/isa-demo/fleet-routing/editor?version=1.1.0'
    );

    fireEvent.click(within(row).getByRole('button', { name: 'Download YAML' }));
    await waitFor(() =>
      expect(download.saveText).toHaveBeenCalledWith(
        'version: 1.1.0\nkind: application\n',
        'fleet-routing-1.1.0.yaml'
      )
    );

    fireEvent.click(within(row).getByRole('button', { name: 'Copy link' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/p/composition-fleet?version=1.1.0`
      )
    );
    expect(await within(row).findByRole('button', { name: 'Link copied' })).toBeInTheDocument();

    fireEvent.click(within(row).getByRole('button', { name: 'Compare with previous' }));
    await waitFor(() =>
      expect(where()).toBe('/compositions/isa-demo/fleet-routing/versions?from=1.0.0&to=1.1.0')
    );
  });

  it('copies the page of a public composition, the same address every reader opens', async () => {
    api.get.mockResolvedValue({ value: { ...composition, visibility: 'public' }, etag: 'W/"7"' });
    renderVersions();

    fireEvent.click(
      within(await waitFor(() => rowOf('1.2.0'))).getByRole('button', { name: 'Copy link' })
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        `${window.location.origin}/compositions/isa-demo/fleet-routing?version=1.2.0`
      )
    );
  });

  it('offers a MEMBER to re-evaluate only a version the installed toolchain has not evaluated', async () => {
    api.reevaluate.mockResolvedValue({
      created: true,
      evaluation: { ...fmsVersion.evaluations[0], outcome: 'verified' },
    });
    renderVersions();

    const stale = await waitFor(() => rowOf('1.1.0'));
    const button = await within(stale).findByRole('button', { name: 'Re-evaluate' });
    expect(within(rowOf('1.2.0')).queryByRole('button', { name: 'Re-evaluate' })).toBeNull();
    expect(problems.revision).toHaveBeenCalledTimes(1);
    expect(problems.revision).toHaveBeenCalledWith(
      'isa-demo',
      fmsVersion.problem.problem.slug,
      fmsVersion.problem.revision.revision
    );

    fireEvent.click(button);
    await waitFor(() =>
      expect(api.reevaluate).toHaveBeenCalledWith('isa-demo', 'fleet-routing', 'v2')
    );
    expect(
      await screen.findByText('Version 1.1.0 re-evaluated with the installed toolchain: verified.')
    ).toBeInTheDocument();
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  });

  it('offers a VIEWER no re-evaluation, and asks nothing for it', async () => {
    renderVersions(undefined, viewer);

    const row = await waitFor(() => rowOf('1.1.0'));
    expect(within(row).getByRole('button', { name: 'Copy link' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Re-evaluate' })).toBeNull();
    expect(problems.revision).not.toHaveBeenCalled();
  });

  it('compares the pair the address names, swaps it in the address and shows the texts line by line', async () => {
    renderVersions('/compositions/isa-demo/fleet-routing/versions?from=1.0.0&to=1.1.0');

    expect(await screen.findByRole('button', { name: /^\d+ Changed$/ })).toBeInTheDocument();
    expect(api.diff).toHaveBeenCalledWith('isa-demo', 'fleet-routing', 'v1', 'v2');
    expect(screen.getByRole('button', { name: 'Structured' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(await screen.findByRole('region', { name: 'Workflow changes' })).toBeInTheDocument();
    expect(api.version).toHaveBeenCalledWith('isa-demo', 'fleet-routing', 'v1', { document: true });
    expect(api.version).toHaveBeenCalledWith('isa-demo', 'fleet-routing', 'v2', { document: true });

    fireEvent.click(screen.getByRole('button', { name: 'Swap versions' }));
    await waitFor(() =>
      expect(where()).toBe('/compositions/isa-demo/fleet-routing/versions?from=1.1.0&to=1.0.0')
    );
    await waitFor(() =>
      expect(api.diff).toHaveBeenCalledWith('isa-demo', 'fleet-routing', 'v2', 'v1')
    );

    fireEvent.click(screen.getByRole('button', { name: 'File' }));
    await waitFor(() =>
      expect(where()).toBe(
        '/compositions/isa-demo/fleet-routing/versions?from=1.1.0&to=1.0.0&diff=file'
      )
    );
    expect(await screen.findByText('1.1.0', { selector: 'span' })).toBeInTheDocument();
    expect(api.content).toHaveBeenCalledWith('isa-demo', 'fleet-routing', 'v2');
  });

  it('opens the comparison on the latest version and the one before it', async () => {
    renderVersions();
    fireEvent.click(await screen.findByRole('button', { name: 'Compare versions' }));
    await waitFor(() =>
      expect(api.diff).toHaveBeenCalledWith('isa-demo', 'fleet-routing', 'v2', 'v3')
    );
    expect(screen.getByRole('combobox', { name: 'Base version' })).toHaveValue('v2');
    expect(screen.getByRole('combobox', { name: 'Compared with' })).toHaveValue('v3');
  });

  it('draws the version graph above the list, with the lane it was forked from', async () => {
    const lane = (id: string, role: 'current' | 'source', labels: string[]) => ({
      composition_id: id,
      role,
      available: true,
      name: role === 'current' ? 'Fleet routing' : 'Fleet base',
      slug: role === 'current' ? 'fleet-routing' : 'fleet-base',
      organization: { id: 'o', slug: role === 'current' ? 'isa-demo' : 'partner-lab', name: 'Org' },
      versions: labels.map((label, index) => ({
        id: `${id}-${index}`,
        label,
        created_at: `2026-09-1${index}T00:00:00Z`,
        forked_from:
          role === 'current' && index === 0
            ? { composition_id: 'c-src', version_id: 'c-src-0', label: '2.0.0' }
            : null,
      })),
    });
    renderCompositionPage(<CompositionCardPage />, {
      url: '/compositions/isa-demo/fleet-routing/versions',
      organizations: [member],
      gateway: fakeGateway({
        'GET /v1/organizations/isa-demo/compositions/fleet-routing/graph': {
          body: {
            lanes: [
              lane('c-src', 'source', ['2.0.0']),
              lane('composition-fleet', 'current', ['1.0.0', '1.1.0', '1.2.0']),
            ],
            truncated: false,
          },
        },
      }),
    });
    const graph = await screen.findByRole('region', { name: 'Version graph' });
    expect(
      await within(graph).findByRole('img', { name: '4 versions in 2 compositions' })
    ).toBeInTheDocument();
    expect(within(graph).getByRole('link', { name: /Fleet base/ })).toHaveAttribute(
      'href',
      '/compositions/partner-lab/fleet-base'
    );
  });

  it('has nothing to compare with one version', async () => {
    api.allVersions.mockResolvedValue([v1]);
    renderVersions('/compositions/isa-demo/fleet-routing/versions?from=1.0.0');
    expect(await screen.findByRole('listitem', { name: 'Version 1.0.0' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Compare versions' })).toBeNull();
    expect(api.diff).not.toHaveBeenCalled();
  });
});
