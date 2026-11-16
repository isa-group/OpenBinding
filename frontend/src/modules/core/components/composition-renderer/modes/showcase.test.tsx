import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { compositionViewModel, type Reader } from '../../../utils/composition/viewModel';
import type { CompositionVersionView, CompositionView, ProblemFacts } from '../../../api/types';
import fmsFacts from '../../../../../test/fixtures/core/fms.facts.json';
import fmsVersion from '../../../../../test/fixtures/core/fms.version.json';
import { CompositionRenderer } from '../CompositionRenderer';
import type { Section } from '../presets';
import type { ShowcaseActions } from './showcase';

const composition = {
  id: 'composition-fms',
  slug: 'fms',
  name: 'Fleet management',
  description: 'Routes the fleet across providers.',
  kind: 'application',
  archived: false,
  visibility: 'public',
  organization: { id: 'org-lab-other', slug: 'lab-other', name: 'Other Lab' },
  created_by_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-02-03T00:00:00Z',
  version_count: 1,
} as CompositionView;

/** The fixture's version, its first task priced from a SPHERE plan and the composition's own pricing named as `offering`. */
function versionWith(offering: Record<string, string> | null): CompositionVersionView {
  const version = structuredClone(fmsVersion) as CompositionVersionView;
  const document = version.document as Record<string, Record<string, unknown>>;
  document.binding.T1 = {
    candidate: 'cand_t1_aws',
    from: { sphere: 'aws/ec2', version: '6650a1b2', plan: 'ON_DEMAND' },
  };
  return { ...version, offering };
}

const ACTIONS: ShowcaseActions = {
  versions: [
    {
      id: '00000000-0000-4000-8000-000000000008',
      label: '1.0.0',
      createdAt: '2026-01-01T00:00:02Z',
    },
    { id: 'older', label: '0.9.0', createdAt: '2025-12-01T00:00:00Z' },
  ],
  versionHref: label => `/c/lab-other/fms?version=${label}`,
  permalink: 'https://openbinding.example.org/c/lab-other/fms?version=1.0.0',
  updatedAt: '2026-02-03T00:00:00Z',
};

function renderShowcase(
  options: {
    version?: CompositionVersionView | null;
    actions?: Partial<ShowcaseActions>;
    reader?: Reader;
    hide?: Section[];
    facts?: ProblemFacts;
  } = {}
) {
  const version = options.version === undefined ? versionWith(null) : options.version;
  const model = compositionViewModel({
    composition,
    version,
    reader: options.reader ?? 'public',
    facts: options.facts,
  });
  return render(
    <MemoryRouter>
      <CompositionRenderer
        model={model}
        mode="showcase"
        hideSections={options.hide}
        showcase={{ ...ACTIONS, ...options.actions }}
      />
    </MemoryRouter>
  );
}

const region = (name: string) => screen.getByRole('region', { name });

describe('the showcase mode', () => {
  it('heads the page with the name, the kind, the organization, the version and the last change', () => {
    renderShowcase();
    expect(screen.getByRole('heading', { level: 1, name: 'Fleet management' })).toBeInTheDocument();
    expect(screen.getByText('Application · Other Lab')).toBeInTheDocument();
    expect(screen.getByText(/sealed/, { selector: 'p' })).toHaveTextContent(
      'Version 1.0.0, sealed Jan 1, 2026 · Updated Feb 3, 2026'
    );
    expect(region('What it does')).toHaveTextContent('Routes the fleet across providers.');
  });

  it('shows the values with their status, the workflow, the providers and a reference card per upstream plan', () => {
    renderShowcase();
    expect(region('Value status')).toHaveTextContent('Verified');
    expect(region('Values')).toHaveTextContent('3,060 USD/month');
    expect(
      within(region('Workflow')).getByRole('group', { name: 'The workflow of Fleet management' })
    ).toBeInTheDocument();
    expect(region('Providers')).toBeInTheDocument();
    expect(
      within(region('Upstream plans')).getByRole('heading', { name: 'Plan ON_DEMAND' })
    ).toBeInTheDocument();
  });

  it('names the linked problem as text, and never shows its candidates, findings or analysis, even to a member with facts', () => {
    renderShowcase({ reader: 'member', facts: fmsFacts as ProblemFacts });
    expect(region('Problem')).toHaveTextContent(
      'The values were computed against the problem fixtures/problems/fms@1.'
    );
    expect(within(region('Problem')).queryByRole('link')).toBeNull();
    for (const name of ['Problem candidates', 'Evaluation findings', 'Binding'])
      expect(screen.queryByRole('region', { name })).toBeNull();
  });

  it('says the composition’s own pricing as a reference: a URL is a link, a SPHERE pricing is named where it is kept', () => {
    const { unmount } = renderShowcase({
      version: versionWith({ url: 'https://pricings.example.org/fms.yml' }),
    });
    expect(
      within(region('Offering')).getByRole('link', { name: /pricings\.example\.org\/fms\.yml/ })
    ).toHaveAttribute('href', 'https://pricings.example.org/fms.yml');
    expect(region('Offering')).toHaveTextContent(
      'Plans and prices arrive when OpenBinding reads the offering.'
    );
    unmount();

    const registry = renderShowcase({
      version: versionWith({ sphere: 'fleet/fms', registry: 'lab-sphere' }),
    });
    expect(region('Offering')).toHaveTextContent('fleet/fms on the on-premise SPHERE lab-sphere');
    expect(within(region('Offering')).queryByRole('link')).toBeNull();
    registry.unmount();

    renderShowcase({ version: versionWith({ sphere: 'fleet/fms' }) });
    expect(region('Offering')).toHaveTextContent('fleet/fms in SPHERE');
  });

  it('lists the versions as links to their own page, the one shown marked', () => {
    renderShowcase();
    const versions = screen.getByRole('list', { name: 'Versions' });
    expect(within(versions).getByRole('link', { name: '1.0.0' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(within(versions).getByRole('link', { name: '0.9.0' })).toHaveAttribute(
      'href',
      '/c/lab-other/fms?version=0.9.0'
    );
  });

  it('copies the permalink of the version shown and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderShowcase();
    fireEvent.click(screen.getByRole('button', { name: 'Copy permalink' }));
    expect(writeText).toHaveBeenCalledWith(
      'https://openbinding.example.org/c/lab-other/fms?version=1.0.0'
    );
    expect(await screen.findByText('Link copied.')).toHaveAttribute('role', 'status');
  });

  it('offers Fork and the app only when the page answers them', () => {
    const onFork = vi.fn();
    const { unmount } = renderShowcase();
    expect(screen.queryByRole('button', { name: 'Fork' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open in the app' })).toBeNull();
    unmount();

    renderShowcase({ actions: { onFork, appHref: '/app/lab-other/compositions/fms' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fork' }));
    expect(onFork).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Open in the app' })).toHaveAttribute(
      'href',
      '/app/lab-other/compositions/fms'
    );
  });

  it('says there is no version yet, and leaves out what a version would show', () => {
    renderShowcase({ version: null, actions: { versions: [] } });
    expect(screen.getByRole('heading', { level: 1, name: 'Fleet management' })).toBeInTheDocument();
    expect(
      screen.getByText('No version yet: nothing has been sealed for this composition.')
    ).toBeInTheDocument();
    for (const name of ['Values', 'Workflow', 'Offering', 'Versions'])
      expect(screen.queryByRole('region', { name })).toBeNull();
  });

  it('leaves out the sections a screen hides', () => {
    renderShowcase({ hide: ['about', 'plans', 'versions'] });
    for (const name of ['What it does', 'Upstream plans', 'Versions'])
      expect(screen.queryByRole('region', { name })).toBeNull();
    expect(region('Values')).toBeInTheDocument();
  });
});
