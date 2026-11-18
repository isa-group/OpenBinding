import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import mailgun from '../../../../test/fixtures/sphere/6ade364540e55445692b0eda.6ade36454b2b5b01c587db3d.yml?raw';
import scaled from '../../../../test/fixtures/sphere/derived.mailgun-scale.yml?raw';
import PricingChangeReview from '.';
import { compareProviderPlan, PROVIDER_PLAN_MESSAGES } from './compare';

describe('PricingChangeReview (core)', () => {
  it('compares one provider plan across two versions of its pricing', () => {
    const compared = compareProviderPlan(mailgun, scaled, 'SCALE');
    expect(compared.ok).toBe(true);
    if (!compared.ok) return;
    expect(compared.comparison.selections.after.planId).toBe('SCALE');
    expect(compared.comparison.selections.before.planId).toBe('SCALE');
  });

  it('says why it cannot draw a version it cannot read', () => {
    expect(compareProviderPlan('syntaxVersion: "2.1"\n', mailgun, 'SCALE')).toMatchObject({
      ok: false,
    });
  });

  it('draws a read-only review with neutral words and the title it is given', () => {
    const compared = compareProviderPlan(mailgun, scaled, 'SCALE');
    if (!compared.ok) throw new Error('not compared');
    const { container } = render(
      <PricingChangeReview
        comparison={compared.comparison}
        title="Mailgun SCALE: version 2026-10 → derived"
        messages={PROVIDER_PLAN_MESSAGES}
        readOnly
      />
    );
    expect(container.querySelector('pricing-change-review')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /Confirm/ })).toBeNull();
  });
});
