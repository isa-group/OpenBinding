import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Provenance } from '../../utils/composition/document';
import brevo from '../../../../test/fixtures/pricings/brevo.yaml?raw';
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

const STARTER: Provenance = {
  sphere: 'brevo/brevo',
  version: '665f1c2e9b1d4a0012ab34cd',
  plan: 'STARTER',
};

describe('PricingCard', () => {
  beforeEach(() => {
    renderer.props = null;
  });

  it('shows the reference without a document: the plan, the pricing, the pinned version and where SPHERE is', () => {
    render(<PricingCard reference={STARTER} />);
    const card = screen.getByRole('article', { name: 'Plan STARTER' });
    expect(card).toHaveTextContent('brevo/brevo');
    expect(within(card).getByText('665f1c2e9b1d4a0012ab34cd')).toBeInTheDocument();
    expect(card).toHaveTextContent('SPHEREThis installation’s');
    expect(card).toHaveTextContent('Add-onsNone');
    expect(card).toHaveTextContent('its prices and limits are kept in SPHERE');
    expect(screen.queryByTestId('pricing-renderer')).toBeNull();
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

  it('links nowhere: owner/name and a version id form no address of SPHERE, and a registry alias names an address only the gateway knows', () => {
    render(
      <>
        <PricingCard reference={STARTER} />
        <PricingCard reference={{ ...STARTER, registry: 'lab' }} />
      </>
    );
    expect(screen.queryAllByRole('link')).toEqual([]);
  });

  it("draws the plan from its document with pricing-renderer's catalog preset, read only and with nothing to buy", async () => {
    render(<PricingCard reference={STARTER} yaml={brevo} />);
    expect(await screen.findByTestId('pricing-renderer')).toBeInTheDocument();
    expect(renderer.props).toMatchObject({
      yaml: brevo,
      mode: 'catalog',
      currentSelection: { planId: 'STARTER' },
      selectionEnabled: false,
      ctaEnabled: false,
      hideSections: ['hero', 'billing', 'variables', 'summary', 'addOns'],
      diagnostics: 'verbose',
      visibility: 'all',
      theme: 'light',
    });
    // The platform's tokens reach the renderer through the bridge.
    expect(renderer.props?.style).toMatchObject({ '--pr-color-accent': 'var(--color-tp-accent)' });
    expect(renderer.props).not.toHaveProperty('renderPlanCta');
    expect(renderer.props).not.toHaveProperty('renderSummaryActions');
    expect(brevo).toContain('STARTER:');
    expect(screen.getByRole('article', { name: 'Plan STARTER' })).not.toHaveTextContent(
      'kept in SPHERE'
    );
  });
});
