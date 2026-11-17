import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { compositionViewModel, type Reader } from '../../../utils/composition/viewModel';
import type { CompositionVersionView, CompositionView, ProblemFacts } from '../../../api/types';
import fmsFacts from '../../../../../test/fixtures/core/fms.facts.json';
import fmsVersion from '../../../../../test/fixtures/core/fms.version.json';
import { CompositionRenderer } from '../CompositionRenderer';
import type { Section } from '../presets';

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

function renderShowcase(
  options: {
    version?: CompositionVersionView | null;
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
      <CompositionRenderer model={model} mode="showcase" hideSections={options.hide} />
    </MemoryRouter>
  );
}

const region = (name: string) => screen.getByRole('region', { name });

describe('the showcase mode', () => {
  it('says what the composition does; the page header, not the mode, names it', () => {
    renderShowcase();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
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

  it('says there is no version yet, and leaves out what a version would show', () => {
    renderShowcase({ version: null });
    expect(
      screen.getByText('No version yet: nothing has been sealed for this composition.')
    ).toBeInTheDocument();
    for (const name of ['Values', 'Workflow', 'Offering'])
      expect(screen.queryByRole('region', { name })).toBeNull();
  });

  it('leaves out the sections a screen hides', () => {
    renderShowcase({ hide: ['about', 'plans'] });
    for (const name of ['What it does', 'Upstream plans'])
      expect(screen.queryByRole('region', { name })).toBeNull();
    expect(region('Values')).toBeInTheDocument();
  });
});
