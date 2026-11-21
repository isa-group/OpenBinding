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
  'sphere'
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
  if (value === null || value === undefined || value === false || value === 0 || value === '')
    return false;
  return true;
}

function close(actual: number | undefined, expected: number | null | undefined): boolean {
  if (actual === undefined || expected === null || expected === undefined)
    return actual === expected;
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
    throw new Error(
      `${fixture.name}: pricing-renderer refused it: ${JSON.stringify(result.diagnostics)}`
    );
  }
  return result.value;
}

const FIXTURES = readdirSync(DIRECTORY)
  .filter(name => name.endsWith('.normalised.json'))
  .map(name => name.slice(0, -'.normalised.json'.length))
  .sort();

function numericSets(golden: Golden): { features: Set<string> } {
  return {
    features: new Set(
      golden.pricing.features.filter(f => f.valueType === 'NUMERIC').map(f => f.id)
    ),
  };
}

function planValues(pricing: NormalizedPricing, planId: string, numeric: Set<string>) {
  const plan = pricing.plans.find(candidate => candidate.id === planId)!;
  const own = (values: Record<string, unknown>, id: string) =>
    Object.prototype.hasOwnProperty.call(values, id) && values[id] !== undefined;
  const features: Record<string, unknown> = {};
  for (const feature of pricing.features) {
    const raw = own(plan.features, feature.id)
      ? unwrapValue(plan.features[feature.id])
      : feature.defaultValue;
    features[feature.id] = fromRaw(raw, false, numeric.has(feature.id));
  }
  const usageLimits: Record<string, unknown> = {};
  for (const limit of pricing.usageLimits) {
    const raw = own(plan.usageLimits, limit.id)
      ? unwrapValue(plan.usageLimits[limit.id])
      : limit.defaultValue;
    usageLimits[limit.id] = fromRaw(raw, true, true);
  }
  return { features, usageLimits };
}

function selection(effective: GoldenEffective): Partial<PricingSelection> {
  const addOns: PricingSelection['addOns'] = {};
  for (const [id, quantity] of Object.entries(effective.addOns))
    addOns[id] = { selected: true, quantity };
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
        expect(
          pricing.plans.map(p => p.id),
          `${name} plans`
        ).toEqual(golden.pricing.plans.map(p => p.id));
        expect(
          pricing.addOns.map(a => a.id),
          `${name} add-ons`
        ).toEqual(golden.pricing.addOns.map(a => a.id));
        expect(
          pricing.features.map(f => f.id),
          `${name} features`
        ).toEqual(golden.pricing.features.map(f => f.id));
        expect(
          pricing.usageLimits.map(u => u.id),
          `${name} usage limits`
        ).toEqual(golden.pricing.usageLimits.map(u => u.id));
        if (golden.pricing.billing.every(b => b.synthesized)) {
          expect(
            pricing.billing.every(b => b.synthesized === true),
            `${name} billing`
          ).toBe(true);
        } else {
          expect(
            pricing.billing.map(b => [b.id, b.multiplier]),
            `${name} billing`
          ).toEqual(golden.pricing.billing.map(b => [b.id, b.multiplier]));
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
          const resolved = resolvePricing(pricing, selection(effective), {
            expression: EXPRESSION,
          });
          expect(
            resolved.breakdown.billingPeriod?.multiplier ?? 1,
            `${name} ${variant} billing`
          ).toBe(effective.billing.multiplier);
          expect(
            close(resolved.breakdown.subtotal, effective.subtotal),
            `${name} ${variant} subtotal ${resolved.breakdown.subtotal} != ${effective.subtotal}`
          ).toBe(true);
          expect(resolved.breakdown.requiresQuote, `${name} ${variant} requiresQuote`).toBe(
            effective.requiresQuote
          );
          const plan = golden.pricing.plans.find(p => p.id === effective.plan)!;
          if (plan.price.kind === 'expression') {
            const theirs = resolved.planPrices[effective.plan]!;
            if (plan.price.value === null || plan.price.value === undefined) {
              expect(theirs.kind, `${name} ${variant} expression`).toBe('error');
            } else {
              expect(
                theirs.kind === 'amount' && close(theirs.baseAmount, plan.price.value),
                `${name} ${variant} expression value`
              ).toBe(true);
            }
          }
        }
      });

      it('gives every plan the same feature and usage-limit values', () => {
        for (const [variant, effective] of Object.entries(golden.effective)) {
          if (Object.keys(effective.addOns).length > 0) continue;
          const values = planValues(pricing, effective.plan, numeric.features);
          for (const [id, value] of Object.entries(effective.features)) {
            expect(values.features[id], `${name} plan ${variant} feature ${id}`).toEqual(
              fromGolden(value)
            );
          }
          for (const [id, value] of Object.entries(effective.usageLimits)) {
            expect(values.usageLimits[id], `${name} plan ${variant} usage limit ${id}`).toEqual(
              fromGolden(value)
            );
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
            reported.set(
              change.id,
              fromCompared(change.after, false, numeric.features.has(change.id))
            );
          }
          for (const [id, value] of Object.entries(effective.features)) {
            const expected = fromGolden(value);
            if (reported.has(id)) {
              expect(reported.get(id), `${name} ${variant} feature ${id}`).toEqual(expected);
            } else {
              const same =
                JSON.stringify(expected) === JSON.stringify(fromGolden(base.features[id]));
              expect(
                same || (!capable(expected) && !capable(fromGolden(base.features[id]))),
                `${name} ${variant} feature ${id} (unchanged)`
              ).toBe(true);
            }
          }
          const limits = new Map(
            comparison.usageLimits.changed.map(change => [
              change.id,
              fromCompared(change.after, true, true),
            ])
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
  function across(
    beforeName: string,
    afterName: string,
    plans: string[] | 'all',
    withPrice: boolean
  ) {
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
        expect(
          close(comparison.price.before.subtotal, goldenBefore.subtotal),
          `${plan} price before`
        ).toBe(true);
        expect(
          close(comparison.price.after.subtotal, goldenAfter.subtotal),
          `${plan} price after`
        ).toBe(true);
      }
      for (const change of comparison.usageLimits.changed) {
        expect(
          fromCompared(change.before, true, true),
          `${plan} usage limit ${change.id} before`
        ).toEqual(fromGolden(goldenBefore.usageLimits[change.id]));
        expect(
          fromCompared(change.after, true, true),
          `${plan} usage limit ${change.id} after`
        ).toEqual(fromGolden(goldenAfter.usageLimits[change.id]));
      }
      for (const change of [...comparison.features.gained, ...comparison.features.lost]) {
        const isNumeric = numeric.features.has(change.id);
        expect(
          fromCompared(change.before, false, isNumeric),
          `${plan} feature ${change.id} before`
        ).toEqual(fromGolden(goldenBefore.features[change.id]));
        expect(
          fromCompared(change.after, false, isNumeric),
          `${plan} feature ${change.id} after`
        ).toEqual(fromGolden(goldenAfter.features[change.id]));
      }
    }
  }

  it('the synthetic Mailgun pair, every plan, with prices', () => {
    across(
      '6ade364540e55445692b0eda.6ade36454b2b5b01c587db3d',
      'derived.mailgun-scale',
      'all',
      true
    );
    const scale = compareSelections({
      before: {
        pricing: rendererPricing(load('6ade364540e55445692b0eda.6ade36454b2b5b01c587db3d')),
        selection: { planId: 'SCALE' },
      },
      after: {
        pricing: rendererPricing(load('derived.mailgun-scale')),
        selection: { planId: 'SCALE' },
      },
      expression: EXPRESSION,
    });
    expect(scale.usageLimits.changed.map(change => change.id)).toEqual(['emailsPerMonth']);
  });

  it('Dropbox 2021 to 2024, plan PLUS, features and usage limits', () => {
    across(
      '6ab0a323697330667ccce9c1.687e4b68102baa50f3a5c7b7',
      '6ab0a323697330667ccce9c1.687e4b68102baa50f3a5c7b6',
      ['PLUS'],
      false
    );
  });
});

// The F6 classifier's comparisons (openbinding-gateway/tests/golden/upstream, copied to fixtures/sphere/upstream by
// tools/dump_frontend_fixtures.py): pricing-renderer's compareSelections, given each golden entry's selection with
// its billing period, must agree with the Python port (plans/domain/pricing2yaml/compare.py) on the plan, the
// add-on reconciliation, the features gained, lost and changed, the usage limits and the price. The one documented
// difference (two NUMERIC values of at least 1e8 are both Unlimited for the gateway) must be listed by the port as
// `sentinel`, never silently skipped.
interface PortValue {
  kind: string;
  value?: unknown;
}
interface PortComparison {
  plan: { after: { known: boolean } };
  addOns: { removedByReconciliation: Array<{ id: string; reason: string }> };
  features: {
    gained: Array<{ id: string }>;
    lost: Array<{ id: string }>;
    changed: Array<{ id: string }>;
  };
  usageLimits: Array<{ id: string; before: PortValue; after: PortValue }>;
  price: {
    before: { subtotal: string | null };
    after: { subtotal: string | null };
    difference?: string;
  };
  sentinel?: string[];
}
interface PortEntry {
  selection: { plan: string; addOns: string[]; billing: string | null };
  comparison?: PortComparison | null;
}
interface UpstreamGolden {
  event: boolean;
  diff?: { entries?: PortEntry[] };
}

const UPSTREAM = join(DIRECTORY, 'upstream');

function portValue(value: PortValue): unknown {
  if (value.kind === 'none') return null;
  if (value.kind === 'unlimited') return UNLIMITED;
  if (value.kind === 'number') return Number(value.value);
  return value.value ?? null;
}

function ids(items: Array<{ id: string }>): string[] {
  return items.map(item => item.id).sort();
}

describe('the F6 classifier compares two versions of a selection as pricing-renderer does', () => {
  const cases = readdirSync(UPSTREAM)
    .filter(name => name.endsWith('.json'))
    .map(name => name.slice(0, -'.json'.length))
    .sort();

  it('has upstream goldens to compare', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  for (const name of cases) {
    const golden = JSON.parse(
      readFileSync(join(UPSTREAM, `${name}.json`), 'utf8')
    ) as UpstreamGolden;
    const entries = (golden.diff?.entries ?? []).filter(entry => Boolean(entry.comparison));
    if (!golden.event || entries.length === 0) continue;
    const before = parsePricingYaml(readFileSync(join(UPSTREAM, `${name}.old.yml`), 'utf8')).value;
    const after = parsePricingYaml(readFileSync(join(UPSTREAM, `${name}.new.yml`), 'utf8')).value;
    if (!before || !after) continue;

    it(name, () => {
      for (const entry of entries) {
        const port = entry.comparison!;
        const addOns: PricingSelection['addOns'] = {};
        for (const id of entry.selection.addOns) addOns[id] = { selected: true, quantity: 1 };
        const selection: Partial<PricingSelection> = { planId: entry.selection.plan, addOns };
        if (entry.selection.billing) selection.billingPeriod = entry.selection.billing;
        const renderer = compareSelections({
          before: { pricing: before, selection },
          after: { pricing: after, selection },
          expression: EXPRESSION,
        });
        const sentinel = new Set(port.sentinel ?? []);
        expect(renderer.plan.after.known, `${name} plan known`).toBe(port.plan.after.known);
        expect(
          renderer.addOns.removedByReconciliation.map(item => [item.id, item.reason]),
          `${name} add-on reconciliation`
        ).toEqual(port.addOns.removedByReconciliation.map(item => [item.id, item.reason]));
        for (const kind of ['gained', 'lost', 'changed'] as const) {
          const theirs = ids(renderer.features[kind]).filter(id => !sentinel.has(id));
          expect(theirs, `${name} features ${kind}`).toEqual(ids(port.features[kind]));
        }
        const limits = new Map(port.usageLimits.map(change => [change.id, change]));
        for (const change of renderer.usageLimits.changed) {
          const ours = limits.get(change.id);
          if (ours === undefined) {
            // O18: two numbers of at least 1e8 are both Unlimited for the gateway, and the port says so.
            expect(sentinel.has(change.id), `${name} usage limit ${change.id} is a sentinel`).toBe(
              true
            );
            continue;
          }
          expect(fromCompared(change.before, true, true), `${name} ${change.id} before`).toEqual(
            portValue(ours.before)
          );
          expect(fromCompared(change.after, true, true), `${name} ${change.id} after`).toEqual(
            portValue(ours.after)
          );
        }
        if (
          port.plan.after.known &&
          port.price.before.subtotal !== null &&
          port.price.after.subtotal !== null
        ) {
          expect(
            close(renderer.price.before.subtotal, Number(port.price.before.subtotal)),
            `${name} price before`
          ).toBe(true);
          expect(
            close(renderer.price.after.subtotal, Number(port.price.after.subtotal)),
            `${name} price after`
          ).toBe(true);
          if (port.price.difference !== undefined && renderer.price.difference !== undefined) {
            expect(
              close(renderer.price.difference, Number(port.price.difference)),
              `${name} price difference`
            ).toBe(true);
          }
        }
      }
    });
  }
});
