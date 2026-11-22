import { readFileSync } from 'node:fs';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { UpstreamEventDetail } from '../../api/types';
import valuesChanged from '../../../../test/fixtures/core/upstream.tomatometer.event.values-changed.json';
import bindingInvalid from '../../../../test/fixtures/core/upstream.tomatometer.event.binding-invalid.json';
import offering from '../../../../test/fixtures/core/upstream.tomatometer.event.offering-changed.json';
import unavailable from '../../../../test/fixtures/core/upstream.tomatometer.event.unavailable.json';
import withdrawn from '../../../../test/fixtures/core/upstream.tomatometer.event.withdrawn.json';
import { UpstreamChangeSummary } from '.';
import { decimalText, deltaText, moneyText } from './format';
import { noteText, reasonText } from './words';

const draw = (event: unknown) =>
  render(<UpstreamChangeSummary event={event as UpstreamEventDetail} />);

describe('the upstream change summary', () => {
  it('says what the values would become, entry by entry, with the delta as the gateway gave it', () => {
    draw(valuesChanged);
    expect(screen.getByRole('region', { name: 'Global values' })).toHaveTextContent(
      'subscription 508.99 → 558.99 USD/month, +50.00'
    );
    const entry = screen.getByRole('region', { name: 'dailySummary: email.brevo.professional' });
    expect(entry).toHaveTextContent('plan PROFESSIONAL, billed monthly');
    const row = within(entry).getByRole('row', { name: /Price/ });
    expect(row).toHaveTextContent('499.00');
    expect(row).toHaveTextContent('549.00');
    expect(row).toHaveTextContent('+50.00');
    expect(within(entry).getByRole('row', { name: /Guarantee/ })).toHaveTextContent('unchanged');
    expect(within(entry).getByRole('row', { name: /emailsPerDay/ })).toHaveTextContent('Unlimited');
    const notes = screen.getByRole('list', { name: 'Notes' });
    expect(notes).toHaveTextContent('Nothing was re-evaluated');
    expect(notes).toHaveTextContent('may fall outside the range');
  });

  it('words the plan comparison’s features and limits, which the gateway writes as compared values', () => {
    const [entry] = (
      valuesChanged as unknown as { diff: { entries: Array<Record<string, unknown>> } }
    ).diff.entries;
    const compared = (kind: string, value?: unknown) =>
      value === undefined ? { kind } : { kind, value };
    draw({
      ...valuesChanged,
      diff: {
        ...valuesChanged.diff,
        entries: [
          {
            ...entry,
            comparison: {
              features: {
                gained: [
                  {
                    id: 'webhooks',
                    name: 'Webhooks',
                    before: compared('boolean', false),
                    after: compared('boolean', true),
                    presence: 'both',
                  },
                ],
                lost: [
                  {
                    id: 'sms',
                    name: null,
                    before: compared('boolean', true),
                    after: compared('none'),
                    presence: 'before',
                  },
                ],
                changed: [
                  {
                    id: 'support',
                    name: 'Support',
                    before: compared('text', 'email'),
                    after: compared('text', 'phone'),
                    presence: 'both',
                  },
                ],
                unchanged: [],
              },
              usageLimits: [
                {
                  id: 'emailsPerMonth',
                  name: 'Monthly emails',
                  before: compared('number', '150000'),
                  after: compared('unlimited'),
                  presence: 'both',
                },
                {
                  id: 'emailsPerDay',
                  name: 'Daily emails',
                  before: compared('unlimited'),
                  after: compared('unlimited'),
                  presence: 'both',
                },
              ],
              plan: { renamedTo: null },
            },
          },
        ],
      },
    });
    const region = screen.getByRole('region', { name: 'dailySummary: email.brevo.professional' });
    expect(region).toHaveTextContent('Webhooks is now included');
    expect(region).toHaveTextContent('sms is no longer included');
    expect(region).toHaveTextContent('Support: email → phone');
    expect(region).toHaveTextContent('Monthly emails: 150,000 → Unlimited');
    expect(region).not.toHaveTextContent('Daily emails');
    expect(region).not.toHaveTextContent('[object Object]');
  });

  it('words an offering plan’s Unlimited values, and calls an unchanged one unchanged', () => {
    const rows = (offering as unknown as { diff: { plans: Array<Record<string, unknown>> } }).diff
      .plans;
    draw({
      ...offering,
      diff: {
        ...offering.diff,
        plans: [
          {
            plan: 'premium',
            addOns: [],
            changed: false,
            before: {
              price: '9.990000',
              unit: 'user/month',
              features: { export: true },
              usageLimits: { maxPomodoroTimers: { unlimited: true } },
            },
            after: {
              price: '9.990000',
              unit: 'user/month',
              features: { export: true },
              usageLimits: { maxPomodoroTimers: { unlimited: true } },
            },
          },
          {
            plan: 'basic',
            addOns: [],
            changed: true,
            before: {
              price: '0.000000',
              unit: 'user/month',
              features: {},
              usageLimits: { maxPomodoroTimers: '3.000000' },
            },
            after: {
              price: '0.990000',
              unit: 'user/month',
              features: {},
              usageLimits: { maxPomodoroTimers: { unlimited: true } },
            },
          },
        ],
      },
    });
    expect(rows.length).toBeGreaterThan(0);
    const table = screen.getByLabelText('Offering plans before and after');
    expect(within(table).getByRole('row', { name: /premium/ })).toHaveTextContent('Unchanged');
    expect(within(table).getByRole('row', { name: /basic/ })).toHaveTextContent(
      'maxPomodoroTimers 3 → Unlimited'
    );
    expect(table).not.toHaveTextContent('[object Object]');
  });

  it('says why rebinding is recommended for a removed plan', () => {
    draw(bindingInvalid);
    expect(screen.getByRole('region', { name: 'Why' })).toHaveTextContent(
      'Why rebinding is recommendedPlan PROFESSIONAL is no longer offered.'
    );
  });

  it('says why a vanished family or a withdrawn version is a binding to redo', () => {
    draw(unavailable);
    expect(screen.getByRole('region', { name: 'Why' })).toHaveTextContent(
      'the pricing is no longer readable in SPHERE (hidden, private or deleted)'
    );
    draw(withdrawn);
    expect(screen.getAllByRole('region', { name: 'Why' })[1]).toHaveTextContent(
      'the pinned version is no longer listed'
    );
  });

  it('gives an offering event SPHERE’s catalog line and each plan before and after', () => {
    draw(offering);
    const section = screen.getByRole('region', { name: 'Offering plans' });
    expect(section).toHaveTextContent('1 plan changed · 1 plan with an add-on changed');
    const basic = within(section).getAllByRole('row')[1];
    expect(basic).toHaveTextContent('basic');
    expect(basic).toHaveTextContent('0.00');
    expect(basic).toHaveTextContent('0.99');
    expect(basic).toHaveTextContent('gains dailySummary; maxPomodoroTimers 3 → 5');
    expect(screen.queryByRole('region', { name: 'Global values' })).toBeNull();
  });

  it('says every reason and note code in words, a URL offering by its host', () => {
    for (const code of [
      'pricing_unreadable',
      'plan_private',
      'price_not_numeric',
      'addon_removed',
      'addon_unavailable',
      'addon_not_subscription',
      'currency_changed',
      'billing_missing',
      'value_unmapped',
      'requirement_unmet',
      'offering_unavailable',
    ])
      expect(reasonText({ code }), code).not.toBe(`${code}.`);
    expect(
      reasonText({ code: 'source_unavailable', detail: 'family_not_found' }, 'pricings.example.org')
    ).toBe('Source unavailable: the file at pricings.example.org can no longer be read.');
    expect(
      reasonText({
        code: 'requirement_unmet',
        name: 'emailsPerDay',
        kind: 'limit',
        demand: '1000.000000',
        after: '500.000000',
      })
    ).toBe('Requirement not met: emailsPerDay is 500, below the demand of 1,000.');
    for (const note of [
      'values_not_reevaluated',
      'no_direct_mapping',
      'no_value_origins',
      'unlimited_sentinel',
      'domain_may_change',
      'baseline_unavailable',
    ])
      expect(noteText(note), note).not.toBe(note);
  });

  it('formats the gateway’s amounts from their text, never as numbers', () => {
    expect(deltaText('50.000000', true)).toBe('+50.00');
    expect(deltaText('-0.500000', true)).toBe('−0.50');
    expect(deltaText('0.000000', true)).toBe('0.00');
    expect(moneyText('1508.990000')).toBe('1,508.99');
    expect(decimalText('0.999500')).toBe('0.9995');
    expect(decimalText('150000.000000')).toBe('150,000');
    expect(decimalText('100000000.000000')).toBe('Unlimited');
    for (const file of ['index.tsx', 'format.ts', 'words.ts']) {
      const source = readFileSync(
        `${process.cwd()}/src/modules/core/components/upstream-change-summary/${file}`,
        'utf8'
      );
      expect(source, file).not.toMatch(/parseFloat|parseInt|Number\(/);
    }
  });
});
