import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareSelections, resolvePricing, unwrapValue } from 'pricing-renderer';
import type {
  ComparedValue,
  ExpressionOptions,
  NormalizedPricing,
  PricingSelection,
} from 'pricing-renderer';
import { parsePricingYaml } from 'pricing-renderer/yaml';

// The gateway's Python Pricing2Yaml normaliser (openbinding-gateway/src/openbinding_gateway/modules/plans/domain/
// pricing2yaml: normalise.py, effective.py, expression.py, summary.py) must read every recorded SPHERE pricing as
// pricing-renderer does, because the F3 expansion, the F6 classifier and the screens all read pricings.
// The fixtures in src/test/fixtures/sphere/ pair each recorded (or synthetic) YAML with the Python golden. Regenerate
// them from the gateway, never by hand:
//   openbinding-gateway: python tools/dump_normalised_pricings.py   (the goldens, NORM)
//   openbinding-gateway: python tools/dump_frontend_fixtures.py     (the copies here, FIXT)
// Only pricing-renderer's public exports are used. The one documented difference: a NUMERIC value of at least 1e8
// (pricing4ts's sentinel) is unlimited for the gateway and a number for the renderer, so both compare as unlimited.

const DIRECTORY = join(
  import.meta.dirname ?? join(process.cwd(), 'src', 'test', 'sphere'),
  '..',
  'fixtures',
  'sphere',
);
const EXPRESSION: ExpressionOptions = { functions: { String: (value: unknown) => String(value) } };
const SENTINEL = 1e8;
const UNLIMITED_TEXT = new Set(['.inf', 'Infinity', 'unlimited']);
const EPSILON = 1e-9;

type GoldenValue = unknown;
interface GoldenPrice {
  kind: 'fixed' | 'expression' | 'label';
  amount?: number;
  value?: number | null;
}
interface GoldenEffective {
  plan: string;
  billing: { id: string; multiplier: number };
  addOns: Record<string, number>;
  parts: Array<{ kind: string; id: string; amount: number | null; unitAmount: number | null }>;
  subtotal: number;
  requiresQuote: boolean;
  features: Record<string, GoldenValue>;
  usageLimits: Record<string, GoldenValue>;
}
interface GoldenPlan {
  id: string;
  price: GoldenPrice;
}
interface Golden {
  pricing: {
    billing: Array<{ id: string; multiplier: number; synthesized: boolean }>;
    features: Array<{ id: string; valueType: string | null }>;
    usageLimits: Array<{ id: string; valueType: string | null }>;
    plans: GoldenPlan[];
    addOns: Array<{ id: string; price: GoldenPrice }>;
  };
  effective: Record<string, GoldenEffective>;
}

const UNLIMITED = { unlimited: true } as const;

function fromGolden(value: GoldenValue): unknown {
  return value ?? null;
}

/** A raw renderer value (a plan's or a default) as the golden writes values. */
function fromRaw(raw: unknown, limit: boolean, numeric: boolean): unknown {
  if (raw === undefined) return null;
  if (raw === null) return limit ? UNLIMITED : null;
  if (typeof raw === 'number') {
    if (raw === Number.POSITIVE_INFINITY) return UNLIMITED;
    if (!Number.isFinite(raw)) return null;
    if ((limit || numeric) && raw >= SENTINEL) return UNLIMITED;
    return raw;
  }
  if (typeof raw === 'string') return UNLIMITED_TEXT.has(raw) ? UNLIMITED : raw;
  return raw;
}

function fromCompared(value: ComparedValue, limit: boolean, numeric: boolean): unknown {
  switch (value.kind) {
    case 'none':
      return null;
    case 'unlimited':
      return UNLIMITED;
    case 'number':
      return (limit || numeric) && value.value >= SENTINEL ? UNLIMITED : value.value;
    default:
      return value.value;
  }
}

function capable(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === '') return false;
  return true;
}

function close(actual: number | undefined, expected: number | null | undefined): boolean {
  if (actual === undefined || expected === null || expected === undefined) return actual === expected;
  return Math.abs(actual - expected) <= EPSILON * Math.max(1, Math.abs(expected));
}

interface Fixture {
  name: string;
  yaml: string;
  golden: Golden;
}

function load(name: string): Fixture {
  return {
    name,
    yaml: readFileSync(join(DIRECTORY, `${name}.yml`), 'utf8'),
    golden: JSON.parse(readFileSync(join(DIRECTORY, `${name}.normalised.json`), 'utf8')) as Golden,
  };
}

function rendererPricing(fixture: Fixture): NormalizedPricing {
  const result = parsePricingYaml(fixture.yaml);
  if (!result.value) {
    throw new Error(`${fixture.name}: pricing-renderer refused it: ${JSON.stringify(result.diagnostics)}`);
  }
  return result.value;
}

const FIXTURES = readdirSync(DIRECTORY)
  .filter(name => name.endsWith('.normalised.json'))
  .map(name => name.slice(0, -'.normalised.json'.length))
  .sort();

function numericSets(golden: Golden): { features: Set<string> } {
  return {
    features: new Set(golden.pricing.features.filter(f => f.valueType === 'NUMERIC').map(f => f.id)),
  };
}

function planValues(pricing: NormalizedPricing, planId: string, numeric: Set<string>) {
  const plan = pricing.plans.find(candidate => candidate.id === planId)!;
  const own = (values: Record<string, unknown>, id: string) =>
    Object.prototype.hasOwnProperty.call(values, id) && values[id] !== undefined;
  const features: Record<string, unknown> = {};
  for (const feature of pricing.features) {
    const raw = own(plan.features, feature.id) ? unwrapValue(plan.features[feature.id]) : feature.defaultValue;
    features[feature.id] = fromRaw(raw, false, numeric.has(feature.id));
  }
  const usageLimits: Record<string, unknown> = {};
  for (const limit of pricing.usageLimits) {
    const raw = own(plan.usageLimits, limit.id) ? unwrapValue(plan.usageLimits[limit.id]) : limit.defaultValue;
    usageLimits[limit.id] = fromRaw(raw, true, true);
  }
  return { features, usageLimits };
}

function selection(effective: GoldenEffective): Partial<PricingSelection> {
  const addOns: PricingSelection['addOns'] = {};
  for (const [id, quantity] of Object.entries(effective.addOns)) addOns[id] = { selected: true, quantity };
  return { planId: effective.plan, addOns };
}

describe('the Python Pricing2Yaml normaliser reads every recorded pricing as pricing-renderer does', () => {
  it('has fixtures to compare', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(20);
  });

  for (const name of FIXTURES) {
    describe(name, () => {
      const fixture = load(name);
      const golden = fixture.golden;
      const pricing = rendererPricing(fixture);
      const numeric = numericSets(golden);

      it('has the same names, billing and price kinds', () => {
        expect(pricing.plans.map(p => p.id), `${name} plans`).toEqual(golden.pricing.plans.map(p => p.id));
        expect(pricing.addOns.map(a => a.id), `${name} add-ons`).toEqual(golden.pricing.addOns.map(a => a.id));
        expect(pricing.features.map(f => f.id), `${name} features`).toEqual(golden.pricing.features.map(f => f.id));
        expect(pricing.usageLimits.map(u => u.id), `${name} usage limits`).toEqual(
          golden.pricing.usageLimits.map(u => u.id),
        );
        if (golden.pricing.billing.every(b => b.synthesized)) {
          expect(pricing.billing.every(b => b.synthesized === true), `${name} billing`).toBe(true);
        } else {
          expect(pricing.billing.map(b => [b.id, b.multiplier]), `${name} billing`).toEqual(
            golden.pricing.billing.map(b => [b.id, b.multiplier]),
          );
        }
        for (const plan of golden.pricing.plans) {
          const theirs = pricing.plans.find(p => p.id === plan.id)!;
          expect(theirs.price.kind, `${name} plan ${plan.id} price kind`).toBe(plan.price.kind);
        }
        for (const addOn of golden.pricing.addOns) {
          const theirs = pricing.addOns.find(a => a.id === addOn.id)!;
          expect(theirs.price.kind, `${name} add-on ${addOn.id} price kind`).toBe(addOn.price.kind);
        }
      });

      it('prices every plan and single add-on variant alike', () => {
        for (const [variant, effective] of Object.entries(golden.effective)) {
          const resolved = resolvePricing(pricing, selection(effective), { expression: EXPRESSION });
          expect(resolved.breakdown.billingPeriod?.multiplier ?? 1, `${name} ${variant} billing`).toBe(
            effective.billing.multiplier,
          );
          expect(
            close(resolved.breakdown.subtotal, effective.subtotal),
            `${name} ${variant} subtotal ${resolved.breakdown.subtotal} != ${effective.subtotal}`,
          ).toBe(true);
          expect(resolved.breakdown.requiresQuote, `${name} ${variant} requiresQuote`).toBe(effective.requiresQuote);
          const plan = golden.pricing.plans.find(p => p.id === effective.plan)!;
          if (plan.price.kind === 'expression') {
            const theirs = resolved.planPrices[effective.plan]!;
            if (plan.price.value === null || plan.price.value === undefined) {
              expect(theirs.kind, `${name} ${variant} expression`).toBe('error');
            } else {
              expect(theirs.kind === 'amount' && close(theirs.baseAmount, plan.price.value), `${name} ${variant} expression value`).toBe(true);
            }
          }
        }
      });

      it('gives every plan the same feature and usage-limit values', () => {
        for (const [variant, effective] of Object.entries(golden.effective)) {
          if (Object.keys(effective.addOns).length > 0) continue;
          const values = planValues(pricing, effective.plan, numeric.features);
          for (const [id, value] of Object.entries(effective.features)) {
            expect(values.features[id], `${name} plan ${variant} feature ${id}`).toEqual(fromGolden(value));
          }
          for (const [id, value] of Object.entries(effective.usageLimits)) {
            expect(values.usageLimits[id], `${name} plan ${variant} usage limit ${id}`).toEqual(fromGolden(value));
          }
        }
      });

      it('gives every single add-on variant the same values', () => {
        for (const [variant, effective] of Object.entries(golden.effective)) {
          const addOn = Object.keys(effective.addOns)[0];
          if (addOn === undefined) continue;
          const base = golden.effective[effective.plan]!;
          const comparison = compareSelections({
            before: { pricing, selection: { planId: effective.plan } },
            after: { pricing, selection: selection(effective) },
            expression: EXPRESSION,
          });
          const reported = new Map<string, unknown>();
          for (const change of [
            ...comparison.features.gained,
            ...comparison.features.lost,
            ...comparison.features.changed,
          ]) {
            reported.set(change.id, fromCompared(change.after, false, numeric.features.has(change.id)));
          }
          for (const [id, value] of Object.entries(effective.features)) {
            const expected = fromGolden(value);
            if (reported.has(id)) {
              expect(reported.get(id), `${name} ${variant} feature ${id}`).toEqual(expected);
            } else {
              const same = JSON.stringify(expected) === JSON.stringify(fromGolden(base.features[id]));
              expect(same || (!capable(expected) && !capable(fromGolden(base.features[id]))), `${name} ${variant} feature ${id} (unchanged)`).toBe(true);
            }
          }
          const limits = new Map(
            comparison.usageLimits.changed.map(change => [change.id, fromCompared(change.after, true, true)]),
          );
          for (const [id, value] of Object.entries(effective.usageLimits)) {
            const expected = fromGolden(value);
            const actual = limits.has(id) ? limits.get(id) : fromGolden(base.usageLimits[id]);
            expect(actual, `${name} ${variant} usage limit ${id}`).toEqual(expected);
          }
        }
      });
    });
  }
});

describe('the same plan across two versions compares as the goldens say (the inputs of the F6 classifier)', () => {
  function across(beforeName: string, afterName: string, plans: string[] | 'all', withPrice: boolean) {
    const before = load(beforeName);
    const after = load(afterName);
    const beforePricing = rendererPricing(before);
    const afterPricing = rendererPricing(after);
    const numeric = numericSets(after.golden);
    const ids = plans === 'all' ? before.golden.pricing.plans.map(p => p.id) : plans;
    for (const plan of ids) {
      const comparison = compareSelections({
        before: { pricing: beforePricing, selection: { planId: plan } },
        after: { pricing: afterPricing, selection: { planId: plan } },
        expression: EXPRESSION,
      });
      const goldenBefore = before.golden.effective[plan]!;
      const goldenAfter = after.golden.effective[plan]!;
      if (withPrice) {
        expect(close(comparison.price.before.subtotal, goldenBefore.subtotal), `${plan} price before`).toBe(true);
        expect(close(comparison.price.after.subtotal, goldenAfter.subtotal), `${plan} price after`).toBe(true);
      }
      for (const change of comparison.usageLimits.changed) {
        expect(fromCompared(change.before, true, true), `${plan} usage limit ${change.id} before`).toEqual(
          fromGolden(goldenBefore.usageLimits[change.id]),
        );
        expect(fromCompared(change.after, true, true), `${plan} usage limit ${change.id} after`).toEqual(
          fromGolden(goldenAfter.usageLimits[change.id]),
        );
      }
      for (const change of [...comparison.features.gained, ...comparison.features.lost]) {
        const isNumeric = numeric.features.has(change.id);
        expect(fromCompared(change.before, false, isNumeric), `${plan} feature ${change.id} before`).toEqual(
          fromGolden(goldenBefore.features[change.id]),
        );
        expect(fromCompared(change.after, false, isNumeric), `${plan} feature ${change.id} after`).toEqual(
          fromGolden(goldenAfter.features[change.id]),
        );
      }
    }
  }

  it('the synthetic Mailgun pair, every plan, with prices', () => {
    across('6ade364540e55445692b0eda.6ade36454b2b5b01c587db3d', 'derived.mailgun-scale', 'all', true);
    const scale = compareSelections({
      before: { pricing: rendererPricing(load('6ade364540e55445692b0eda.6ade36454b2b5b01c587db3d')), selection: { planId: 'SCALE' } },
      after: { pricing: rendererPricing(load('derived.mailgun-scale')), selection: { planId: 'SCALE' } },
      expression: EXPRESSION,
    });
    expect(scale.usageLimits.changed.map(change => change.id)).toEqual(['emailsPerMonth']);
  });

  it('Dropbox 2021 to 2024, plan PLUS, features and usage limits', () => {
    across(
      '6ab0a323697330667ccce9c1.687e4b68102baa50f3a5c7b7',
      '6ab0a323697330667ccce9c1.687e4b68102baa50f3a5c7b6',
      ['PLUS'],
      false,
    );
  });
});
