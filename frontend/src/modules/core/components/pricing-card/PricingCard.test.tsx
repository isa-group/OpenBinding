import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Provenance } from '../../utils/composition/document';
import brevo from '../../../../test/fixtures/sphere/6ade2d4440e55445692b07f1.6ade2d444b2b5b01c587d80d.yml?raw';
import upstream from '../../../../test/fixtures/core/tomatometer-email.upstream.json';
import type { UpstreamSnapshot } from '../../api/types';
import { PricingCard } from './PricingCard';

const renderer = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

// In jsdom the element never takes its properties (it stays on PR_SOURCE_MISSING), so what it draws is not asserted here: the
// stand-in records what the card passes to it.
vi.mock('pricing-renderer/react', async () => {
  const { createElement } = await import('react');
  return {
    PricingRenderer: (props: Record<string, unknown>) => {
      renderer.props = props;
      return createElement('div', { 'data-testid': 'pricing-renderer' });
    },
  };
});

/** The set-B Brevo version recorded from SPHERE (src/test/fixtures/sphere), as a composition's `from` pins it. */
const STARTER: Provenance = {
  sphere: 'danruilop1/brevo',
  version: '6ade2d444b2b5b01c587d80d',
  plan: 'STARTER',
};

/** Its stored snapshot, as the upstream view names one (names and dates, SPHERE's permanent link). */
const SNAPSHOT: UpstreamSnapshot = {
  ...(upstream.entries[1].snapshot as UpstreamSnapshot),
  id: '00000000-0000-4000-8000-000000000011',
  pricingId: '6ade2d4440e55445692b07f1',
  versionId: '6ade2d444b2b5b01c587d80d',
  slug: 'brevo',
  title: 'brevo',
  versionName: '2026-10',
  createdAt: '2026-10-25T00:00:00Z',
  permanentUrl:
    'https://sphere.score.us.es/p/6ade2d4440e55445692b07f1?version=6ade2d444b2b5b01c587d80d',
};

describe('PricingCard', () => {
  beforeEach(() => {
    renderer.props = null;
  });

  it('shows the pinned reference without a snapshot: the plan, the pricing, where SPHERE is, and no version id', () => {
    render(<PricingCard reference={STARTER} />);
    const card = screen.getByRole('article', { name: 'Plan STARTER' });
    expect(card).toHaveTextContent('danruilop1/brevo');
    expect(card).toHaveTextContent('VersionThe pinned version (no copy here)');
    expect(card).not.toHaveTextContent('6ade2d444b2b5b01c587d80d');
    expect(card).toHaveTextContent('SPHEREThis installation’s');
    expect(card).toHaveTextContent('Add-onsNone');
    expect(card).toHaveTextContent('Showing the pinned reference');
    expect(screen.queryByTestId('pricing-renderer')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('names the registry and the add-ons when the reference has them', () => {
    render(
      <PricingCard
        reference={{
          sphere: 'acme/picking',
          registry: 'lab',
          version: 'v7',
          plan: 'Pro',
          addons: ['Priority support', 'SSO'],
        }}
      />
    );
    const card = screen.getByRole('article', { name: 'Plan Pro' });
    expect(card).toHaveTextContent('SPHERERegistry lab');
    expect(card).toHaveTextContent('Add-onsPriority support, SSO');
  });

  it('names the version of a stored snapshot by its name and date, and links to it in SPHERE', () => {
    render(<PricingCard reference={STARTER} snapshot={SNAPSHOT} />);
    const card = screen.getByRole('article', { name: 'Plan STARTER' });
    expect(card).toHaveTextContent('Version2026-10 · Oct 25, 2026');
    expect(card).not.toHaveTextContent('6ade2d444b2b5b01c587d80d');
    const link = within(card).getByRole('link', { name: 'Open in SPHERE' });
    expect(link).toHaveAttribute('href', SNAPSHOT.permanentUrl);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it("draws the plan from its snapshot with pricing-renderer's catalog preset, read only, its add-ons marked", async () => {
    render(
      <PricingCard
        reference={{ ...STARTER, addons: ['dedicatedIp'] }}
        snapshot={SNAPSHOT}
        yaml={brevo}
      />
    );
    expect(await screen.findByTestId('pricing-renderer')).toBeInTheDocument();
    expect(renderer.props).toMatchObject({
      yaml: brevo,
      mode: 'catalog',
      currentSelection: {
        planId: 'STARTER',
        addOns: { dedicatedIp: { selected: true, quantity: 1 } },
      },
      selectionEnabled: false,
      ctaEnabled: false,
      hideSections: ['hero', 'billing', 'variables', 'summary'],
      diagnostics: 'verbose',
      visibility: 'all',
      theme: 'light',
    });
    // The platform's tokens and the expression function the gateway allows reach the renderer through the bridge.
    expect(renderer.props?.style).toMatchObject({ '--pr-color-accent': 'var(--color-tp-accent)' });
    expect(
      (
        renderer.props?.expressionOptions as { functions: Record<string, (v: unknown) => unknown> }
      ).functions.String(5)
    ).toBe('5');
    expect(renderer.props).not.toHaveProperty('renderPlanCta');
    expect(brevo).toContain('STARTER:');
    expect(screen.getByRole('article', { name: 'Plan STARTER' })).not.toHaveTextContent(
      'Showing the pinned reference'
    );
  });

  it('hides the add-ons section when the plan is taken alone', async () => {
    render(<PricingCard reference={STARTER} snapshot={SNAPSHOT} yaml={brevo} />);
    await screen.findByTestId('pricing-renderer');
    expect(renderer.props).toMatchObject({
      currentSelection: { planId: 'STARTER' },
      hideSections: ['hero', 'billing', 'variables', 'summary', 'addOns'],
    });
  });
});
