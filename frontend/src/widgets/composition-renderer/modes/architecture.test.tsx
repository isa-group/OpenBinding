import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { compositionViewModel, type Reader } from '../../../entities/composition/viewModel';
import type { CompositionVersionView, CompositionView, ProblemFacts } from '../../../shared/api/types';
import fmsFacts from '../../../test/fixtures/core/fms.facts.json';
import fmsVersion from '../../../test/fixtures/core/fms.version.json';
import { CompositionRenderer } from '../CompositionRenderer';
import type { Section } from '../presets';

const composition = {
  id: 'composition-fms', slug: 'fms', name: 'Fleet management', description: '', kind: 'application', archived: false, visibility: 'private',
  organization: { id: 'org-isa-demo', slug: 'isa-demo', name: 'ISA demo' }, created_by_id: null, created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z', version_count: 1,
} as CompositionView;

const BREVO = { sphere: 'brevo/brevo', version: '665f1c2e9b1d4a0012ab34cd', plan: 'STARTER' };

/** The fleet version with SPHERE plans named: two tasks on one Brevo plan, one on a plan of an on-premise SPHERE. */
function withPlans(): CompositionVersionView {
  const version = structuredClone(fmsVersion) as CompositionVersionView;
  const document = version.document as { binding: Record<string, unknown> };
  document.binding.T1 = { candidate: 'cand_t1_aws', from: BREVO };
  document.binding.T3 = { candidate: 'cand_t3_distance_matrix_api', from: BREVO };
  document.binding.T6 = { candidate: 'cand_t6_paypal', from: { sphere: 'paypal/checkout', registry: 'lab', version: 'v9', plan: 'Pro', addons: ['Fraud'] } };
  version.analytics = { ...version.analytics, upstreamPricings: 2 };
  return version;
}

function renderArchitecture(version: CompositionVersionView | null, options: { reader?: Reader; facts?: ProblemFacts; hide?: Section[] } = {}) {
  const model = compositionViewModel({ composition, version, facts: options.facts, reader: options.reader ?? 'member' });
  return render(<CompositionRenderer model={model} mode="architecture" hideSections={options.hide} />);
}

const section = (name: string) => screen.getByRole('region', { name });

describe('the architecture mode', () => {
  it('groups the tasks by the provider the problem names, for a member who may read it', () => {
    renderArchitecture(structuredClone(fmsVersion) as CompositionVersionView, { facts: fmsFacts as ProblemFacts });
    const providers = section('Providers');
    expect(within(providers).getByRole('heading', { level: 3, name: 'amazon 2 tasks' })).toBeInTheDocument();
    expect(within(providers).getByRole('heading', { level: 3, name: 'In-house 1 task' })).toBeInTheDocument();
    expect(within(providers).getByText('No candidate names the SPHERE pricing it comes from.')).toBeInTheDocument();
    expect(within(section('Upstream plans')).getByText('No candidate names the SPHERE plan it comes from.')).toBeInTheDocument();
  });

  it('groups by SPHERE pricing without the problem, and shows one reference card per plan with the tasks it serves', () => {
    renderArchitecture(withPlans(), { reader: 'public' });
    const providers = section('Providers');
    expect(within(providers).getByText('The candidates come from 2 SPHERE pricings.')).toBeInTheDocument();
    expect(within(providers).getByRole('heading', { level: 3, name: 'brevo/brevo SPHERE pricing 2 tasks' })).toBeInTheDocument();
    expect(within(providers).getByRole('heading', { level: 3, name: 'Provider not known 2 tasks' })).toBeInTheDocument();

    const plans = within(section('Upstream plans')).getAllByRole('listitem');
    expect(plans).toHaveLength(2);
    expect(within(plans[0]).getByRole('article', { name: 'Plan STARTER' })).toHaveTextContent('brevo/brevo');
    expect(plans[0]).toHaveTextContent('For T1, T3');
    expect(within(plans[1]).getByRole('article', { name: 'Plan Pro' })).toHaveTextContent('Registry lab');
    expect(plans[1]).toHaveTextContent('Add-onsFraud');
    expect(plans[1]).toHaveTextContent('For T6');
    expect(within(section('Upstream plans')).queryByRole('link')).toBeNull();
  });

  it('leaves out the sections a screen hides', () => {
    renderArchitecture(withPlans(), { hide: ['plans'] });
    expect(section('Providers')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Upstream plans' })).toBeNull();
  });

  it('draws nothing before the first version', () => {
    const { container } = renderArchitecture(null);
    expect(container.querySelector('[data-mode="architecture"]')).toBeEmptyDOMElement();
  });
});
